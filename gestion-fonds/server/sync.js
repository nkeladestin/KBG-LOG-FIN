'use strict';
/**
 * Synchronisation bidirectionnelle stockage local ⇄ MongoDB Atlas.
 *
 *  - ENVOI   : la file d'envoi locale est poussée vers Atlas (remplacement par _id, idempotent),
 *              puis acquittée. Hors ligne, elle s'accumule et part automatiquement au retour du réseau.
 *  - RÉCEPTION : téléchargement complet au premier contact, puis flux de changements Atlas
 *              (temps réel entre postes) + relevé périodique des documents modifiés (_maj).
 *  - CONFLITS : un document modifié localement et pas encore envoyé n'est jamais écrasé ;
 *              ensuite, la dernière écriture l'emporte.
 *  - NUMÉROTATION : en ligne, les numéros (BQ, OV, BEC, BSC, PV) sont attribués par Atlas, donc
 *              uniques entre tous les postes ; hors ligne, ils portent le code du poste.
 *  - LIAISON : directe (chaîne MongoDB Atlas) ou PAR LE SERVEUR EN LIGNE (jeton de poste, sans
 *              mot de passe de la base sur l'ordinateur) — même fonctionnement dans les deux cas.
 */
const { MongoStore } = require('./db');
const { RelaisDistant } = require('./relais');
const { SYNCHRONISEES } = require('./local');

const MARGE_RELEVE = 10 * 60 * 1000; // tolérance de décalage d'horloge entre postes
const delai = (ms) => new Promise((r) => setTimeout(r, ms));
const avecDelai = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

class Synchro {
  constructor(local, uri, nomBase, poste) {
    this.local = local;
    this.uri = uri;
    this.nomBase = nomBase;
    this.poste = poste;
    this.enLigne = false;
    this.etatCloud = 'connexion';
    this.erreur = '';
    this.conflits = [];
    this.dernierEnvoi = null;
    this.derniereReception = local.meta.dernierPull || null;
    this.enCours = false;
    this.attente = 5000;
    this.minuteur = null;
    this.parServeur = !!(uri && uri.relais);
    local.declencheur = () => this.declencher();
    local.allouerNumero = (ctx, prefixe, annee) => this.allouerNumero(ctx, prefixe, annee);
  }

  etat() {
    return {
      mode: 'double', liaison: this.parServeur ? 'serveur' : 'atlas', poste: this.poste, local: { ok: true, dossier: this.local.dossier, documents: this.local.compter() },
      cloud: this.etatCloud, enLigne: this.enLigne, enAttente: this.local.outbox.size,
      dernierEnvoi: this.dernierEnvoi, derniereReception: this.derniereReception, erreur: this.erreur,
      conflits: this.conflits.slice(-20),
    };
  }

  /* -------------------------------------------------------- connexion */
  demarrer() { this._connecterEnBoucle(); this.horloge = setInterval(() => this._cycle(false), 60000); this.horloge.unref(); }

  /** Premier démarrage d'un poste vierge : récupère d'abord les données existantes du cloud. */
  async premiereConnexion(maxMs) {
    try { await avecDelai(this._connecter(), maxMs, 'délai dépassé'); return true; } catch (e) { this._horsLigne(e); return false; }
  }

  async _connecterEnBoucle() {
    while (!this.arrete) {
      if (!this.enLigne) {
        try { await this._connecter(); this.attente = 3000; } catch (e) { this._horsLigne(e); this.attente = this.etatCloud === 'refuse' ? 300000 : this.etatCloud === 'suspendu' ? 2000 : Math.min(this.attente * 2, 30000); }
      }
      await this._attendre(this.enLigne ? 15000 : this.attente);
    }
  }

  /** Pause de la boucle de connexion, interrompue dès qu'une coupure est détectée (reprise rapide). */
  _attendre(ms) {
    return new Promise((r) => { this._reveil = r; this._minuterieBoucle = setTimeout(() => { this._reveil = null; r(); }, ms); });
  }

  _connecter() {
    if (this.enLigne) return Promise.resolve();
    if (!this.pConnexion) this.pConnexion = this._connecterReel().finally(() => { this.pConnexion = null; });
    return this.pConnexion;
  }

  async _connecterReel() {
    this.etatCloud = 'connexion';
    const distant = this.parServeur ? new RelaisDistant(this.uri.relais, this.uri.jeton) : new MongoStore(this.uri, this.nomBase);
    await distant.connect();
    this.distant = distant;
    this.db = distant.db;
    this.enLigne = true; this.etatCloud = 'connecte'; this.erreur = '';
    console.log(this.parServeur ? `[sync] Relié au cloud par le serveur en ligne (${this.uri.relais}).` : '[sync] Connecté à MongoDB Atlas.');
    await this._alignerCompteurs();
    const premiere = !this.local.meta.pullInitial;
    await this._recevoir(premiere);
    if (premiere) await this._oublierComptesLocaux();
    if (premiere) await this.local.majMeta({ pullInitial: new Date().toISOString() });
    await this._envoyer();
    if (this.arrete) { this._horsLigne(new Error('synchronisation arrêtée')); return; }
    this._ecouter();
  }

