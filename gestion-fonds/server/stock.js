'use strict';
/* =====================================================================
   Gestion de stock (produits vivriers) — inspirée du cahier des charges KBG v2.
   - Référentiel : catégories, articles (unité, durée de vie, alerte péremption, seuils min/max par agence).
   - Lots : coût unitaire réel (prix + frais accessoires), date de péremption, fournisseur / producteur,
     campagne, contrôle qualité (humidité, impuretés), statut (disponible, quarantaine, bloqué, périmé…).
   - Mouvements valorisés : réception, sortie (FEFO), transfert inter-agences, perte, ajustement d'inventaire.
   - Valorisation au coût réel des lots (FIFO / FEFO, IAS 2) ; valeur reconstituable à n'importe quelle date.
   - Chaque jour : détection et valorisation des lots périmés, instantané non modifiable de la valeur du stock.
   Toutes les données sont cloisonnées par agence (voir agences.js).
   ===================================================================== */
const { agenceCourante, CHOISIR } = require('./agences');

const CATEGORIES_DEFAUT = [
  ['cereales', 'Céréales'], ['farines', 'Farines'], ['tubercules', 'Tubercules'], ['legumineuses', 'Légumineuses'],
  ['huiles', 'Huiles'], ['sucre', 'Sucre'], ['fruits-legumes', 'Fruits et légumes'], ['transformes', 'Produits transformés'], ['autres', 'Autres'],
];
const MOTIFS_PERTE = {
  casse: 'Casse', vol: 'Vol', deterioration: 'Détérioration', infestation: 'Infestation (ravageurs)', freinte: 'Freinte (perte de poids naturelle)',
  don: 'Don', declassement: 'Déclassement qualité', transit: 'Perte en transit', autre: 'Autre',
};
const NATURES_SORTIE = { vente: 'Vente', livraison: 'Livraison client', consommation: 'Consommation interne', transformation: 'Mise en transformation', autre: 'Autre sortie' };
const MODES_PERIME = { destruction: 'Destruction', vente_declassee: 'Vente déclassée', don: 'Don', transformation: 'Transformation (alimentation animale…)' };
const STATUTS = { disponible: 'Disponible', quarantaine: 'Quarantaine', bloque: 'Bloqué', perime: 'Périmé', epuise: 'Épuisé', sorti: 'Sorti (périmé)' };
const EN_STOCK = ['disponible', 'quarantaine', 'bloque'];

const q3 = (x) => Math.round(Number(x) * 1000) / 1000;
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const r4 = (x) => Math.round(Number(x) * 10000) / 10000;
const jour = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusJours = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ordreFefo = (a, b) => ((a.datePeremption || '9999-12-31').localeCompare(b.datePeremption || '9999-12-31'))
  || a.dateReception.localeCompare(b.dateReception) || String(a.numero).localeCompare(String(b.numero));
const estPerimeAu = (lot, d) => !!lot.datePeremption && lot.datePeremption <= d;

