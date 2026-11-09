'use strict';
/** Authentification : mots de passe scrypt, jetons de session signés (HMAC), rôles. */
const crypto = require('crypto');

const ROLES = { admin: 'Administrateur', saisie: 'Agent de saisie', lecture: 'Consultation' };
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
    if (!data.e || data.e < Date.now()) return null;
    const u = await store.col('utilisateurs').findOne({ _id: data.u });
    if (!u || u.actif === false || (u.versionSession || 0) !== data.v) return null;
    return { _id: u._id, identifiant: u.identifiant, nom: u.nom, role: u.role };
  }

  async function connecter(identifiant, motDePasse) {
    const u = await store.col('utilisateurs').findOne({ identifiant: String(identifiant || '').trim().toLowerCase() });
    if (!u || u.actif === false || !verifier(motDePasse || '', u.sel, u.hash)) return null;
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

  return { emettre, lire, connecter, initialiserAdmin, hacher };
}

module.exports = { createAuth, ROLES, DUREE_SESSION };
