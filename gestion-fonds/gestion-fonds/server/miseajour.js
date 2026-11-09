'use strict';
/* =====================================================================
   Mise à jour automatique des ordinateurs.
   - Le serveur en ligne (Render) publie son propre code : /api/mise-a-jour/paquet.
   - Chaque PC compare sa version avec celle du serveur en ligne ; si elle est plus récente,
     il télécharge le paquet, vérifie chaque fichier (empreinte SHA-256 + contrôle de syntaxe),
     garde une copie de l'ancienne version, remplace les fichiers puis redémarre.
   Seuls le code (server/, public/) et package.json sont concernés : jamais les données ni .env.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DOSSIERS = ['server', 'public'];
const CHEMIN_VALIDE = /^(server|public)\/[A-Za-z0-9_\-./]+$|^package\.json$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** « 2026.11.09-11 » > « 2026.11.09-10 » (comparaison numérique de chaque partie). */
function plusRecente(a, b) {
  const p = (v) => String(v || '').split(/[.-]/).map((x) => Number(x) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function lister(racine) {
  const out = [];
  const parcourir = (rel) => {
    for (const e of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) parcourir(r);
      else if (e.isFile()) out.push(r);
    }
  };
  for (const d of DOSSIERS) if (fs.existsSync(path.join(racine, d))) parcourir(d);
  if (fs.existsSync(path.join(racine, 'package.json'))) out.push('package.json');
  return out.filter((c) => CHEMIN_VALIDE.test(c));
}

let cache = null;
/** Paquet publié par le serveur en ligne (calculé une fois par démarrage). */
function paquet(racine, version) {
  if (cache && cache.version === version) return cache;
  const fichiers = lister(racine).map((chemin) => {
    const buf = fs.readFileSync(path.join(racine, chemin));
    return { chemin, sha256: sha256(buf), contenu: buf.toString('base64') };
  });
  cache = { version, fichiers };
  return cache;
}

const dependances = (txt) => { try { return JSON.stringify(JSON.parse(txt).dependencies || {}); } catch { return null; } };

/**
 * Installe un paquet dans « racine ». Retourne { ok, fichiers } ou { ok:false, raison }.
 * Rien n'est remplacé tant que tous les fichiers n'ont pas été vérifiés.
 */
function appliquer(racine, p, versionLocale) {
  if (!p || !Array.isArray(p.fichiers) || !p.fichiers.length) return { ok: false, raison: 'Paquet vide.' };
  if (!plusRecente(p.version, versionLocale)) return { ok: false, raison: 'Version déjà à jour.' };
  const nouveaux = [];
  for (const f of p.fichiers) {
    if (!CHEMIN_VALIDE.test(f.chemin || '') || f.chemin.includes('..')) return { ok: false, raison: `Chemin refusé : ${f.chemin}` };
    const buf = Buffer.from(f.contenu || '', 'base64');
    if (sha256(buf) !== f.sha256) return { ok: false, raison: `Fichier altéré : ${f.chemin}` };
    nouveaux.push({ chemin: f.chemin, buf });
  }
  if (!nouveaux.some((f) => f.chemin === 'server/index.js')) return { ok: false, raison: 'Paquet incomplet.' };
  // Une nouvelle bibliothèque demande une réinstallation complète (npm install).
  const pkg = nouveaux.find((f) => f.chemin === 'package.json');
  const pkgLocal = path.join(racine, 'package.json');
  if (pkg && fs.existsSync(pkgLocal) && dependances(pkg.buf.toString()) !== dependances(fs.readFileSync(pkgLocal, 'utf8'))) {
    return { ok: false, raison: 'dependances' };
  }
  // Contrôle de syntaxe du code serveur avant de toucher à quoi que ce soit.
  const essai = path.join(racine, 'maj-essai');
  fs.rmSync(essai, { recursive: true, force: true });
  try {
    for (const f of nouveaux.filter((x) => x.chemin.startsWith('server/') && x.chemin.endsWith('.js'))) {
      const cible = path.join(essai, f.chemin);
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.writeFileSync(cible, f.buf);
      const r = spawnSync(process.execPath, ['--check', cible], { windowsHide: true, timeout: 30000 });
      if (r.status !== 0) return { ok: false, raison: `Erreur de syntaxe dans ${f.chemin}` };
    }
  } finally { fs.rmSync(essai, { recursive: true, force: true }); }
  // Copie de l'ancienne version (retour arrière manuel possible), puis remplacement.
  const sauvegarde = path.join(racine, 'maj-precedente');
  fs.rmSync(sauvegarde, { recursive: true, force: true });
  for (const c of lister(racine)) {
    const dest = path.join(sauvegarde, c);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(racine, c), dest);
  }
  let n = 0;
  for (const f of nouveaux) {
    const cible = path.join(racine, f.chemin);
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    try { if (fs.readFileSync(cible).equals(f.buf)) continue; } catch { /* nouveau fichier */ }
    fs.writeFileSync(`${cible}.maj`, f.buf);
    fs.renameSync(`${cible}.maj`, cible);
    n += 1;
  }
  return { ok: true, fichiers: n };
}

module.exports = { paquet, appliquer, plusRecente };
