'use strict';
/**
 * Règles de gestion : opérations bancaires, ordres de virement, bons de caisse,
 * clôtures journalières, PV de contrôle, prévisions, traçabilité (journal d'audit).
 */
const { montantEnLettres } = require('./lettres');

class ErreurMetier extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const arrondi = (x) => Math.round(Number(x) * 100) / 100;
const texte = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));

function exigerDate(d, champ = 'date') {
  if (!DATE_RE.test(d || '') || Number.isNaN(Date.parse(d))) throw new ErreurMetier(`Date invalide (${champ}).`);
  return d;
}
function exigerMontant(m) {
  const v = arrondi(m);
  if (!Number.isFinite(v) || v <= 0) throw new ErreurMetier('Le montant doit être un nombre strictement positif.');
  if (v > 1e13) throw new ErreurMetier('Montant trop élevé.');
  return v;
}
function exigerTexte(v, champ, max) {
  const t = texte(v, max);
  if (!t) throw new ErreurMetier(`Le champ « ${champ} » est obligatoire.`);
  return t;
}

const CATEGORIES_ENC = ['Ventes / Prestations', 'Subventions et dons', 'Apports / Financements', 'Emprunts', 'Autres encaissements'];
const CATEGORIES_DEC = ['Achats fournisseurs', 'Salaires et charges sociales', 'Impôts et taxes', 'Loyers et charges',
  'Transport et déplacements', 'Frais bancaires', 'Investissements', "Remboursements d'emprunts", 'Autres décaissements'];

const PARAMETRES_DEFAUT = {
  entreprise: {
    nom: 'Nom de votre structure', sigle: '', formeJuridique: '', adresse: '', ville: '', pays: '',
    telephone: '', email: '', siteWeb: '', rccm: '', nif: '', ligneComplementaire: '', piedDePage: '', logo: '',
  },
  devise: 'USD',
  deviseLettres: 'dollars américains',
  subdivisionLettres: 'cents',
  decimales: 2,
  soldeInitialCaisse: 0,
  autoriserDecouvert: false,
  signataires: {
    caissier: '', comptable: '', directeur: '', controleur: '',
    titreCaissier: 'Le Caissier', titreComptable: 'Le Comptable', titreDirecteur: 'Le Directeur', titreControleur: 'Le Contrôleur',
  },
  categoriesEncaissement: CATEGORIES_ENC,
  categoriesDecaissement: CATEGORIES_DEC,
};

