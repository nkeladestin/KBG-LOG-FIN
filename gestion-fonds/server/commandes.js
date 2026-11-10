'use strict';
/* =====================================================================
   Stock par bons de commande (État-Major Général).
   - Référentiel commun : régions militaires, unités (rattachées à une région), articles, types de bons.
   - Chaque dépôt (agence) enregistre les bons de commande qu'il doit servir : pour chaque unité,
     les quantités par article (mensuelles ou temporaires selon le type de bon).
   - Stock physique commun par dépôt et par article ; pour chaque bon / unité / article :
     commandé, livré, reste à livrer.
   - Toute entrée, livraison, correction ou annulation est un mouvement horodaté et non modifiable
     (le stock est la somme des mouvements) : traçabilité complète, sans conflit entre ordinateurs.
   - Chaque retrait d'une unité produit un bon de livraison, signé sur papier par l'unité.
   ===================================================================== */
const crypto = require('crypto');
const { agenceCourante, CHOISIR } = require('./agences');

const TYPES_DEFAUT = [
  ['ops', 'Opérations', 'mensuel'], ['initial', 'Initial', 'temporaire'], ['complementaire', 'Complémentaire', 'temporaire'],
  ['init-compl', 'Initial et complémentaire', 'temporaire'], ['conditionnes', 'Vivres conditionnés', 'mensuel'],
  ['special', 'Bon spécial', 'temporaire'], ['extra', 'Extra-bon', 'temporaire'],
];
// Articles habituels des bons de vivres (modifiables).
const ARTICLES_DEFAUT = [
  ['Riz', 'Sac 50 kg', 'sac'], ['Farine de maïs', 'Sac 50 kg', 'sac'], ['Farine de manioc', 'Sac 50 kg', 'sac'],
  ['Farine bouillie', 'Sac 50 kg', 'sac'], ['Semoule', 'Sac 25 kg', 'sac'], ['Haricot', 'Sac 100 kg', 'sac'],
  ['Poisson salé', 'Kg', 'kg'], ['Viande', 'Kg', 'kg'], ['Huile végétale', 'Bidon 25 L', 'bidon'], ['Sel', 'Sac 20 kg', 'sac'],
  ['Tomate', 'Carton 100 boîtes', 'carton'], ['Oignon', 'Kg', 'kg'], ['Sucre', 'Sac 50 kg', 'sac'], ['Lait', 'Carton 25 kg', 'carton'],
  ['Pain', 'Pièce', 'pièce'], ['Sardine', 'Carton 50 boîtes', 'carton'], ['Biscuits', 'Carton 120 paquets', 'carton'], ['Eau', 'Box 24 bouteilles', 'box'],
];
const TYPES_MVT = { entree: 'Entrée en stock', livraison: 'Livraison à une unité', ajustement: "Ajustement d'inventaire", annulation: 'Annulation' };

