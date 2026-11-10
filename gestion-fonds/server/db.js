'use strict';
/**
 * Couche d'accès aux données.
 *  - MongoStore  : MongoDB Atlas (production) avec transactions et flux de changements (temps réel).
 *  - MemoryStore : stockage en mémoire, uniquement pour une démonstration locale ou des tests.
 * Les deux exposent la même interface : col(nom), tx(fn), watch(cb), close().
 */
const crypto = require('crypto');

const COLLECTIONS = [
  'parametres', 'comptes', 'fournisseurs', 'operations', 'ordres', 'bons',
  'clotures', 'pv', 'previsions', 'audit', 'utilisateurs', 'roles', 'compteurs',
  // Agences et stock par bons de commande
  'agences', 'cmd_regions', 'cmd_unites', 'cmd_articles', 'cmd_types', 'cmd_bons', 'cmd_mouvements', 'cmd_livraisons',
];

const newId = () => crypto.randomUUID();

/* ------------------------------------------------------------------ MongoDB */
const horodater = (update) => ({ ...update, $set: { ...(update.$set || {}), _maj: new Date().toISOString() } });

class MongoStore {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.txSupported = true;
  }

  async connect() {
    // Chargé ici pour que le mode mémoire fonctionne sans le pilote installé.
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, {
      retryWrites: true,
      w: 'majority',
      readConcernLevel: 'majority',
      serverSelectionTimeoutMS: 15000,
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    const existing = new Set((await this.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const name of COLLECTIONS) {
      if (!existing.has(name)) await this.db.createCollection(name);
    }
    await Promise.all([
      this.db.collection('operations').createIndex({ date: 1, numero: 1 }),
      this.db.collection('operations').createIndex({ compteId: 1, date: 1 }),
      this.db.collection('bons').createIndex({ date: 1, numero: 1 }),
      this.db.collection('ordres').createIndex({ date: 1 }),
      this.db.collection('pv').createIndex({ date: 1 }),
      this.db.collection('audit').createIndex({ quand: -1 }),
      this.db.collection('utilisateurs').createIndex({ identifiant: 1 }, { unique: true }),
      this.db.collection('cmd_mouvements').createIndex({ agenceId: 1, date: 1 }),
      this.db.collection('cmd_livraisons').createIndex({ agenceId: 1, bonId: 1 }),
      this.db.collection('cmd_bons').createIndex({ agenceId: 1, dateBon: -1 }),
      this.db.collection('operations').createIndex({ agenceId: 1, date: 1 }),
      this.db.collection('bons').createIndex({ agenceId: 1, date: 1 }),
    ]);
  }

  col(name, session) {
    const c = this.db.collection(name);
    const opt = (o = {}) => (session ? { ...o, session } : o);
    return {
      find: (filter = {}, o = {}) => {
        let cur = c.find(filter, opt());
        if (o.sort) cur = cur.sort(o.sort);
        if (o.limit) cur = cur.limit(o.limit);
        return cur.toArray();
      },
      findOne: (filter) => c.findOne(filter, opt()),
      insertOne: async (doc) => {
        // _maj : date de modification, utilisée par les PC en double stockage pour récupérer les nouveautés.
        const d = { _id: newId(), ...doc, _maj: new Date().toISOString() };
        await c.insertOne(d, opt());
        return d;
      },
      updateOne: (filter, update, o = {}) => c.updateOne(filter, horodater(update), opt(o)),
      findOneAndUpdate: async (filter, update, o = {}) => {
        const r = await c.findOneAndUpdate(filter, horodater(update), opt({ returnDocument: 'after', ...o }));
        // pilote v5 : { value, ok } ; pilote v6 : le document directement
        return r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
      },
      countDocuments: (filter = {}) => c.countDocuments(filter, opt()),
      deleteMany: (filter) => c.deleteMany(filter, opt()),
    };
  }

  /** Exécute fn dans une transaction ACID (Atlas = replica set, donc supporté). */
  async tx(fn) {
    if (!this.txSupported) return fn({ col: (n) => this.col(n) });
    const session = this.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn({ col: (n) => this.col(n, session) });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      return result;
    } catch (e) {
      // Serveur MongoDB autonome (hors Atlas) : pas de transactions.
      if (e && (e.code === 20 || /replica set|Transaction numbers/i.test(e.message || ''))) {
        console.warn('[db] Transactions non supportées par ce serveur, exécution sans transaction.');
        this.txSupported = false;
        return fn({ col: (n) => this.col(n) });
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }

  /** Flux de changements MongoDB : toute écriture (même depuis une autre instance) est signalée. */
  watch(cb) {
    try {
      const stream = this.db.watch([], { fullDocument: 'default' });
      stream.on('change', (ch) => cb({ collection: ch.ns && ch.ns.coll, type: ch.operationType, id: ch.documentKey && ch.documentKey._id }));
      stream.on('error', (e) => console.warn('[db] Flux de changements interrompu :', e.message));
      return () => stream.close();
    } catch (e) {
      console.warn('[db] Flux de changements indisponible :', e.message);
      return () => {};
    }
  }

  close() { return this.client && this.client.close(); }
}

/* ------------------------------------------------------- Mémoire (démo/tests) */
function getPath(doc, key) { return doc == null ? undefined : doc[key]; }

function matchValue(v, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, x]) => {
      switch (op) {
        case '$gte': return v >= x;
        case '$gt': return v > x;
        case '$lte': return v <= x;
        case '$lt': return v < x;
        case '$ne': return v !== x && !(x === null && v === undefined);
        case '$in': return x.includes(v);
        case '$nin': return !x.includes(v);
        case '$exists': return (v !== undefined) === !!x;
        default: throw new Error('Opérateur non géré en mode mémoire : ' + op);
      }
    });
  }
  if (cond === null) return v === null || v === undefined;
  return v === cond;
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    return matchValue(getPath(doc, k), cond);
  });
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, v] of Object.entries(fields)) {
      if (op === '$set') doc[k] = v;
      else if (op === '$inc') doc[k] = (doc[k] || 0) + v;
      else if (op === '$setOnInsert') { /* traité à l'insertion */ }
      else throw new Error('Opérateur de mise à jour non géré : ' + op);
    }
  }
}

