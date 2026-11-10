'use strict';
/**
 * Stockage LOCAL durable (sur le disque du PC).
 *
 *  donnees/base.json        instantané complet (données + file d'envoi vers le cloud)
 *  donnees/journal.ndjson   journal des transactions validées depuis l'instantané (écrit et synchronisé
 *                           sur disque avant que l'opération soit confirmée à l'utilisateur)
 *  donnees/sauvegardes/     copie quotidienne automatique de la base (30 derniers jours)
 *
 * Au démarrage : lecture de l'instantané puis rejeu du journal ⇒ aucune perte, même en cas de coupure.
 * La « file d'envoi » (outbox) liste les documents modifiés localement et pas encore confirmés par
 * MongoDB Atlas ; le module sync.js la vide dès que le cloud est joignable.
 */
const fs = require('fs');
const path = require('path');
const { MemoryStore, COLLECTIONS, clone, cle } = require('./db');

/** Collections propres à chaque poste, jamais envoyées vers le cloud. */
const LOCALES = new Set(['compteurs']);
const SYNCHRONISEES = COLLECTIONS.filter((c) => !LOCALES.has(c));
const SEUIL_LIGNES = 400;
const SEUIL_OCTETS = 8 * 1024 * 1024;
const JOURS_SAUVEGARDE = 30;

class LocalStore extends MemoryStore {
  constructor(dossier) {
    super();
    this.dossier = dossier;
    this.fBase = path.join(dossier, 'base.json');
    this.fJournal = path.join(dossier, 'journal.ndjson');
    this.dSauv = path.join(dossier, 'sauvegardes');
    this.outbox = new Map(); // clé → { seq, col, id }
    this.seq = 0;
    this.meta = {};
    this.lignes = 0;
    this.declencheur = null; // appelé après chaque validation (synchronisation)
  }

  async connect() {
    fs.mkdirSync(this.dSauv, { recursive: true });
    if (fs.existsSync(this.fBase)) {
      const b = JSON.parse(fs.readFileSync(this.fBase, 'utf8'));
      for (const c of COLLECTIONS) this.data[c] = (b.data && b.data[c]) || [];
      for (const e of b.outbox || []) this.outbox.set(cle(e.col, e.id), e);
      this.seq = b.seq || 0;
      this.meta = b.meta || {};
    }
    let rejouees = 0;
    if (fs.existsSync(this.fJournal)) {
      const lignes = fs.readFileSync(this.fJournal, 'utf8').split('\n');
      for (const l of lignes) {
        if (!l.trim()) continue;
        let o;
        try { o = JSON.parse(l); } catch { console.warn('[local] Dernière ligne du journal incomplète ignorée (arrêt brutal).'); break; }
        this._rejouer(o);
        rejouees += 1;
      }
    }
    this._compacter();
    console.log(`Stockage local : ${this.dossier} (${this.compter()} documents${rejouees ? `, ${rejouees} transaction(s) récupérée(s) du journal` : ''})`);
  }

  compter() { return COLLECTIONS.reduce((a, c) => a + this.data[c].length, 0); }
  estVide() { return SYNCHRONISEES.every((c) => !this.data[c].length); }

