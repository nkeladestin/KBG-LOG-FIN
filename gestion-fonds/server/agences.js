'use strict';
/* =====================================================================
   Agences : cloisonnement des données.
   - Chaque donnée opérationnelle (banque, caisse, PV, prévisions, stock, audit) porte un agenceId.
   - Pendant une requête, l'agence en vigueur est mémorisée (AsyncLocalStorage) :
       · utilisateur rattaché à une agence  → uniquement cette agence (imposé par le serveur) ;
       · administrateur / accès « toutes agences » → l'agence choisie dans l'en-tête, ou toutes.
   - vueAgence() enveloppe le stockage : toute lecture est filtrée sur l'agence, toute création
     y est rattachée. Il est donc impossible de lire ou d'écrire les données d'une autre agence.
   - Hors requête (tâches automatiques, synchronisation), l'accès est complet.
   ===================================================================== */
const { AsyncLocalStorage } = require('async_hooks');

const contexte = new AsyncLocalStorage();

const PAR_AGENCE = new Set([
  'comptes', 'operations', 'ordres', 'bons', 'clotures', 'pv', 'previsions', 'audit',
  'cmd_bons', 'cmd_mouvements', 'cmd_livraisons',
]);
const SIEGE = 'siege';

class ErreurAgence extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** undefined : hors requête (accès complet) ; null : toutes les agences ; 'id' : une agence. */
function agenceCourante() {
  const c = contexte.getStore();
  return c ? c.agence : undefined;
}
const dansAgence = (agence, fn) => contexte.run({ agence }, fn);

const CHOISIR = "Choisissez d'abord l'agence concernée (sélecteur « Agence » en haut de l'écran).";

function envelopperCol(c, nom, a) {
  if (!PAR_AGENCE.has(nom) || a === undefined) return c;
  const strict = (f = {}) => (a ? { ...f, agenceId: a } : f);
  // Siège : inclut aussi les données sans agence (saisies par un poste encore en ancienne version,
  // avant leur rattachement automatique).
  const filtre = (f = {}) => (a === SIEGE && !f.$or ? { ...f, $or: [{ agenceId: a }, { agenceId: { $exists: false } }] } : strict(f));
  const poser = (doc) => {
    if (a) return { ...doc, agenceId: a };
    if (doc.agenceId || nom === 'audit') return doc;
    throw new ErreurAgence(CHOISIR);
  };
  // Une donnée ne change jamais d'agence par une simple modification.
  const proteger = (u) => {
    if (!u || !u.$set || !('agenceId' in u.$set)) return u;
    const { agenceId, ...reste } = u.$set; // eslint-disable-line no-unused-vars
    return { ...u, $set: reste };
  };
  const avecInsertion = (o, u) => {
    if (!(o && o.upsert)) return u;
    if (!a) throw new ErreurAgence(CHOISIR);
    return u; // le filtre contient agenceId : il est repris à la création
  };
  return {
    find: (f, o) => c.find(filtre(f), o),
    findOne: (f) => c.findOne(filtre(f)),
    insertOne: (doc) => c.insertOne(poser(doc)),
    updateOne: (f, u, o) => c.updateOne((o && o.upsert ? strict : filtre)(f), avecInsertion(o, proteger(u)), o),
    findOneAndUpdate: (f, u, o) => c.findOneAndUpdate((o && o.upsert ? strict : filtre)(f), avecInsertion(o, proteger(u)), o),
    countDocuments: (f) => c.countDocuments(filtre(f)),
    deleteMany: (f) => c.deleteMany(filtre(f)),
  };
}

/** Vue du stockage restreinte à l'agence en vigueur (les autres fonctions sont transmises telles quelles). */
function vueAgence(lireStore) {
  return new Proxy({}, {
    get(_, prop) {
      const store = lireStore();
      if (prop === 'col') return (nom, ...r) => envelopperCol(store.col(nom, ...r), nom, agenceCourante());
      if (prop === 'tx') {
        return (fn) => {
          const a = agenceCourante();
          return store.tx((ctx) => fn({ ...ctx, col: (nom) => envelopperCol(ctx.col(nom), nom, a) }));
        };
      }
      const v = store[prop];
      return typeof v === 'function' ? v.bind(store) : v;
    },
    set(_, prop, v) { lireStore()[prop] = v; return true; },
  });
}

/**
 * Migration (idempotente, relancée régulièrement) : agence « Siège » par défaut et rattachement
 * des données qui n'ont pas encore d'agence (données existantes ou saisies par une ancienne version).
 */
async function migrerAgences(store) {
  let n = 0;
  if (!(await store.col('agences').findOne({ _id: SIEGE }))) {
    const p = (await store.col('parametres').findOne({ _id: 'general' })) || {};
    await store.col('agences').updateOne({ _id: SIEGE }, { $set: {
      code: 'SIEGE', nom: 'Siège', ville: (p.entreprise && p.entreprise.ville) || '', adresse: '', telephone: '', responsable: '',
      soldeInitialCaisse: Number(p.soldeInitialCaisse) || 0, actif: true, semence: true, creeLe: new Date().toISOString(),
    } }, { upsert: true });
  }
  // Les utilisateurs autres que les administrateurs sont des responsables d'agence : sans agence, ils relèvent du Siège.
  for (const u of await store.col('utilisateurs').find({ role: { $ne: 'admin' } })) {
    if (!u.supprime && !u.agenceId) { await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: { agenceId: SIEGE } }); n += 1; }
  }
  for (const nom of PAR_AGENCE) {
    if (nom === 'audit') continue; // l'historique d'audit antérieur reste consolidé (visible du siège)
    for (const d of await store.col(nom).find({ agenceId: { $exists: false } })) {
      const maj = { agenceId: SIEGE };
      if (nom === 'previsions' && !d.annee) maj.annee = String(d._id);
      await store.col(nom).updateOne({ _id: d._id }, { $set: maj });
      n += 1;
    }
  }
  return n;
}

module.exports = { contexte, agenceCourante, dansAgence, vueAgence, migrerAgences, PAR_AGENCE, SIEGE, ErreurAgence, CHOISIR };