const clone = (x) => (x == null ? x : structuredClone(x));
const cle = (col, id) => `${col}\u0000${id}`;

/**
 * Stockage en mémoire. Toutes les écritures passent par des transactions sérialisées :
 * une écriture hors transaction est automatiquement encapsulée dans sa propre transaction.
 * Les classes dérivées (LocalStore) surchargent _valider() pour rendre les changements durables.
 */
class MemoryStore {
  constructor() {
    this.data = Object.fromEntries(COLLECTIONS.map((n) => [n, []]));
    this.listeners = new Set();
    this.lock = Promise.resolve();
    this._chg = null; // changements de la transaction en cours : Map(clé → {col, id, doc|null})
  }
  async connect() {}

  _ecrit(name, d, supprime = false) {
    if (!supprime) d._maj = new Date().toISOString();
    if (this._chg) this._chg.set(cle(name, d._id), { col: name, id: d._id, doc: supprime ? null : d });
  }

  col(name, enTx = false) {
    const arr = () => this.data[name];
    // Écriture hors transaction : encapsulée dans une transaction (sérialisation + durabilité).
    const ecrire = (methode, fn) => (...args) => (enTx ? fn(...args) : this.tx((ctx) => ctx.col(name)[methode](...args)));
    const upsertDoc = (filter, update) => {
      const d = { _id: newId() };
      for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && (typeof v !== 'object' || v === null)) d[k] = v;
      if (update.$setOnInsert) Object.assign(d, update.$setOnInsert);
      applyUpdate(d, update);
      arr().push(d);
      return d;
    };
    return {
      find: async (filter = {}, o = {}) => {
        let r = arr().filter((d) => matches(d, filter));
        if (o.sort) {
          const keys = Object.entries(o.sort);
          r.sort((a, b) => {
            for (const [k, dir] of keys) {
              if (a[k] < b[k]) return -dir;
              if (a[k] > b[k]) return dir;
            }
            return 0;
          });
        }
        if (o.limit) r = r.slice(0, o.limit);
        return clone(r);
      },
      findOne: async (filter) => clone(arr().find((d) => matches(d, filter)) || null),
      insertOne: ecrire('insertOne', async (doc) => {
        const d = { _id: newId(), ...clone(doc) };
        if (name === 'utilisateurs' && arr().some((u) => u.identifiant === d.identifiant)) {
          const e = new Error('duplicate key'); e.code = 11000; throw e;
        }
        arr().push(d); this._ecrit(name, d);
        return clone(d);
      }),
      updateOne: ecrire('updateOne', async (filter, update, o = {}) => {
        let d = arr().find((x) => matches(x, filter));
        if (d) applyUpdate(d, update);
        else if (o.upsert) d = upsertDoc(filter, update);
        if (d) this._ecrit(name, d);
        return { matchedCount: d ? 1 : 0 };
      }),
      findOneAndUpdate: ecrire('findOneAndUpdate', async (filter, update, o = {}) => {
        let d = arr().find((x) => matches(x, filter));
        if (d) applyUpdate(d, update);
        else if (o.upsert) d = upsertDoc(filter, update);
        if (d) this._ecrit(name, d);
        return clone(d || null);
      }),
      countDocuments: async (filter = {}) => arr().filter((d) => matches(d, filter)).length,
      deleteMany: ecrire('deleteMany', async (filter) => {
        const supprimes = arr().filter((d) => matches(d, filter));
        this.data[name] = arr().filter((d) => !matches(d, filter));
        supprimes.forEach((d) => this._ecrit(name, d, true));
        return { deletedCount: supprimes.length };
      }),
    };
  }

  /** Exécute fn sous verrou ; en cas d'erreur, l'état précédent est restauré. */
  sousVerrou(fn) {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => {});
    return p;
  }

  async tx(fn) {
    return this.sousVerrou(async () => {
      const snapshot = structuredClone(this.data);
      this._chg = new Map();
      try {
        const r = await fn({ col: (n) => this.col(n, true) });
        const chg = this._chg;
        this._chg = null;
        if (chg.size) { await this._valider([...chg.values()]); this._signaler(chg.values()); }
        return r;
      } catch (e) {
        this.data = snapshot; this._chg = null;
        throw e;
      }
    });
  }

  /** Point d'extension : rend durable un lot de changements validés. */
  async _valider() {}

  _signaler(changements) {
    const cols = new Set([...changements].map((c) => c.col));
    for (const c of cols) this.listeners.forEach((cb) => cb({ collection: c }));
  }

  watch(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  close() {}
}

module.exports = { MongoStore, MemoryStore, newId, COLLECTIONS, clone, cle };