function createStock({ store, donnees, svc, broadcast }) {
  const { ErreurMetier, texte, exigerDate, audit, prochainNumero } = svc;
  const now = () => new Date().toISOString();
  const exigerAgence = () => { const a = agenceCourante(); if (!a) throw new ErreurMetier(CHOISIR); return a; };
  const peutValider = (user) => (user.permissions || []).includes('stock.valider');
  function quantite(v, champ = 'Quantité') {
    const x = q3(v);
    if (!Number.isFinite(x) || x <= 0) throw new ErreurMetier(`${champ} : nombre strictement positif attendu.`);
    if (x > 1e9) throw new ErreurMetier(`${champ} trop élevée.`);
    return x;
  }
  const positif = (v) => { const x = Number(v || 0); if (!Number.isFinite(x) || x < 0) throw new ErreurMetier('Montant invalide (nombre positif attendu).'); return x; };
  const notifier = (...cols) => cols.forEach((c) => broadcast(c));

  /* ----------------------------------------------------------- Référentiel */
  async function initialiser() {
    for (const [i, [_id, nom]] of CATEGORIES_DEFAUT.entries()) {
      if (!(await store.col('stock_categories').findOne({ _id }))) {
        await store.col('stock_categories').updateOne({ _id }, { $set: { nom, ordre: i, semence: true } }, { upsert: true });
      }
    }
  }
  const categories = () => store.col('stock_categories').find({}, { sort: { ordre: 1, nom: 1 } });
  async function enregistrerCategorie(user, body, id) {
    const nom = texte(body.nom, 80);
    if (!nom) throw new ErreurMetier('Nom de catégorie obligatoire.');
    const toutes = await categories();
    if (toutes.some((c) => c._id !== id && c.nom.toLowerCase() === nom.toLowerCase())) throw new ErreurMetier('Cette catégorie existe déjà.');
    if (id) {
      if (!toutes.some((c) => c._id === id)) throw new ErreurMetier('Catégorie introuvable.', 404);
      await store.col('stock_categories').updateOne({ _id: id }, { $set: { nom, semence: false } });
    } else await store.col('stock_categories').insertOne({ nom, ordre: toutes.length });
    await audit(donnees, user, id ? 'Catégorie de stock modifiée' : 'Catégorie de stock créée', nom);
    notifier('stock_categories');
    return { ok: true };
  }

  const articles = () => store.col('articles').find({}, { sort: { designation: 1 } });
  async function article(id) {
    const a = await store.col('articles').findOne({ _id: id });
    if (!a) throw new ErreurMetier('Article introuvable.', 404);
    return a;
  }
  async function enregistrerArticle(user, body, id) {
    const doc = {
      code: texte(body.code, 30).toUpperCase(),
      designation: texte(body.designation, 160),
      categorieId: texte(body.categorieId, 60),
      unite: texte(body.unite, 20) || 'kg',
      variete: texte(body.variete, 80),
      gtin: texte(body.gtin, 20),
      dureeVieJours: Math.max(0, Math.floor(Number(body.dureeVieJours) || 0)),
      alerteJours: Math.max(0, Math.floor(Number(body.alerteJours ?? 30) || 0)),
      delaiAppro: Math.max(0, Math.floor(Number(body.delaiAppro ?? 7) || 0)),
      stockMin: Math.max(0, q3(body.stockMin || 0)),
      stockMax: Math.max(0, q3(body.stockMax || 0)),
      conditions: texte(body.conditions, 160),
      actif: body.actif !== false,
    };
    if (!doc.code || !doc.designation) throw new ErreurMetier('Code et désignation obligatoires.');
    if (!(await store.col('stock_categories').findOne({ _id: doc.categorieId }))) throw new ErreurMetier('Choisissez une catégorie.');
    if (doc.stockMax && doc.stockMax < doc.stockMin) throw new ErreurMetier('Le stock maximum doit être supérieur au minimum.');
    const tous = await articles();
    if (tous.some((x) => x._id !== id && x.code === doc.code)) throw new ErreurMetier('Ce code article existe déjà.');
    if (id) {
      await article(id);
      await store.col('articles').updateOne({ _id: id }, { $set: doc });
    } else await store.col('articles').insertOne({ ...doc, seuils: {}, creeLe: now() });
    await audit(donnees, user, id ? 'Article modifié' : 'Article créé', `${doc.code} – ${doc.designation}`);
    notifier('articles');
    return { ok: true };
  }
  /** Seuils propres à l'agence (stock minimum / maximum), qui priment sur ceux de l'article. */
  async function definirSeuils(user, id, body) {
    const a = exigerAgence();
    const art = await article(id);
    const min = Math.max(0, q3(body.min || 0)); const max = Math.max(0, q3(body.max || 0));
    if (max && max < min) throw new ErreurMetier('Le stock maximum doit être supérieur au minimum.');
    await store.col('articles').updateOne({ _id: id }, { $set: { seuils: { ...(art.seuils || {}), [a]: { min, max } } } });
    await audit(donnees, user, 'Seuils de stock de l\'agence', art.code, `min ${min}, max ${max}`);
    notifier('articles');
    return { ok: true };
  }
  const seuilsDe = (art, agenceId) => ((art.seuils || {})[agenceId] || { min: art.stockMin || 0, max: art.stockMax || 0 });

  /* --------------------------------------------------------------- Lots */
  const ligneLot = (lot, qte) => ({
    lotId: lot._id, lotNumero: lot.numero, articleId: lot.articleId, code: lot.code, designation: lot.designation,
    categorieId: lot.categorieId, unite: lot.unite, quantite: q3(qte), coutUnitaire: lot.coutUnitaire, valeur: r2(qte * lot.coutUnitaire),
  });

  /** Répartit une quantité sur les lots disponibles, du plus proche de la péremption au plus lointain (FEFO). */
  async function allouer(ctx, articleId, qte, date, lotImpose) {
    const lots = (await ctx.col('lots').find({ articleId, statut: 'disponible' }))
      .filter((l) => l.quantite > 0 && l.dateReception <= date && !estPerimeAu(l, date)).sort(ordreFefo);
    const dispo = q3(lots.reduce((s, l) => s + l.quantite, 0));
    if (lotImpose) {
      const l = lots.find((x) => x._id === lotImpose);
      if (!l) throw new ErreurMetier('Ce lot n\'est pas disponible à cette date (statut, péremption ou date de réception).');
      if (l.quantite < qte) throw new ErreurMetier(`Quantité insuffisante dans le lot ${l.numero} : ${l.quantite} ${l.unite} disponible(s).`);
      return { lignes: [ligneLot(l, qte)], horsFefo: lots[0]._id !== l._id ? lots[0].numero : null, lots: [[l, qte]] };
    }
    if (dispo < qte) {
      const art = await store.col('articles').findOne({ _id: articleId });
      throw new ErreurMetier(`Stock disponible insuffisant pour ${art ? art.designation : 'cet article'} : ${dispo} ${art ? art.unite : ''} disponible(s) au ${date.split('-').reverse().join('/')}.`);
    }
    let reste = qte; const pris = [];
    for (const l of lots) {
      if (reste <= 0) break;
      const p = q3(Math.min(reste, l.quantite));
      pris.push([l, p]); reste = q3(reste - p);
    }
    return { lignes: pris.map(([l, p]) => ligneLot(l, p)), horsFefo: null, lots: pris };
  }
  async function retirer(ctx, pris) {
    for (const [l, p] of pris) {
      const reste = q3(l.quantite - p);
      await ctx.col('lots').updateOne({ _id: l._id }, { $set: { quantite: reste, ...(reste <= 0 ? { statut: 'epuise' } : {}), dernierMouvement: now() } });
    }
  }
  async function enregistrerMouvement(ctx, user, m) {
    const doc = {
      numero: await prochainNumero(ctx, 'ST', m.date), ...m,
      valeur: r2(m.lignes.reduce((s, l) => s + l.valeur, 0)),
      creePar: user ? user.identifiant : 'système', nomCreateur: user ? user.nom : 'Contrôle automatique', creeLe: now(),
    };
    return ctx.col('stock_mouvements').insertOne(doc);
  }

  /* ----------------------------------------------------------- Réception */
  async function reception(user, body) {
    exigerAgence();
    const date = exigerDate(body.date);
    const art = await article(body.articleId);
    if (art.actif === false) throw new ErreurMetier('Cet article est désactivé.');
    const qte = quantite(body.quantite);
    const prix = positif(body.prixUnitaire);
    const frais = positif(body.fraisAccessoires);
    let peremption = texte(body.datePeremption, 10);
    if (!peremption && art.dureeVieJours) peremption = plusJours(date, art.dureeVieJours);
    if (peremption) exigerDate(peremption, 'date de péremption');
    if (peremption && peremption <= date) throw new ErreurMetier('Ce lot est déjà périmé à la date de réception : enregistrez plutôt un refus de livraison.');
    const statut = body.statut === 'quarantaine' ? 'quarantaine' : 'disponible';
    const r = await donnees.tx(async (ctx) => {
      const lot = await ctx.col('lots').insertOne({
        numero: texte(body.numeroLot, 40) || await prochainNumero(ctx, 'LOT', date),
        articleId: art._id, code: art.code, designation: art.designation, categorieId: art.categorieId, unite: art.unite,
        quantiteInitiale: qte, quantite: qte, prixUnitaire: prix, fraisAccessoires: r2(frais), coutUnitaire: r4(prix + frais / qte),
        dateReception: date, datePeremption: peremption, dateProduction: texte(body.dateProduction, 10),
        fournisseur: texte(body.fournisseur, 160), origine: texte(body.origine, 200), campagne: texte(body.campagne, 40),
        document: texte(body.document, 80),
        qualite: { humidite: body.humidite === '' || body.humidite == null ? null : Number(body.humidite), impuretes: body.impuretes === '' || body.impuretes == null ? null : Number(body.impuretes), observations: texte(body.observationsQualite, 300) },
        statut, creePar: user.identifiant, creeLe: now(), dernierMouvement: now(),
      });
      const mvt = await enregistrerMouvement(ctx, user, {
        type: 'reception', date, tiers: lot.fournisseur, document: lot.document, libelle: texte(body.libelle, 200) || `Réception ${art.designation}`,
        lignes: [ligneLot(lot, qte)],
      });
      await audit(ctx, user, 'Réception de stock', mvt.numero, `${qte} ${art.unite} ${art.designation} – lot ${lot.numero} – coût ${lot.coutUnitaire}`);
      return { lot, mouvement: mvt };
    });
    notifier('lots', 'stock_mouvements');
    return r;
  }

  /* -------------------------------------------------------------- Sortie */
  async function sortie(user, body) {
    exigerAgence();
    const date = exigerDate(body.date);
    const art = await article(body.articleId);
    const qte = quantite(body.quantite);
    const nature = NATURES_SORTIE[body.nature] ? body.nature : 'autre';
    const r = await donnees.tx(async (ctx) => {
      const { lignes, horsFefo, lots } = await allouer(ctx, art._id, qte, date, body.lotId || null);
      if (horsFefo && !texte(body.motifHorsFefo, 200)) throw new ErreurMetier(`Règle FEFO : le lot ${horsFefo} périme plus tôt. Indiquez le motif pour sortir un autre lot.`);
      await retirer(ctx, lots);
      const prixVente = body.prixVente === '' || body.prixVente == null ? null : positif(body.prixVente);
      const mvt = await enregistrerMouvement(ctx, user, {
        type: 'sortie', nature, date, tiers: texte(body.tiers, 160), document: texte(body.document, 80),
        libelle: texte(body.libelle, 200) || `${NATURES_SORTIE[nature]} ${art.designation}`,
        lignes: lignes.map((l) => ({ ...l, quantite: -l.quantite, valeur: -l.valeur })),
        horsFefo: horsFefo ? { lotAttendu: horsFefo, motif: texte(body.motifHorsFefo, 200) } : null,
        prixVente, montantVente: prixVente == null ? null : r2(prixVente * qte),
      });
      await audit(ctx, user, 'Sortie de stock', mvt.numero, `${qte} ${art.unite} ${art.designation} (${NATURES_SORTIE[nature]}) – valeur ${-mvt.valeur}${horsFefo ? ' – hors FEFO' : ''}`);
      return mvt;
    });
    notifier('lots', 'stock_mouvements');
    return r;
  }

  /* ---------------------------------------------------- Statut d'un lot */
  async function changerStatut(user, id, body) {
    const statut = body.statut;
    if (!['disponible', 'quarantaine', 'bloque'].includes(statut)) throw new ErreurMetier('Statut invalide.');
    const motif = texte(body.motif, 250);
    if (!motif) throw new ErreurMetier('Indiquez le motif (contrôle qualité, analyse, traitement…).');
    const r = await donnees.tx(async (ctx) => {
      const lot = await ctx.col('lots').findOne({ _id: id });
      if (!lot) throw new ErreurMetier('Lot introuvable.', 404);
      if (!EN_STOCK.includes(lot.statut)) throw new ErreurMetier(`Un lot « ${STATUTS[lot.statut]} » ne peut pas changer de statut.`);
      const historique = [...(lot.historiqueStatuts || []), { de: lot.statut, a: statut, motif, par: user.identifiant, le: now() }];
      await ctx.col('lots').updateOne({ _id: id }, { $set: { statut, historiqueStatuts: historique } });
      await audit(ctx, user, 'Statut de lot modifié', lot.numero, `${STATUTS[lot.statut]} → ${STATUTS[statut]} : ${motif}`);
      return { ok: true };
    });
    notifier('lots');
    return r;
  }

  /* ------------------------------------------------------------- Pertes */
  async function appliquerPerte(ctx, user, p) {
    const { lignes, lots } = await allouerPerte(ctx, p);
    await retirer(ctx, lots);
    const mvt = await enregistrerMouvement(ctx, user, {
      type: 'perte', motif: p.motif, date: p.date, document: p.justificatif, libelle: `Perte : ${MOTIFS_PERTE[p.motif]} – ${p.designation}`,
      lignes: lignes.map((l) => ({ ...l, quantite: -l.quantite, valeur: -l.valeur })), perteId: p._id || null,
    });
    return mvt;
  }
  async function allouerPerte(ctx, p) {
    if (!p.lotId) return allouer(ctx, p.articleId, p.quantite, p.date, null);
    // Une perte peut concerner un lot bloqué ou en quarantaine.
    const l = await ctx.col('lots').findOne({ _id: p.lotId });
    if (!l || !EN_STOCK.includes(l.statut) || l.dateReception > p.date) throw new ErreurMetier('Ce lot n\'est pas en stock à cette date.');
    if (l.quantite < p.quantite) throw new ErreurMetier(`Quantité insuffisante dans le lot ${l.numero} : ${l.quantite} ${l.unite}.`);
    return { lignes: [ligneLot(l, p.quantite)], lots: [[l, p.quantite]] };
  }
  async function declarerPerte(user, body) {
    exigerAgence();
    const date = exigerDate(body.date);
    const art = await article(body.articleId);
    const motif = MOTIFS_PERTE[body.motif] ? body.motif : null;
    if (!motif) throw new ErreurMetier('Choisissez le motif de la perte.');
    const justificatif = texte(body.justificatif, 200);
    if (!justificatif) throw new ErreurMetier('Indiquez la pièce justificative (PV de constat, rapport, déclaration de vol…).');
    const p = {
      date, articleId: art._id, code: art.code, designation: art.designation, categorieId: art.categorieId, unite: art.unite,
      lotId: body.lotId || null, quantite: quantite(body.quantite), motif, justificatif, observations: texte(body.observations, 500),
    };
    const r = await donnees.tx(async (ctx) => {
      const { lignes } = await allouerPerte(ctx, p); // contrôle et valorisation affichée au valideur
      const doc = await ctx.col('stock_pertes').insertOne({
        numero: await prochainNumero(ctx, 'PRT', date), ...p, valeur: r2(lignes.reduce((s, l) => s + l.valeur, 0)),
        lots: lignes.map((l) => l.lotNumero).join(', '), statut: 'proposee', proposePar: user.identifiant, nomPropose: user.nom, proposeLe: now(),
      });
      await audit(ctx, user, 'Perte de stock déclarée', doc.numero, `${p.quantite} ${art.unite} ${art.designation} – ${MOTIFS_PERTE[motif]} – valeur ${doc.valeur}`);
      if (!peutValider(user)) return doc;
      const mvt = await appliquerPerte(ctx, user, doc);
      const maj = { statut: 'validee', validePar: user.identifiant, nomValide: user.nom, valideLe: now(), mouvementId: mvt._id, mouvementNumero: mvt.numero, valeur: -mvt.valeur };
      await ctx.col('stock_pertes').updateOne({ _id: doc._id }, { $set: maj });
      return { ...doc, ...maj };
    });
    notifier('stock_pertes', 'lots', 'stock_mouvements');
    return r;
  }
  async function deciderPerte(user, id, body) {
    const valider = body.decision === 'valider';
    const r = await donnees.tx(async (ctx) => {
      const p = await ctx.col('stock_pertes').findOne({ _id: id });
      if (!p) throw new ErreurMetier('Déclaration introuvable.', 404);
      if (p.statut !== 'proposee') throw new ErreurMetier('Cette déclaration a déjà été traitée.');
      if (!valider) {
        const motif = texte(body.motif, 250);
        if (!motif) throw new ErreurMetier('Indiquez le motif du rejet.');
        await ctx.col('stock_pertes').updateOne({ _id: id }, { $set: { statut: 'rejetee', motifRejet: motif, validePar: user.identifiant, nomValide: user.nom, valideLe: now() } });
        await audit(ctx, user, 'Perte de stock rejetée', p.numero, motif);
        return { ok: true };
      }
      const mvt = await appliquerPerte(ctx, user, p);
      await ctx.col('stock_pertes').updateOne({ _id: id }, { $set: { statut: 'validee', validePar: user.identifiant, nomValide: user.nom, valideLe: now(), mouvementId: mvt._id, mouvementNumero: mvt.numero, valeur: -mvt.valeur } });
      await audit(ctx, user, 'Perte de stock validée', p.numero, `valeur ${-mvt.valeur} – mouvement ${mvt.numero}`);
      return { ok: true, mouvement: mvt };
    });
    notifier('stock_pertes', 'lots', 'stock_mouvements');
    return r;
  }

  /* ------------------------------------------------ Lots périmés (EF-58) */
  /**
   * Contrôle automatique (plusieurs fois par jour, sur chaque serveur) : les lots dont la date de péremption
   * est atteinte passent au statut « périmé » et leur perte est valorisée. Identifiants déterministes :
   * le contrôle peut tourner en même temps sur le PC et sur le serveur en ligne sans doublon.
   */
  async function detecterPerimes(aujourdhui = jour()) {
    const lots = (await store.col('lots').find({ statut: { $in: EN_STOCK } }))
      .filter((l) => l.quantite > 0 && estPerimeAu(l, aujourdhui));
    for (const l of lots) {
      await store.tx(async (ctx) => {
        const cur = await ctx.col('lots').findOne({ _id: l._id });
        if (!cur || !EN_STOCK.includes(cur.statut) || !(cur.quantite > 0)) return;
        await ctx.col('lots').updateOne({ _id: l._id }, { $set: { statut: 'perime', statutAvantPeremption: cur.statut, perimeLe: now() } });
        if (!(await ctx.col('stock_peremptions').findOne({ _id: `per-${l._id}` }))) {
          const valeur = r2(cur.quantite * cur.coutUnitaire);
          await ctx.col('stock_peremptions').insertOne({
            _id: `per-${l._id}`, agenceId: cur.agenceId, date: cur.datePeremption, constateLe: now(),
            lotId: cur._id, lotNumero: cur.numero, articleId: cur.articleId, code: cur.code, designation: cur.designation, categorieId: cur.categorieId, unite: cur.unite,
            quantite: cur.quantite, coutUnitaire: cur.coutUnitaire, valeurBrute: valeur, recuperation: 0, perteNette: valeur, realisee: false,
          });
        }
      });
    }
    if (lots.length) notifier('lots', 'stock_peremptions');
    return lots.length;
  }
  /** Sortie physique d'un lot périmé : perte « réalisée » (sans double comptage) et valeur de récupération. */
  async function sortirPerime(user, id, body) {
    const date = exigerDate(body.date);
    const mode = MODES_PERIME[body.mode] ? body.mode : 'destruction';
    const recuperation = r2(positif(body.recuperation));
    const r = await donnees.tx(async (ctx) => {
      const lot = await ctx.col('lots').findOne({ _id: id });
      if (!lot) throw new ErreurMetier('Lot introuvable.', 404);
      if (lot.statut !== 'perime' || !(lot.quantite > 0)) throw new ErreurMetier('Seul un lot périmé encore en stock peut être sorti ici.');
      const per = await ctx.col('stock_peremptions').findOne({ _id: `per-${lot._id}` });
      if (per && recuperation > per.valeurBrute) throw new ErreurMetier('La valeur de récupération ne peut pas dépasser la valeur du lot.');
      const l = ligneLot(lot, lot.quantite);
      const mvt = await enregistrerMouvement(ctx, user, {
        type: 'perte', motif: 'peremption', dejaConstatee: true, mode, date, document: texte(body.document, 120),
        libelle: `Lot périmé ${lot.numero} : ${MODES_PERIME[mode]}`, lignes: [{ ...l, quantite: -l.quantite, valeur: -l.valeur }], recuperation,
      });
      await ctx.col('lots').updateOne({ _id: id }, { $set: { quantite: 0, statut: 'sorti', dernierMouvement: now() } });
      if (per) {
        await ctx.col('stock_peremptions').updateOne({ _id: per._id }, { $set: {
          recuperation, perteNette: r2(per.valeurBrute - recuperation), realisee: true, dateRealisation: date, mode, mouvementNumero: mvt.numero,
        } });
      }
      await audit(ctx, user, 'Lot périmé sorti du stock', lot.numero, `${MODES_PERIME[mode]} – récupération ${recuperation} – mouvement ${mvt.numero}`);
      return mvt;
    });
    notifier('lots', 'stock_mouvements', 'stock_peremptions');
    return r;
  }

  /* -------------------------------------------------------- Transferts */
  async function listeTransferts(statut) {
    const a = agenceCourante();
    const f = a ? { $or: [{ agenceId: a }, { destinationId: a }] } : {};
    if (statut) f.statut = statut;
    return store.col('stock_transferts').find(f, { sort: { date: -1, numero: -1 } });
  }
  async function transfert(id) {
    const t = await store.col('stock_transferts').findOne({ _id: id });
    const a = agenceCourante();
    if (!t || (a && t.agenceId !== a && t.destinationId !== a)) throw new ErreurMetier('Transfert introuvable.', 404);
    return t;
  }
  async function creerTransfert(user, body) {
    const a = exigerAgence();
    const date = exigerDate(body.date);
    const dest = await store.col('agences').findOne({ _id: body.destinationId });
    if (!dest || dest.actif === false) throw new ErreurMetier('Agence de destination invalide.');
    if (dest._id === a) throw new ErreurMetier('L\'agence de destination doit être différente de la vôtre.');
    const demandes = (Array.isArray(body.lignes) ? body.lignes : []).filter((l) => l && l.articleId && Number(l.quantite) > 0);
    if (!demandes.length) throw new ErreurMetier('Ajoutez au moins un article à transférer.');
    const origine = await store.col('agences').findOne({ _id: a });
    const r = await donnees.tx(async (ctx) => {
      const lignes = []; const mvtLignes = [];
      for (const d of demandes) {
        await article(d.articleId);
        const { lignes: ls, lots } = await allouer(ctx, d.articleId, quantite(d.quantite), date, null);
        await retirer(ctx, lots);
        for (const [l, p] of lots) {
          lignes.push({
            origineLotId: l._id, lotNumero: l.numero, articleId: l.articleId, code: l.code, designation: l.designation, categorieId: l.categorieId, unite: l.unite,
            quantite: p, coutUnitaire: l.coutUnitaire, valeur: r2(p * l.coutUnitaire), datePeremption: l.datePeremption, dateReception: l.dateReception,
            fournisseur: l.fournisseur, origine: l.origine, campagne: l.campagne, qualite: l.qualite,
          });
        }
        mvtLignes.push(...ls.map((l) => ({ ...l, quantite: -l.quantite, valeur: -l.valeur })));
      }
      const numero = await prochainNumero(ctx, 'TR', date);
      const mvt = await enregistrerMouvement(ctx, user, { type: 'transfert_sortie', date, tiers: dest.nom, document: numero, libelle: `Transfert ${numero} vers ${dest.nom}`, lignes: mvtLignes });
      const t = {
        _id: require('crypto').randomUUID(), numero, date, agenceId: a, agenceNom: origine ? origine.nom : a, destinationId: dest._id, destinationNom: dest.nom,
        lignes, valeur: r2(lignes.reduce((s, l) => s + l.valeur, 0)), statut: 'en_transit', transporteur: texte(body.transporteur, 160), observations: texte(body.observations, 500),
        mouvementSortieId: mvt._id, mouvementSortieNumero: mvt.numero, creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
      };
      await ctx.col('stock_transferts').insertOne(t);
      await audit(ctx, user, 'Transfert de stock expédié', numero, `vers ${dest.nom} – valeur ${t.valeur}`);
      return t;
    });
    notifier('stock_transferts', 'lots', 'stock_mouvements');
    return r;
  }
  async function recevoirTransfert(user, id, body) {
    const a = agenceCourante();
    const t = await transfert(id);
    if (t.statut !== 'en_transit') throw new ErreurMetier('Ce transfert n\'est plus en transit.');
    if (a && a !== t.destinationId) throw new ErreurMetier('Seule l\'agence destinataire peut réceptionner ce transfert.', 403);
    const date = exigerDate(body.date || jour());
    if (date < t.date) throw new ErreurMetier('La date de réception ne peut pas précéder la date d\'expédition.');
    const r = await donnees.tx(async (ctx) => {
      const cur = await ctx.col('stock_transferts').findOne({ _id: id });
      if (!cur || cur.statut !== 'en_transit') throw new ErreurMetier('Ce transfert n\'est plus en transit.');
      const lignes = [];
      for (const l of cur.lignes) {
        const lot = await ctx.col('lots').insertOne({
          agenceId: cur.destinationId, numero: l.lotNumero, articleId: l.articleId, code: l.code, designation: l.designation, categorieId: l.categorieId, unite: l.unite,
          quantiteInitiale: l.quantite, quantite: l.quantite, prixUnitaire: l.coutUnitaire, fraisAccessoires: 0, coutUnitaire: l.coutUnitaire,
          dateReception: date, datePeremption: l.datePeremption, fournisseur: l.fournisseur, origine: l.origine, campagne: l.campagne, qualite: l.qualite || {},
          document: cur.numero, origineLotId: l.origineLotId, transfertId: cur._id, provenance: cur.agenceNom,
          statut: 'disponible', creePar: user.identifiant, creeLe: now(), dernierMouvement: now(),
        });
        lignes.push(ligneLot(lot, l.quantite));
      }
      const mvt = await enregistrerMouvement(ctx, user, { agenceId: cur.destinationId, type: 'transfert_entree', date, tiers: cur.agenceNom, document: cur.numero, libelle: `Réception du transfert ${cur.numero} (${cur.agenceNom})`, lignes });
      await ctx.col('stock_transferts').updateOne({ _id: id }, { $set: { statut: 'recu', dateReception: date, recuPar: user.identifiant, nomRecu: user.nom, mouvementEntreeNumero: mvt.numero } });
      await audit(ctx, user, 'Transfert de stock réceptionné', cur.numero, `de ${cur.agenceNom} – valeur ${cur.valeur}`);
      return { ok: true, mouvement: mvt };
    });
    notifier('stock_transferts', 'lots', 'stock_mouvements');
    return r;
  }
  async function annulerTransfert(user, id, body) {
    const a = agenceCourante();
    const t = await transfert(id);
    if (t.statut !== 'en_transit') throw new ErreurMetier('Seul un transfert encore en transit peut être annulé.');
    if (a && a !== t.agenceId) throw new ErreurMetier('Seule l\'agence expéditrice peut annuler ce transfert.', 403);
    const motif = texte(body.motif, 250);
    if (!motif) throw new ErreurMetier('Indiquez le motif de l\'annulation.');
    const r = await donnees.tx(async (ctx) => {
      const lignes = [];
      for (const l of t.lignes) {
        const lot = await ctx.col('lots').findOne({ _id: l.origineLotId });
        if (!lot) continue;
        const q = q3(lot.quantite + l.quantite);
        await ctx.col('lots').updateOne({ _id: lot._id }, { $set: { quantite: q, statut: lot.statut === 'epuise' ? 'disponible' : lot.statut, dernierMouvement: now() } });
        lignes.push(ligneLot(lot, l.quantite));
      }
      const mvt = await enregistrerMouvement(ctx, user, { agenceId: t.agenceId, type: 'transfert_annule', date: jour(), document: t.numero, libelle: `Annulation du transfert ${t.numero} : ${motif}`, lignes });
      await ctx.col('stock_transferts').updateOne({ _id: id }, { $set: { statut: 'annule', motifAnnulation: motif, annulePar: user.identifiant, annuleLe: now(), mouvementAnnulationNumero: mvt.numero } });
      await audit(ctx, user, 'Transfert de stock annulé', t.numero, motif);
      return { ok: true };
    });
    notifier('stock_transferts', 'lots', 'stock_mouvements');
    return r;
  }

  /* -------------------------------------------------------- Inventaires */
  async function creerInventaire(user, body) {
    exigerAgence();
    const date = exigerDate(body.date || jour());
    const cat = texte(body.categorieId, 60);
    const r = await donnees.tx(async (ctx) => {
      if ((await ctx.col('stock_inventaires').countDocuments({ statut: 'en_cours' }))) throw new ErreurMetier('Un inventaire est déjà en cours dans cette agence : validez-le ou annulez-le d\'abord.');
      const lots = (await ctx.col('lots').find({ statut: { $in: [...EN_STOCK, 'perime'] } }))
        .filter((l) => l.quantite > 0 && (!cat || l.categorieId === cat)).sort((x, y) => x.designation.localeCompare(y.designation) || ordreFefo(x, y));
      if (!lots.length) throw new ErreurMetier('Aucun lot en stock à inventorier.');
      const inv = await ctx.col('stock_inventaires').insertOne({
        numero: await prochainNumero(ctx, 'INV', date), date, categorieId: cat, aveugle: body.aveugle === true || body.aveugle === 'true' || body.aveugle === 'on',
        observations: texte(body.observations, 500), statut: 'en_cours',
        lignes: lots.map((l) => ({ lotId: l._id, lotNumero: l.numero, articleId: l.articleId, code: l.code, designation: l.designation, categorieId: l.categorieId, unite: l.unite, statutLot: l.statut, datePeremption: l.datePeremption, theorique: l.quantite, compte: null, coutUnitaire: l.coutUnitaire })),
        creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
      });
      await audit(ctx, user, 'Inventaire ouvert', inv.numero, `${lots.length} lot(s)`);
      return inv;
    });
    notifier('stock_inventaires');
    return r;
  }
  async function inventaire(id, user) {
    const inv = await donnees.col('stock_inventaires').findOne({ _id: id });
    if (!inv) throw new ErreurMetier('Inventaire introuvable.', 404);
    // Comptage à l'aveugle : les quantités théoriques sont masquées tant que l'inventaire n'est pas validé.
    if (inv.aveugle && inv.statut === 'en_cours' && user && !peutValider(user)) inv.lignes = inv.lignes.map(({ theorique, ...l }) => l); // eslint-disable-line no-unused-vars
    return inv;
  }
  async function saisirComptages(user, id, body) {
    const comptes = body.comptes || {};
    const r = await donnees.tx(async (ctx) => {
      const inv = await ctx.col('stock_inventaires').findOne({ _id: id });
      if (!inv) throw new ErreurMetier('Inventaire introuvable.', 404);
      if (inv.statut !== 'en_cours') throw new ErreurMetier('Cet inventaire est clos.');
      const lignes = inv.lignes.map((l) => {
        if (!(l.lotId in comptes)) return l;
        const v = comptes[l.lotId];
        if (v === '' || v == null) return { ...l, compte: null };
        const x = q3(v);
        if (!Number.isFinite(x) || x < 0) throw new ErreurMetier(`Quantité comptée invalide pour le lot ${l.lotNumero}.`);
        return { ...l, compte: x, comptePar: user.identifiant };
      });
      await ctx.col('stock_inventaires').updateOne({ _id: id }, { $set: { lignes, majLe: now() } });
      return { ok: true, comptes: lignes.filter((l) => l.compte != null).length, total: lignes.length };
    });
    notifier('stock_inventaires');
    return r;
  }
  async function validerInventaire(user, id) {
    const r = await donnees.tx(async (ctx) => {
      const inv = await ctx.col('stock_inventaires').findOne({ _id: id });
      if (!inv) throw new ErreurMetier('Inventaire introuvable.', 404);
      if (inv.statut !== 'en_cours') throw new ErreurMetier('Cet inventaire est déjà clos.');
      const manquants = inv.lignes.filter((l) => l.compte == null).length;
      if (manquants) throw new ErreurMetier(`${manquants} lot(s) n'ont pas encore été comptés.`);
      const lignes = inv.lignes.map((l) => { const e = q3(l.compte - l.theorique); return { ...l, ecart: e, valeurEcart: r2(e * l.coutUnitaire) }; });
      const mvtLignes = [];
      for (const l of lignes.filter((x) => x.ecart !== 0)) {
        const lot = await ctx.col('lots').findOne({ _id: l.lotId });
        if (!lot) continue;
        const q = q3(lot.quantite + l.ecart);
        if (q < 0) throw new ErreurMetier(`Le lot ${lot.numero} a bougé depuis le comptage : recomptez-le.`);
        await ctx.col('lots').updateOne({ _id: lot._id }, { $set: { quantite: q, ...(q === 0 && EN_STOCK.includes(lot.statut) ? { statut: 'epuise' } : {}), dernierMouvement: now() } });
        mvtLignes.push(ligneLot(lot, l.ecart));
      }
      let mvt = null;
      if (mvtLignes.length) mvt = await enregistrerMouvement(ctx, user, { type: 'ajustement', date: inv.date, document: inv.numero, libelle: `Ajustement d'inventaire ${inv.numero}`, lignes: mvtLignes });
      const sansEcart = lignes.filter((l) => l.ecart === 0).length;
      const synthese = {
        lots: lignes.length, sansEcart, exactitude: Math.round((sansEcart / lignes.length) * 1000) / 10,
        valeurTheorique: r2(lignes.reduce((s, l) => s + l.theorique * l.coutUnitaire, 0)),
        valeurComptee: r2(lignes.reduce((s, l) => s + l.compte * l.coutUnitaire, 0)),
        ecartPositif: r2(lignes.filter((l) => l.valeurEcart > 0).reduce((s, l) => s + l.valeurEcart, 0)),
        ecartNegatif: r2(lignes.filter((l) => l.valeurEcart < 0).reduce((s, l) => s + l.valeurEcart, 0)),
      };
      await ctx.col('stock_inventaires').updateOne({ _id: id }, { $set: { lignes, statut: 'valide', synthese, validePar: user.identifiant, nomValide: user.nom, valideLe: now(), mouvementNumero: mvt ? mvt.numero : '' } });
      await audit(ctx, user, 'Inventaire validé', inv.numero, `exactitude ${synthese.exactitude} % – écart net ${r2(synthese.ecartPositif + synthese.ecartNegatif)}`);
      return { ok: true, synthese };
    });
    notifier('stock_inventaires', 'lots', 'stock_mouvements');
    return r;
  }
  async function annulerInventaire(user, id) {
    const inv = await donnees.col('stock_inventaires').findOne({ _id: id });
    if (!inv || inv.statut !== 'en_cours') throw new ErreurMetier('Seul un inventaire en cours peut être abandonné.');
    await donnees.col('stock_inventaires').updateOne({ _id: id }, { $set: { statut: 'abandonne', abandonnePar: user.identifiant, abandonneLe: now() } });
    await audit(donnees, user, 'Inventaire abandonné', inv.numero);
    notifier('stock_inventaires');
    return { ok: true };
  }

  /* -------------------------------------------- Valorisation et analyses */
  async function nomsAgences() {
    return Object.fromEntries((await store.col('agences').find({})).map((g) => [g._id, g.nom]));
  }
  /** Quantité de chaque lot à la fin d'une journée, reconstituée à partir des mouvements (EF-5C). */
  function quantitesAu(mouvements, d) {
    const q = new Map();
    for (const m of mouvements) {
      if (m.date > d) continue;
      for (const l of m.lignes || []) q.set(l.lotId, q3((q.get(l.lotId) || 0) + l.quantite));
    }
    return q;
  }
  function valoriser(lots, qtes, d) {
    const res = new Map(); // clé agence|categorie → { valeur, quantiteLots, sansCout }
    for (const l of lots) {
      const qte = qtes ? (qtes.get(l._id) || 0) : (EN_STOCK.includes(l.statut) ? l.quantite : 0);
      if (!(qte > 0) || (d && estPerimeAu(l, d))) continue;
      const k = `${l.agenceId}|${l.categorieId}`;
      const x = res.get(k) || { agenceId: l.agenceId, categorieId: l.categorieId, valeur: 0, lots: 0, sansCout: 0 };
      x.valeur = r2(x.valeur + qte * l.coutUnitaire); x.lots += 1; if (!l.coutUnitaire) x.sansCout += 1;
      res.set(k, x);
    }
    return [...res.values()];
  }

  /** Rapport « Valeur du stock par agence et par catégorie » à une date (EF-56, EF-57). */
  async function etatValeur(date) {
    const d = exigerDate(date || jour());
    const veille = plusJours(d, -1);
    const [lots, mvts, cats, ags] = await Promise.all([donnees.col('lots').find({}), donnees.col('stock_mouvements').find({ date: { $lte: d } }), categories(), nomsAgences()]);
    const jourJ = valoriser(lots, quantitesAu(mvts, d), d);
    const jourV = valoriser(lots, quantitesAu(mvts, veille), veille);
    const cle = (x) => `${x.agenceId}|${x.categorieId}`;
    const vMap = new Map(jourV.map((x) => [cle(x), x.valeur]));
    const lignes = jourJ.map((x) => ({ ...x, agence: ags[x.agenceId] || x.agenceId, categorie: (cats.find((c) => c._id === x.categorieId) || {}).nom || x.categorieId, veille: vMap.get(cle(x)) || 0 }));
    for (const x of jourV) if (!lignes.some((l) => cle(l) === cle(x))) lignes.push({ ...x, valeur: 0, lots: 0, sansCout: 0, veille: x.valeur, agence: ags[x.agenceId] || x.agenceId, categorie: (cats.find((c) => c._id === x.categorieId) || {}).nom || x.categorieId });
    lignes.sort((a, b) => a.agence.localeCompare(b.agence) || a.categorie.localeCompare(b.categorie));
    const perimesEnStock = r2(lots.filter((l) => l.statut === 'perime' && l.quantite > 0).reduce((s, l) => s + l.quantite * l.coutUnitaire, 0));
    const instantanes = await donnees.col('stock_instantanes').find({ date: d });
    return { date: d, veille, lignes, total: r2(lignes.reduce((s, l) => s + l.valeur, 0)), totalVeille: r2(lignes.reduce((s, l) => s + l.veille, 0)), perimesEnStock, instantane: instantanes.length > 0 };
  }

  /** Rapport quotidien des pertes sur péremption (EF-58, EF-59, EF-5B, structure §7.3). */
  async function etatPertesPeremption(date) {
    const d = exigerDate(date || jour());
    const mois = d.slice(0, 7); const annee = d.slice(0, 4);
    const [pers, cats, ags] = await Promise.all([donnees.col('stock_peremptions').find({ date: { $gte: `${annee}-01-01`, $lte: d } }), categories(), nomsAgences()]);
    const nomCat = (id) => (cats.find((c) => c._id === id) || {}).nom || id;
    const groupes = new Map();
    for (const p of pers) {
      const k = `${p.agenceId}|${p.categorieId}`;
      const g = groupes.get(k) || { agenceId: p.agenceId, agence: ags[p.agenceId] || p.agenceId, categorieId: p.categorieId, categorie: nomCat(p.categorieId), quantite: 0, valeurBrute: 0, recuperation: 0, perteNette: 0, cumulMois: 0, cumulAnnee: 0, veille: 0 };
      if (p.date === d) { g.quantite = q3(g.quantite + p.quantite); g.valeurBrute = r2(g.valeurBrute + p.valeurBrute); g.recuperation = r2(g.recuperation + p.recuperation); g.perteNette = r2(g.perteNette + p.perteNette); }
      if (p.date === plusJours(d, -1)) g.veille = r2(g.veille + p.perteNette);
      if (p.date.startsWith(mois)) g.cumulMois = r2(g.cumulMois + p.perteNette);
      g.cumulAnnee = r2(g.cumulAnnee + p.perteNette);
      groupes.set(k, g);
    }
    const lignes = [...groupes.values()].sort((a, b) => a.agence.localeCompare(b.agence) || a.categorie.localeCompare(b.categorie));
    const somme = (k) => r2(lignes.reduce((s, l) => s + l[k], 0));
    const joursMois = Number(d.slice(8, 10));
    return {
      date: d, lignes, lots: pers.filter((p) => p.date === d).sort((a, b) => a.designation.localeCompare(b.designation)).map((p) => ({ ...p, agence: ags[p.agenceId] || p.agenceId, categorie: nomCat(p.categorieId) })),
      totaux: { quantite: somme('quantite'), valeurBrute: somme('valeurBrute'), recuperation: somme('recuperation'), perteNette: somme('perteNette'), cumulMois: somme('cumulMois'), cumulAnnee: somme('cumulAnnee'), veille: somme('veille') },
      moyenneJourMois: r2(somme('cumulMois') / joursMois),
    };
  }

  /** Péremptions à venir (valeur à risque à 7, 15 et 30 jours, EF-5E) et stock dormant (EF-45). */
  async function etatPeremptions(date, joursDormant = 90) {
    const d = exigerDate(date || jour());
    const [lots, mvts, cats, ags] = await Promise.all([donnees.col('lots').find({ statut: { $in: [...EN_STOCK, 'perime'] } }), donnees.col('stock_mouvements').find({ date: { $gte: plusJours(d, -joursDormant) } }), categories(), nomsAgences()]);
    const nomCat = (id) => (cats.find((c) => c._id === id) || {}).nom || id;
    const enStock = lots.filter((l) => l.quantite > 0);
    const tranches = [[7, 'à 7 jours'], [15, 'de 8 à 15 jours'], [30, 'de 16 à 30 jours']];
    const aRisque = []; const groupes = new Map();
    for (const l of enStock) {
      if (l.statut === 'perime' || !l.datePeremption) continue;
      const jr = Math.round((Date.parse(l.datePeremption) - Date.parse(d)) / 86400000);
      if (jr <= 0 || jr > 30) continue;
      const t = jr <= 7 ? 7 : jr <= 15 ? 15 : 30;
      const v = r2(l.quantite * l.coutUnitaire);
      aRisque.push({ ...l, agence: ags[l.agenceId] || l.agenceId, categorie: nomCat(l.categorieId), joursRestants: jr, tranche: t, valeur: v });
      const k = `${l.agenceId}|${l.categorieId}`;
      const g = groupes.get(k) || { agence: ags[l.agenceId] || l.agenceId, categorie: nomCat(l.categorieId), 7: 0, 15: 0, 30: 0 };
      g[t] = r2(g[t] + v); groupes.set(k, g);
    }
    aRisque.sort((a, b) => a.joursRestants - b.joursRestants);
    const actifs = new Set(); for (const m of mvts) for (const l of m.lignes || []) actifs.add(l.lotId);
    const dormants = enStock.filter((l) => l.statut !== 'perime' && !actifs.has(l._id) && l.dateReception <= plusJours(d, -joursDormant))
      .map((l) => ({ ...l, agence: ags[l.agenceId] || l.agenceId, categorie: nomCat(l.categorieId), valeur: r2(l.quantite * l.coutUnitaire), ancienneteJours: Math.round((Date.parse(d) - Date.parse(l.dateReception)) / 86400000) }));
    const perimes = enStock.filter((l) => l.statut === 'perime').map((l) => ({ ...l, agence: ags[l.agenceId] || l.agenceId, categorie: nomCat(l.categorieId), valeur: r2(l.quantite * l.coutUnitaire) }));
    const tot = (t) => r2(aRisque.filter((x) => x.tranche === t).reduce((s, x) => s + x.valeur, 0));
    return { date: d, tranches: tranches.map(([t, lbl]) => ({ tranche: t, libelle: lbl, valeur: tot(t) })), groupes: [...groupes.values()], lots: aRisque, dormants, perimes, joursDormant };
  }

  /** Pertes par motif, catégorie et agence sur une période (EF-47). */
  async function etatPertes(debut, fin) {
    const [mvts, pers, cats, ags] = await Promise.all([
      donnees.col('stock_mouvements').find({ type: 'perte', date: { $gte: debut, $lte: fin } }),
      donnees.col('stock_peremptions').find({ date: { $gte: debut, $lte: fin } }), categories(), nomsAgences()]);
    const nomCat = (id) => (cats.find((c) => c._id === id) || {}).nom || id;
    const lignes = [];
    for (const m of mvts) {
      if (m.dejaConstatee) continue; // perte sur péremption déjà comptée lors du constat (pas de double comptage)
      for (const l of m.lignes) lignes.push({ date: m.date, numero: m.numero, motif: MOTIFS_PERTE[m.motif] || m.motif, agence: ags[m.agenceId] || m.agenceId, categorie: nomCat(l.categorieId), designation: l.designation, lotNumero: l.lotNumero, quantite: -l.quantite, unite: l.unite, valeur: -l.valeur });
    }
    for (const p of pers) lignes.push({ date: p.date, numero: p.lotNumero, motif: 'Péremption', agence: ags[p.agenceId] || p.agenceId, categorie: nomCat(p.categorieId), designation: p.designation, lotNumero: p.lotNumero, quantite: p.quantite, unite: p.unite, valeur: p.perteNette, recuperation: p.recuperation });
    lignes.sort((a, b) => a.date.localeCompare(b.date));
    const grouper = (k) => Object.entries(lignes.reduce((o, l) => { o[l[k]] = r2((o[l[k]] || 0) + l.valeur); return o; }, {})).map(([nom, valeur]) => ({ nom, valeur })).sort((a, b) => b.valeur - a.valeur);
    return { debut, fin, lignes, parMotif: grouper('motif'), parCategorie: grouper('categorie'), parAgence: grouper('agence'), total: r2(lignes.reduce((s, l) => s + l.valeur, 0)) };
  }

  /** Situation par article (et par agence) : quantités, valeur, seuils, consommation, couverture, réapprovisionnement. */
  async function situation(date) {
    const d = date || jour();
    const depuis = plusJours(d, -90);
    const [lots, sorties, arts, cats, ags] = await Promise.all([
      donnees.col('lots').find({ statut: { $in: [...EN_STOCK, 'perime'] } }),
      donnees.col('stock_mouvements').find({ type: { $in: ['sortie', 'transfert_sortie'] }, date: { $gte: depuis, $lte: d } }),
      articles(), categories(), nomsAgences()]);
    const a = agenceCourante();
    const agencesVues = a ? [a] : [...new Set([...Object.keys(ags)])];
    const lignes = [];
    for (const ag of agencesVues) {
      for (const art of arts) {
        const ls = lots.filter((l) => l.articleId === art._id && l.agenceId === ag && l.quantite > 0);
        const conso = q3(sorties.filter((m) => m.agenceId === ag).reduce((s, m) => s + m.lignes.filter((l) => l.articleId === art._id).reduce((t, l) => t - l.quantite, 0), 0));
        if (!ls.length && !conso && (art.actif === false || !a)) continue;
        const dispo = q3(ls.filter((l) => l.statut === 'disponible').reduce((s, l) => s + l.quantite, 0));
        const bloque = q3(ls.filter((l) => ['bloque', 'quarantaine'].includes(l.statut)).reduce((s, l) => s + l.quantite, 0));
        const perime = q3(ls.filter((l) => l.statut === 'perime').reduce((s, l) => s + l.quantite, 0));
        const valeur = r2(ls.filter((l) => l.statut !== 'perime').reduce((s, l) => s + l.quantite * l.coutUnitaire, 0));
        const { min, max } = seuilsDe(art, ag);
        const consoJour = q3(conso / 90);
        const pointCommande = q3(consoJour * (art.delaiAppro || 0) + min);
        const prochaine = ls.filter((l) => l.statut !== 'perime' && l.datePeremption).sort(ordreFefo)[0];
        lignes.push({
          agenceId: ag, agence: ags[ag] || ag, articleId: art._id, code: art.code, designation: art.designation, unite: art.unite,
          categorie: (cats.find((c) => c._id === art.categorieId) || {}).nom || '', disponible: dispo, bloque, perime, valeur, min, max,
          coutMoyen: dispo + bloque ? r4(valeur / (dispo + bloque)) : 0,
          consoJour, couvertureJours: consoJour ? Math.floor(dispo / consoJour) : null, pointCommande,
          alerte: (min && dispo < min) ? 'rupture' : (dispo <= pointCommande && pointCommande > 0 ? 'commander' : ''),
          aCommander: (min && dispo <= pointCommande) ? q3(Math.max(0, (max || min * 2) - dispo)) : 0,
          prochainePeremption: prochaine ? prochaine.datePeremption : '',
          peremptionProche: prochaine ? Math.round((Date.parse(prochaine.datePeremption) - Date.parse(d)) / 86400000) <= (art.alerteJours || 30) : false,
        });
      }
    }
    return lignes;
  }

  /** Indicateurs du tableau de bord stock. */
  async function tableau() {
    const d = jour();
    const a = agenceCourante();
    const [sit, risque, pertes, aValider, transits, perimesJour] = await Promise.all([
      situation(d), etatPeremptions(d), etatPertesPeremption(d),
      donnees.col('stock_pertes').countDocuments({ statut: 'proposee' }),
      listeTransferts('en_transit'),
      donnees.col('stock_peremptions').find({ date: d }),
    ]);
    return {
      date: d,
      valeur: r2(sit.reduce((s, l) => s + l.valeur, 0)),
      valeurRisque30: r2(risque.tranches.reduce((s, t) => s + t.valeur, 0)),
      tranches: risque.tranches,
      perimesEnStock: r2(risque.perimes.reduce((s, l) => s + l.valeur, 0)), nbPerimes: risque.perimes.length,
      perteJour: pertes.totaux.perteNette, perteMois: pertes.totaux.cumulMois, perteAnnee: pertes.totaux.cumulAnnee, lotsPerimesJour: perimesJour.length,
      ruptures: sit.filter((l) => l.alerte === 'rupture').length, aCommander: sit.filter((l) => l.alerte).length,
      peremptionsProches: risque.lots.length, pertesAValider: aValider,
      transfertsARecevoir: transits.filter((t) => !a || t.destinationId === a).length,
      transfertsEnvoyes: transits.filter((t) => !a || t.agenceId === a).length,
      valeurEnTransit: r2(transits.reduce((s, t) => s + t.valeur, 0)),
      alertes: sit.filter((l) => l.alerte || l.peremptionProche).slice(0, 30),
    };
  }

  /** Instantané quotidien non modifiable (EF-5C), pour chaque agence et chaque journée écoulée. */
  async function enregistrerInstantanes(aujourdhui = jour()) {
    const hier = plusJours(aujourdhui, -1);
    let n = 0;
    for (const ag of await store.col('agences').find({})) {
      const mvts = await store.col('stock_mouvements').find({ agenceId: ag._id, date: { $lte: hier } });
      if (!mvts.length) continue;
      const deja = new Set((await store.col('stock_instantanes').find({ agenceId: ag._id })).map((x) => x.date));
      const premier = mvts.reduce((m, x) => (x.date < m ? x.date : m), hier);
      let d = premier < plusJours(hier, -400) ? plusJours(hier, -400) : premier;
      const lots = await store.col('lots').find({ agenceId: ag._id });
      const pers = await store.col('stock_peremptions').find({ agenceId: ag._id });
      for (; d <= hier; d = plusJours(d, 1)) {
        if (deja.has(d)) continue;
        const v = valoriser(lots, quantitesAu(mvts, d), d);
        await store.col('stock_instantanes').updateOne({ _id: `${ag._id}-${d}` }, { $set: {
          agenceId: ag._id, date: d, valeur: r2(v.reduce((s, x) => s + x.valeur, 0)),
          parCategorie: Object.fromEntries(v.map((x) => [x.categorieId, x.valeur])),
          perteJour: r2(pers.filter((p) => p.date === d).reduce((s, p) => s + p.perteNette, 0)), enregistreLe: now(),
        } }, { upsert: true });
        n += 1;
      }
    }
    return n;
  }
  async function historiqueValeur(debut, fin) {
    const [xs, ags] = await Promise.all([donnees.col('stock_instantanes').find({ date: { $gte: debut, $lte: fin } }), nomsAgences()]);
    return xs.sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ ...x, agence: ags[x.agenceId] || x.agenceId }));
  }

  /* -------------------------------------------------- Consultation */
  async function listeLots(q) {
    const f = {};
    if (q.statut === 'en_stock') f.statut = { $in: EN_STOCK };
    else if (q.statut) f.statut = q.statut;
    if (q.articleId) f.articleId = q.articleId;
    if (q.categorieId) f.categorieId = q.categorieId;
    const [lots, ags] = await Promise.all([donnees.col('lots').find(f), nomsAgences()]);
    return lots.filter((l) => q.statut === 'tous' || q.statut === 'epuise' || q.statut === 'sorti' || l.quantite > 0 || !q.statut)
      .sort(ordreFefo).map((l) => ({ ...l, agence: ags[l.agenceId] || l.agenceId, valeur: r2(l.quantite * l.coutUnitaire) }));
  }
  /** Fiche lot : traçabilité amont (fournisseur, campagne, transfert d'origine) et aval (sorties, clients). */
  async function ficheLot(id) {
    const lot = await donnees.col('lots').findOne({ _id: id });
    if (!lot) throw new ErreurMetier('Lot introuvable.', 404);
    const mvts = (await donnees.col('stock_mouvements').find({})).filter((m) => (m.lignes || []).some((l) => l.lotId === id))
      .map((m) => ({ numero: m.numero, date: m.date, type: m.type, nature: m.nature, motif: m.motif, tiers: m.tiers, document: m.document, libelle: m.libelle, nomCreateur: m.nomCreateur, quantite: q3(m.lignes.filter((l) => l.lotId === id).reduce((s, l) => s + l.quantite, 0)), valeur: r2(m.lignes.filter((l) => l.lotId === id).reduce((s, l) => s + l.valeur, 0)) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.numero.localeCompare(b.numero));
    const peremption = await donnees.col('stock_peremptions').findOne({ _id: `per-${id}` });
    const ags = await nomsAgences();
    return { lot: { ...lot, agence: ags[lot.agenceId] || lot.agenceId }, mouvements: mvts, peremption };
  }
  async function listeMouvements(q) {
    const f = { date: { $gte: q.debut, $lte: q.fin } };
    if (q.type) f.type = q.type;
    const [ms, ags] = await Promise.all([donnees.col('stock_mouvements').find(f, { sort: { date: -1, numero: -1 } }), nomsAgences()]);
    return ms.filter((m) => !q.articleId || m.lignes.some((l) => l.articleId === q.articleId)).map((m) => ({ ...m, agence: ags[m.agenceId] || m.agenceId }));
  }
  async function mouvement(id) {
    const m = await donnees.col('stock_mouvements').findOne({ _id: id });
    if (!m) throw new ErreurMetier('Mouvement introuvable.', 404);
    const ags = await nomsAgences();
    return { ...m, agence: ags[m.agenceId] || m.agenceId };
  }
  async function listePertes(q) {
    const f = {};
    if (q.statut) f.statut = q.statut;
    const [ps, pers, ags] = await Promise.all([donnees.col('stock_pertes').find(f, { sort: { date: -1, numero: -1 } }), donnees.col('stock_peremptions').find({}), nomsAgences()]);
    return {
      declarations: ps.map((p) => ({ ...p, agence: ags[p.agenceId] || p.agenceId, motifLibelle: MOTIFS_PERTE[p.motif] })),
      peremptions: pers.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300).map((p) => ({ ...p, agence: ags[p.agenceId] || p.agenceId })),
    };
  }
  const listeInventaires = () => donnees.col('stock_inventaires').find({}, { sort: { date: -1, numero: -1 } });

  return {
    CATEGORIES_DEFAUT, MOTIFS_PERTE, NATURES_SORTIE, MODES_PERIME, STATUTS,
    initialiser, categories, enregistrerCategorie, articles, enregistrerArticle, definirSeuils,
    reception, sortie, changerStatut, declarerPerte, deciderPerte, detecterPerimes, sortirPerime,
    listeTransferts, transfert, creerTransfert, recevoirTransfert, annulerTransfert,
    creerInventaire, inventaire, saisirComptages, validerInventaire, annulerInventaire, listeInventaires,
    etatValeur, etatPertesPeremption, etatPeremptions, etatPertes, situation, tableau, enregistrerInstantanes, historiqueValeur,
    listeLots, ficheLot, listeMouvements, mouvement, listePertes,
  };
}

module.exports = { createStock, jour, plusJours };