  /* ------------------------------------------------------- écriture disque */
  _ecrireLigne(o) {
    const fd = fs.openSync(this.fJournal, 'a');
    try { fs.writeSync(fd, `${JSON.stringify(o)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.lignes += 1;
  }

  _compacter() {
    const tmp = `${this.fBase}.tmp`;
    const contenu = JSON.stringify({ v: 1, enregistreLe: new Date().toISOString(), data: this.data, outbox: [...this.outbox.values()], seq: this.seq, meta: this.meta });
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, contenu); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.fBase);
    fs.writeFileSync(this.fJournal, '');
    this.lignes = 0;
    this._sauvegardeDuJour();
  }

  _sauvegardeDuJour() {
    const jour = new Date().toISOString().slice(0, 10);
    const f = path.join(this.dSauv, `base-${jour}.json`);
    if (!fs.existsSync(f)) fs.copyFileSync(this.fBase, f);
    const anciennes = fs.readdirSync(this.dSauv).filter((n) => /^base-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    for (const n of anciennes.slice(0, Math.max(0, anciennes.length - JOURS_SAUVEGARDE))) fs.rmSync(path.join(this.dSauv, n), { force: true });
  }

  _peutEtreCompacter() {
    if (this.lignes < SEUIL_LIGNES) {
      try { if (fs.statSync(this.fJournal).size < SEUIL_OCTETS) return; } catch { return; }
    }
    this._compacter();
  }

  /* ------------------------------------------------------------ rejeu */
  _poser(col, id, doc) {
    const arr = this.data[col];
    const i = arr.findIndex((d) => d._id === id);
    if (doc) { if (i >= 0) arr[i] = doc; else arr.push(doc); } else if (i >= 0) arr.splice(i, 1);
  }

  _rejouer(o) {
    if (o.c) for (const c of o.c) this._poser(c.col, c.id, c.doc);
    if (o.r) for (const c of o.r) this._poser(c.col, c.id, c.doc);
    if (o.o) for (const [col, id, seq] of o.o) { this.outbox.set(cle(col, id), { seq, col, id }); this.seq = Math.max(this.seq, seq); }
    if (o.a) for (const [k, seq] of o.a) { const e = this.outbox.get(k); if (e && e.seq === seq) this.outbox.delete(k); }
    if (o.m) Object.assign(this.meta, o.m);
  }

  /** Appelé par MemoryStore.tx après succès : la transaction est écrite sur disque avant confirmation. */
  async _valider(changements) {
    const c = changements.map((x) => ({ col: x.col, id: x.id, doc: x.doc ? clone(x.doc) : null }));
    const o = c.filter((x) => !LOCALES.has(x.col)).map((x) => [x.col, x.id, ++this.seq]);
    this._ecrireLigne({ c, o });
    for (const [col, id, seq] of o) this.outbox.set(cle(col, id), { seq, col, id });
    this._peutEtreCompacter();
    if (o.length && this.declencheur) this.declencheur();
  }

  /* --------------------------------------------- interface avec sync.js */
  /** Documents à envoyer au cloud (état local actuel ; doc null = suppression). */
  aEnvoyer(max = 500) {
    return [...this.outbox.values()].sort((a, b) => a.seq - b.seq).slice(0, max).map((e) => ({
      ...e, doc: clone(this.data[e.col].find((d) => d._id === e.id) || null),
    }));
  }

  /** Le cloud a confirmé ces envois. */
  acquitter(entrees) {
    if (!entrees.length) return Promise.resolve();
    return this.sousVerrou(async () => {
      const a = entrees.map((e) => [cle(e.col, e.id), e.seq]);
      this._ecrireLigne({ a });
      this._rejouer({ a });
      this._peutEtreCompacter();
    });
  }

  /** Applique des documents reçus du cloud (sauf ceux modifiés localement et pas encore envoyés). */
  appliquerDistant(col, docs, supprimes = [], options = {}) {
    if (LOCALES.has(col) || !this.data[col]) return Promise.resolve(0);
    return this.sousVerrou(async () => {
      const r = []; const abandons = [];
      for (const doc of docs) {
        const cur = this.data[col].find((d) => d._id === doc._id);
        const k = cle(col, doc._id);
        if (this.outbox.has(k)) {
          // Première liaison d'un poste qui a travaillé seul : le cloud est prioritaire sur les données
          // présentes des deux côtés (la modification locale en attente est abandonnée).
          if (options.prioriteCloud) abandons.push([k, this.outbox.get(k).seq]);
          // Sinon, une modification locale en attente n'est jamais écrasée… sauf un élément par défaut
          // (« semence ») créé au premier démarrage, que la version du cloud remplace.
          else if (!(cur && cur.semence && !doc.semence)) continue;
        }
        if (cur && JSON.stringify(cur) === JSON.stringify(doc)) continue;
        r.push({ col, id: doc._id, doc });
      }
      for (const id of supprimes) {
        const k = cle(col, id);
        if (!this.data[col].some((d) => d._id === id)) continue;
        if (this.outbox.has(k)) { if (!options.prioriteCloud) continue; abandons.push([k, this.outbox.get(k).seq]); }
        r.push({ col, id, doc: null });
      }
      if (abandons.length) { this._ecrireLigne({ a: abandons }); this._rejouer({ a: abandons }); }
      if (!r.length) return 0;
      this._ecrireLigne({ r });
      this._rejouer({ r });
      this._peutEtreCompacter();
      this._signaler(r);
      return r.length;
    });
  }

  /** Remet tous les documents dans la file d'envoi (reconstruction complète du cloud). */
  toutRenvoyer() {
    return this.sousVerrou(async () => {
      const o = [];
      for (const col of SYNCHRONISEES) for (const d of this.data[col]) o.push([col, d._id, ++this.seq]);
      this._ecrireLigne({ o });
      this._rejouer({ o });
      this._compacter();
      if (this.declencheur) this.declencheur();
      return o.length;
    });
  }

  majMeta(m) {
    return this.sousVerrou(async () => { this._ecrireLigne({ m }); this._rejouer({ m }); });
  }

  /** Copie complète (sauvegarde téléchargeable). */
  exporter() { return { format: 'gestion-fonds', version: 1, exporteLe: new Date().toISOString(), data: this.data }; }

  close() { try { this._compacter(); } catch (e) { console.warn('[local]', e.message); } }
}

module.exports = { LocalStore, SYNCHRONISEES, LOCALES };
