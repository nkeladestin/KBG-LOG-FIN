'use strict';
/* =====================================================================
   Liaison cloud des ordinateurs PAR LE SERVEUR EN LIGNE (sans mot de passe de la base sur les PC).

   Côté ordinateur  : RelaisDistant imite la petite partie du pilote MongoDB dont sync.js a besoin
                      (bulkWrite, find, compteurs, flux de changements) en appelant le serveur en ligne.
   Côté serveur     : creerRelaisServeur() expose /api/relais/* et applique les droits du poste :
                      un poste relié par un responsable d'agence ne lit et n'écrit que son agence.
   Authentification : jeton de poste (auth.emettreJetonPoste), envoyé dans l'en-tête Authorization.
   ===================================================================== */
const { EventEmitter } = require('events');
const { PAR_AGENCE, SIEGE } = require('./agences');

const GLOBALES = new Set(['parametres', 'fournisseurs', 'roles', 'agences', 'articles', 'stock_categories']);

/* ===================================================== Côté ordinateur */
class ErreurRelais extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

class RelaisDistant {
  constructor(url, jeton) {
    this.url = String(url).replace(/\/+$/, '');
    this.jeton = jeton;
    this.flux = new Set();
  }

  async appel(methode, chemin, corps, delaiMs = 30000) {
    let r;
    try {
      r = await fetch(`${this.url}${chemin}`, {
        method: methode,
        headers: { authorization: `Poste ${this.jeton}`, 'x-requested-with': 'gestion-fonds', ...(corps ? { 'content-type': 'application/json' } : {}) },
        body: corps ? JSON.stringify(corps) : undefined,
        signal: AbortSignal.timeout(delaiMs),
      });
    } catch (e) { throw new ErreurRelais(`Serveur en ligne injoignable (${e.name === 'TimeoutError' ? 'délai dépassé' : e.message})`, 0); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new ErreurRelais('Liaison de ce poste refusée : reconnectez-vous sur cet ordinateur.', 401);
    if (r.status === 423) throw Object.assign(new ErreurRelais(j.erreur || 'Accès suspendu', 423), { utilisateur: j.utilisateur });
    if (!r.ok) throw new ErreurRelais(j.erreur || `Erreur ${r.status} du serveur en ligne`, r.status);
    return j;
  }

  /** « Connexion » : le serveur en ligne peut être en veille (jusqu'à une minute pour se réveiller). */
  async connect() {
    await this.appel('GET', '/api/relais/etat', null, 75000);
    const relais = this;
    this.db = {
      collection(col) {
        return {
          async bulkWrite(ops) {
            const r = await relais.appel('POST', '/api/relais/ecrire', { col, ops });
            if (r.erreurs && r.erreurs.length) {
              const e = new Error('Écritures refusées par le serveur en ligne');
              e.writeErrors = r.erreurs; // [{ index, code, motif }]
              throw e;
            }
            return r;
          },
          find(filtre = {}) {
            const depuis = filtre._maj && filtre._maj.$gte;
            return { toArray: async () => (await relais.appel('GET', `/api/relais/lire?col=${encodeURIComponent(col)}${depuis ? `&depuis=${encodeURIComponent(depuis)}` : ''}`, null, 120000)).docs };
          },
          async updateOne(filtre, maj) {
            if (col !== 'compteurs' || !maj.$max) throw new Error('Opération non prise en charge par le relais');
            return relais.appel('POST', '/api/relais/compteur', { id: filtre._id, max: maj.$max.seq });
          },
          async findOneAndUpdate(filtre, maj) {
            if (col !== 'compteurs' || !maj.$inc) throw new Error('Opération non prise en charge par le relais');
            return (await relais.appel('POST', '/api/relais/compteur', { id: filtre._id, inc: 1 })).doc;
          },
        };
      },
      /** Flux temps réel : notifications du serveur, puis lecture des documents concernés. */
      watch() { return relais.ecouter(); },
    };
  }

  ecouter() {
    const em = new EventEmitter();
    const ctrl = new AbortController();
    em.close = async () => { ctrl.abort(); this.flux.delete(em); };
    this.flux.add(em);
    let enAttente = new Map(); let minuteur = null;
    const vider = async () => {
      const lot = enAttente; enAttente = new Map(); minuteur = null;
      for (const [col, ids] of lot) {
        try {
          const { docs } = await this.appel('GET', `/api/relais/lire?col=${encodeURIComponent(col)}&ids=${encodeURIComponent([...ids.keys()].join(','))}`);
          const recus = new Set(docs.map((d) => d._id));
          for (const d of docs) em.emit('change', { ns: { coll: col }, operationType: 'replace', fullDocument: d, documentKey: { _id: d._id } });
          for (const [id, type] of ids) if (type === 'delete' && !recus.has(id)) em.emit('change', { ns: { coll: col }, operationType: 'delete', documentKey: { _id: id } });
        } catch (e) { em.emit('error', e); return; }
      }
    };
    (async () => {
      let r;
      try {
        r = await fetch(`${this.url}/api/relais/flux`, { headers: { authorization: `Poste ${this.jeton}` }, signal: ctrl.signal });
        if (r.status === 423) { const j = await r.json().catch(() => ({})); throw Object.assign(new ErreurRelais('Accès suspendu', 423), { utilisateur: j.utilisateur }); }
        if (!r.ok) throw new ErreurRelais(`Flux refusé (${r.status})`, r.status);
      } catch (e) { if (!ctrl.signal.aborted) em.emit('error', e); return; }
      let tampon = ''; let dernier = Date.now();
      const garde = setInterval(() => { if (Date.now() - dernier > 60000) { ctrl.abort(); em.emit('error', new Error('Flux temps réel interrompu')); } }, 15000);
      garde.unref();
      try {
        for await (const morceau of r.body) {
          dernier = Date.now();
          tampon += Buffer.from(morceau).toString();
          let i;
          while ((i = tampon.indexOf('\n\n')) >= 0) {
            const bloc = tampon.slice(0, i); tampon = tampon.slice(i + 2);
            const ligne = bloc.split('\n').find((l) => l.startsWith('data: '));
            if (!ligne) continue;
            let m; try { m = JSON.parse(ligne.slice(6)); } catch { continue; }
            if (!m.c || !m.i) continue;
            if (!enAttente.has(m.c)) enAttente.set(m.c, new Map());
            enAttente.get(m.c).set(m.i, m.t);
            if (!minuteur) minuteur = setTimeout(vider, 150);
          }
        }
        if (!ctrl.signal.aborted) em.emit('error', new Error('Flux temps réel fermé par le serveur'));
      } catch (e) { if (!ctrl.signal.aborted) em.emit('error', e); } finally { clearInterval(garde); }
    })();
    return em;
  }

  async close() { for (const f of this.flux) await f.close(); }
}

/* ======================================================= Côté serveur */
/**
 * @param store   MongoStore du serveur en ligne (mode cloud)
 * @param auth    module d'authentification (jetons de poste)
 */
function creerRelaisServeur({ store, auth }) {
  const abonnes = new Set();
  const mongo = (col) => store.db.collection(col);

  async function identifier(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Poste ')) return null;
    const r = await auth.lireJetonPoste(h.slice(6).trim());
    if (!r) return null;
    const u = r.user;
    return { user: u, poste: r.poste, suspendu: !!r.suspendu, agence: u.role === 'admin' ? null : (u.agenceId || SIEGE) };
  }

  /** Ce que le poste peut lire. */
  function filtreLecture(col, agence) {
    if (!agence || GLOBALES.has(col)) return {};
    if (PAR_AGENCE.has(col)) return agence === SIEGE ? { $or: [{ agenceId: agence }, { agenceId: { $exists: false } }] } : { agenceId: agence };
    if (col === 'stock_transferts') return { $or: [{ agenceId: agence }, { destinationId: agence }] };
    if (col === 'utilisateurs') return { agenceId: agence };
    return { _id: '__aucun__' };
  }
  const nettoyer = (col, d, agence) => {
    if (col !== 'utilisateurs' || !agence) return d;
    const { mdpAdmin, ...reste } = d; // eslint-disable-line no-unused-vars
    return reste;
  };
  const memeAgence = (d, agence) => d.agenceId === agence || (agence === SIEGE && !d.agenceId);
  const memesDroits = (a, b) => a.role === b.role && (a.agenceId || '') === (b.agenceId || '') && JSON.stringify(a.permissions || null) === JSON.stringify(b.permissions || null)
    && (a.actif !== false) === (b.actif !== false) && !!a.supprime === !!b.supprime && a.identifiant === b.identifiant;

  /** Ce que le poste peut écrire (un responsable : uniquement son agence, jamais les données communes). */
  function peutEcrire(col, doc, existant, ctx) {
    const { agence, user } = ctx;
    if (!agence) return true;
    if (PAR_AGENCE.has(col)) return (!doc || memeAgence(doc, agence)) && (!existant || memeAgence(existant, agence));
    if (col === 'stock_transferts') { const ok = (d) => d.agenceId === agence || d.destinationId === agence; return (!doc || ok(doc)) && (!existant || ok(existant)); }
    if (col === 'utilisateurs') return !!(doc && existant && doc._id === user._id && memesDroits(doc, existant)); // sa propre fiche (dernière connexion, mot de passe)
    return false;
  }

  async function lire(ctx, q) {
    const col = q.get('col');
    if (!col || col === 'compteurs' || !store.db) return { docs: [] };
    const f = { ...filtreLecture(col, ctx.agence) };
    if (q.get('depuis')) f._maj = { $gte: q.get('depuis') };
    if (q.get('ids')) f._id = { $in: q.get('ids').split(',').filter(Boolean).slice(0, 500) };
    const docs = await mongo(col).find(f).toArray();
    return { docs: docs.map((d) => nettoyer(col, d, ctx.agence)) };
  }

  async function ecrire(ctx, corps) {
    const col = corps.col;
    const ops = Array.isArray(corps.ops) ? corps.ops.slice(0, 1000) : [];
    if (!col || col === 'compteurs' || !store.db) return { ok: true, erreurs: [] };
    const ids = ops.map((o) => (o.replaceOne ? o.replaceOne.filter._id : o.deleteOne && o.deleteOne.filter._id)).filter((x) => x != null);
    const existants = new Map((await mongo(col).find({ _id: { $in: ids } }).toArray()).map((d) => [d._id, d]));
    const maintenant = new Date().toISOString();
    const valides = []; const index = []; const erreurs = [];
    ops.forEach((o, i) => {
      const id = o.replaceOne ? o.replaceOne.filter._id : o.deleteOne && o.deleteOne.filter._id;
      const doc = o.replaceOne ? o.replaceOne.replacement : null;
      const ex = existants.get(id);
      if (id == null || (doc && doc._id !== id)) { erreurs.push({ index: i, code: 400, motif: 'Document invalide' }); return; }
      // Un élément « par défaut » créé au premier démarrage d'un poste ne remplace jamais la version du cloud.
      if (doc && doc.semence && ex) { erreurs.push({ index: i, code: 0, motif: 'semence' }); return; }
      if (!peutEcrire(col, doc, ex, ctx)) { erreurs.push({ index: i, code: 403, motif: 'Hors du périmètre de ce poste' }); return; }
      // Horodatage du serveur : les autres postes retrouvent la donnée même si elle a été saisie hors ligne.
      valides.push(doc ? { replaceOne: { filter: { _id: id }, replacement: { ...doc, _maj: maintenant }, upsert: true } } : { deleteOne: { filter: { _id: id } } });
      index.push(i);
    });
    if (valides.length) {
      try {
        await mongo(col).bulkWrite(valides, { ordered: false });
      } catch (e) {
        const fautes = (e.writeErrors || []).map((w) => (w.err || w));
        if (!fautes.length) throw e;
        for (const w of fautes) erreurs.push({ index: index[w.index], code: w.code || 500, motif: w.code === 11000 ? 'Doublon refusé par le cloud' : (w.errmsg || 'Refusé') });
      }
    }
    return { ok: true, erreurs };
  }

  async function compteur(ctx, corps) {
    const id = String(corps.id || '');
    if (!/^[A-Z]+-\d{4}$/.test(id)) throw Object.assign(new Error('Compteur invalide.'), { status: 400 });
    if (corps.inc) {
      const r = await mongo('compteurs').findOneAndUpdate({ _id: id }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const doc = r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
      return { doc };
    }
    await mongo('compteurs').updateOne({ _id: id }, { $max: { seq: Number(corps.max) || 0 } }, { upsert: true });
    return { ok: true };
  }

  /** Flux temps réel : chaque modification du cloud est signalée aussitôt aux postes reliés. */
  function abonner(ctx, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': relié\n\n');
    const a = { ctx, res };
    abonnes.add(a);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); abonnes.delete(a); });
  }
  function signaler(ev) {
    if (!ev.collection || ev.collection === 'compteurs' || !ev.id) return;
    const data = `data: ${JSON.stringify({ c: ev.collection, i: ev.id, t: ev.type })}\n\n`;
    for (const a of abonnes) a.res.write(data);
  }

  return { identifier, lire, ecrire, compteur, abonner, signaler, nbPostes: () => abonnes.size };
}

module.exports = { RelaisDistant, ErreurRelais, creerRelaisServeur };