function createServices(store, broadcast) {
  const now = () => new Date().toISOString();

  async function audit(ctx, user, action, cible, details) {
    await ctx.col('audit').insertOne({
      quand: now(), utilisateur: user ? user.identifiant : 'système', nomUtilisateur: user ? user.nom : '',
      action, cible: cible || '', details: details || '',
    });
  }

  async function prochainNumero(ctx, prefixe, date) {
    const annee = date.slice(0, 4);
    if (store.allouerNumero) return store.allouerNumero(ctx, prefixe, annee); // double stockage
    const id = `${prefixe}-${annee}`;
    const c = await ctx.col('compteurs').findOneAndUpdate({ _id: id }, { $inc: { seq: 1 } }, { upsert: true });
    return `${prefixe}-${annee}-${String(c.seq).padStart(5, '0')}`;
  }

  /* ------------------------------------------------------------ Paramètres */
  async function getParametres(ctx = store) {
    const p = await ctx.col('parametres').findOne({ _id: 'general' });
    const merged = { ...structuredClone(PARAMETRES_DEFAUT), ...(p || {}) };
    merged.entreprise = { ...PARAMETRES_DEFAUT.entreprise, ...((p && p.entreprise) || {}) };
    merged.signataires = { ...PARAMETRES_DEFAUT.signataires, ...((p && p.signataires) || {}) };
    delete merged._id;
    return merged;
  }

  async function setParametres(user, body) {
    const cur = await getParametres();
    const e = body.entreprise || {};
    const ent = {};
    for (const k of Object.keys(PARAMETRES_DEFAUT.entreprise)) {
      if (k === 'logo') continue;
      ent[k] = texte(e[k] !== undefined ? e[k] : cur.entreprise[k], 400);
    }
    let logo = e.logo !== undefined ? String(e.logo || '') : cur.entreprise.logo;
    if (logo && !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
      throw new ErreurMetier('Format de logo non reconnu (PNG, JPEG, GIF, WEBP ou SVG).');
    }
    if (logo.length > 1_500_000) throw new ErreurMetier('Logo trop volumineux (1 Mo maximum).');
    ent.logo = logo;
    const sig = {};
    for (const k of Object.keys(PARAMETRES_DEFAUT.signataires)) {
      sig[k] = texte((body.signataires || {})[k] !== undefined ? body.signataires[k] : cur.signataires[k], 120);
    }
    const liste = (v, def) => {
      const l = Array.isArray(v) ? [...new Set(v.map((x) => texte(x, 80)).filter(Boolean))] : def;
      return l.length ? l : def;
    };
    const doc = {
      entreprise: ent,
      devise: texte(body.devise ?? cur.devise, 12) || 'USD',
      subdivisionLettres: texte(body.subdivisionLettres ?? cur.subdivisionLettres, 30) || 'cents',
      deviseLettres: texte(body.deviseLettres ?? cur.deviseLettres, 40),
      decimales: [0, 2].includes(Number(body.decimales)) ? Number(body.decimales) : cur.decimales,
      soldeInitialCaisse: arrondi(body.soldeInitialCaisse ?? cur.soldeInitialCaisse) || 0,
      autoriserDecouvert: body.autoriserDecouvert !== undefined ? !!body.autoriserDecouvert : cur.autoriserDecouvert,
      signataires: sig,
      categoriesEncaissement: liste(body.categoriesEncaissement, cur.categoriesEncaissement),
      categoriesDecaissement: liste(body.categoriesDecaissement, cur.categoriesDecaissement),
      majLe: now(), majPar: user.identifiant,
    };
    await store.tx(async (ctx) => {
      await ctx.col('parametres').updateOne({ _id: 'general' }, { $set: doc }, { upsert: true });
      await audit(ctx, user, 'Paramètres modifiés', 'Entête / paramètres', '');
    });
    broadcast('parametres');
    return getParametres();
  }

  /* -------------------------------------------------- Comptes et fournisseurs */
  const listeComptes = () => store.col('comptes').find({}, { sort: { banque: 1, intitule: 1 } });
  const listeFournisseurs = () => store.col('fournisseurs').find({}, { sort: { nom: 1 } });

  async function enregistrerCompte(user, body, id) {
    const doc = {
      banque: exigerTexte(body.banque, 'Banque', 120),
      intitule: texte(body.intitule, 120),
      numero: exigerTexte(body.numero, 'N° de compte', 60),
      iban: texte(body.iban, 60), swift: texte(body.swift, 20), agence: texte(body.agence, 120),
      actif: body.actif !== false,
    };
    return store.tx(async (ctx) => {
      if (id) {
        const cur = await ctx.col('comptes').findOne({ _id: id });
        if (!cur) throw new ErreurMetier('Compte introuvable.', 404);
        // Le solde initial ne peut plus être modifié une fois des opérations saisies (traçabilité).
        const nb = await ctx.col('operations').countDocuments({ compteId: id });
        doc.soldeInitial = nb ? cur.soldeInitial : arrondi(body.soldeInitial || 0);
        await ctx.col('comptes').updateOne({ _id: id }, { $set: doc });
        await audit(ctx, user, 'Compte bancaire modifié', `${doc.banque} ${doc.numero}`);
        return { ...cur, ...doc };
      }
      doc.soldeInitial = arrondi(body.soldeInitial || 0);
      doc.creeLe = now();
      const r = await ctx.col('comptes').insertOne(doc);
      await audit(ctx, user, 'Compte bancaire créé', `${doc.banque} ${doc.numero}`, `Solde initial ${doc.soldeInitial}`);
      return r;
    }).finally(() => broadcast('comptes'));
  }

  async function enregistrerFournisseur(user, body, id) {
    const doc = {
      nom: exigerTexte(body.nom, 'Nom', 160),
      adresse: texte(body.adresse, 200), telephone: texte(body.telephone, 60), email: texte(body.email, 120),
      nif: texte(body.nif, 60), banque: texte(body.banque, 120), numeroCompte: texte(body.numeroCompte, 60),
      actif: body.actif !== false,
    };
    return store.tx(async (ctx) => {
      if (id) {
        const r = await ctx.col('fournisseurs').findOneAndUpdate({ _id: id }, { $set: doc });
        if (!r) throw new ErreurMetier('Fournisseur introuvable.', 404);
        await audit(ctx, user, 'Fournisseur modifié', doc.nom);
        return r;
      }
      doc.creeLe = now();
      const r = await ctx.col('fournisseurs').insertOne(doc);
      await audit(ctx, user, 'Fournisseur créé', doc.nom);
      return r;
    }).finally(() => broadcast('fournisseurs'));
  }

  /* ------------------------------------------------------------- Soldes */
  /** Solde d'un compte (ou de tous si compteId null) avant la date (exclue). */
  async function soldeBanque(ctx, compteId, avant) {
    const comptes = compteId ? [await ctx.col('comptes').findOne({ _id: compteId })] : await ctx.col('comptes').find({});
    let s = comptes.reduce((a, c) => a + (c ? c.soldeInitial || 0 : 0), 0);
    const f = { annulee: { $ne: true } };
    if (compteId) f.compteId = compteId;
    if (avant) f.date = { $lt: avant };
    for (const o of await ctx.col('operations').find(f)) s += o.sens === 'entree' ? o.montant : -o.montant;
    return arrondi(s);
  }

  async function soldeCaisse(ctx, avant) {
    const p = await getParametres(ctx);
    let s = p.soldeInitialCaisse || 0;
    const f = { annulee: { $ne: true } };
    if (avant) f.date = { $lt: avant };
    for (const b of await ctx.col('bons').find(f)) s += b.type === 'entree' ? b.montant : -b.montant;
    return arrondi(s);
  }

  /** Vérifie que le solde ne devient négatif à aucun moment après ajout du mouvement. */
  function verifierChronologie(initial, mouvements, nouveau, libelle) {
    const all = [...mouvements, nouveau].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sens === 'entree' ? -1 : 1)));
    let s = initial;
    for (const m of all) {
      s = arrondi(s + (m.sens === 'entree' ? m.montant : -m.montant));
      if (s < 0) throw new ErreurMetier(`${libelle} insuffisant : le solde deviendrait négatif au ${m.date.split('-').reverse().join('/')} (${s}).`);
    }
  }

  async function controlerBanque(ctx, compte, sortie) {
    const p = await getParametres(ctx);
    if (p.autoriserDecouvert) return;
    const ops = await ctx.col('operations').find({ compteId: compte._id, annulee: { $ne: true } });
    verifierChronologie(compte.soldeInitial || 0, ops, sortie, `Solde du compte ${compte.banque}`);
  }

  async function controlerCaisse(ctx, sortie) {
    const p = await getParametres(ctx);
    const bons = await ctx.col('bons').find({ annulee: { $ne: true } });
    verifierChronologie(p.soldeInitialCaisse || 0, bons.map((b) => ({ date: b.date, montant: b.montant, sens: b.type })), sortie, 'Solde de caisse');
  }

  async function verifierCloture(ctx, date) {
    const derniere = (await ctx.col('clotures').find({}, { sort: { date: -1 }, limit: 1 }))[0];
    if (derniere && date <= derniere.date) {
      throw new ErreurMetier(`La caisse est clôturée jusqu'au ${derniere.date.split('-').reverse().join('/')} : impossible d'enregistrer un mouvement de caisse à cette date.`);
    }
  }

  async function compteActif(ctx, id) {
    const c = await ctx.col('comptes').findOne({ _id: id });
    if (!c) throw new ErreurMetier('Compte bancaire introuvable.');
    if (c.actif === false) throw new ErreurMetier('Ce compte bancaire est désactivé.');
    return c;
  }

  /* ---------------------------------------------------- Opérations bancaires */
  async function creerBon(ctx, user, p, b) {
    const type = b.type;
    const numero = await prochainNumero(ctx, type === 'entree' ? 'BEC' : 'BSC', b.date);
    const doc = {
      numero, type, date: b.date, montant: b.montant,
      montantLettres: montantEnLettres(b.montant, p.deviseLettres, p.subdivisionLettres),
      libelle: b.libelle, tiers: b.tiers || '', categorie: b.categorie || '',
      piece: b.piece || '', origine: b.origine || 'manuel', operationId: b.operationId || null,
      interne: !!b.interne, annulee: false, creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
    };
    return ctx.col('bons').insertOne(doc);
  }

  async function base(ctx, user, body, sens) {
    const date = exigerDate(body.date);
    const montant = exigerMontant(body.montant);
    const compte = await compteActif(ctx, body.compteId);
    return {
      date, montant, compte, sens,
      doc: {
        date, sens, montant, compteId: compte._id,
        compte: { banque: compte.banque, intitule: compte.intitule, numero: compte.numero },
        libelle: exigerTexte(body.libelle, 'Libellé', 250),
        reference: texte(body.reference, 80),
        annulee: false, creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
      },
    };
  }

  /** Entrée d'argent : le compte banque est DÉBITÉ. */
  async function entreeBanque(user, body) {
    const r = await store.tx(async (ctx) => {
      const p = await getParametres(ctx);
      const { doc } = await base(ctx, user, body, 'entree');
      doc.nature = 'encaissement';
      doc.provenance = exigerTexte(body.provenance, 'Provenance des fonds', 200);
      doc.banqueDestinataire = texte(body.banqueDestinataire, 200) || `${doc.compte.banque} – ${doc.compte.numero}`;
      doc.categorie = exigerTexte(body.categorie, 'Catégorie', 80);
      if (!p.categoriesEncaissement.includes(doc.categorie)) throw new ErreurMetier("Catégorie d'encaissement inconnue.");
      doc.interne = false;
      doc.numero = await prochainNumero(ctx, 'BQ', doc.date);
      const op = await ctx.col('operations').insertOne(doc);
      await audit(ctx, user, 'Entrée bancaire', op.numero, `${doc.montant} – ${doc.libelle} (provenance : ${doc.provenance})`);
      return { operation: op };
    });
    broadcast('operations');
    return r;
  }

  /** Versement de la caisse vers la banque : bon de sortie caisse + entrée bancaire. */
  async function versementCaisse(user, body) {
    const r = await store.tx(async (ctx) => {
      const p = await getParametres(ctx);
      const { doc } = await base(ctx, user, body, 'entree');
      await verifierCloture(ctx, doc.date);
      await controlerCaisse(ctx, { date: doc.date, montant: doc.montant, sens: 'sortie' });
      doc.nature = 'versement_caisse';
      doc.provenance = 'Caisse';
      doc.banqueDestinataire = `${doc.compte.banque} – ${doc.compte.numero}`;
      doc.categorie = 'Mouvement interne';
      doc.interne = true;
      doc.numero = await prochainNumero(ctx, 'BQ', doc.date);
      const op = await ctx.col('operations').insertOne(doc);
      const bon = await creerBon(ctx, user, p, {
        type: 'sortie', date: doc.date, montant: doc.montant, libelle: doc.libelle,
        tiers: `${doc.compte.banque} (${doc.compte.numero})`, categorie: 'Mouvement interne', origine: 'banque',
        operationId: op._id, interne: true, piece: op.numero,
      });
      await ctx.col('operations').updateOne({ _id: op._id }, { $set: { bonId: bon._id, bonNumero: bon.numero } });
      await audit(ctx, user, 'Versement caisse → banque', op.numero, `${doc.montant} – bon ${bon.numero}`);
      return { operation: { ...op, bonId: bon._id, bonNumero: bon.numero }, bon };
    });
    broadcast('operations');
    return r;
  }

  /** Sortie par virement fournisseur : compte banque CRÉDITÉ + ordre de virement officiel. */
  async function virementFournisseur(user, body) {
    const r = await store.tx(async (ctx) => {
      const p = await getParametres(ctx);
      const { doc, compte } = await base(ctx, user, body, 'sortie');
      const f = await ctx.col('fournisseurs').findOne({ _id: body.fournisseurId });
      if (!f) throw new ErreurMetier('Fournisseur introuvable.');
      if (f.actif === false) throw new ErreurMetier('Ce fournisseur est désactivé.');
      await controlerBanque(ctx, compte, { date: doc.date, montant: doc.montant, sens: 'sortie' });
      const banqueBenef = texte(body.banqueDestinataire, 120) || f.banque;
      const compteBenef = texte(body.compteBeneficiaire, 60) || f.numeroCompte;
      if (!banqueBenef) throw new ErreurMetier('Indiquez la banque du fournisseur (banque destinataire).');
      if (!compteBenef) throw new ErreurMetier('Indiquez le numéro de compte du fournisseur.');
      doc.nature = 'virement_fournisseur';
      doc.provenance = `${compte.banque} – ${compte.numero}`;
      doc.banqueDestinataire = banqueBenef;
      doc.fournisseurId = f._id;
      doc.fournisseurNom = f.nom;
      doc.categorie = texte(body.categorie, 80) || 'Achats fournisseurs';
      if (!p.categoriesDecaissement.includes(doc.categorie)) throw new ErreurMetier('Catégorie de décaissement inconnue.');
      doc.interne = false;
      doc.numero = await prochainNumero(ctx, 'BQ', doc.date);
      const op = await ctx.col('operations').insertOne(doc);
      const ordre = await ctx.col('ordres').insertOne({
        numero: await prochainNumero(ctx, 'OV', doc.date),
        date: doc.date, operationId: op._id, operationNumero: op.numero,
        donneurOrdre: { banque: compte.banque, intitule: compte.intitule, numero: compte.numero, iban: compte.iban || '', swift: compte.swift || '', agence: compte.agence || '' },
        beneficiaire: { nom: f.nom, adresse: f.adresse || '', banque: banqueBenef, numeroCompte: compteBenef, nif: f.nif || '' },
        montant: doc.montant, montantLettres: montantEnLettres(doc.montant, p.deviseLettres, p.subdivisionLettres),
        motif: doc.libelle, reference: doc.reference, annulee: false,
        creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
      });
      await ctx.col('operations').updateOne({ _id: op._id }, { $set: { ordreId: ordre._id, ordreNumero: ordre.numero } });
      await audit(ctx, user, 'Virement fournisseur', op.numero, `${doc.montant} → ${f.nom} (${banqueBenef}) – ordre ${ordre.numero}`);
      return { operation: { ...op, ordreId: ordre._id, ordreNumero: ordre.numero }, ordre };
    });
    broadcast('operations');
    return r;
  }

  /** Sortie par transfert en caisse : compte banque CRÉDITÉ + bon d'entrée caisse automatique. */
  async function transfertCaisse(user, body) {
    const r = await store.tx(async (ctx) => {
      const p = await getParametres(ctx);
      const { doc, compte } = await base(ctx, user, body, 'sortie');
      await verifierCloture(ctx, doc.date);
      await controlerBanque(ctx, compte, { date: doc.date, montant: doc.montant, sens: 'sortie' });
      doc.nature = 'transfert_caisse';
      doc.provenance = `${compte.banque} – ${compte.numero}`;
      doc.banqueDestinataire = 'Caisse';
      doc.categorie = 'Mouvement interne';
      doc.interne = true;
      doc.numero = await prochainNumero(ctx, 'BQ', doc.date);
      const op = await ctx.col('operations').insertOne(doc);
      const bon = await creerBon(ctx, user, p, {
        type: 'entree', date: doc.date, montant: doc.montant, libelle: doc.libelle,
        tiers: texte(body.porteur, 120) || `${compte.banque} (${compte.numero})`, categorie: 'Mouvement interne',
        origine: 'banque', operationId: op._id, interne: true, piece: op.numero + (doc.reference ? ` / ${doc.reference}` : ''),
      });
      await ctx.col('operations').updateOne({ _id: op._id }, { $set: { bonId: bon._id, bonNumero: bon.numero } });
      await audit(ctx, user, 'Transfert banque → caisse', op.numero, `${doc.montant} – bon d'entrée ${bon.numero}`);
      return { operation: { ...op, bonId: bon._id, bonNumero: bon.numero }, bon };
    });
    broadcast('operations');
    return r;
  }

  async function annulerOperation(user, id, motif) {
    motif = exigerTexte(motif, "Motif d'annulation", 250);
    const r = await store.tx(async (ctx) => {
      const op = await ctx.col('operations').findOne({ _id: id });
      if (!op) throw new ErreurMetier('Opération introuvable.', 404);
      if (op.annulee) throw new ErreurMetier('Opération déjà annulée.');
      const marque = { annulee: true, motifAnnulation: motif, annuleePar: user.identifiant, annuleeLe: now() };
      if (op.sens === 'entree' && !(await getParametres(ctx)).autoriserDecouvert) {
        // Retirer une entrée ne doit pas rendre le compte négatif.
        const compte = await ctx.col('comptes').findOne({ _id: op.compteId });
        const ops = (await ctx.col('operations').find({ compteId: op.compteId, annulee: { $ne: true } })).filter((o) => o._id !== id);
        verifierChronologie(compte.soldeInitial || 0, ops, { date: op.date, montant: 0, sens: 'entree' }, `Solde du compte ${compte.banque}`);
      }
      if (op.bonId) {
        const bon = await ctx.col('bons').findOne({ _id: op.bonId });
        await verifierCloture(ctx, bon.date);
        if (bon.type === 'entree') {
          // Retirer un approvisionnement ne doit pas rendre la caisse négative.
          const bons = (await ctx.col('bons').find({ annulee: { $ne: true } })).filter((b) => b._id !== bon._id);
          const p = await getParametres(ctx);
          verifierChronologie(p.soldeInitialCaisse || 0, bons.map((b) => ({ date: b.date, montant: b.montant, sens: b.type })),
            { date: bon.date, montant: 0, sens: 'entree' }, 'Solde de caisse');
        }
        await ctx.col('bons').updateOne({ _id: bon._id }, { $set: marque });
      }
      if (op.ordreId) await ctx.col('ordres').updateOne({ _id: op.ordreId }, { $set: marque });
      await ctx.col('operations').updateOne({ _id: id }, { $set: marque });
      await audit(ctx, user, 'Opération annulée', op.numero, `Motif : ${motif}`);
      return { ok: true };
    });
    broadcast('operations');
    return r;
  }

  /* --------------------------------------------------------------- Caisse */
  async function bonManuel(user, body) {
    const type = body.type === 'sortie' ? 'sortie' : body.type === 'entree' ? 'entree' : null;
    if (!type) throw new ErreurMetier('Type de bon invalide.');
    const r = await store.tx(async (ctx) => {
      const p = await getParametres(ctx);
      const date = exigerDate(body.date);
      const montant = exigerMontant(body.montant);
      await verifierCloture(ctx, date);
      const categorie = exigerTexte(body.categorie, 'Catégorie', 80);
      const cats = type === 'entree' ? p.categoriesEncaissement : p.categoriesDecaissement;
      if (!cats.includes(categorie)) throw new ErreurMetier('Catégorie inconnue.');
      if (type === 'sortie') await controlerCaisse(ctx, { date, montant, sens: 'sortie' });
      const bon = await creerBon(ctx, user, p, {
        type, date, montant, categorie,
        libelle: exigerTexte(body.libelle, 'Libellé', 250),
        tiers: exigerTexte(body.tiers, type === 'entree' ? 'Remettant' : 'Bénéficiaire', 160),
        piece: texte(body.piece, 80),
      });
      await audit(ctx, user, type === 'entree' ? 'Bon d\'entrée caisse' : 'Bon de sortie caisse', bon.numero, `${montant} – ${bon.libelle}`);
      return bon;
    });
    broadcast('bons');
    return r;
  }

  async function annulerBon(user, id, motif) {
    motif = exigerTexte(motif, "Motif d'annulation", 250);
    const r = await store.tx(async (ctx) => {
      const bon = await ctx.col('bons').findOne({ _id: id });
      if (!bon) throw new ErreurMetier('Bon introuvable.', 404);
      if (bon.annulee) throw new ErreurMetier('Bon déjà annulé.');
      if (bon.operationId) throw new ErreurMetier("Ce bon est lié à une opération bancaire : annulez l'opération bancaire correspondante.");
      await verifierCloture(ctx, bon.date);
      if (bon.type === 'entree') {
        const p = await getParametres(ctx);
        const bons = (await ctx.col('bons').find({ annulee: { $ne: true } })).filter((b) => b._id !== id);
        verifierChronologie(p.soldeInitialCaisse || 0, bons.map((b) => ({ date: b.date, montant: b.montant, sens: b.type })),
          { date: bon.date, montant: 0, sens: 'entree' }, 'Solde de caisse');
      }
      await ctx.col('bons').updateOne({ _id: id }, { $set: { annulee: true, motifAnnulation: motif, annuleePar: user.identifiant, annuleeLe: now() } });
      await audit(ctx, user, 'Bon annulé', bon.numero, `Motif : ${motif}`);
      return { ok: true };
    });
    broadcast('bons');
    return r;
  }

  async function cloturerJournee(user, date) {
    exigerDate(date);
    const r = await store.tx(async (ctx) => {
      const derniere = (await ctx.col('clotures').find({}, { sort: { date: -1 }, limit: 1 }))[0];
      if (derniere && date <= derniere.date) throw new ErreurMetier('Cette journée est déjà clôturée.');
      const lendemain = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
      const solde = await soldeCaisse(ctx, lendemain);
      const c = await ctx.col('clotures').insertOne({ date, soldeCloture: solde, cloturePar: user.identifiant, nomCloture: user.nom, clotureLe: now() });
      await audit(ctx, user, 'Clôture journalière de caisse', date, `Solde de clôture ${solde}`);
      return c;
    });
    broadcast('clotures');
    return r;
  }

  /* ------------------------------------------------- PV de contrôle de caisse */
  async function creerPV(user, body) {
    const r = await store.tx(async (ctx) => {
      const date = exigerDate(body.date);
      const lendemain = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
      const soldeTheorique = await soldeCaisse(ctx, lendemain);
      const billetage = (Array.isArray(body.billetage) ? body.billetage : [])
        .map((l) => ({ type: l.type === 'piece' ? 'piece' : 'billet', valeur: arrondi(l.valeur), quantite: Math.max(0, Math.floor(Number(l.quantite) || 0)) }))
        .filter((l) => l.valeur > 0)
        .map((l) => ({ ...l, total: arrondi(l.valeur * l.quantite) }));
      const autres = arrondi(body.autresValeurs || 0);
      const soldePhysique = arrondi(billetage.reduce((a, l) => a + l.total, 0) + autres);
      const doc = {
        numero: await prochainNumero(ctx, 'PV', date),
        date, heure: texte(body.heure, 5), soldeTheorique, billetage, autresValeurs: autres,
        libelleAutresValeurs: texte(body.libelleAutresValeurs, 120),
        soldePhysique, ecart: arrondi(soldePhysique - soldeTheorique),
        observations: texte(body.observations, 2000),
        caissier: texte(body.caissier, 120), controleur: texte(body.controleur, 120), temoin: texte(body.temoin, 120),
        creePar: user.identifiant, nomCreateur: user.nom, creeLe: now(),
      };
      const pv = await ctx.col('pv').insertOne(doc);
      await audit(ctx, user, 'PV de contrôle de caisse', pv.numero, `Théorique ${soldeTheorique}, physique ${soldePhysique}, écart ${doc.ecart}`);
      return pv;
    });
    broadcast('pv');
    return r;
  }

  /* -------------------------------------------------------------- Prévisions */
  async function getPrevisions(annee) {
    const d = await store.col('previsions').findOne({ _id: String(annee) });
    return d || { _id: String(annee), encaissements: {}, decaissements: {} };
  }
  async function setPrevisions(user, annee, body) {
    if (!/^\d{4}$/.test(String(annee))) throw new ErreurMetier('Année invalide.');
    const nettoie = (o) => {
      const r = {};
      for (const [cat, mois] of Object.entries(o || {})) {
        r[texte(cat, 80)] = Array.from({ length: 12 }, (_, i) => arrondi((Array.isArray(mois) ? mois[i] : 0) || 0));
      }
      return r;
    };
    const doc = { encaissements: nettoie(body.encaissements), decaissements: nettoie(body.decaissements), majLe: now(), majPar: user.identifiant };
    await store.tx(async (ctx) => {
      await ctx.col('previsions').updateOne({ _id: String(annee) }, { $set: doc }, { upsert: true });
      await audit(ctx, user, 'Prévisions de trésorerie modifiées', String(annee));
    });
    broadcast('previsions');
    return getPrevisions(annee);
  }

  return {
    ErreurMetier, getParametres, setParametres, listeComptes, listeFournisseurs, enregistrerCompte, enregistrerFournisseur,
    soldeBanque, soldeCaisse, entreeBanque, versementCaisse, virementFournisseur, transfertCaisse, annulerOperation,
    bonManuel, annulerBon, cloturerJournee, creerPV, getPrevisions, setPrevisions, audit, exigerDate, texte, arrondi,
  };
}

module.exports = { createServices, ErreurMetier, PARAMETRES_DEFAUT };
