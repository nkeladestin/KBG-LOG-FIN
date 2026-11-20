'use strict';
/* =====================================================================
   Pouvoirs de l'administrateur : modifier ou supprimer n'importe quelle saisie.
   - Réservé aux comptes « Administrateur » (jamais aux responsables d'agence).
   - Les pièces liées suivent : une opération bancaire et son bon de caisse / ordre de virement,
     une livraison et son mouvement de stock, un bon de commande et ses livraisons…
   - Tout ce qui est supprimé part dans la CORBEILLE (copie complète) et peut être restauré.
   - Chaque modification ou suppression est inscrite au journal d'audit (avant → après).
   ===================================================================== */
const crypto = require('crypto');
const { montantEnLettres } = require('./lettres');

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const q3 = (x) => Math.round(Number(x) * 1000) / 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createAdmin({ store, donnees, svc, broadcast }) {
  const { ErreurMetier, audit, getParametres, texte } = svc;
  const now = () => new Date().toISOString();
  const col = (c) => store.col(c);
  const un = async (c, id) => (id ? col(c).findOne({ _id: id }) : null);
  const exigerAdmin = (user) => { if (!user || user.role !== 'admin') throw new ErreurMetier("Réservé à l'administrateur.", 403); };
  const fd = (d) => (d ? String(d).split('-').reverse().join('/') : '');
  const nbf = (x) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(x) || 0).replace(/ /g, ' ');

  /* ------------------------------------------------------------------ Types */
  // Pour chaque type : collection, libellé lisible, et calcul des pièces liées à supprimer avec lui.
  const TYPES = {
    operation: {
      col: 'operations', nom: 'Opération bancaire', lib: (d) => `${d.numero} du ${fd(d.date)} – ${nbf(d.montant)} – ${d.libelle || ''}`,
      async liees(d) {
        const r = [];
        if (d.bonId) { const b = await un('bons', d.bonId); if (b) r.push(['bons', b]); }
        if (d.ordreId) { const o = await un('ordres', d.ordreId); if (o) r.push(['ordres', o]); }
        return r;
      },
    },
    bon: {
      col: 'bons', nom: 'Bon de caisse', lib: (d) => `${d.numero} du ${fd(d.date)} – ${d.type === 'entree' ? 'entrée' : 'sortie'} ${nbf(d.montant)} – ${d.libelle || ''}`,
      async liees(d) {
        if (!d.operationId) return [];
        const op = await un('operations', d.operationId);
        if (!op) return [];
        return [['operations', op], ...(await TYPES.operation.liees(op)).filter(([c, x]) => !(c === 'bons' && x._id === d._id))];
      },
    },
    ordre: {
      col: 'ordres', nom: 'Ordre de virement', lib: (d) => `${d.numero} du ${fd(d.date)} – ${nbf(d.montant)} → ${(d.beneficiaire || {}).nom || ''}`,
      async liees(d) {
        const op = await un('operations', d.operationId);
        if (!op) return [];
        return [['operations', op], ...(await TYPES.operation.liees(op)).filter(([c, x]) => !(c === 'ordres' && x._id === d._id))];
      },
    },
    pv: { col: 'pv', nom: 'PV de contrôle de caisse', lib: (d) => `${d.numero} du ${fd(d.date)}`, liees: async () => [] },
    cloture: { col: 'clotures', nom: 'Clôture de caisse', lib: (d) => `Journée du ${fd(d.date)} (solde ${nbf(d.soldeCloture)})`, liees: async () => [] },
    compte: {
      col: 'comptes', nom: 'Compte bancaire', lib: (d) => `${d.banque} – ${d.numero}`,
      async liees(d) {
        const r = [];
        for (const op of await col('operations').find({ compteId: d._id })) { r.push(['operations', op]); r.push(...(await TYPES.operation.liees(op))); }
        return r;
      },
    },
    fournisseur: { col: 'fournisseurs', nom: 'Fournisseur', lib: (d) => d.nom, liees: async () => [] },
    agence: {
      col: 'agences', nom: 'Agence', lib: (d) => `${d.nom} (${d.code || ''})`,
      async liees(d) {
        if (d._id === 'siege') throw new ErreurMetier("Le Siège ne peut pas être supprimé (il reçoit les données sans agence). Vous pouvez le renommer.");
        const { PAR_AGENCE } = require('./agences');
        let n = 0;
        for (const c of PAR_AGENCE) if (c !== 'audit' && c !== 'compteurs') n += (await col(c).find({ agenceId: d._id })).length;
        n += (await col('utilisateurs').find({ agenceId: d._id })).filter((u) => !u.supprime).length;
        if (n) throw new ErreurMetier(`L'agence « ${d.nom} » contient encore ${n} élément(s) (opérations, bons, stock, utilisateurs…). Supprimez-les d'abord, ou désactivez l'agence : ses données restent consultables.`);
        return [];
      },
    },
    'stock-bon': {
      col: 'cmd_bons', nom: 'Bon de commande', lib: (d) => `${d.reference} (${d.numero}) – ${d.edition || ''}`,
      async liees(d) {
        const r = [];
        for (const lv of await col('cmd_livraisons').find({ bonId: d._id })) r.push(['cmd_livraisons', lv]);
        for (const m of await col('cmd_mouvements').find({ bonId: d._id })) if (m.type !== 'entree') r.push(['cmd_mouvements', m]);
        return r;
      },
    },
    'stock-livraison': {
      col: 'cmd_livraisons', nom: 'Bon de livraison', lib: (d) => `${d.numero} du ${fd(d.date)} – ${d.uniteNom}`,
      async liees(d) { return (await col('cmd_mouvements').find({ livraisonId: d._id })).map((m) => ['cmd_mouvements', m]); },
    },
    'stock-mouvement': {
      col: 'cmd_mouvements', nom: 'Mouvement de stock', lib: (d) => `${d.numero} du ${fd(d.date)} – ${d.libelle || d.type}`,
      async liees(d) {
        const r = [];
        if (d.type === 'livraison' && d.livraisonId) {
          const lv = await un('cmd_livraisons', d.livraisonId);
          if (lv) { r.push(['cmd_livraisons', lv]); for (const m of await col('cmd_mouvements').find({ livraisonId: lv._id })) if (m._id !== d._id) r.push(['cmd_mouvements', m]); }
        }
        // L'annulation d'une entrée ou d'un ajustement disparaît avec lui
        for (const m of await col('cmd_mouvements').find({ annuleMouvementId: d._id })) if (!r.some(([, x]) => x._id === m._id)) r.push(['cmd_mouvements', m]);
        return r;
      },
    },
    'stock-region': {
      col: 'cmd_regions', nom: 'Région militaire', lib: (d) => d.nom,
      async liees(d) { return (await col('cmd_unites').find({ regionId: d._id })).map((u) => ['cmd_unites', u]); },
    },
    'stock-unite': { col: 'cmd_unites', nom: 'Unité', lib: (d) => d.nom, liees: async () => [] },
  };
  const type = (t) => { const x = TYPES[t]; if (!x) throw new ErreurMetier('Type inconnu.'); return x; };
  async function charger(t, id) {
    const T = type(t);
    const d = await un(T.col, id);
    if (!d) throw new ErreurMetier(`${T.nom} introuvable (déjà supprimé ?).`, 404);
    return { T, d };
  }
  const NOMS_COL = { operations: 'Opération bancaire', bons: 'Bon de caisse', ordres: 'Ordre de virement', cmd_livraisons: 'Bon de livraison', cmd_mouvements: 'Mouvement de stock', cmd_unites: 'Unité' };
  const libDoc = (c, x) => `${NOMS_COL[c] || c} ${x.numero || x.nom || ''}`.trim();

  /** Ce qui sera supprimé avec l'élément, et les avertissements (journée clôturée…). */
  async function apercu(user, t, id) {
    exigerAdmin(user);
    const { T, d } = await charger(t, id);
    const liees = await T.liees(d);
    const avert = [];
    const derniere = (await col('clotures').find({ agenceId: d.agenceId }, { sort: { date: -1 }, limit: 1 }))[0];
    const caisse = [[T.col, d], ...liees].filter(([c]) => c === 'bons').map(([, x]) => x);
    if (derniere && caisse.some((b) => b.date <= derniere.date)) avert.push(`La caisse est clôturée jusqu'au ${fd(derniere.date)} : le solde de caisse de ces journées va changer.`);
    if (t === 'stock-mouvement' && d.type === 'entree') avert.push("Le stock du dépôt diminuera d'autant : vérifiez qu'il ne devient pas négatif.");
    return { type: t, nom: T.nom, libelle: T.lib(d), liees: liees.map(([c, x]) => libDoc(c, x)), avertissements: avert, modifiable: !!MODIFS[t], champs: MODIFS[t] ? await MODIFS[t].champs(d) : [] };
  }

  /* ------------------------------------------------------------ Suppression */
  async function supprimer(user, t, id, motif) {
    exigerAdmin(user);
    motif = texte(motif, 300);
    if (!motif) throw new ErreurMetier('Indiquez le motif de la suppression (il figurera au journal).');
    const { T, d } = await charger(t, id);
    const liees = await T.liees(d);
    const docs = [[T.col, d], ...liees];
    const vus = new Set();
    const uniques = docs.filter(([c, x]) => { const k = `${c}|${x._id}`; if (vus.has(k)) return false; vus.add(k); return true; });
    const corb = {
      _id: crypto.randomUUID(), type: t, nom: T.nom, libelle: T.lib(d), motif, agenceId: d.agenceId || null,
      docs: uniques.map(([c, x]) => ({ col: c, doc: x })), supprimePar: user.identifiant, nomSuppression: user.nom, supprimeLe: now(),
    };
    await col('corbeille').insertOne(corb);
    // Une annulation supprimée : la pièce d'origine n'est plus « annulée »
    if (t === 'stock-mouvement' && d.type === 'annulation' && d.annuleMouvementId && !d.livraisonId) {
      await col('cmd_mouvements').updateOne({ _id: d.annuleMouvementId }, { $set: { annulePar: null, annuleLe: null, motifAnnulation: null } });
    }
    for (const [c, x] of uniques) await col(c).deleteMany({ _id: x._id });
    await audit(donnees, user, `Suppression par l'administrateur : ${T.nom.toLowerCase()}`, T.lib(d),
      `Motif : ${motif}${liees.length ? ` – supprimé avec : ${liees.map(([c, x]) => libDoc(c, x)).join(', ')}` : ''} (récupérable dans la corbeille)`);
    new Set(uniques.map(([c]) => c)).forEach((c) => broadcast(c));
    broadcast('corbeille');
    return { ok: true, supprimes: uniques.length, corbeilleId: corb._id };
  }

  /* --------------------------------------------------------- Modification */
  const champDate = (nom, label, v) => ({ nom, label, genre: 'date', valeur: v || '' });
  const champMontant = (nom, label, v) => ({ nom, label, genre: 'montant', valeur: v ?? '' });
  const champTexte = (nom, label, v, max = 250) => ({ nom, label, genre: 'texte', valeur: v || '', max });
  const champListe = (nom, label, v, options) => ({ nom, label, genre: 'liste', valeur: v || '', options });
  const lireDate = (v, label) => { if (!DATE_RE.test(String(v || ''))) throw new ErreurMetier(`${label} invalide.`); return v; };
  const lireMontant = (v, label = 'Montant') => { const x = r2(String(v).replace(',', '.')); if (!Number.isFinite(x) || x <= 0) throw new ErreurMetier(`${label} : nombre positif attendu.`); return x; };
  const lettres = async (m) => { const p = await getParametres(); return montantEnLettres(m, p.deviseLettres, p.subdivisionLettres); };
  const diff = (avant, apres, noms) => noms.filter((k) => String(avant[k] ?? '') !== String(apres[k] ?? '')).map((k) => `${k} : « ${avant[k] ?? ''} » → « ${apres[k] ?? ''} »`);

  /** Opération bancaire (et sa pièce liée : bon de caisse, ordre de virement). */
  async function modifierOperation(user, op, v) {
    const p = await getParametres();
    const comptes = await col('comptes').find({});
    const nouv = {
      date: lireDate(v.date, 'Date'), montant: lireMontant(v.montant), libelle: texte(v.libelle, 250), reference: texte(v.reference, 80),
      categorie: texte(v.categorie, 80) || op.categorie || '', provenance: texte(v.provenance, 200) || op.provenance || '', compteId: texte(v.compteId, 60) || op.compteId,
    };
    if (!nouv.libelle) throw new ErreurMetier('Libellé obligatoire.');
    const compte = comptes.find((c) => c._id === nouv.compteId);
    if (!compte) throw new ErreurMetier('Compte bancaire introuvable.');
    const set = { ...nouv, compte: { banque: compte.banque, intitule: compte.intitule, numero: compte.numero }, modifieLe: now(), modifiePar: user.identifiant };
    const changements = diff({ ...op, compteId: op.compteId }, nouv, ['date', 'montant', 'libelle', 'reference', 'categorie', 'provenance', 'compteId']);
    await col('operations').updateOne({ _id: op._id }, { $set: set });
    const ml = await lettres(nouv.montant);
    if (op.bonId) await col('bons').updateOne({ _id: op.bonId }, { $set: { date: nouv.date, montant: nouv.montant, montantLettres: ml, libelle: nouv.libelle, modifieLe: set.modifieLe, modifiePar: user.identifiant } });
    if (op.ordreId) await col('ordres').updateOne({ _id: op.ordreId }, { $set: { date: nouv.date, montant: nouv.montant, montantLettres: ml, motif: nouv.libelle, reference: nouv.reference, donneurOrdre: { banque: compte.banque, intitule: compte.intitule, numero: compte.numero, iban: compte.iban || '', swift: compte.swift || '', agence: compte.agence || '' }, modifieLe: set.modifieLe, modifiePar: user.identifiant } });
    void p;
    return { cible: op.numero, changements, cols: ['operations', 'bons', 'ordres'] };
  }

  const MODIFS = {
    operation: {
      async champs(op) {
        const p = await getParametres();
        const cats = op.sens === 'entree' ? p.categoriesEncaissement : p.categoriesDecaissement;
        return [champDate('date', 'Date', op.date), champMontant('montant', 'Montant', op.montant), champTexte('libelle', 'Libellé', op.libelle),
          champTexte('reference', 'Référence', op.reference, 80),
          champListe('compteId', 'Compte bancaire', op.compteId, (await col('comptes').find({})).map((c) => [c._id, `${c.banque} – ${c.numero}`])),
          ...(op.categorie ? [champListe('categorie', 'Catégorie', op.categorie, [...new Set([...(cats || []), op.categorie])].map((c) => [c, c]))] : []),
          ...(op.nature === 'encaissement' ? [champTexte('provenance', 'Provenance des fonds', op.provenance, 200)] : [])];
      },
      appliquer: (user, op, v) => modifierOperation(user, op, v),
    },
    ordre: {
      async champs(o) { const op = await un('operations', o.operationId); return op ? MODIFS.operation.champs(op) : []; },
      async appliquer(user, o, v) { const op = await un('operations', o.operationId); if (!op) throw new ErreurMetier("Opération liée introuvable."); return modifierOperation(user, op, v); },
    },
    bon: {
      async champs(b) {
        if (b.operationId) { const op = await un('operations', b.operationId); if (op) return MODIFS.operation.champs(op); }
        const p = await getParametres();
        const cats = b.type === 'entree' ? p.categoriesEncaissement : p.categoriesDecaissement;
        return [champDate('date', 'Date', b.date), champMontant('montant', 'Montant', b.montant), champTexte('libelle', 'Libellé', b.libelle),
          champTexte('tiers', b.type === 'entree' ? 'Remis par' : 'Bénéficiaire', b.tiers, 160), champTexte('piece', 'Pièce justificative', b.piece, 80),
          champListe('categorie', 'Catégorie', b.categorie, [...new Set([...(cats || []), b.categorie].filter(Boolean))].map((c) => [c, c]))];
      },
      async appliquer(user, b, v) {
        if (b.operationId) { const op = await un('operations', b.operationId); if (op) return modifierOperation(user, op, v); }
        const nouv = { date: lireDate(v.date, 'Date'), montant: lireMontant(v.montant), libelle: texte(v.libelle, 250), tiers: texte(v.tiers, 160), piece: texte(v.piece, 80), categorie: texte(v.categorie, 80) || b.categorie };
        if (!nouv.libelle) throw new ErreurMetier('Libellé obligatoire.');
        await col('bons').updateOne({ _id: b._id }, { $set: { ...nouv, montantLettres: await lettres(nouv.montant), modifieLe: now(), modifiePar: user.identifiant } });
        return { cible: b.numero, changements: diff(b, nouv, Object.keys(nouv)), cols: ['bons'] };
      },
    },
    compte: {
      champs: async (c) => [champTexte('banque', 'Banque', c.banque, 120), champTexte('intitule', 'Intitulé', c.intitule, 120), champTexte('numero', 'N° de compte', c.numero, 60),
        { ...champMontant('soldeInitial', 'Solde initial', c.soldeInitial ?? 0), zero: true }],
      async appliquer(user, c, v) {
        const nouv = { banque: texte(v.banque, 120), intitule: texte(v.intitule, 120), numero: texte(v.numero, 60), soldeInitial: r2(String(v.soldeInitial || 0).replace(',', '.')) };
        if (!nouv.banque || !nouv.numero) throw new ErreurMetier('Banque et numéro de compte obligatoires.');
        if (!Number.isFinite(nouv.soldeInitial)) throw new ErreurMetier('Solde initial invalide.');
        await col('comptes').updateOne({ _id: c._id }, { $set: nouv });
        for (const op of await col('operations').find({ compteId: c._id })) await col('operations').updateOne({ _id: op._id }, { $set: { compte: { banque: nouv.banque, intitule: nouv.intitule, numero: nouv.numero } } });
        return { cible: `${c.banque} ${c.numero}`, changements: diff(c, nouv, Object.keys(nouv)), cols: ['comptes', 'operations'] };
      },
    },
    'stock-livraison': {
      async champs(l) {
        return [champDate('date', 'Date', l.date), champTexte('receptionnaire', 'Réceptionnaire', l.receptionnaire, 160), champTexte('vehicule', 'Véhicule / transport', l.vehicule, 120),
          champTexte('observations', 'Observations', l.observations, 500),
          ...l.lignes.map((x, i) => ({ ...champMontant(`q${i}`, `${x.designation} (quantité livrée)`, x.quantite), zero: true }))];
      },
      async appliquer(user, l, v) {
        const lignes = l.lignes.map((x, i) => ({ ...x, quantite: q3(String(v[`q${i}`] ?? x.quantite).replace(',', '.')) })).filter((x) => x.quantite > 0);
        if (lignes.some((x) => !Number.isFinite(x.quantite))) throw new ErreurMetier('Quantité invalide.');
        if (!lignes.length) throw new ErreurMetier('Toutes les quantités sont à zéro : supprimez plutôt la livraison.');
        const nouv = { date: lireDate(v.date, 'Date'), receptionnaire: texte(v.receptionnaire, 160), vehicule: texte(v.vehicule, 120), observations: texte(v.observations, 500) };
        await col('cmd_livraisons').updateOne({ _id: l._id }, { $set: { ...nouv, lignes, modifieLe: now(), modifiePar: user.identifiant } });
        if (l.mouvementId) await col('cmd_mouvements').updateOne({ _id: l.mouvementId }, { $set: { date: nouv.date, lignes: lignes.map((x) => ({ ...x, quantite: -x.quantite })) } });
        // Retour en stock d'une livraison annulée : mêmes quantités
        for (const m of await col('cmd_mouvements').find({ livraisonId: l._id, type: 'annulation' })) await col('cmd_mouvements').updateOne({ _id: m._id }, { $set: { lignes: lignes.map((x) => ({ ...x })) } });
        const ch = diff(l, nouv, Object.keys(nouv));
        l.lignes.forEach((x) => { const n = lignes.find((y) => y.articleId === x.articleId); if (!n || n.quantite !== x.quantite) ch.push(`${x.designation} : ${x.quantite} → ${n ? n.quantite : 0}`); });
        return { cible: l.numero, changements: ch, cols: ['cmd_livraisons', 'cmd_mouvements'] };
      },
    },
    'stock-mouvement': {
      async champs(m) {
        if (m.type === 'livraison') throw new ErreurMetier('Une livraison se modifie depuis son bon de livraison (menu Livraisons).');
        return [champDate('date', 'Date', m.date), ...(m.type === 'entree' ? [champTexte('fournisseur', 'Fournisseur', m.fournisseur, 160), champTexte('document', 'Pièce', m.document, 80)] : [champTexte('motif', 'Motif', m.motif, 300)]),
          ...m.lignes.map((x, i) => ({ ...champMontant(`q${i}`, `${x.designation} (quantité${m.type === 'entree' ? '' : ', négatif = sortie'})`, x.quantite), zero: true, signe: m.type !== 'entree' })),
          ...(m.type === 'entree' ? m.lignes.map((x, i) => ({ ...champMontant(`p${i}`, `${x.designation} (prix unitaire)`, x.prixUnitaire ?? ''), zero: true })) : [])];
      },
      async appliquer(user, m, v) {
        const lignes = m.lignes.map((x, i) => {
          const q = q3(String(v[`q${i}`] ?? x.quantite).replace(',', '.'));
          if (!Number.isFinite(q)) throw new ErreurMetier('Quantité invalide.');
          const pu = m.type === 'entree' && v[`p${i}`] !== '' && v[`p${i}`] != null ? r2(String(v[`p${i}`]).replace(',', '.')) : x.prixUnitaire ?? null;
          return { ...x, quantite: q, ...(m.type === 'entree' ? { prixUnitaire: pu, montant: pu == null ? null : r2(pu * q) } : {}) };
        }).filter((x) => x.quantite !== 0);
        if (!lignes.length) throw new ErreurMetier('Toutes les quantités sont à zéro : supprimez plutôt le mouvement.');
        const nouv = { date: lireDate(v.date, 'Date'), ...(m.type === 'entree' ? { fournisseur: texte(v.fournisseur, 160), document: texte(v.document, 80) } : { motif: texte(v.motif, 300) }) };
        const set = { ...nouv, lignes, modifieLe: now(), modifiePar: user.identifiant };
        if (m.type === 'entree') set.montant = lignes.some((x) => x.montant != null) ? r2(lignes.reduce((s, x) => s + (x.montant || 0), 0)) : null;
        await col('cmd_mouvements').updateOne({ _id: m._id }, { $set: set });
        const ch = diff(m, nouv, Object.keys(nouv));
        m.lignes.forEach((x) => { const n = lignes.find((y) => y.articleId === x.articleId); if (!n || n.quantite !== x.quantite) ch.push(`${x.designation} : ${x.quantite} → ${n ? n.quantite : 0}`); });
        return { cible: m.numero, changements: ch, cols: ['cmd_mouvements'] };
      },
    },
  };

  async function modifier(user, t, id, valeurs) {
    exigerAdmin(user);
    const M = MODIFS[t];
    if (!M) throw new ErreurMetier("Ce type d'élément se modifie depuis son propre écran.");
    const { T, d } = await charger(t, id);
    const r = await M.appliquer(user, d, valeurs || {});
    if (r.changements.length) await audit(donnees, user, `Modification par l'administrateur : ${T.nom.toLowerCase()}`, r.cible, r.changements.join(' ; ').slice(0, 3000));
    r.cols.forEach((c) => broadcast(c));
    return { ok: true, changements: r.changements };
  }

  /* --------------------------------------------------------------- Corbeille */
  async function corbeille(user) {
    exigerAdmin(user);
    return (await col('corbeille').find({})).sort((a, b) => b.supprimeLe.localeCompare(a.supprimeLe))
      .map(({ docs, ...x }) => ({ ...x, nbDocs: docs.length, contenu: docs.map((e) => libDoc(e.col, e.doc)) }));
  }
  async function restaurer(user, id) {
    exigerAdmin(user);
    const c = await un('corbeille', id);
    if (!c) throw new ErreurMetier('Élément introuvable dans la corbeille.', 404);
    const existants = [];
    for (const e of c.docs) if (await un(e.col, e.doc._id)) existants.push(libDoc(e.col, e.doc));
    if (existants.length) throw new ErreurMetier(`Restauration impossible : ${existants.join(', ')} existe déjà.`);
    if (c.type === 'stock-unite' || c.type === 'stock-region') {
      for (const e of c.docs) {
        if (e.col === 'cmd_unites' && !(await un('cmd_regions', e.doc.regionId)) && !c.docs.some((x) => x.doc._id === e.doc.regionId)) throw new ErreurMetier("La région de cette unité n'existe plus : restaurez d'abord la région.");
      }
    }
    for (const e of c.docs) await col(e.col).insertOne({ ...e.doc });
    await col('corbeille').deleteMany({ _id: id });
    await audit(donnees, user, `Restauration depuis la corbeille : ${c.nom.toLowerCase()}`, c.libelle, `${c.docs.length} élément(s) remis en place`);
    new Set(c.docs.map((e) => e.col)).forEach((x) => broadcast(x));
    broadcast('corbeille');
    return { ok: true };
  }
  async function viderCorbeille(user, id) {
    exigerAdmin(user);
    const c = await un('corbeille', id);
    if (!c) throw new ErreurMetier('Élément introuvable dans la corbeille.', 404);
    await col('corbeille').deleteMany({ _id: id });
    await audit(donnees, user, 'Suppression définitive (corbeille)', c.libelle, `${c.nom} – ${c.docs.length} élément(s)`);
    broadcast('corbeille');
    return { ok: true };
  }

  return { TYPES, apercu, supprimer, modifier, corbeille, restaurer, viderCorbeille };
}

module.exports = { createAdmin };
