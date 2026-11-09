'use strict';
/** Authentification : mots de passe scrypt, jetons de session signés (HMAC), rôles. */
const crypto = require('crypto');

const DUREE_SESSION = 12 * 3600 * 1000;

function hacher(motDePasse, sel = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(motDePasse), sel, 64).toString('hex');
  return { sel, hash: h };
}
function verifier(motDePasse, sel, hash) {
  const h = crypto.scryptSync(String(motDePasse), sel, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}

function createAuth(store, secret) {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const signer = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function emettre(user) {
    const payload = b64(JSON.stringify({ u: user._id, e: Date.now() + DUREE_SESSION, v: user.versionSession || 0 }));
    return `${payload}.${signer(payload)}`;
  }

  async function lire(jeton) {
    if (!jeton || !jeton.includes('.')) return null;
    const [payload, sig] = jeton.split('.');
    const attendu = signer(payload);
    if (sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (!data.e || data.e < Date.now() || data.t) return null; // un jeton de transfert n'est jamais une session
    const u = await store.col('utilisateurs').findOne({ _id: data.u });
    if (!u || u.actif === false || u.supprime || (u.versionSession || 0) !== data.v) return null;
    return { _id: u._id, identifiant: u.identifiant, nom: u.nom, role: u.role, agenceId: u.role === 'admin' ? '' : (u.agenceId || ''), permissionsPerso: Array.isArray(u.permissions) ? u.permissions : null, doitChanger: !!u.doitChanger };
  }

  async function connecter(identifiant, motDePasse) {
    const id = String(identifiant || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').toLowerCase();
    const u = await store.col('utilisateurs').findOne({ identifiant: id });
    if (!u || u.actif === false || u.supprime || !u.hash || !verifier(motDePasse || '', u.sel, u.hash)) return null;
    return u;
  }

  /**
   * Jeton de transfert (2 minutes, usage unique) : un ordinateur non relié au cloud vérifie l'identifiant
   * auprès du serveur en ligne et ouvre la session directement sur celui-ci, sans ressaisie.
   */
  const jetonsUtilises = new Map();
  function emettreJeton(user) {
    const payload = b64(JSON.stringify({ u: user._id, e: Date.now() + 120000, v: user.versionSession || 0, t: 'tr', n: crypto.randomBytes(8).toString('hex') }));
    return `${payload}.${signer(payload)}`;
  }
  async function lireJeton(jeton) {
    if (!jeton || typeof jeton !== 'string' || !jeton.includes('.')) return null;
    const [payload, sig] = jeton.split('.');
    const attendu = signer(payload);
    if (sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (data.t !== 'tr' || !data.e || data.e < Date.now() || jetonsUtilises.has(data.n)) return null;
    for (const [n, e] of jetonsUtilises) if (e < Date.now()) jetonsUtilises.delete(n);
    jetonsUtilises.set(data.n, data.e);
    const u = await store.col('utilisateurs').findOne({ _id: data.u });
    if (!u || u.actif === false || u.supprime || (u.versionSession || 0) !== data.v) return null;
    return u;
  }

  async function initialiserAdmin(identifiant, motDePasse) {
    const nb = await store.col('utilisateurs').countDocuments({});
    if (nb > 0) return null;
    let genere = false;
    if (!motDePasse) { motDePasse = crypto.randomBytes(9).toString('base64url'); genere = true; }
    const { sel, hash } = hacher(motDePasse);
    await store.col('utilisateurs').insertOne({
      identifiant: (identifiant || 'admin').toLowerCase(), nom: 'Administrateur', role: 'admin', sel, hash, actif: true, creeLe: new Date().toISOString(),
    });
    return genere ? motDePasse : '(défini par ADMIN_PASSWORD)';
  }

  return { emettre, lire, connecter, initialiserAdmin, hacher, emettreJeton, lireJeton };
}

module.exports = { createAuth, verifier, DUREE_SESSION };