  _horsLigne(e) {
    if (this.enLigne) console.warn('[sync] Cloud injoignable, poursuite en local :', e.message);
    this.enLigne = false; this.etatCloud = e && e.status === 401 ? 'refuse' : e && e.status === 423 ? 'suspendu' : 'hors_ligne'; this.erreur = e.message;
    // Titulaire du poste suspendu : l'écran de ce poste se bloque aussi (réactivation automatique ensuite).
    if (e && e.status === 423 && this.surSuspension) this.surSuspension(e.utilisateur).catch(() => {});
    if (this._reveil) {
      const r = this._reveil; this._reveil = null; clearTimeout(this._minuterieBoucle);
      setTimeout(r, e && e.status === 423 ? 2000 : 1000);
    }
    if (this.flux) { try { this.flux.close(); } catch { /* déjà fermé */ } this.flux = null; }
    if (this.distant) { const d = this.distant; this.distant = null; d.close().catch(() => {}); }
  }

  /* --------------------------------------------------------------- envoi */
  declencher() {
    clearTimeout(this.minuteur);
    this.minuteur = setTimeout(() => this._cycle(true), 30);
  }

  /**
   * Cloud prioritaire : après un enregistrement, attend que le cloud l'ait confirmé (au plus « ms »).
   * Retourne vrai si tout est dans le cloud, faux si des données restent en attente sur ce poste.
   */
  async attendreEnvoi(ms = 6000) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      if (!this.local.outbox.size) return true;
      if (!this.enLigne) return false;
      if (!this.enCours) this._cycle(true);
      await delai(60);
    }
    return !this.local.outbox.size;
  }

  async _cycle(envoiSeul) {
    if (!this.enLigne || this.enCours) return;
    this.enCours = true;
    try {
      await this._envoyer();
      if (!envoiSeul) await this._recevoir(false);
    } catch (e) { this._horsLigne(e); } finally { this.enCours = false; }
  }

  async synchroniserMaintenant() {
    if (!this.enLigne) {
      try { await avecDelai(this._connecter(), 20000, 'délai de connexion dépassé'); } catch (e) { this._horsLigne(e); }
    } else {
      while (this.enCours) await delai(100);
      await this._cycle(false);
    }
    return this.etat();
  }

  async _envoyer() {
    for (;;) {
      const lot = this.local.aEnvoyer(500);
      if (!lot.length) return;
      const parCol = new Map();
      for (const e of lot) { if (!parCol.has(e.col)) parCol.set(e.col, []); parCol.get(e.col).push(e); }
      const acquis = [];
      for (const [col, entrees] of parCol) {
        // Horodatage au moment de l'envoi : une donnée saisie hors ligne reste visible des autres postes.
        const envoi = new Date().toISOString();
        const ops = entrees.map((e) => (e.doc
          ? { replaceOne: { filter: { _id: e.id }, replacement: { ...e.doc, _maj: envoi }, upsert: true } }
          : { deleteOne: { filter: { _id: e.id } } }));
        try {
          await this.db.collection(col).bulkWrite(ops, { ordered: false });
          acquis.push(...entrees);
        } catch (err) {
          // Erreurs de doublon (ex. même identifiant d'utilisateur créé sur deux postes hors ligne) :
          // le document en conflit est écarté et signalé ; les autres sont acquittés.
          // Refus du serveur en ligne (hors du périmètre du poste) : signalés, sans bloquer la file.
          const fautes = (err.writeErrors || []).map((w) => (w.err || w)).filter((w) => w.code === 11000 || w.motif !== undefined);
          if (!fautes.length) throw err;
          const enConflit = new Map(fautes.map((w) => [w.index, w]));
          entrees.forEach((e, i) => {
            acquis.push(e);
            const w = enConflit.get(i);
            if (w && w.motif !== 'semence') this.conflits.push({ quand: new Date().toISOString(), collection: col, id: e.id, motif: w.motif || 'Doublon refusé par le cloud' });
          });
        }
      }
      await this.local.acquitter(acquis);
      this.dernierEnvoi = new Date().toISOString();
    }
  }

  /* ----------------------------------------------------------- réception */
  async _recevoir(complet) {
    const debut = new Date();
    const depuis = !complet && this.local.meta.dernierPull
      ? new Date(Date.parse(this.local.meta.dernierPull) - MARGE_RELEVE).toISOString() : null;
    let n = 0;
    if (complet) this.idsCloud = {};
    for (const col of SYNCHRONISEES) {
      const docs = await this.db.collection(col).find(depuis ? { _maj: { $gte: depuis } } : {}).toArray();
      if (complet) this.idsCloud[col] = new Set(docs.map((d) => d._id));
      n += await this.local.appliquerDistant(col, docs, [], { prioriteCloud: complet && !this.local.meta.pullInitial });
    }
    this.derniereReception = debut.toISOString();
    await this.local.majMeta({ dernierPull: this.derniereReception });
    if (n) console.log(`[sync] ${n} document(s) reçu(s) du cloud.`);
  }

  /**
   * Première liaison d'un poste qui a fonctionné seul : les comptes et rôles qui n'existent que sur ce
   * poste ne sont jamais envoyés au cloud (un compte créé sur un PC isolé ne doit pas devenir un accès
   * au cloud) ; ils sont retirés du poste, qui utilise désormais les comptes du cloud.
   */
  async _oublierComptesLocaux() {
    for (const col of ['utilisateurs', 'roles']) {
      const cloud = (this.idsCloud && this.idsCloud[col]) || new Set();
      const locaux = (await this.local.col(col).find({})).filter((d) => !cloud.has(d._id) && !(col === 'roles' && d.semence)).map((d) => d._id);
      if (locaux.length) {
        await this.local.appliquerDistant(col, [], locaux, { prioriteCloud: true });
        console.log(`[sync] ${locaux.length} ${col === 'roles' ? 'rôle(s)' : 'compte(s)'} propre(s) à ce poste retiré(s) : seuls les comptes du cloud sont utilisés.`);
      }
    }
  }

  _ecouter() {
    try {
      this.flux = this.db.watch([], { fullDocument: 'updateLookup' });
      this.flux.on('change', (ch) => {
        const col = ch.ns && ch.ns.coll;
        if (!SYNCHRONISEES.includes(col)) return;
        if (ch.operationType === 'delete') this.local.appliquerDistant(col, [], [ch.documentKey._id]).catch(() => {});
        else if (ch.fullDocument) this.local.appliquerDistant(col, [ch.fullDocument]).catch(() => {});
      });
      this.flux.on('error', (e) => this._horsLigne(e));
    } catch (e) { console.warn('[sync] Flux de changements indisponible, relevé périodique uniquement :', e.message); }
  }

  /* -------------------------------------------------------- numérotation */
  async _alignerCompteurs() {
    // Un poste ayant travaillé seul (ou hors ligne) remonte ses compteurs pour éviter tout doublon.
    const compteurs = await this.local.col('compteurs').find({});
    for (const c of compteurs) {
      if (!/^[A-Z]+-\d{4}$/.test(c._id)) continue;
      await this.db.collection('compteurs').updateOne({ _id: c._id }, { $max: { seq: c.seq } }, { upsert: true });
    }
  }

  async allouerNumero(ctx, prefixe, annee) {
    const id = `${prefixe}-${annee}`;
    if (this.enLigne) {
      try {
        const r = await avecDelai(this.db.collection('compteurs').findOneAndUpdate(
          { _id: id }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
        ), 5000, 'délai dépassé pour la numérotation');
        const doc = r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
        // Garder le compteur local à jour pour un éventuel passage en mode local seul.
        await ctx.col('compteurs').updateOne({ _id: id }, { $set: { seq: doc.seq } }, { upsert: true });
        return `${id}-${String(doc.seq).padStart(5, '0')}`;
      } catch (e) { this._horsLigne(e); }
    }
    // Hors ligne : numéro propre au poste, unique et identifiable (ex. BQ-2026-P1-0003).
    const c = await ctx.col('compteurs').findOneAndUpdate({ _id: `${id}-${this.poste}` }, { $inc: { seq: 1 } }, { upsert: true });
    return `${id}-${this.poste}-${String(c.seq).padStart(4, '0')}`;
  }

  async arreter() {
    this.arrete = true;
    clearInterval(this.horloge);
    try { if (this.enLigne) await avecDelai(this._envoyer(), 5000, 'délai'); } catch { /* sera envoyé au prochain démarrage */ }
    if (this.flux) try { await this.flux.close(); } catch { /* ignoré */ }
    if (this.distant) await this.distant.close().catch(() => {});
  }
}

/** Mode local seul (pas de cloud configuré). */
class SansCloud {
  constructor(local) { this.local = local; }
  etat() {
    return { mode: 'local', local: { ok: true, dossier: this.local.dossier, documents: this.local.compter() }, cloud: 'desactive', enLigne: false, enAttente: this.local.outbox.size, conflits: [] };
  }
  demarrer() {}
  async synchroniserMaintenant() { return this.etat(); }
  async arreter() {}
}

module.exports = { Synchro, SansCloud };