const q3 = (x) => Math.round(Number(x) * 1000) / 1000;
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function createCommandes({ store, donnees, svc, broadcast }) {
  const { ErreurMetier, texte, exigerDate, audit, prochainNumero } = svc;
  const now = () => new Date().toISOString();
  const exigerAgence = () => { const a = agenceCourante(); if (!a) throw new ErreurMetier(CHOISIR); return a; };
  const notifier = (...cols) => cols.forEach((c) => broadcast(c));
  function quantite(v, champ = 'Quantité', zeroOk = false) {
    const x = q3(v);
    if (!Number.isFinite(x) || x < 0 || (!zeroOk && x === 0)) throw new ErreurMetier(`${champ} : nombre ${zeroOk ? 'positif' : 'strictement positif'} attendu.`);
    if (x > 1e9) throw new ErreurMetier(`${champ} trop élevée.`);
    return x;
  }
  const qDe = (o, k) => q3((o && o[k]) || 0);
  const trace = (user) => ({ creePar: user ? user.identifiant : 'système', nomCreateur: user ? user.nom : 'Système', creeLe: now() });

  /* ======================================================= Référentiel */
  async function initialiser() {
    for (const [i, [_id, nom, nature]] of TYPES_DEFAUT.entries()) {
      if (!(await store.col('cmd_types').findOne({ _id }))) await store.col('cmd_types').updateOne({ _id }, { $set: { nom, nature, ordre: i, actif: true, semence: true } }, { upsert: true });
    }
    if (!(await store.col('cmd_articles').countDocuments({}))) {
      for (const [i, [designation, conditionnement, unite]] of ARTICLES_DEFAUT.entries()) {
        await store.col('cmd_articles').updateOne({ _id: `art-${norm(designation).replace(/ /g, '-')}` }, { $set: { designation, conditionnement, unite, prixUnitaire: 0, seuilMin: 0, ordre: i, actif: true, semence: true } }, { upsert: true });
      }
    }
  }
  const tri = (a, b) => (a.ordre ?? 999) - (b.ordre ?? 999) || String(a.designation || a.nom).localeCompare(String(b.designation || b.nom), 'fr');
  const articles = async () => (await store.col('cmd_articles').find({})).sort(tri);
  const regions = async () => (await store.col('cmd_regions').find({})).sort(tri);
  const unites = async () => (await store.col('cmd_unites').find({})).sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'));
  const types = async () => (await store.col('cmd_types').find({})).sort(tri);
  const referentiel = async () => ({ articles: await articles(), regions: await regions(), unites: await unites(), types: await types(), typesMouvement: TYPES_MVT });

  async function enregistrer(col, user, id, doc, libelle, unique) {
    const tous = await store.col(col).find({});
    if (unique && tous.some((x) => x._id !== id && norm(unique(x)) === norm(unique(doc)))) throw new ErreurMetier(`${libelle} « ${unique(doc)} » existe déjà.`);
    if (id) {
      if (!tous.some((x) => x._id === id)) throw new ErreurMetier(`${libelle} introuvable.`, 404);
      await store.col(col).updateOne({ _id: id }, { $set: { ...doc, semence: false, modifieLe: now(), modifiePar: user.identifiant } });
    } else {
      id = crypto.randomUUID();
      await store.col(col).insertOne({ _id: id, ordre: tous.length, ...doc, creeLe: now(), creePar: user.identifiant });
    }
    await audit(donnees, user, `Stock : ${libelle.toLowerCase()} ${doc.actif === false ? 'désactivé(e)' : 'enregistré(e)'}`, doc.designation || doc.nom || '');
    notifier(col);
    return { ok: true, _id: id };
  }
  function enregistrerArticle(user, body, id) {
    const doc = {
      designation: texte(body.designation, 120), conditionnement: texte(body.conditionnement, 60), unite: texte(body.unite, 20) || 'unité',
      prixUnitaire: Math.max(0, r2(body.prixUnitaire || 0)) || 0, seuilMin: Math.max(0, q3(body.seuilMin || 0)) || 0, actif: body.actif !== false,
    };
    if (!doc.designation) throw new ErreurMetier("Désignation de l'article obligatoire.");
    return enregistrer('cmd_articles', user, id, doc, 'Article', (x) => x.designation);
  }
  /**
   * Suppression d'un article : uniquement s'il n'a jamais servi (aucun bon, mouvement ni livraison, tous dépôts).
   * Sinon il est conservé pour la traçabilité et peut être désactivé (il disparaît alors des saisies).
   */
  async function utilisationsArticle(id) {
    const [bons, mvts, lvs] = await Promise.all(['cmd_bons', 'cmd_mouvements', 'cmd_livraisons'].map((c) => store.col(c).find({})));
    return {
      bons: bons.filter((b) => (b.lignes || []).some((l) => l.quantites && l.quantites[id])).length,
      mouvements: mvts.filter((m) => (m.lignes || []).some((l) => l.articleId === id)).length,
      livraisons: lvs.filter((l) => (l.lignes || []).some((x) => x.articleId === id)).length,
    };
  }
  async function supprimerArticle(user, id) {
    const a = await store.col('cmd_articles').findOne({ _id: id });
    if (!a) throw new ErreurMetier('Article introuvable.', 404);
    const u = await utilisationsArticle(id);
    if (u.bons || u.mouvements || u.livraisons) {
      const detail = [u.bons && `${u.bons} bon(s) de commande`, u.mouvements && `${u.mouvements} mouvement(s) de stock`, u.livraisons && `${u.livraisons} livraison(s)`].filter(Boolean).join(', ');
      throw Object.assign(new ErreurMetier(`« ${a.designation} » ne peut pas être supprimé : il figure dans ${detail} (traçabilité). Désactivez-le plutôt : il n'apparaîtra plus dans les nouvelles saisies.`), { code: 'article-utilise' });
    }
    await store.col('cmd_articles').deleteMany({ _id: id });
    await audit(donnees, user, 'Stock : article supprimé', a.designation, a.conditionnement || '');
    notifier('cmd_articles');
    return { ok: true };
  }
  /** Suppression d'un type de bon : uniquement si aucun bon (même annulé) ne l'utilise ; sinon désactivation. */
  async function utilisationsType(id) {
    return { bons: (await store.col('cmd_bons').find({ typeId: id })).length };
  }
  async function supprimerType(user, id) {
    const t = await store.col('cmd_types').findOne({ _id: id });
    if (!t) throw new ErreurMetier('Type de bon introuvable.', 404);
    const u = await utilisationsType(id);
    if (u.bons) throw Object.assign(new ErreurMetier(`Le type « ${t.nom} » ne peut pas être supprimé : ${u.bons} bon(s) de commande l'utilisent (traçabilité). Désactivez-le plutôt : il ne sera plus proposé pour les nouveaux bons.`), { code: 'type-utilise' });
    if ((await store.col('cmd_types').find({})).filter((x) => x._id !== id && x.actif !== false).length === 0) throw new ErreurMetier('Gardez au moins un type de bon actif.');
    await store.col('cmd_types').deleteMany({ _id: id });
    await audit(donnees, user, 'Stock : type de bon supprimé', t.nom);
    notifier('cmd_types');
    return { ok: true };
  }
  function enregistrerRegion(user, body, id) {
    const doc = { nom: texte(body.nom, 120), code: texte(body.code, 30), observations: texte(body.observations, 300), actif: body.actif !== false };
    if (!doc.nom) throw new ErreurMetier('Nom de la région obligatoire.');
    return enregistrer('cmd_regions', user, id, doc, 'Région', (x) => x.nom);
  }
  async function enregistrerUnite(user, body, id) {
    const doc = { nom: texte(body.nom, 120), regionId: texte(body.regionId, 60), effectif: Math.max(0, Math.floor(Number(body.effectif) || 0)), observations: texte(body.observations, 300), actif: body.actif !== false };
    if (!doc.nom) throw new ErreurMetier("Nom de l'unité obligatoire.");
    const region = await store.col('cmd_regions').findOne({ _id: doc.regionId });
    if (!region) throw new ErreurMetier("Choisissez la région de l'unité.");
    // Une même unité peut être déployée dans plusieurs régions : le nom est unique par région.
    const dbl = (await store.col('cmd_unites').find({ regionId: doc.regionId })).find((x) => x._id !== id && norm(x.nom) === norm(doc.nom));
    if (dbl) throw new ErreurMetier(`L'unité « ${doc.nom} » existe déjà dans la région ${region.nom}.`);
    return enregistrer('cmd_unites', user, id, doc, 'Unité', null);
  }
  function enregistrerType(user, body, id) {
    const doc = { nom: texte(body.nom, 80), nature: body.nature === 'mensuel' ? 'mensuel' : 'temporaire', actif: body.actif !== false };
    if (!doc.nom) throw new ErreurMetier('Nom du type de bon obligatoire.');
    return enregistrer('cmd_types', user, id, doc, 'Type de bon', (x) => x.nom);
  }

  /* ================================================= Calculs de stock */
  // Le stock et les livraisons sont recalculés à partir des documents (jamais un compteur modifié sur place).
  async function stockParArticle(ctx) {
    const s = new Map(); // `${agenceId}|${articleId}` → quantité
    for (const m of await ctx.col('cmd_mouvements').find({})) {
      for (const l of m.lignes || []) { const k = `${m.agenceId || ''}|${l.articleId}`; s.set(k, q3((s.get(k) || 0) + Number(l.quantite || 0))); }
    }
    return s;
  }
  async function livreParBon(ctx, filtre = {}) {
    const r = new Map(); // bonId → uniteId → articleId → quantité
    for (const lv of await ctx.col('cmd_livraisons').find(filtre)) {
      if (lv.statut === 'annule') continue;
      if (!r.has(lv.bonId)) r.set(lv.bonId, new Map());
      const u = r.get(lv.bonId);
      if (!u.has(lv.uniteId)) u.set(lv.uniteId, {});
      const o = u.get(lv.uniteId);
      for (const l of lv.lignes) o[l.articleId] = q3((o[l.articleId] || 0) + l.quantite);
    }
    return r;
  }
  /** Commandé / livré / reste par unité et par article pour un bon. */
  function etatBon(bon, livres) {
    const parUnite = (livres && livres.get(bon._id)) || new Map();
    const actif = bon.statut === 'en_cours';
    const lignes = bon.lignes.map((l) => {
      const livre = parUnite.get(l.uniteId) || {};
      const articlesL = {};
      for (const [a, c] of Object.entries(l.quantites || {})) {
        const lv = qDe(livre, a);
        articlesL[a] = { commande: q3(c), livre: lv, reste: actif ? Math.max(0, q3(c - lv)) : 0 };
      }
      for (const [a, lv] of Object.entries(livre)) if (!articlesL[a]) articlesL[a] = { commande: 0, livre: lv, reste: 0 };
      return { ...l, articles: articlesL };
    });
    const totaux = {};
    for (const l of lignes) for (const [a, v] of Object.entries(l.articles)) {
      const t = totaux[a] || (totaux[a] = { commande: 0, livre: 0, reste: 0 });
      t.commande = q3(t.commande + v.commande); t.livre = q3(t.livre + v.livre); t.reste = q3(t.reste + v.reste);
    }
    const tc = Object.values(totaux).reduce((s, t) => s + t.commande, 0);
    const tl = Object.values(totaux).reduce((s, t) => s + t.livre, 0);
    const resteTotal = q3(Object.values(totaux).reduce((s, t) => s + t.reste, 0));
    const etat = bon.statut === 'annule' ? 'annule' : bon.statut === 'cloture' ? 'cloture' : resteTotal <= 0 ? 'livre' : tl > 0 ? 'partiel' : 'a_livrer';
    return { lignes, totaux, avancement: tc ? Math.round((tl / tc) * 1000) / 10 : 0, etat, resteTotal };
  }

  /* ===================================================== Bons de commande */
  async function lireLignes(body, artIds) {
    const brutes = Array.isArray(body.lignes) ? body.lignes : [];
    const lignes = [];
    const vues = new Set();
    for (const l of brutes) {
      const u = await store.col('cmd_unites').findOne({ _id: texte(l.uniteId, 60) });
      if (!u) throw new ErreurMetier('Unité inconnue dans le bon : rechargez la page.');
      if (vues.has(u._id)) throw new ErreurMetier(`L'unité ${u.nom} figure deux fois dans le bon.`);
      vues.add(u._id);
      const quantites = {};
      for (const [a, v] of Object.entries(l.quantites || {})) {
        if (v === '' || v == null || Number(v) === 0) continue;
        if (!artIds.has(a)) throw new ErreurMetier('Article inconnu dans le bon : rechargez la page.');
        quantites[a] = quantite(v, `Quantité (${u.nom})`, true);
      }
      lignes.push({ uniteId: u._id, uniteNom: u.nom, regionId: u.regionId, effectif: Math.max(0, Math.floor(Number(l.effectif ?? u.effectif) || 0)), quantites });
    }
    if (!lignes.length) throw new ErreurMetier('Ajoutez au moins une unité au bon de commande.');
    if (!lignes.some((l) => Object.keys(l.quantites).length)) throw new ErreurMetier('Le bon ne contient aucune quantité.');
    return lignes;
  }
  async function lireEntete(body, typeActuel) {
    const type = await store.col('cmd_types').findOne({ _id: texte(body.typeId, 60) });
    if (!type) throw new ErreurMetier('Choisissez le type de bon.');
    if (type.actif === false && type._id !== typeActuel) throw new ErreurMetier(`Le type « ${type.nom} » est désactivé : choisissez un autre type de bon.`);
    const region = await store.col('cmd_regions').findOne({ _id: texte(body.regionId, 60) });
    if (!region) throw new ErreurMetier('Choisissez la région militaire.');
    const e = {
      reference: texte(body.reference, 120), typeId: type._id, typeNom: type.nom, nature: type.nature, regionId: region._id, regionNom: region.nom,
      edition: texte(body.edition, 60), dateBon: exigerDate(body.dateBon, 'date du bon'), dateReception: body.dateReception ? exigerDate(body.dateReception, 'date de réception') : '',
      dateDebut: body.dateDebut ? exigerDate(body.dateDebut, 'début de période') : '', dateFin: body.dateFin ? exigerDate(body.dateFin, 'fin de période') : '',
      autonomie: Math.max(0, Math.floor(Number(body.autonomie) || 0)), observations: texte(body.observations, 1000),
    };
    if (!e.reference) throw new ErreurMetier("Indiquez la référence du bon (n° de l'État-Major Général).");
    if (!e.edition) throw new ErreurMetier('Indiquez l\'édition (ex. Mai 2026).');
    if (e.dateDebut && e.dateFin && e.dateFin < e.dateDebut) throw new ErreurMetier('La fin de période doit suivre le début.');
    return e;
  }
  const resumeLignes = (lignes) => `${lignes.length} unité(s), ${q3(lignes.reduce((s, l) => s + Object.values(l.quantites).reduce((x, y) => x + y, 0), 0))} unité(s) d'articles`;

  async function creerBon(user, body) {
    exigerAgence();
    const e = await lireEntete(body);
    const artIds = new Set((await articles()).map((a) => a._id));
    const lignes = await lireLignes(body, artIds);
    const r = await donnees.tx(async (ctx) => {
      const dbl = (await ctx.col('cmd_bons').find({})).find((b) => b.statut !== 'annule' && norm(b.reference) === norm(e.reference));
      if (dbl) throw new ErreurMetier(`Ce bon (${e.reference}) est déjà enregistré sous le n° ${dbl.numero}.`);
      const t = trace(user);
      const bon = await ctx.col('cmd_bons').insertOne({
        numero: await prochainNumero(ctx, 'BC', e.dateBon), ...e, lignes, statut: 'en_cours', ...t,
        historique: [{ quand: t.creeLe, par: user.identifiant, nom: user.nom, action: 'Création', details: resumeLignes(lignes) }],
      });
      await audit(ctx, user, 'Stock : bon de commande enregistré', bon.numero, `${e.reference} – ${e.typeNom} – ${e.regionNom} – ${e.edition} – ${resumeLignes(lignes)}`);
      return bon;
    });
    notifier('cmd_bons');
    return r;
  }

  async function modifierBon(user, id, body) {
    exigerAgence();
    const e = await lireEntete(body, ((await donnees.col('cmd_bons').findOne({ _id: id })) || {}).typeId);
    const artIds = new Set((await articles()).map((a) => a._id));
    const lignes = await lireLignes(body, artIds);
    const r = await donnees.tx(async (ctx) => {
      const bon = await ctx.col('cmd_bons').findOne({ _id: id });
      if (!bon) throw new ErreurMetier('Bon de commande introuvable.', 404);
      if (bon.statut === 'annule') throw new ErreurMetier('Ce bon est annulé.');
      const dbl = (await ctx.col('cmd_bons').find({})).find((b) => b._id !== id && b.statut !== 'annule' && norm(b.reference) === norm(e.reference));
      if (dbl) throw new ErreurMetier(`Cette référence est déjà utilisée par le bon ${dbl.numero}.`);
      const livres = (await livreParBon(ctx, { bonId: id })).get(id) || new Map();
      // On ne peut pas descendre sous ce qui a déjà été livré.
      for (const [uid, arts] of livres) {
        const l = lignes.find((x) => x.uniteId === uid);
        for (const [a, q] of Object.entries(arts)) {
          if (q > 0 && (!l || qDe(l.quantites, a) < q)) {
            const nomU = (l || bon.lignes.find((x) => x.uniteId === uid) || {}).uniteNom || 'une unité';
            const art = await store.col('cmd_articles').findOne({ _id: a });
            throw new ErreurMetier(`${nomU} a déjà reçu ${q} ${art ? art.designation : ''} : la quantité commandée ne peut pas être inférieure.`);
          }
        }
      }
      const changements = [];
      for (const k of ['reference', 'typeNom', 'regionNom', 'edition', 'dateBon', 'dateReception', 'dateDebut', 'dateFin', 'autonomie', 'observations']) {
        if (String(bon[k] ?? '') !== String(e[k] ?? '')) changements.push(`${k} : « ${bon[k] ?? ''} » → « ${e[k] ?? ''} »`);
      }
      const avant = new Map(bon.lignes.map((l) => [l.uniteId, l]));
      for (const l of lignes) {
        const a = avant.get(l.uniteId);
        if (!a) { changements.push(`+ ${l.uniteNom}`); continue; }
        for (const k of new Set([...Object.keys(a.quantites), ...Object.keys(l.quantites)])) {
          if (qDe(a.quantites, k) !== qDe(l.quantites, k)) {
            const art = await store.col('cmd_articles').findOne({ _id: k });
            changements.push(`${l.uniteNom} / ${art ? art.designation : k} : ${qDe(a.quantites, k)} → ${qDe(l.quantites, k)}`);
          }
        }
        avant.delete(l.uniteId);
      }
      for (const a of avant.values()) changements.push(`– ${a.uniteNom}`);
      if (!changements.length) return bon;
      const h = { quand: now(), par: user.identifiant, nom: user.nom, action: 'Modification', details: changements.join(' ; ').slice(0, 3000) };
      await ctx.col('cmd_bons').updateOne({ _id: id }, { $set: { ...e, lignes, modifieLe: h.quand, modifiePar: user.identifiant, historique: [...(bon.historique || []), h] } });
      await audit(ctx, user, 'Stock : bon de commande modifié', bon.numero, h.details);
      return ctx.col('cmd_bons').findOne({ _id: id });
    });
    notifier('cmd_bons');
    return r;
  }

  async function changerStatutBon(user, id, body) {
    exigerAgence();
    const action = body.action;
    const motif = texte(body.motif, 300);
    const r = await donnees.tx(async (ctx) => {
      const bon = await ctx.col('cmd_bons').findOne({ _id: id });
      if (!bon) throw new ErreurMetier('Bon de commande introuvable.', 404);
      let statut; let libelle;
      if (action === 'cloturer') {
        if (bon.statut !== 'en_cours') throw new ErreurMetier('Seul un bon en cours peut être clôturé.');
        if (!motif) throw new ErreurMetier('Indiquez le motif de la clôture (le reste ne sera plus livré).');
        statut = 'cloture'; libelle = 'Clôture (reste non livré abandonné)';
      } else if (action === 'rouvrir') {
        if (bon.statut !== 'cloture') throw new ErreurMetier('Seul un bon clôturé peut être rouvert.');
        statut = 'en_cours'; libelle = 'Réouverture';
      } else if (action === 'annuler') {
        if (bon.statut === 'annule') throw new ErreurMetier('Ce bon est déjà annulé.');
        if (!motif) throw new ErreurMetier("Indiquez le motif de l'annulation.");
        const lv = (await ctx.col('cmd_livraisons').find({ bonId: id })).filter((x) => x.statut !== 'annule');
        if (lv.length) throw new ErreurMetier(`Impossible : ${lv.length} livraison(s) déjà faite(s) sur ce bon. Annulez-les d'abord ou clôturez le bon.`);
        statut = 'annule'; libelle = 'Annulation';
      } else throw new ErreurMetier('Action inconnue.');
      const h = { quand: now(), par: user.identifiant, nom: user.nom, action: libelle, details: motif };
      await ctx.col('cmd_bons').updateOne({ _id: id }, { $set: { statut, historique: [...(bon.historique || []), h] } });
      await audit(ctx, user, `Stock : bon de commande – ${libelle.toLowerCase()}`, bon.numero, motif);
      return { ok: true };
    });
    notifier('cmd_bons');
    return r;
  }

  async function listeBons(f = {}) {
    const livres = await livreParBon(donnees);
    const tous = await donnees.col('cmd_bons').find({}, { sort: { dateBon: -1 } });
    return tous.filter((b) => (!f.regionId || b.regionId === f.regionId) && (!f.typeId || b.typeId === f.typeId)
      && (!f.debut || b.dateBon >= f.debut) && (!f.fin || b.dateBon <= f.fin))
      .map((b) => { const e = etatBon(b, livres); const { lignes, ...entete } = b; return { ...entete, nbUnites: lignes.length, etat: e.etat, avancement: e.avancement, totaux: e.totaux }; })
      .filter((b) => !f.etat || (f.etat === 'ouverts' ? ['a_livrer', 'partiel'].includes(b.etat) : b.etat === f.etat))
      .sort((a, b) => b.dateBon.localeCompare(a.dateBon) || b.numero.localeCompare(a.numero));
  }
  async function bon(id) {
    const b = await donnees.col('cmd_bons').findOne({ _id: id });
    if (!b) throw new ErreurMetier('Bon de commande introuvable.', 404);
    const livres = await livreParBon(donnees, { bonId: id });
    const livraisons = (await donnees.col('cmd_livraisons').find({ bonId: id })).sort((a, c) => c.creeLe.localeCompare(a.creeLe));
    return { ...b, ...etatBon(b, livres), livraisons };
  }

  /* ======================================================= Livraisons */
  /** Ce qu'une unité peut retirer sur un bon : reste à livrer et stock du dépôt. */
  async function preparerLivraison(bonId, uniteId) {
    exigerAgence();
    const b = await bon(bonId);
    const l = b.lignes.find((x) => x.uniteId === uniteId);
    if (!l) throw new ErreurMetier("Cette unité ne figure pas sur le bon.");
    const stock = await stockParArticle(donnees);
    const arts = await articles();
    return {
      bon: { _id: b._id, numero: b.numero, reference: b.reference, typeNom: b.typeNom, edition: b.edition, regionNom: b.regionNom, etat: b.etat },
      unite: { _id: l.uniteId, nom: l.uniteNom, effectif: l.effectif },
      lignes: arts.filter((a) => l.articles[a._id]).map((a) => ({
        articleId: a._id, designation: a.designation, conditionnement: a.conditionnement, unite: a.unite,
        ...l.articles[a._id], stock: stock.get(`${b.agenceId || ''}|${a._id}`) || 0,
      })),
    };
  }

  async function livrer(user, body) {
    const ag = exigerAgence();
    const date = exigerDate(body.date);
    const demandes = (Array.isArray(body.lignes) ? body.lignes : []).filter((x) => x && x.articleId && Number(x.quantite) > 0);
    if (!demandes.length) throw new ErreurMetier('Indiquez au moins une quantité à livrer.');
    const arts = new Map((await articles()).map((a) => [a._id, a]));
    const r = await donnees.tx(async (ctx) => {
      const b = await ctx.col('cmd_bons').findOne({ _id: texte(body.bonId, 60) });
      if (!b) throw new ErreurMetier('Bon de commande introuvable.', 404);
      if (b.statut !== 'en_cours') throw new ErreurMetier(`Ce bon est ${b.statut === 'annule' ? 'annulé' : 'clôturé'} : plus aucune livraison possible.`);
      const ligne = b.lignes.find((x) => x.uniteId === body.uniteId);
      if (!ligne) throw new ErreurMetier("Cette unité ne figure pas sur le bon.");
      const livre = ((await livreParBon(ctx, { bonId: b._id })).get(b._id) || new Map()).get(ligne.uniteId) || {};
      const stock = await stockParArticle(ctx);
      const lignes = [];
      for (const d of demandes) {
        const a = arts.get(d.articleId);
        if (!a) throw new ErreurMetier('Article inconnu : rechargez la page.');
        const q = quantite(d.quantite, a.designation);
        const reste = q3(qDe(ligne.quantites, a._id) - qDe(livre, a._id));
        if (q > reste) throw new ErreurMetier(`${a.designation} : ${q} demandé(s), mais il ne reste que ${Math.max(0, reste)} ${a.unite} à livrer à ${ligne.uniteNom} sur ce bon.`);
        const dispo = stock.get(`${ag}|${a._id}`) || 0;
        if (q > dispo) throw new ErreurMetier(`${a.designation} : stock insuffisant au dépôt (${Math.max(0, dispo)} ${a.unite} disponible(s)).`);
        lignes.push({ articleId: a._id, designation: a.designation, conditionnement: a.conditionnement, unite: a.unite, quantite: q });
      }
      const t = trace(user);
      const numero = await prochainNumero(ctx, 'BL', date);
      const lvId = crypto.randomUUID();
      const commun = { bonId: b._id, bonNumero: b.numero, bonReference: b.reference, typeNom: b.typeNom, edition: b.edition, regionId: b.regionId, regionNom: b.regionNom, uniteId: ligne.uniteId, uniteNom: ligne.uniteNom };
      const mvt = await ctx.col('cmd_mouvements').insertOne({
        numero: await prochainNumero(ctx, 'MV', date), type: 'livraison', date, ...commun, livraisonId: lvId, livraisonNumero: numero,
        lignes: lignes.map((l) => ({ ...l, quantite: -l.quantite })), libelle: `Livraison ${numero} – ${ligne.uniteNom}`, ...t,
      });
      const lv = await ctx.col('cmd_livraisons').insertOne({
        _id: lvId, numero, date, ...commun, effectif: ligne.effectif, lignes,
        receptionnaire: texte(body.receptionnaire, 160), vehicule: texte(body.vehicule, 120), observations: texte(body.observations, 500),
        statut: 'a_signer', mouvementId: mvt._id, mouvementNumero: mvt.numero, ...t,
      });
      await audit(ctx, user, 'Stock : livraison à une unité', numero, `${ligne.uniteNom} – bon ${b.reference} (${b.numero}) – ${lignes.map((l) => `${l.quantite} ${l.designation}`).join(', ')}`);
      return lv;
    });
    notifier('cmd_livraisons', 'cmd_mouvements');
    return r;
  }

  async function signerLivraison(user, id, body) {
    exigerAgence();
    const nom = texte(body.nom, 160);
    if (!nom) throw new ErreurMetier("Indiquez le nom de la personne qui a signé pour l'unité.");
    const date = exigerDate(body.date || new Date().toISOString().slice(0, 10), 'date de signature');
    const r = await donnees.tx(async (ctx) => {
      const lv = await ctx.col('cmd_livraisons').findOne({ _id: id });
      if (!lv) throw new ErreurMetier('Bon de livraison introuvable.', 404);
      if (lv.statut !== 'a_signer') throw new ErreurMetier(lv.statut === 'signe' ? 'Ce bon de livraison est déjà signé.' : 'Ce bon de livraison est annulé.');
      const signature = { nom, grade: texte(body.grade, 60), fonction: texte(body.fonction, 80), date, enregistrePar: user.identifiant, nomEnregistreur: user.nom, le: now() };
      await ctx.col('cmd_livraisons').updateOne({ _id: id }, { $set: { statut: 'signe', signature } });
      await audit(ctx, user, 'Stock : bon de livraison signé par l\'unité', lv.numero, `${lv.uniteNom} – signé par ${[signature.grade, nom].filter(Boolean).join(' ')} le ${date}`);
      return { ok: true };
    });
    notifier('cmd_livraisons');
    return r;
  }

  async function annulerLivraison(user, id, body) {
    exigerAgence();
    const motif = texte(body.motif, 300);
    if (!motif) throw new ErreurMetier("Indiquez le motif de l'annulation (ex. marchandises retournées par l'unité).");
    const r = await donnees.tx(async (ctx) => {
      const lv = await ctx.col('cmd_livraisons').findOne({ _id: id });
      if (!lv) throw new ErreurMetier('Bon de livraison introuvable.', 404);
      if (lv.statut === 'annule') throw new ErreurMetier('Ce bon de livraison est déjà annulé.');
      const date = new Date().toISOString().slice(0, 10);
      const t = trace(user);
      const mvt = await ctx.col('cmd_mouvements').insertOne({
        numero: await prochainNumero(ctx, 'MV', date), type: 'annulation', date, bonId: lv.bonId, bonNumero: lv.bonNumero, bonReference: lv.bonReference, typeNom: lv.typeNom,
        edition: lv.edition, regionId: lv.regionId, regionNom: lv.regionNom, uniteId: lv.uniteId, uniteNom: lv.uniteNom, livraisonId: lv._id, livraisonNumero: lv.numero,
        annuleMouvementId: lv.mouvementId, annuleMouvementNumero: lv.mouvementNumero, lignes: lv.lignes.map((l) => ({ ...l })), motif,
        libelle: `Annulation de la livraison ${lv.numero} – retour en stock`, ...t,
      });
      await ctx.col('cmd_livraisons').updateOne({ _id: id }, { $set: { statut: 'annule', annulation: { motif, par: user.identifiant, nom: user.nom, le: t.creeLe, mouvementNumero: mvt.numero, etaitSigne: lv.statut === 'signe' } } });
      await audit(ctx, user, 'Stock : livraison annulée (retour en stock)', lv.numero, `${lv.uniteNom} – ${motif}`);
      return { ok: true, mouvement: mvt };
    });
    notifier('cmd_livraisons', 'cmd_mouvements');
    return r;
  }

  async function listeLivraisons(f = {}) {
    const tous = await donnees.col('cmd_livraisons').find({});
    return tous.filter((l) => (!f.debut || l.date >= f.debut) && (!f.fin || l.date <= f.fin) && (!f.statut || l.statut === f.statut)
      && (!f.uniteId || l.uniteId === f.uniteId) && (!f.bonId || l.bonId === f.bonId) && (!f.regionId || l.regionId === f.regionId))
      .sort((a, b) => b.date.localeCompare(a.date) || b.numero.localeCompare(a.numero));
  }
  async function livraison(id) {
    const lv = await donnees.col('cmd_livraisons').findOne({ _id: id });
    if (!lv) throw new ErreurMetier('Bon de livraison introuvable.', 404);
    return lv;
  }

  /* ============================================ Entrées et ajustements */
  async function entree(user, body) {
    exigerAgence();
    const date = exigerDate(body.date);
    const arts = new Map((await articles()).map((a) => [a._id, a]));
    const demandes = (Array.isArray(body.lignes) ? body.lignes : []).filter((x) => x && x.articleId && Number(x.quantite) > 0);
    if (!demandes.length) throw new ErreurMetier('Indiquez au moins un article et sa quantité.');
    const lignes = demandes.map((d) => {
      const a = arts.get(d.articleId);
      if (!a) throw new ErreurMetier('Article inconnu : rechargez la page.');
      const prix = d.prixUnitaire === '' || d.prixUnitaire == null ? null : Math.max(0, r2(d.prixUnitaire));
      const q = quantite(d.quantite, a.designation);
      return { articleId: a._id, designation: a.designation, conditionnement: a.conditionnement, unite: a.unite, quantite: q, prixUnitaire: prix, montant: prix == null ? null : r2(prix * q) };
    });
    const r = await donnees.tx(async (ctx) => {
      let b = null;
      if (body.bonId) {
        b = await ctx.col('cmd_bons').findOne({ _id: texte(body.bonId, 60) });
        if (!b) throw new ErreurMetier('Bon de commande introuvable.');
      }
      const mvt = await ctx.col('cmd_mouvements').insertOne({
        numero: await prochainNumero(ctx, 'MV', date), type: 'entree', date, fournisseur: texte(body.fournisseur, 160), document: texte(body.document, 80),
        ...(b ? { bonId: b._id, bonNumero: b.numero, bonReference: b.reference, typeNom: b.typeNom, edition: b.edition, regionId: b.regionId, regionNom: b.regionNom } : {}),
        lignes, montant: lignes.some((l) => l.montant != null) ? r2(lignes.reduce((s, l) => s + (l.montant || 0), 0)) : null,
        libelle: texte(body.libelle, 200) || `Entrée en stock${b ? ` pour le bon ${b.reference}` : ''}`, observations: texte(body.observations, 500), ...trace(user),
      });
      await audit(ctx, user, 'Stock : entrée en stock', mvt.numero, `${lignes.map((l) => `${l.quantite} ${l.designation}`).join(', ')}${mvt.fournisseur ? ` – ${mvt.fournisseur}` : ''}`);
      return mvt;
    });
    notifier('cmd_mouvements');
    return r;
  }

  async function annulerEntree(user, id, body) {
    const ag = exigerAgence();
    const motif = texte(body.motif, 300);
    if (!motif) throw new ErreurMetier("Indiquez le motif de l'annulation.");
    const r = await donnees.tx(async (ctx) => {
      const m = await ctx.col('cmd_mouvements').findOne({ _id: id });
      if (!m) throw new ErreurMetier('Mouvement introuvable.', 404);
      if (m.type !== 'entree' && m.type !== 'ajustement') throw new ErreurMetier("Une livraison s'annule depuis son bon de livraison.");
      if (m.annulePar) throw new ErreurMetier(`Ce mouvement est déjà annulé (${m.annulePar}).`);
      const stock = await stockParArticle(ctx);
      for (const l of m.lignes) {
        if (l.quantite > 0 && (stock.get(`${ag}|${l.articleId}`) || 0) < l.quantite) throw new ErreurMetier(`Annulation impossible : ${l.designation} déjà en partie livré (stock actuel ${stock.get(`${ag}|${l.articleId}`) || 0}).`);
      }
      const date = new Date().toISOString().slice(0, 10);
      const inv = await ctx.col('cmd_mouvements').insertOne({
        numero: await prochainNumero(ctx, 'MV', date), type: 'annulation', date, annuleMouvementId: m._id, annuleMouvementNumero: m.numero,
        lignes: m.lignes.map((l) => ({ articleId: l.articleId, designation: l.designation, conditionnement: l.conditionnement, unite: l.unite, quantite: -l.quantite })),
        motif, libelle: `Annulation de ${m.numero} (${TYPES_MVT[m.type].toLowerCase()})`, ...trace(user),
      });
      await ctx.col('cmd_mouvements').updateOne({ _id: id }, { $set: { annulePar: inv.numero, annuleLe: inv.creeLe, motifAnnulation: motif } });
      await audit(ctx, user, 'Stock : mouvement annulé', m.numero, motif);
      return inv;
    });
    notifier('cmd_mouvements');
    return r;
  }

  /** Inventaire : le stock compté remplace le stock théorique ; l'écart devient un ajustement tracé. */
  async function ajuster(user, body) {
    const ag = exigerAgence();
    const date = exigerDate(body.date);
    const motif = texte(body.motif, 300);
    if (!motif) throw new ErreurMetier("Indiquez le motif de l'ajustement (inventaire du …, casse, avarie…).");
    const arts = new Map((await articles()).map((a) => [a._id, a]));
    const comptes = (Array.isArray(body.lignes) ? body.lignes : []).filter((x) => x && x.articleId && x.compte !== '' && x.compte != null);
    if (!comptes.length) throw new ErreurMetier('Saisissez au moins une quantité comptée.');
    const r = await donnees.tx(async (ctx) => {
      const stock = await stockParArticle(ctx);
      const lignes = [];
      for (const c of comptes) {
        const a = arts.get(c.articleId);
        if (!a) throw new ErreurMetier('Article inconnu : rechargez la page.');
        const compte = quantite(c.compte, a.designation, true);
        const theorique = stock.get(`${ag}|${a._id}`) || 0;
        const ecart = q3(compte - theorique);
        if (ecart) lignes.push({ articleId: a._id, designation: a.designation, conditionnement: a.conditionnement, unite: a.unite, quantite: ecart, theorique, compte });
      }
      if (!lignes.length) throw new ErreurMetier('Aucun écart : le stock compté est identique au stock enregistré.');
      const mvt = await ctx.col('cmd_mouvements').insertOne({
        numero: await prochainNumero(ctx, 'MV', date), type: 'ajustement', date, lignes, motif, libelle: `Ajustement d'inventaire – ${motif}`, ...trace(user),
      });
      await audit(ctx, user, "Stock : ajustement d'inventaire", mvt.numero, `${motif} – ${lignes.map((l) => `${l.designation} ${l.quantite > 0 ? '+' : ''}${l.quantite}`).join(', ')}`);
      return mvt;
    });
    notifier('cmd_mouvements');
    return r;
  }

  /* ===================================================== Consultations */
  async function listeMouvements(f = {}) {
    const tous = await donnees.col('cmd_mouvements').find({});
    let liste = tous.filter((m) => (!f.type || m.type === f.type) && (!f.uniteId || m.uniteId === f.uniteId) && (!f.bonId || m.bonId === f.bonId)
      && (!f.regionId || m.regionId === f.regionId) && (!f.utilisateur || m.creePar === f.utilisateur)
      && (!f.articleId || (m.lignes || []).some((l) => l.articleId === f.articleId)));
    liste.sort((a, b) => a.date.localeCompare(b.date) || a.creeLe.localeCompare(b.creeLe));
    // Fiche de stock d'un article : solde avant la période puis solde après chaque mouvement.
    let soldeInitial = null;
    if (f.articleId) {
      const solde = new Map();
      const q = (m) => q3((m.lignes || []).filter((l) => l.articleId === f.articleId).reduce((s, l) => s + l.quantite, 0));
      soldeInitial = 0;
      liste = liste.map((m) => {
        const k = m.agenceId || '';
        const s = q3((solde.get(k) || 0) + q(m));
        solde.set(k, s);
        return { ...m, quantiteArticle: q(m), solde: s };
      });
      if (f.debut) soldeInitial = q3(liste.filter((m) => m.date < f.debut).reduce((s, m) => s + m.quantiteArticle, 0));
    }
    liste = liste.filter((m) => (!f.debut || m.date >= f.debut) && (!f.fin || m.date <= f.fin)).reverse();
    return { mouvements: liste, soldeInitial };
  }
  async function mouvement(id) {
    const m = await donnees.col('cmd_mouvements').findOne({ _id: id });
    if (!m) throw new ErreurMetier('Mouvement introuvable.', 404);
    return m;
  }

  /** Situation par article : stock physique, reste à livrer, besoin de réapprovisionnement. */
  async function situation() {
    const [arts, stock, bons] = await Promise.all([articles(), stockParArticle(donnees), donnees.col('cmd_bons').find({ statut: 'en_cours' })]);
    const livres = await livreParBon(donnees);
    const reste = new Map(); const nbBons = new Map();
    for (const b of bons) {
      const e = etatBon(b, livres);
      for (const [a, t] of Object.entries(e.totaux)) {
        if (!t.reste) continue;
        const k = `${b.agenceId || ''}|${a}`;
        reste.set(k, q3((reste.get(k) || 0) + t.reste));
        nbBons.set(k, (nbBons.get(k) || 0) + 1);
      }
    }
    const agences = new Set([...stock.keys(), ...reste.keys()].map((k) => k.split('|')[0]));
    const a = agenceCourante();
    if (a) agences.add(a);
    const lignes = [];
    for (const ag of agences) {
      for (const art of arts) {
        const k = `${ag}|${art._id}`;
        const s = stock.get(k) || 0; const r = reste.get(k) || 0;
        if (art.actif === false && !s && !r) continue;
        const besoin = Math.max(0, q3(r - s));
        const sousSeuil = art.seuilMin > 0 && s < art.seuilMin;
        lignes.push({
          agenceId: ag, articleId: art._id, designation: art.designation, conditionnement: art.conditionnement, unite: art.unite, prixUnitaire: art.prixUnitaire || 0,
          stock: s, resteALivrer: r, nbBons: nbBons.get(k) || 0, besoin, seuilMin: art.seuilMin || 0, apresLivraisons: q3(s - r),
          alerte: s < 0 ? 'negatif' : besoin > 0 ? 'reappro' : sousSeuil ? 'seuil' : '', valeurBesoin: r2(besoin * (art.prixUnitaire || 0)),
        });
      }
    }
    return lignes;
  }

  async function alertes() {
    const sit = await situation();
    const lv = (await donnees.col('cmd_livraisons').find({ statut: 'a_signer' }));
    const vieux = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    return {
      reappro: sit.filter((l) => l.alerte === 'reappro' || l.alerte === 'negatif').map((l) => ({ agenceId: l.agenceId, designation: l.designation, unite: l.unite, besoin: l.besoin, stock: l.stock, reste: l.resteALivrer })),
      seuil: sit.filter((l) => l.alerte === 'seuil').map((l) => ({ agenceId: l.agenceId, designation: l.designation, unite: l.unite, stock: l.stock, seuilMin: l.seuilMin })),
      nonSignes: lv.length, nonSignesAnciens: lv.filter((l) => l.date <= vieux).length,
    };
  }

  /**
   * Consolidation : commandé / livré / reste par unité, par région ou par type de bon (bons non annulés).
   * Filtres : période (date du bon), région, type, bon, état (ouverts = en cours).
   */
  async function consolidation(f = {}) {
    const groupe = ['unite', 'region', 'type', 'bon'].includes(f.groupe) ? f.groupe : 'unite';
    const livres = await livreParBon(donnees);
    const bons = (await donnees.col('cmd_bons').find({})).filter((b) => b.statut !== 'annule' && (!f.regionId || b.regionId === f.regionId)
      && (!f.typeId || b.typeId === f.typeId) && (!f.bonId || b._id === f.bonId) && (!f.debut || b.dateBon >= f.debut) && (!f.fin || b.dateBon <= f.fin)
      && (!f.ouverts || b.statut === 'en_cours'));
    const groupes = new Map(); const artUtilises = new Set();
    for (const b of bons) {
      const e = etatBon(b, livres);
      for (const l of e.lignes) {
        if (f.uniteId && l.uniteId !== f.uniteId) continue;
        const [cle, libelle, sous] = groupe === 'unite' ? [`${b.agenceId}|${l.uniteId}`, l.uniteNom, b.regionNom]
          : groupe === 'region' ? [`${b.agenceId}|${b.regionId}`, b.regionNom, '']
            : groupe === 'type' ? [`${b.agenceId}|${b.typeId}`, b.typeNom, '']
              : [`${b.agenceId}|${b._id}`, `${b.reference}`, `${b.typeNom} – ${b.edition} – ${b.regionNom}`];
        const g = groupes.get(cle) || { cle, agenceId: b.agenceId, libelle, sous, effectif: 0, bons: new Set(), articles: {} };
        if (groupe === 'unite' && !g.bons.has(b._id)) g.effectif = Math.max(g.effectif, l.effectif || 0);
        else if (groupe !== 'unite') g.effectif += l.effectif || 0;
        g.bons.add(b._id);
        for (const [a, v] of Object.entries(l.articles)) {
          artUtilises.add(a);
          const t = g.articles[a] || (g.articles[a] = { commande: 0, livre: 0, reste: 0 });
          t.commande = q3(t.commande + v.commande); t.livre = q3(t.livre + v.livre); t.reste = q3(t.reste + v.reste);
        }
        groupes.set(cle, g);
      }
    }
    const arts = (await articles()).filter((a) => artUtilises.has(a._id)).map((a) => ({ _id: a._id, designation: a.designation, conditionnement: a.conditionnement, unite: a.unite }));
    const lignes = [...groupes.values()].map((g) => ({ ...g, bons: g.bons.size })).sort((a, b) => String(a.sous).localeCompare(String(b.sous), 'fr') || String(a.libelle).localeCompare(String(b.libelle), 'fr'));
    return { groupe, articles: arts, lignes, nbBons: bons.length };
  }

  /* ===================================== Remplacement de l'ancienne gestion */
  const ANCIENNES = ['stock_categories', 'articles', 'lots', 'stock_mouvements', 'stock_pertes', 'stock_peremptions', 'stock_transferts', 'stock_inventaires', 'stock_instantanes'];
  /** Efface une fois pour toutes les données de l'ancienne gestion de stock (base en ligne). */
  async function effacerAncienStock() {
    if (!store.db) return 0;
    const fait = await store.col('parametres').findOne({ _id: 'migration-stock-v2' });
    if (fait) return 0;
    let n = 0;
    for (const c of ANCIENNES) {
      try { const r = await store.db.collection(c).deleteMany({}); n += r.deletedCount || 0; } catch (e) { console.error('[stock] effacement', c, e.message); }
    }
    await store.col('parametres').updateOne({ _id: 'migration-stock-v2' }, { $set: { le: now(), documentsEffaces: n } }, { upsert: true });
    if (n) console.log(`[stock] Ancienne gestion de stock remplacée : ${n} document(s) effacé(s).`);
    return n;
  }

  return {
    initialiser, referentiel, articles, enregistrerArticle, supprimerArticle, utilisationsArticle, enregistrerRegion, enregistrerUnite, enregistrerType, supprimerType, utilisationsType,
    creerBon, modifierBon, changerStatutBon, listeBons, bon,
    preparerLivraison, livrer, signerLivraison, annulerLivraison, listeLivraisons, livraison,
    entree, annulerEntree, ajuster, listeMouvements, mouvement, situation, alertes, consolidation,
    effacerAncienStock, ANCIENNES, TYPES_MVT,
  };
}

module.exports = { createCommandes, TYPES_MVT };
