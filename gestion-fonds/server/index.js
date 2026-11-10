'use strict';
/**
 * Gestion des fonds – serveur HTTP (Node.js ≥ 18, sans framework).
 * Variables d'environnement : voir .env.example
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* -------------------------------------- Exécutable autonome (Node SEA) */
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
// Dossier de l'application : à côté de l'exécutable, sinon racine du projet.
const APP_DIR = sea ? path.dirname(process.execPath) : path.join(__dirname, '..');
const FICHIER_ENV = path.join(APP_DIR, '.env');

/* --------------------------------------------------------------- .env */
(function chargerEnv() {
  const f = FICHIER_ENV;
  if (!fs.existsSync(f)) return;
  for (const ligne of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}());

const { MongoStore, MemoryStore } = require('./db');
const { createServices, ErreurMetier } = require('./services');
const { createReports } = require('./reports');
const { createAuth, verifier: verifierMdp } = require('./auth');
const { createDroits, PERMISSIONS, CLES, CLES_RESPONSABLE, CENTRALES } = require('./droits');
const miseAJour = require('./miseajour');
const { dansAgence, vueAgence, migrerAgences } = require('./agences');
const { createCommandes } = require('./commandes');

const VERSION = '2026.11.10-18'; // à chaque livraison : le PC compare avec le serveur en ligne
const PORT = Number(process.env.PORT || 3000);
// Sur un hébergeur (Render, Railway…), le mode cloud est utilisé par défaut.
const MODE = (process.env.DB_MODE || (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT ? 'cloud' : 'double')).toLowerCase(); // double | cloud | memory
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const PUBLIC = path.join(APP_DIR, 'public');

/** Assistant de premier lancement (exécutable) : crée le fichier .env à côté du programme. */
async function assistantConfiguration() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // File d'attente des lignes saisies (supporte aussi un collage de plusieurs lignes d'un coup).
  const lignes = []; let attente = null;
  rl.on('line', (l) => { if (attente) { const f = attente; attente = null; f(l); } else lignes.push(l); });
  const q = (t, def = '') => new Promise((res) => {
    process.stdout.write(def ? `${t} [${def}] : ` : `${t} : `);
    const fin = (r) => res(String(r).trim() || def);
    if (lignes.length) fin(lignes.shift()); else attente = fin;
  });
  console.log('\n=== Gestion des fonds – configuration initiale ===\n');
  console.log('Les données sont enregistrées sur ce PC (dossier « donnees »).');
  console.log('La connexion au cloud (MongoDB Atlas) se paramètre plus tard dans l\'application :');
  console.log('menu « Stockage & synchronisation ».\n');
  const uri = '';
  const db = 'gestion_fonds';
  const poste = (await q('Code de ce poste (ex. P1, COMPTA, CAISSE)', 'P1')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'P1';
  const port = await q("Port de l'application", '3000');
  const admin = await q('Identifiant du premier administrateur', 'admin');
  let mdp = '';
  while (mdp.length < 8) mdp = await q('Mot de passe administrateur (8 caractères minimum)');
  rl.close();
  const secret = crypto.randomBytes(48).toString('hex');
  const contenu = [
    '# Double stockage : local (dossier donnees) + MongoDB Atlas si MONGODB_URI est renseigné',
    `MONGODB_URI=${uri}`, `MONGODB_DB=${db}`, `POSTE=${poste}`, `SESSION_SECRET=${secret}`,
    `ADMIN_USER=${admin}`, `ADMIN_PASSWORD=${mdp}`, 'ADMIN_REINITIALISER=1', `PORT=${port}`, 'COOKIE_SECURE=false', '',
  ].join('\n');
  fs.writeFileSync(FICHIER_ENV, contenu, { mode: 0o600 });
  Object.assign(process.env, { MONGODB_URI: uri, MONGODB_DB: db, POSTE: poste, SESSION_SECRET: secret, ADMIN_USER: admin, ADMIN_PASSWORD: mdp, PORT: port });
  console.log(`\nConfiguration enregistrée dans ${FICHIER_ENV}\n`);
}

/** Met à jour (ou ajoute) des clés dans le fichier .env, et dans process.env. */
function majEnv(valeurs) {
  let lignes = fs.existsSync(FICHIER_ENV) ? fs.readFileSync(FICHIER_ENV, 'utf8').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(valeurs)) {
    const val = String(v ?? '').replace(/[\r\n]/g, '');
    const i = lignes.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lignes[i] = `${k}=${val}`; else lignes.push(`${k}=${val}`);
    process.env[k] = val;
  }
  lignes = lignes.filter((l, i, a) => !(l === '' && i === a.length - 1));
  fs.writeFileSync(FICHIER_ENV, `${lignes.join('\n')}\n`, { mode: 0o600 });
}
/** Masque le mot de passe d'une chaîne de connexion. */
const masquerUri = (u) => String(u || '').replace(/(mongodb(?:\+srv)?:\/\/[^:/@]+:)[^@]*@/, '$1••••••@');

/** Lit un fichier de l'interface : intégré à l'exécutable, ou depuis le dossier public. */
function lireStatique(rel) {
  if (sea) {
    try { return Buffer.from(sea.getAsset(`public${rel}`)); } catch { /* ressource absente : dossier public éventuel */ }
  }
  const fichier = path.normalize(path.join(PUBLIC, rel));
  if (!fichier.startsWith(PUBLIC + path.sep) || !fs.existsSync(fichier) || fs.statSync(fichier).isDirectory()) return null;
  return fs.readFileSync(fichier);
}

function ouvrirNavigateur(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/* ------------------------------------------------- Temps réel (SSE) */
const clients = new Set();
const ipDe = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
/** Limitation des requêtes (fenêtre glissante d'une minute) : protège le serveur contre les abus. */
const limiteur = (() => {
  const compteurs = new Map();
  setInterval(() => { const t = Date.now() - 60000; for (const [k, v] of compteurs) { while (v.length && v[0] < t) v.shift(); if (!v.length) compteurs.delete(k); } }, 30000).unref();
  return {
    accepter(cle, max) {
      const t = Date.now(); const v = compteurs.get(cle) || [];
      while (v.length && v[0] < t - 60000) v.shift();
      if (v.length >= max) { compteurs.set(cle, v); return false; }
      v.push(t); compteurs.set(cle, v); return true;
    },
  };
})();
let redemarrer = async () => {}; // défini au démarrage du serveur
let derniereActivite = Date.now();
let tempo = null; const enAttente = new Set();
/** Événement nommé envoyé tout de suite à toutes les fenêtres ouvertes. */
function diffuser(evenement, donnees) {
  const data = JSON.stringify(donnees || {});
  for (const res of clients) if (!res.gf || res.gf.etat === 'actif') res.write(`event: ${evenement}\ndata: ${data}\n\n`);
}
/** Événement adressé à un seul utilisateur (toutes ses fenêtres, sur tous ses appareils reliés à ce serveur). */
function notifierUtilisateur(userId, evenement, donnees) {
  const data = JSON.stringify(donnees || {});
  for (const res of clients) if (res.gf && res.gf.userId === userId) res.write(`event: ${evenement}\ndata: ${data}\n\n`);
}
function broadcast(collection) {
  enAttente.add(collection || '*');
  if (tempo) return;
  tempo = setTimeout(() => {
    const data = JSON.stringify({ collections: [...enAttente], quand: Date.now() });
    enAttente.clear(); tempo = null;
    for (const res of clients) if (!res.gf || res.gf.etat === 'actif') res.write(`event: maj\ndata: ${data}\n\n`);
  }, 150);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------- Utilitaires */
// Derrière un hébergeur HTTPS (Render, Railway…), le cookie de session est marqué « Secure ».
const cookieSecurise = (req) => COOKIE_SECURE || req.headers['x-forwarded-proto'] === 'https';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const SECURITE = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function envoyer(res, status, obj, extra = {}) {
  const corps = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITE, ...extra });
  res.end(corps);
}

function lireCorps(req, max = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let taille = 0; const morceaux = [];
    req.on('data', (c) => {
      taille += c.length;
      if (taille > max) { reject(new ErreurMetier('Requête trop volumineuse.', 413)); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on('end', () => {
      if (!morceaux.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(morceaux).toString('utf8'))); } catch { reject(new ErreurMetier('JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const o = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}

function periode(q, svc) {
  const auj = new Date();
  const debutDefaut = `${auj.getFullYear()}-${String(auj.getMonth() + 1).padStart(2, '0')}-01`;
  const debut = svc.exigerDate(q.get('debut') || debutDefaut, 'début');
  const fin = svc.exigerDate(q.get('fin') || auj.toISOString().slice(0, 10), 'fin');
  if (fin < debut) throw new ErreurMetier('La date de fin doit être postérieure à la date de début.');
  return { debut, fin };
}

/* --------------------------------------------------------- Démarrage */
const posteCourant = () => String(process.env.POSTE || 'P1').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'P1';

async function demarrer() {
  let store;
  let synchro = null;
  /** (Ré)active la synchronisation selon MONGODB_URI : sans chaîne, stockage local uniquement. */
  async function configurerCloud() {
    const { Synchro, SansCloud } = require('./sync');
    if (synchro) await synchro.arreter();
    store.declencheur = null; store.allouerNumero = undefined;
    if (process.env.MONGODB_URI) {
      synchro = new Synchro(store, process.env.MONGODB_URI, process.env.MONGODB_DB || 'gestion_fonds', posteCourant());
      synchro.demarrer();
      console.log(`Stockage : LOCAL + CLOUD (MongoDB Atlas « ${process.env.MONGODB_DB || 'gestion_fonds'} »), poste ${posteCourant()}`);
    } else if (store.meta.relais && store.meta.relais.url && store.meta.relais.jeton) {
      // Liaison par le serveur en ligne : aucun mot de passe de la base sur cet ordinateur.
      synchro = new Synchro(store, { relais: store.meta.relais.url, jeton: store.meta.relais.jeton }, '', posteCourant());
      synchro.surSuspension = async (id) => {
        const u = id && await store.col('utilisateurs').findOne({ _id: id });
        // Prioritaire sur une modification locale en attente (ex. date de dernière connexion), qui ne partira plus.
        if (u && u.actif !== false) await store.appliquerDistant('utilisateurs', [{ ...u, actif: false }], [], { prioriteCloud: true });
      };
      synchro.demarrer();
      console.log(`Stockage : CLOUD par le serveur en ligne (${store.meta.relais.url}) + copie locale, poste ${posteCourant()}`);
    } else {
      synchro = new SansCloud(store);
      console.log('Stockage : LOCAL (connexion cloud non paramétrée).');
    }
  }
  if (MODE === 'memory') {
    console.warn('⚠  Mode DÉMONSTRATION (DB_MODE=memory) : les données sont perdues à l\'arrêt du serveur.');
    store = new MemoryStore();
    await store.connect();
  } else if (MODE === 'cloud') {
    // Ancien mode : MongoDB Atlas uniquement, sans copie locale.
    if (!process.env.MONGODB_URI) {
      console.error('ERREUR DE CONFIGURATION : la variable MONGODB_URI est absente.');
      console.error('Render : onglet « Environment » → Add Environment Variable → MONGODB_URI = mongodb+srv://utilisateur:motdepasse@cluster.mongodb.net/');
      terminerAvecErreur(); return;
    }
    store = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'gestion_fonds');
    await store.connect();
    console.log(`Stockage : cloud uniquement (base « ${process.env.MONGODB_DB || 'gestion_fonds'} »)`);
  } else {
    // DOUBLE STOCKAGE : base locale durable sur ce PC + réplication vers MongoDB Atlas.
    if (!fs.existsSync(FICHIER_ENV)) {
      // Premier démarrage : configuration créée automatiquement, sans aucune question.
      const h = crypto.createHash('sha1').update(require('os').hostname()).digest('hex');
      majEnv({ MONGODB_URI: '', MONGODB_DB: 'gestion_fonds', POSTE: `P${parseInt(h.slice(0, 6), 16).toString(36).toUpperCase().slice(0, 4)}`, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), PORT: process.env.PORT || '3000', COOKIE_SECURE: 'false' });
      console.log(`Configuration initiale créée : ${FICHIER_ENV}`);
    }
    const { LocalStore } = require('./local');
    const { Synchro } = require('./sync');
    const dossier = path.resolve(APP_DIR, process.env.DOSSIER_DONNEES || 'donnees');
    store = new LocalStore(dossier);
    await store.connect();
    // Connexion cloud mémorisée avec les données : restaurée si le fichier .env a été perdu (réinstallation…).
    if (!process.env.MONGODB_URI && store.meta.cloud && store.meta.cloud.uri) {
      majEnv({ MONGODB_URI: store.meta.cloud.uri, MONGODB_DB: store.meta.cloud.base || 'gestion_fonds', ...(store.meta.cloud.poste ? { POSTE: store.meta.cloud.poste } : {}) });
      console.log('Connexion cloud restaurée depuis les données locales.');
    } else if (process.env.MONGODB_URI && !(store.meta.cloud && store.meta.cloud.uri === process.env.MONGODB_URI)) {
      await store.majMeta({ cloud: { uri: process.env.MONGODB_URI, base: process.env.MONGODB_DB || 'gestion_fonds', poste: process.env.POSTE } });
    }
    if (store.estVide() && process.env.MONGODB_URI) {
      console.log('Premier démarrage de ce poste : récupération des données existantes dans le cloud…');
      const s0 = new Synchro(store, process.env.MONGODB_URI, process.env.MONGODB_DB || 'gestion_fonds', posteCourant());
      const ok = await s0.premiereConnexion(30000);
      console.log(ok ? `Données du cloud récupérées (${store.compter()} documents).` : 'Cloud injoignable : démarrage en local, la synchronisation se fera automatiquement.');
      await s0.arreter();
      s0.arrete = false;
    }
    await configurerCloud();
  }

  let secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('⚠  SESSION_SECRET absent ou trop court : secret temporaire généré (les sessions seront perdues au redémarrage).');
  }

  // Vue cloisonnée par agence : toutes les règles de gestion et tous les états passent par elle.
  const donnees = vueAgence(() => store);
  const svc = createServices(donnees, broadcast);
  const rep = createReports(donnees, svc);
  const stock = createCommandes({ store, donnees, svc, broadcast });
  const auth = createAuth(store, secret);
  store.watch((ev) => { if (ev.collection !== 'audit' && ev.collection !== 'compteurs') broadcast(ev.collection); });
  /*
   * Droits d'accès en temps réel : à chaque modification d'un compte (sur ce serveur, sur un autre
   * ordinateur ou par la synchronisation), l'état de chaque fenêtre ouverte est recalculé et seul
   * l'utilisateur concerné est prévenu : suspendu → écran bloqué ; rétabli → reprise automatique ;
   * supprimé ou mot de passe changé → déconnexion.
   */
  let tempoAcces = null;
  async function verifierAcces() {
    tempoAcces = null;
    const cache = new Map();
    for (const res of [...clients]) {
      const g = res.gf;
      if (!g) continue;
      if (!cache.has(g.userId)) cache.set(g.userId, await store.col('utilisateurs').findOne({ _id: g.userId }));
      const u = cache.get(g.userId);
      const etat = !u || u.supprime || (u.versionSession || 0) !== g.v ? 'ferme' : u.actif === false ? 'suspendu' : 'actif';
      if (etat === g.etat) continue;
      g.etat = etat;
      res.write(`event: acces\ndata: ${JSON.stringify({ etat })}\n\n`);
      if (etat === 'ferme') { res.end(); clients.delete(res); }
    }
  }
  store.watch((ev) => { if (ev.collection === 'utilisateurs' || ev.collection === '*') { clearTimeout(tempoAcces); tempoAcces = setTimeout(() => verifierAcces().catch((e) => console.error('[accès]', e.message)), 50); } });

  // Serveur en ligne : relais par lequel les ordinateurs se relient au cloud (sans mot de passe de la base).
  const relais = MODE === 'cloud' && store.db ? require('./relais').creerRelaisServeur({ store, auth }) : null;
  if (relais) store.watch((ev) => relais.signaler(ev));

  // Nouvelle configuration sur un poste qui a déjà des données : le compte administrateur
  // saisi à l'installation est (re)défini avec ce mot de passe.
  if (process.env.ADMIN_REINITIALISER === '1' && process.env.ADMIN_PASSWORD && (await store.col('utilisateurs').countDocuments({})) > 0) {
    const ident = (process.env.ADMIN_USER || 'admin').toLowerCase();
    const { sel, hash } = auth.hacher(process.env.ADMIN_PASSWORD);
    const u = await store.col('utilisateurs').findOne({ identifiant: ident });
    if (u) await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: { sel, hash, role: 'admin', actif: true, versionSession: (u.versionSession || 0) + 1 } });
    else await store.col('utilisateurs').insertOne({ identifiant: ident, nom: 'Administrateur', role: 'admin', sel, hash, actif: true, creeLe: new Date().toISOString() });
    console.log(`Mot de passe du compte administrateur « ${ident} » défini depuis la configuration.`);
  }
  if (process.env.ADMIN_REINITIALISER === '1' && MODE !== 'memory') majEnv({ ADMIN_REINITIALISER: '0' });
  const droits = createDroits(store);
  await droits.initialiser();
  await stock.initialiser();
  const rattachees = await migrerAgences(store);
  if (rattachees) console.log(`Agences : ${rattachees} donnée(s) existante(s) rattachée(s) à l'agence « Siège ».`);
  // Remplacement de l'ancienne gestion de stock (base en ligne, une seule fois) et rattachement régulier aux agences.
  if (MODE === 'cloud') await stock.effacerAncienStock().catch((e) => console.error('[stock]', e.message));
  setInterval(() => migrerAgences(store).catch((e) => console.error('[agences]', e.message)), 10 * 60000).unref();
  // Les comptes créés par l'administrateur gardent le mot de passe qu'il a fixé (correction unique des anciens comptes).
  const params = await store.col('parametres').findOne({ _id: 'migrations' });
  if (!params || !params.mdpSansChangementForce) {
    for (const u of await store.col('utilisateurs').find({ doitChanger: true })) await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: { doitChanger: false } });
    await store.col('parametres').updateOne({ _id: 'migrations' }, { $set: { mdpSansChangementForce: true } }, { upsert: true });
  }
  const mdp = process.env.ADMIN_PASSWORD ? await auth.initialiserAdmin(process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD) : null;
  if (!(await store.col('utilisateurs').countDocuments({}))) console.log('Aucun utilisateur : l\'écran de démarrage de l\'application permet de créer le compte administrateur.');
  if (mdp) console.log(`Compte administrateur créé : identifiant « ${process.env.ADMIN_USER || 'admin'} », mot de passe : ${mdp}`);

  const tentatives = new Map();

  /* ------------------------------------------------------------ Routes */
  const routes = [];
  // perm : null = tout utilisateur connecté ; 'x' ou ['x','y'] = au moins une de ces permissions.
  const r = (method, motif, perm, fn) => routes.push({ method, re: new RegExp(`^${motif.replace(/:(\w+)/g, '(?<$1>[\\w-]+)')}$`), perm, fn });

  r('GET', '/api/me', null, async ({ user }) => {
    const role = await donnees.col('roles').findOne({ _id: user.role });
    const ags = await store.col('agences').find({}, { sort: { nom: 1 } });
    const nomAg = (id) => (ags.find((g) => g._id === id) || {}).nom || '';
    return {
      ...user, roleLibelle: role ? role.nom : user.role,
      agenceNom: nomAg(user.agenceId), agenceEffective: user.agence, agenceEffectiveNom: nomAg(user.agence),
      agences: ags.map((g) => ({ _id: g._id, code: g.code, nom: g.nom, actif: g.actif !== false })),
    };
  });

  /* ------------------------------------------------------------ Agences */
  // Les actions qui touchent toute l'entreprise sont réservées aux comptes « toutes agences ».
  const exigerSiege = (user) => {
    if (user.agenceId) throw new ErreurMetier("Action réservée à l'administration centrale (accès « toutes agences »).", 403);
  };
  r('GET', '/api/agences', null, async ({ user }) => {
    const ags = await store.col('agences').find({}, { sort: { nom: 1 } });
    // Un compte rattaché à une agence ne voit des autres agences que leur nom (pour les transferts).
    return ags.map((g) => (!user.agenceId || g._id === user.agenceId ? g : { _id: g._id, code: g.code, nom: g.nom, ville: g.ville, actif: g.actif }));
  });
  const lireAgence = async (body, id) => {
    const doc = {
      code: svc.texte(body.code, 12).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
      nom: svc.texte(body.nom, 120), ville: svc.texte(body.ville, 120), adresse: svc.texte(body.adresse, 200),
      telephone: svc.texte(body.telephone, 60), responsable: svc.texte(body.responsable, 120), actif: body.actif !== false,
    };
    if (!doc.code || !doc.nom) throw new ErreurMetier("Code et nom de l'agence obligatoires.");
    const ags = await store.col('agences').find({});
    if (ags.some((g) => g._id !== id && (g.code === doc.code || g.nom.toLowerCase() === doc.nom.toLowerCase()))) throw new ErreurMetier('Une agence porte déjà ce code ou ce nom.');
    return doc;
  };
  r('POST', '/api/agences', 'agences.gerer', async ({ user, body }) => {
    exigerSiege(user);
    const doc = await lireAgence(body);
    const g = await store.col('agences').insertOne({ ...doc, soldeInitialCaisse: svc.arrondi(body.soldeInitialCaisse || 0) || 0, creeLe: new Date().toISOString(), creePar: user.identifiant });
    await svc.audit(donnees, user, 'Agence créée', `${doc.code} – ${doc.nom}`);
    broadcast('agences');
    return g;
  });
  r('PUT', '/api/agences/:id', 'agences.gerer', async ({ user, body, p }) => {
    exigerSiege(user);
    const g = await store.col('agences').findOne({ _id: p.id });
    if (!g) throw new ErreurMetier('Agence introuvable.', 404);
    const doc = await lireAgence(body, p.id);
    if (body.soldeInitialCaisse !== undefined && svc.arrondi(body.soldeInitialCaisse || 0) !== (g.soldeInitialCaisse || 0)) {
      // Le solde initial de caisse est figé dès que la caisse de l'agence a des mouvements (traçabilité).
      if (await store.col('bons').countDocuments({ agenceId: p.id })) throw new ErreurMetier("La caisse de cette agence a déjà des mouvements : son solde initial n'est plus modifiable.");
      doc.soldeInitialCaisse = svc.arrondi(body.soldeInitialCaisse || 0) || 0;
    }
    if (doc.actif === false && (await store.col('utilisateurs').countDocuments({ agenceId: p.id, actif: { $ne: false }, supprime: { $ne: true } }))) {
      throw new ErreurMetier('Des utilisateurs actifs sont rattachés à cette agence : suspendez-les ou changez leur agence avant de la désactiver.');
    }
    await store.col('agences').updateOne({ _id: p.id }, { $set: { ...doc, semence: false } });
    await svc.audit(donnees, user, 'Agence modifiée', `${doc.code} – ${doc.nom}`);
    broadcast('agences');
    return { ok: true };
  });

  /* -------------------------------------------------------------- Stock */
  const per = (q) => periode(q, svc);
  /* ------------------------------------------- Stock par bons de commande */
  const fStock = (q) => ({ ...Object.fromEntries(q), ouverts: q.get('ouverts') === '1' });
  r('GET', '/api/stock/referentiel', null, () => stock.referentiel());
  r('POST', '/api/stock/articles', 'stock.referentiel', ({ user, body }) => stock.enregistrerArticle(user, body));
  r('PUT', '/api/stock/articles/:id', 'stock.referentiel', ({ user, body, p }) => stock.enregistrerArticle(user, body, p.id));
  r('GET', '/api/stock/articles/:id/utilisations', 'stock.referentiel', ({ p }) => stock.utilisationsArticle(p.id));
  r('POST', '/api/stock/articles/:id/supprimer', 'stock.referentiel', ({ user, p }) => stock.supprimerArticle(user, p.id));
  r('POST', '/api/stock/regions', 'stock.referentiel', ({ user, body }) => stock.enregistrerRegion(user, body));
  r('PUT', '/api/stock/regions/:id', 'stock.referentiel', ({ user, body, p }) => stock.enregistrerRegion(user, body, p.id));
  r('POST', '/api/stock/unites', ['stock.referentiel', 'stock.bons'], ({ user, body }) => stock.enregistrerUnite(user, body));
  r('PUT', '/api/stock/unites/:id', 'stock.referentiel', ({ user, body, p }) => stock.enregistrerUnite(user, body, p.id));
  r('POST', '/api/stock/types', 'stock.referentiel', ({ user, body }) => stock.enregistrerType(user, body));
  r('PUT', '/api/stock/types/:id', 'stock.referentiel', ({ user, body, p }) => stock.enregistrerType(user, body, p.id));
  r('GET', '/api/stock/types/:id/utilisations', 'stock.referentiel', ({ p }) => stock.utilisationsType(p.id));
  r('POST', '/api/stock/types/:id/supprimer', 'stock.referentiel', ({ user, p }) => stock.supprimerType(user, p.id));
  r('GET', '/api/stock/bons', 'stock.voir', ({ q }) => stock.listeBons(Object.fromEntries(q)));
  r('GET', '/api/stock/bons/:id', 'stock.voir', ({ p }) => stock.bon(p.id));
  r('POST', '/api/stock/bons', 'stock.bons', ({ user, body }) => stock.creerBon(user, body));
  r('PUT', '/api/stock/bons/:id', 'stock.bons', ({ user, body, p }) => stock.modifierBon(user, p.id, body));
  r('POST', '/api/stock/bons/:id/statut', 'stock.bons', ({ user, body, p }) => stock.changerStatutBon(user, p.id, body));
  r('GET', '/api/stock/bons/:id/livraison/:unite', 'stock.livrer', ({ p }) => stock.preparerLivraison(p.id, p.unite));
  r('GET', '/api/stock/livraisons', 'stock.voir', ({ q }) => stock.listeLivraisons(Object.fromEntries(q)));
  r('GET', '/api/stock/livraisons/:id', 'stock.voir', ({ p }) => stock.livraison(p.id));
  r('POST', '/api/stock/livraisons', 'stock.livrer', ({ user, body }) => stock.livrer(user, body));
  r('POST', '/api/stock/livraisons/:id/signature', 'stock.livrer', ({ user, body, p }) => stock.signerLivraison(user, p.id, body));
  r('POST', '/api/stock/livraisons/:id/annuler', 'stock.corriger', ({ user, body, p }) => stock.annulerLivraison(user, p.id, body));
  r('POST', '/api/stock/entrees', 'stock.entrees', ({ user, body }) => stock.entree(user, body));
  r('POST', '/api/stock/ajustements', 'stock.corriger', ({ user, body }) => stock.ajuster(user, body));
  r('POST', '/api/stock/mouvements/:id/annuler', 'stock.corriger', ({ user, body, p }) => stock.annulerEntree(user, p.id, body));
  r('GET', '/api/stock/mouvements', 'stock.voir', ({ q }) => stock.listeMouvements(Object.fromEntries(q)));
  r('GET', '/api/stock/mouvements/:id', 'stock.voir', ({ p }) => stock.mouvement(p.id));
  r('GET', '/api/stock/situation', 'stock.voir', () => stock.situation());
  r('GET', '/api/stock/alertes', 'stock.voir', () => stock.alertes());
  r('GET', '/api/stock/consolidation', ['stock.etats', 'stock.voir'], ({ q }) => stock.consolidation(fStock(q)));
  r('POST', '/api/me/mot-de-passe', null, async ({ user, body }) => {
    const u = await auth.connecter(user.identifiant, body.ancien);
    if (!u || u.suspendu) throw new ErreurMetier('Mot de passe actuel incorrect.');
    if (String(body.nouveau || '').length < 8) throw new ErreurMetier('Le nouveau mot de passe doit contenir au moins 8 caractères.');
    const { sel, hash } = auth.hacher(body.nouveau);
    if (verifierMdp(body.nouveau, u.sel, u.hash)) throw new ErreurMetier('Le nouveau mot de passe doit être différent du mot de passe actuel.');
    await donnees.col('utilisateurs').updateOne({ _id: u._id }, { $set: { sel, hash, doitChanger: false, mdpAdmin: '', mdpModifieParUtilisateur: true, versionSession: (u.versionSession || 0) + 1 } });
    await svc.audit(donnees, user, 'Mot de passe personnel changé', user.identifiant);
    return { ok: true, reconnexion: true };
  });

  r('GET', '/api/parametres', null, () => svc.getParametres());
  r('PUT', '/api/parametres', 'parametres.gerer', ({ user, body }) => { exigerSiege(user); return svc.setParametres(user, body); });

  r('GET', '/api/comptes', null, () => svc.listeComptes());
  r('POST', '/api/comptes', 'comptes.gerer', ({ user, body }) => svc.enregistrerCompte(user, body));
  r('PUT', '/api/comptes/:id', 'comptes.gerer', ({ user, body, p }) => svc.enregistrerCompte(user, body, p.id));

  r('GET', '/api/fournisseurs', null, () => svc.listeFournisseurs());
  r('POST', '/api/fournisseurs', 'fournisseurs.gerer', ({ user, body }) => svc.enregistrerFournisseur(user, body));
  r('PUT', '/api/fournisseurs/:id', 'fournisseurs.gerer', ({ user, body, p }) => svc.enregistrerFournisseur(user, body, p.id));

  r('GET', '/api/operations', 'banque.voir', async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    const f = { date: { $gte: debut, $lte: fin } };
    if (q.get('compteId')) f.compteId = q.get('compteId');
    if (q.get('nature')) f.nature = q.get('nature');
    return donnees.col('operations').find(f, { sort: { date: -1, numero: -1 } });
  });
  r('POST', '/api/operations/entree', 'banque.saisir', ({ user, body }) => svc.entreeBanque(user, body));
  r('POST', '/api/operations/versement-caisse', 'banque.saisir', ({ user, body }) => svc.versementCaisse(user, body));
  r('POST', '/api/operations/virement', 'banque.saisir', ({ user, body }) => svc.virementFournisseur(user, body));
  r('POST', '/api/operations/transfert-caisse', 'banque.saisir', ({ user, body }) => svc.transfertCaisse(user, body));
  r('POST', '/api/operations/:id/annuler', 'banque.annuler', ({ user, body, p }) => svc.annulerOperation(user, p.id, body.motif));

  r('GET', '/api/ordres', 'banque.voir', async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return donnees.col('ordres').find({ date: { $gte: debut, $lte: fin } }, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/ordres/:id', 'banque.voir', async ({ p }) => {
    const o = await donnees.col('ordres').findOne({ _id: p.id });
    if (!o) throw new ErreurMetier('Ordre introuvable.', 404);
    return o;
  });

  r('GET', '/api/bons', 'caisse.voir', async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    const f = { date: { $gte: debut, $lte: fin } };
    if (q.get('type')) f.type = q.get('type');
    return donnees.col('bons').find(f, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/bons/:id', ['caisse.voir', 'banque.voir'], async ({ p }) => {
    const b = await donnees.col('bons').findOne({ _id: p.id });
    if (!b) throw new ErreurMetier('Bon introuvable.', 404);
    return b;
  });
  r('POST', '/api/bons', 'caisse.saisir', ({ user, body }) => svc.bonManuel(user, body));
  r('POST', '/api/bons/:id/annuler', 'caisse.annuler', ({ user, body, p }) => svc.annulerBon(user, p.id, body.motif));

  r('GET', '/api/caisse/solde', ['caisse.voir', 'pv.saisir', 'caisse.cloturer'], async ({ q }) => {
    const d = q.get('date') ? svc.exigerDate(q.get('date')) : null;
    const avant = d ? new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10) : null;
    return { date: d, solde: await svc.soldeCaisse(donnees, avant) };
  });
  r('GET', '/api/clotures', ['caisse.voir', 'caisse.cloturer'], () => donnees.col('clotures').find({}, { sort: { date: -1 }, limit: 60 }));
  r('POST', '/api/clotures', 'caisse.cloturer', ({ user, body }) => svc.cloturerJournee(user, body.date));

  r('GET', '/api/pv', ['pv.voir', 'etats.voir'], async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return donnees.col('pv').find({ date: { $gte: debut, $lte: fin } }, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/pv/:id', ['pv.voir', 'etats.voir'], async ({ p }) => {
    const d = await donnees.col('pv').findOne({ _id: p.id });
    if (!d) throw new ErreurMetier('PV introuvable.', 404);
    return d;
  });
  r('POST', '/api/pv', 'pv.saisir', ({ user, body }) => svc.creerPV(user, body));

  r('GET', '/api/previsions/:annee', 'previsions.voir', ({ p }) => svc.getPrevisions(p.annee));
  r('PUT', '/api/previsions/:annee', 'previsions.modifier', ({ user, body, p }) => svc.setPrevisions(user, p.annee, body));

  r('GET', '/api/etats/journal-banque', 'etats.voir', ({ q }) => { const { debut, fin } = periode(q, svc); return rep.journalBanque(debut, fin, q.get('compteId') || null); });
  r('GET', '/api/etats/livre-caisse', ['etats.voir', 'caisse.voir'], ({ q }) => { const { debut, fin } = periode(q, svc); return rep.livreCaisse(debut, fin); });
  r('GET', '/api/etats/tresorerie', 'etats.voir', ({ q }) => { const { debut, fin } = periode(q, svc); return rep.tresorerie(debut, fin); });
  r('GET', '/api/etats/rapport', 'etats.voir', ({ q }) => { const { debut, fin } = periode(q, svc); return rep.rapport(debut, fin); });
  r('GET', '/api/tableau-de-bord', null, () => rep.tableauDeBord());

  /* ---------------------------------------------- Double stockage */
  // Le PC vérifie que le serveur en ligne (Render) a la même version que lui.
  // S'il est plus récent, ce PC se met à jour tout seul à partir du serveur en ligne.
  let enLigne = null;
  let majPrete = null; // { version } : fichiers remplacés, redémarrage en attente
  let majEchec = null;
  async function verifierServeurEnLigne() {
    const url = DEFAUT_CLOUD.serveurEnLigne;
    if (MODE !== 'double' || !url) return;
    try {
      const r = await fetch(`${url}/api/sante`, { signal: AbortSignal.timeout(70000) });
      const j = await r.json();
      const distante = j.version || 'ancienne';
      enLigne = { url, version: distante, aJour: distante === VERSION, plusRecent: miseAJour.plusRecente(distante, VERSION), verifieLe: new Date().toISOString() };
      if (enLigne.plusRecent && !majPrete && !sea && process.env.MAJ_AUTO !== 'false') await installerMiseAJour(url, distante);
    } catch (e) { enLigne = { url, injoignable: true, verifieLe: new Date().toISOString() }; }
  }
  async function installerMiseAJour(url, distante) {
    console.log(`Nouvelle version disponible sur le serveur en ligne (${distante}) : téléchargement…`);
    const r = await fetch(`${url}/api/mise-a-jour/paquet`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) { majEchec = { version: distante, raison: `Paquet indisponible (${r.status})` }; return; }
    const res = miseAJour.appliquer(APP_DIR, await r.json(), VERSION);
    if (!res.ok) {
      majEchec = { version: distante, raison: res.raison === 'dependances' ? 'Cette version demande une réinstallation : lancez le nouvel installateur.' : res.raison };
      console.error('Mise à jour non installée :', majEchec.raison);
      return;
    }
    majEchec = null;
    majPrete = { version: distante };
    console.log(`Mise à jour ${distante} installée (${res.fichiers} fichier(s)) : redémarrage dès que possible.`);
    await svc.audit(donnees, null, 'Mise à jour automatique installée', `${VERSION} → ${distante}`).catch(() => {});
    diffuser('mise-a-jour', { version: distante });
    // Personne n'utilise l'application : redémarrage immédiat. Sinon, la fenêtre le déclenche
    // dès qu'aucune saisie n'est en cours (au plus tard 30 minutes après).
    if (!clients.size) setTimeout(() => redemarrer(), 1000);
    else setTimeout(() => redemarrer(), 30 * 60000).unref();
  }
  setTimeout(verifierServeurEnLigne, 5000);
  setInterval(verifierServeurEnLigne, 10 * 60000).unref();
  const etatStockageBrut = () => (synchro ? synchro.etat() : { mode: MODE, cloud: MODE === 'cloud' ? 'connecte' : 'desactive', enLigne: MODE === 'cloud', enAttente: 0, local: { ok: false }, conflits: [] });
  const etatStockage = () => ({
    ...etatStockageBrut(), version: VERSION, serveurEnLigne: enLigne, majPrete, majEchec,
    relais: MODE === 'double' && store.meta && store.meta.relais ? { url: store.meta.relais.url, utilisateur: store.meta.relais.utilisateur, le: store.meta.relais.le } : null,
    relaisPossible: MODE === 'double' && !!(DEFAUT_CLOUD && DEFAUT_CLOUD.serveurEnLigne),
  });
  r('GET', '/api/stockage', null, async () => etatStockage());
  r('POST', '/api/stockage/verifier-serveur', 'stockage.gerer', async () => { await verifierServeurEnLigne(); return etatStockage(); });
  // Appelé par la fenêtre quand aucune saisie n'est en cours : charge la nouvelle version.
  r('POST', '/api/mise-a-jour/appliquer', null, async () => {
    if (!majPrete) return { ok: false };
    setTimeout(() => redemarrer(), 300);
    return { ok: true, version: majPrete.version };
  });
  r('POST', '/api/stockage/synchroniser', 'stockage.gerer', async () => (synchro ? synchro.synchroniserMaintenant() : etatStockage()));
  const DEFAUT_CLOUD = (() => { try { return require('./cloud-defaut.json'); } catch { return {}; } })();
  /** Décompose une chaîne mongodb+srv:// en utilisateur / mot de passe / adresse du cluster. */
  function decomposer(uri) {
    try {
      const u = new URL(uri);
      return { utilisateur: decodeURIComponent(u.username), motDePasse: decodeURIComponent(u.password), hote: u.host };
    } catch { return { utilisateur: '', motDePasse: '', hote: '' }; }
  }
  r('GET', '/api/stockage/config', 'stockage.gerer', async () => {
    const actuel = decomposer(process.env.MONGODB_URI || '');
    return {
      active: !!process.env.MONGODB_URI,
      utilisateur: actuel.utilisateur || DEFAUT_CLOUD.utilisateur || '',
      hote: actuel.hote || DEFAUT_CLOUD.hote || '',
      motDePasseEnregistre: !!actuel.motDePasse,
      base: process.env.MONGODB_DB || DEFAUT_CLOUD.base || 'gestion_fonds', poste: posteCourant(), fichier: FICHIER_ENV,
    };
  });
  /** Construit la chaîne de connexion à partir des champs du formulaire (ou d'une chaîne collée). */
  const uriSaisie = (b) => {
    let hote = String(b.hote || '').trim();
    let utilisateur = String(b.utilisateur || '').trim();
    let motDePasse = String(b.motDePasse || '');
    if (/^mongodb(\+srv)?:\/\//.test(hote)) { // chaîne complète collée depuis Atlas
      const d = decomposer(hote);
      hote = d.hote; utilisateur = utilisateur || d.utilisateur;
      if (!motDePasse && d.motDePasse && !/^<.*>$/.test(d.motDePasse)) motDePasse = d.motDePasse;
    }
    hote = hote.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.mongodb\.net$/i.test(hote) && !/^[a-z0-9.-]+(:\d+)?$/i.test(hote)) throw new ErreurMetier("Adresse du cluster invalide (exemple : cluster0.abcd123.mongodb.net).");
    if (!utilisateur) throw new ErreurMetier("Indiquez l'utilisateur de base de données.");
    if (!motDePasse) {
      const actuel = decomposer(process.env.MONGODB_URI || '');
      if (actuel.motDePasse && actuel.hote === hote && actuel.utilisateur === utilisateur) motDePasse = actuel.motDePasse;
      else throw new ErreurMetier("Indiquez le mot de passe de l'utilisateur de base de données.");
    }
    const schema = /\.mongodb\.net$/i.test(hote) ? 'mongodb+srv' : 'mongodb';
    return `${schema}://${encodeURIComponent(utilisateur)}:${encodeURIComponent(motDePasse)}@${hote}/?retryWrites=true&w=majority&appName=GestionFonds`;
  };
  const nomBase = (b) => { const v = String(b || 'gestion_fonds').trim(); if (!/^[\w-]{1,60}$/.test(v)) throw new ErreurMetier('Nom de base invalide (lettres, chiffres, _ et -).'); return v; };
  async function testerCloud(uri, base) {
    let client;
    try {
      const { MongoClient } = require('mongodb');
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000 });
      await client.connect();
      await client.db(base).command({ ping: 1 });
      const nb = await client.db(base).collection('operations').countDocuments({}).catch(() => 0);
      return { ok: true, message: `Connexion réussie à la base « ${base} »${nb ? ` (${nb} opération(s) déjà présentes)` : ''}.` };
    } catch (e) {
      let m = e.message;
      if (/auth|bad auth/i.test(m)) m = 'Utilisateur ou mot de passe de base de données refusé par Atlas (Database Access).';
      else if (/ENOTFOUND|querySrv/i.test(m)) m = 'Adresse du cluster introuvable : vérifiez la chaîne de connexion et l\'accès Internet.';
      else if (/tlsv1 alert internal error|ssl3_read_bytes|SSL routines/i.test(m)) m = "Atlas refuse la connexion de ce PC : son adresse IP n'est pas autorisée. Dans Atlas : Network Access → Add IP Address → Add Current IP Address, puis réessayez.";
      else if (/Server selection timed out|ETIMEDOUT|ECONNREFUSED/i.test(m)) m = 'Cluster injoignable : autorisez l\'adresse IP de ce PC dans Atlas (Network Access) et vérifiez Internet.';
      else if (/Cannot find module 'mongodb'/.test(m)) m = 'Pilote MongoDB absent : relancez l\'installateur avec une connexion Internet.';
      return { ok: false, message: m };
    } finally { if (client) await client.close().catch(() => {}); }
  }
  r('POST', '/api/stockage/tester', 'stockage.gerer', async ({ body }) => testerCloud(uriSaisie(body), nomBase(body.base)));
  r('PUT', '/api/stockage/config', 'stockage.gerer', async ({ user, body }) => {
    if (MODE !== 'double') throw new ErreurMetier('Paramétrage disponible uniquement avec le stockage local.');
    const poste = String(body.poste || posteCourant()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'P1';
    if (body.active === false) {
      majEnv({ MONGODB_URI: '', POSTE: poste });
      await store.majMeta({ cloud: null });
      await configurerCloud();
      await svc.audit(donnees, user, 'Connexion cloud désactivée', '', 'Stockage local uniquement');
      return etatStockage();
    }
    const uri = uriSaisie(body); const base = nomBase(body.base);
    const t = await testerCloud(uri, base);
    if (!t.ok) throw new ErreurMetier(t.message);
    majEnv({ MONGODB_URI: uri, MONGODB_DB: base, POSTE: poste });
    await store.majMeta({ cloud: { uri, base, poste } });
    await configurerCloud();
    await svc.audit(donnees, user, 'Connexion cloud activée', base, `Poste ${poste}`);
    return { ...etatStockage(), message: t.message };
  });
  r('POST', '/api/stockage/renvoyer', 'stockage.gerer', async ({ user }) => {
    if (!synchro || !store.toutRenvoyer) throw new ErreurMetier('Disponible uniquement en mode double stockage.');
    const n = await store.toutRenvoyer();
    await svc.audit(donnees, user, 'Renvoi complet vers le cloud', '', `${n} documents`);
    return { ...etatStockage(), renvoyes: n };
  });

  r('GET', '/api/audit', 'audit.voir', async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return donnees.col('audit').find({ quand: { $gte: debut, $lte: `${fin}T23:59:59.999Z` } }, { sort: { quand: -1 }, limit: 1000 });
  });

  /* ------------------------------------------- Utilisateurs et rôles */
  // Le mot de passe défini par l'administrateur est conservé chiffré pour pouvoir le lui réafficher.
  // La clé est dérivée de l'identifiant interne du compte : identique sur le PC et sur le serveur en ligne.
  const cleMdp = (id) => crypto.createHash('sha256').update(`gestion-fonds/mdp-administrateur/v1/${id}`).digest();
  const chiffrerMdp = (id, mdp) => {
    const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', cleMdp(id), iv);
    const e = Buffer.concat([c.update(String(mdp), 'utf8'), c.final()]);
    return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${e.toString('base64')}`;
  };
  const dechiffrerMdp = (id, v) => {
    const [iv, tag, e] = String(v).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', cleMdp(id), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(e), d.final()]).toString('utf8');
  };
  const sansSecret = ({ sel, hash, mdpAdmin, ...u }) => ({ ...u, mdpConsultable: !!mdpAdmin });
  const roleExiste = async (id) => !!(await donnees.col('roles').findOne({ _id: id }));
  const nbAdminsActifs = async (sauf) => (await donnees.col('utilisateurs').find({ role: 'admin', actif: { $ne: false }, supprime: { $ne: true } })).filter((u) => u._id !== sauf).length;

  // Un responsable rattaché à une agence ne gère que les comptes de son agence, avec des rôles
  // qui n'excèdent pas ses propres droits ; il ne peut ni créer d'administrateur ni toucher aux rôles.
  const memeAgence = (user, u) => { if (user.agenceId && (u.agenceId || '') !== user.agenceId) throw new ErreurMetier('Utilisateur introuvable.', 404); };
  const agenceValide = async (id) => {
    if (!id) return '';
    const g = await store.col('agences').findOne({ _id: String(id) });
    if (!g) throw new ErreurMetier('Agence invalide.');
    if (g.actif === false) throw new ErreurMetier('Cette agence est désactivée.');
    return g._id;
  };
  /*
   * Deux sortes de comptes :
   *  - Administrateur : toutes les agences, tous les droits ;
   *  - Responsable d'agence : rattaché à UNE agence, avec les permissions cochées par l'administrateur.
   * La gestion des comptes est réservée à l'administration centrale.
   */
  const nomAgence = async (id) => (id ? ((await store.col('agences').findOne({ _id: id })) || {}).nom || id : 'toutes agences');
  async function lireAcces(body, existant) {
    const type = body.type || (body.role ? (body.role === 'admin' ? 'admin' : 'responsable') : (existant && existant.role === 'admin' ? 'admin' : 'responsable'));
    if (type === 'admin') return { role: 'admin', agenceId: '', permissions: null };
    let agenceId = body.agenceId !== undefined ? body.agenceId : (existant ? existant.agenceId : '');
    if (!agenceId) {
      const actives = (await store.col('agences').find({})).filter((g) => g.actif !== false);
      if (actives.length !== 1) throw new ErreurMetier("Choisissez l'agence du responsable.");
      agenceId = actives[0]._id;
    }
    agenceId = await agenceValide(agenceId);
    let perms;
    if (Array.isArray(body.permissions)) perms = body.permissions;
    else if (body.role) perms = await droits.permissionsDe(body.role);
    else perms = existant ? await droits.permissionsUtilisateur({ ...existant, agenceId }) : [];
    perms = CLES_RESPONSABLE.filter((c) => perms.includes(c));
    if (!perms.length) throw new ErreurMetier('Cochez au moins une permission pour ce responsable.');
    return { role: 'responsable-agence', agenceId, permissions: perms };
  }
  const libellesPerms = (l) => PERMISSIONS.filter((x) => l.includes(x.cle)).map((x) => x.cle).join(', ');
  r('GET', '/api/utilisateurs', 'utilisateurs.gerer', async ({ user }) => {
    exigerSiege(user);
    const us = await donnees.col('utilisateurs').find({ supprime: { $ne: true } }, { sort: { nom: 1 } });
    return Promise.all(us.map(async (u) => ({ ...sansSecret(u), type: u.role === 'admin' ? 'admin' : 'responsable', permissionsEffectives: await droits.permissionsUtilisateur(u) })));
  });
  r('GET', '/api/permissions/responsable', null, async () => PERMISSIONS.filter((x) => CLES_RESPONSABLE.includes(x.cle)));
  r('POST', '/api/utilisateurs', 'utilisateurs.gerer', async ({ user, body }) => {
    exigerSiege(user);
    const identifiant = String(body.identifiant || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(identifiant)) throw new ErreurMetier('Identifiant invalide : 3 à 40 caractères, lettres sans accent, chiffres, point, tiret ou souligné (ex. jean.kindu).');
    if (String(body.motDePasse || '').length < 8) throw new ErreurMetier('Mot de passe : 8 caractères minimum.');
    const acces = await lireAcces(body);
    const { sel, hash } = auth.hacher(body.motDePasse);
    const _id = crypto.randomUUID();
    if (await donnees.col('utilisateurs').findOne({ identifiant })) throw new ErreurMetier('Cet identifiant est déjà utilisé : choisissez-en un autre.');
    try {
      await donnees.col('utilisateurs').insertOne({
        _id, mdpAdmin: chiffrerMdp(_id, body.motDePasse),
        identifiant, nom: svc.texte(body.nom, 120) || identifiant, fonction: svc.texte(body.fonction, 120), telephone: svc.texte(body.telephone, 40),
        ...acces, sel, hash, actif: true, doitChanger: body.doitChanger === true, creeLe: new Date().toISOString(), creePar: user.identifiant,
      });
    } catch (e) {
      if (e.code === 11000) throw new ErreurMetier('Cet identifiant est déjà utilisé : choisissez-en un autre.');
      throw e;
    }
    await svc.audit(donnees, user, 'Accès accordé (utilisateur créé)', identifiant,
      acces.role === 'admin' ? 'Administrateur (toutes agences)' : `Responsable d'agence – ${await nomAgence(acces.agenceId)} – ${libellesPerms(acces.permissions)}`);
    return { ok: true, _id, identifiant };
  });
  r('PUT', '/api/utilisateurs/:id', 'utilisateurs.gerer', async ({ user, body, p }) => {
    exigerSiege(user);
    const u = await donnees.col('utilisateurs').findOne({ _id: p.id });
    if (!u || u.supprime) throw new ErreurMetier('Utilisateur introuvable.', 404);
    const moi = u._id === user._id;
    const maj = {};
    for (const k of ['nom', 'fonction', 'telephone']) if (body[k] !== undefined) maj[k] = svc.texte(body[k], 120);
    const touche = ['type', 'role', 'agenceId', 'permissions'].some((k) => body[k] !== undefined);
    if (touche && !moi) {
      const a = await lireAcces(body, u);
      if (a.role !== u.role) maj.role = a.role;
      if ((a.agenceId || '') !== (u.agenceId || '')) maj.agenceId = a.agenceId;
      const avant = Array.isArray(u.permissions) ? u.permissions : null;
      if (JSON.stringify(a.permissions) !== JSON.stringify(avant)) maj.permissions = a.permissions;
    }
    if (body.actif !== undefined && !moi && !!body.actif !== (u.actif !== false)) maj.actif = !!body.actif;
    if (u.role === 'admin' && (maj.actif === false || (maj.role && maj.role !== 'admin')) && (await nbAdminsActifs(u._id)) === 0) throw new ErreurMetier('Il doit rester au moins un administrateur actif.');
    if (body.motDePasse) {
      if (String(body.motDePasse).length < 8) throw new ErreurMetier('Mot de passe : 8 caractères minimum.');
      Object.assign(maj, auth.hacher(body.motDePasse));
      maj.mdpAdmin = chiffrerMdp(u._id, body.motDePasse);
      maj.mdpModifieParUtilisateur = false;
      maj.doitChanger = body.doitChanger === true;
    }
    // Mot de passe redéfini : toutes les sessions sont fermées. Suspension : la session est gelée (écran
    // bloqué en direct) puis rouverte automatiquement à la réactivation.
    if (body.motDePasse) maj.versionSession = (u.versionSession || 0) + 1;
    if (!Object.keys(maj).length) return { ok: true };
    await donnees.col('utilisateurs').updateOne({ _id: u._id }, { $set: maj });
    const quoi = [
      maj.role && (maj.role === 'admin' ? 'devient administrateur' : "devient responsable d'agence"),
      maj.agenceId !== undefined && `agence → ${await nomAgence(maj.agenceId)}`,
      maj.permissions && `permissions → ${libellesPerms(maj.permissions)}`,
      maj.actif === false && 'accès suspendu', maj.actif === true && 'accès rétabli', body.motDePasse && 'mot de passe redéfini',
    ].filter(Boolean).join(' ; ') || 'informations modifiées';
    await svc.audit(donnees, user, 'Utilisateur modifié', u.identifiant, quoi);
    return { ok: true };
  });

  r('GET', '/api/utilisateurs/:id/mot-de-passe', 'utilisateurs.gerer', async ({ user, p }) => {
    const u = await donnees.col('utilisateurs').findOne({ _id: p.id });
    if (!u || u.supprime) throw new ErreurMetier('Utilisateur introuvable.', 404);
    memeAgence(user, u);
    if (u.role === 'admin' && user.agenceId) throw new ErreurMetier('Utilisateur introuvable.', 404);
    if (!u.mdpAdmin) throw new ErreurMetier(u.mdpModifieParUtilisateur ? "L'utilisateur a choisi lui-même son mot de passe : il n'est pas consultable. Vous pouvez en définir un nouveau avec « Modifier »." : "Ce mot de passe a été défini avant cette version : définissez-le à nouveau avec « Modifier » pour pouvoir l'afficher.");
    await svc.audit(donnees, user, 'Mot de passe consulté par l\'administrateur', u.identifiant);
    return { motDePasse: dechiffrerMdp(u._id, u.mdpAdmin) };
  });

  r('POST', '/api/utilisateurs/:id/supprimer', 'utilisateurs.gerer', async ({ user, p }) => {
    const u = await donnees.col('utilisateurs').findOne({ _id: p.id });
    if (!u || u.supprime) throw new ErreurMetier('Utilisateur introuvable.', 404);
    memeAgence(user, u);
    if (u.role === 'admin' && user.agenceId) throw new ErreurMetier("Seule l'administration centrale peut supprimer un administrateur.", 403);
    if (u._id === user._id) throw new ErreurMetier('Vous ne pouvez pas supprimer votre propre compte.');
    if (u.role === 'admin' && (await nbAdminsActifs(u._id)) === 0) throw new ErreurMetier('Il doit rester au moins un administrateur actif.');
    // Suppression « logique » : le compte disparaît, ne peut plus se connecter et son identifiant redevient libre ;
    // les opérations et le journal d'audit gardent la trace de ce qu'il a fait.
    await donnees.col('utilisateurs').updateOne({ _id: u._id }, { $set: {
      supprime: true, actif: false, identifiant: `${u.identifiant}~supprime~${Date.now()}`, identifiantInitial: u.identifiant,
      sel: '', hash: '', mdpAdmin: '', supprimeLe: new Date().toISOString(), supprimePar: user.identifiant, versionSession: (u.versionSession || 0) + 1,
    } });
    await svc.audit(donnees, user, 'Compte utilisateur supprimé', u.identifiant, u.nom);
    return { ok: true };
  });

  r('GET', '/api/roles', null, async () => {
    const roles = await donnees.col('roles').find({}, { sort: { nom: 1 } });
    const users = await donnees.col('utilisateurs').find({});
    return roles.map((ro) => ({ ...ro, permissions: ro._id === 'admin' ? CLES : ro.permissions, systeme: ro._id === 'admin', utilisateurs: users.filter((u) => u.role === ro._id && !u.supprime).length }));
  });
  r('GET', '/api/permissions', null, async () => PERMISSIONS);
  const lireRole = (body) => {
    const nom = svc.texte(body.nom, 60);
    if (!nom) throw new ErreurMetier('Donnez un nom au rôle.');
    const permissions = (Array.isArray(body.permissions) ? body.permissions : []).filter((k) => CLES.includes(k));
    return { nom, description: svc.texte(body.description, 160), permissions };
  };
  r('POST', '/api/roles', 'utilisateurs.gerer', async ({ user, body }) => {
    exigerSiege(user);
    const doc = lireRole(body);
    if ((await donnees.col('roles').find({})).some((ro) => ro.nom.toLowerCase() === doc.nom.toLowerCase())) throw new ErreurMetier('Un rôle porte déjà ce nom.');
    const ro = await donnees.col('roles').insertOne({ ...doc, creeLe: new Date().toISOString(), creePar: user.identifiant });
    await svc.audit(donnees, user, 'Rôle créé', doc.nom, `${doc.permissions.length} permission(s)`);
    return ro;
  });
  r('PUT', '/api/roles/:id', 'utilisateurs.gerer', async ({ user, body, p }) => {
    exigerSiege(user);
    if (p.id === 'admin') throw new ErreurMetier('Le rôle Administrateur est protégé : il garde toujours tous les droits.');
    const ro = await donnees.col('roles').findOne({ _id: p.id });
    if (!ro) throw new ErreurMetier('Rôle introuvable.', 404);
    const doc = lireRole(body);
    if ((await donnees.col('roles').find({})).some((x) => x._id !== p.id && x.nom.toLowerCase() === doc.nom.toLowerCase())) throw new ErreurMetier('Un rôle porte déjà ce nom.');
    await donnees.col('roles').updateOne({ _id: p.id }, { $set: { ...doc, semence: false } });
    await svc.audit(donnees, user, 'Rôle modifié', doc.nom, doc.permissions.join(', ') || 'aucune permission');
    return { ok: true };
  });
  r('POST', '/api/roles/:id/supprimer', 'utilisateurs.gerer', async ({ user, p }) => {
    exigerSiege(user);
    if (p.id === 'admin') throw new ErreurMetier('Le rôle Administrateur ne peut pas être supprimé.');
    const ro = await donnees.col('roles').findOne({ _id: p.id });
    if (!ro) throw new ErreurMetier('Rôle introuvable.', 404);
    const n = await donnees.col('utilisateurs').countDocuments({ role: p.id, supprime: { $ne: true } });
    if (n) throw new ErreurMetier(`Ce rôle est attribué à ${n} utilisateur(s) : changez d'abord leur rôle.`);
    await donnees.col('roles').deleteMany({ _id: p.id });
    await svc.audit(donnees, user, 'Rôle supprimé', ro.nom);
    return { ok: true };
  });

  /* ------------------------------------------------------ Connexion */
  async function ouvrirSession(req, res, u, action, extra = {}) {
    await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: { derniereConnexion: new Date().toISOString() } });
    await svc.audit(store, u, action, u.identifiant);
    return envoyer(res, 200, { ok: true, ...extra }, { 'Set-Cookie': `sid=${auth.emettre(u)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200${cookieSecurise(req) ? '; Secure' : ''}` });
  }
  /**
   * Ordinateur en double stockage : si le compte n'existe pas ici (ordinateur pas encore relié au cloud,
   * ou compte créé à l'instant sur un autre appareil), l'identifiant et le mot de passe sont vérifiés par
   * le serveur en ligne ; s'ils sont bons, la fenêtre bascule sur la version en ligne, session ouverte.
   */
  /** Ce poste doit-il (re)demander sa liaison au cloud ? (pas de liaison Atlas directe, pas de jeton valide) */
  const posteARelier = () => MODE === 'double' && !process.env.MONGODB_URI && DEFAUT_CLOUD.serveurEnLigne
    && (!store.meta.relais || !store.meta.relais.jeton || (synchro && ['refuse', 'suspendu'].includes(synchro.etatCloud)));
  async function enregistrerLiaison(jetonPoste, identifiant) {
    await store.majMeta({ relais: { url: DEFAUT_CLOUD.serveurEnLigne, jeton: jetonPoste, utilisateur: identifiant, le: new Date().toISOString() } });
    await configurerCloud();
    console.log(`Poste relié au cloud par le serveur en ligne (compte ${identifiant}).`);
  }
  /** Liaison en arrière-plan après une connexion locale réussie (le poste n'avait pas encore de liaison). */
  async function relierPoste(body) {
    try {
      const r = await fetch(`${DEFAUT_CLOUD.serveurEnLigne}/api/relais/jeton`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'gestion-fonds' },
        body: JSON.stringify({ identifiant: body.identifiant, motDePasse: body.motDePasse, poste: posteCourant() }), signal: AbortSignal.timeout(75000),
      });
      if (r.status !== 200) return;
      const j = await r.json();
      if (j.jetonPoste && posteARelier()) await enregistrerLiaison(j.jetonPoste, body.identifiant);
    } catch { /* hors ligne : nouvel essai à la prochaine connexion */ }
  }
  async function connexionEnLigne(body) {
    const url = DEFAUT_CLOUD.serveurEnLigne;
    if (MODE !== 'double' || !url || !body.identifiant || !body.motDePasse) return null;
    const id = String(body.identifiant).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').toLowerCase();
    const local = await store.col('utilisateurs').findOne({ identifiant: id });
    if (local && !local.supprime && synchro && synchro.enLigne) return null; // poste à jour avec le cloud : le mot de passe local fait foi
    let j;
    try {
      const r = await fetch(`${url}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'gestion-fonds' },
        body: JSON.stringify({ identifiant: body.identifiant, motDePasse: body.motDePasse, jeton: true, poste: posteCourant() }), signal: AbortSignal.timeout(75000),
      });
      if (r.status === 403) { const e = await r.json().catch(() => ({})); if (e.code === 'acces-suspendu') return { suspendu: true }; }
      if (r.status !== 200) return null;
      j = await r.json();
    } catch {
      throw new ErreurMetier("Ce compte n'est pas connu sur cet ordinateur et le serveur en ligne est injoignable : vérifiez la connexion Internet puis réessayez.", 401);
    }
    // Compte valide dans le cloud : ce poste se relie au cloud avec ce compte, récupère les données de
    // son périmètre, puis la session s'ouvre ICI (l'ordinateur continue de fonctionner hors connexion).
    if (j.jetonPoste && posteARelier()) {
      await enregistrerLiaison(j.jetonPoste, id);
      await synchro.premiereConnexion(30000);
    } else if (synchro && synchro.synchroniserMaintenant) await Promise.race([synchro.synchroniserMaintenant(), new Promise((r) => setTimeout(r, 20000))]);
    const u = await auth.connecter(body.identifiant, body.motDePasse);
    if (u && u.suspendu) return { suspendu: true };
    if (u) return { local: u };
    return j.jeton ? { enLigne: url, jeton: j.jeton } : null;
  }

  /* ---------------------------------------------------------- Serveur */
  const serveur = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!req.headers['x-lanceur']) derniereActivite = Date.now(); // activité de la fenêtre (pas du lanceur)
    const chemin = url.pathname;
    try {
      if (chemin === '/api/login' && req.method === 'POST') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const t = tentatives.get(ip) || { n: 0, jusqua: 0 };
        if (t.jusqua > Date.now()) throw new ErreurMetier('Trop de tentatives. Réessayez dans quelques minutes.', 429);
        const body = await lireCorps(req, 10000);
        const u = await auth.connecter(body.identifiant, body.motDePasse);
        if (u && u.suspendu) throw Object.assign(new ErreurMetier("Votre accès est suspendu par l'administrateur. Il sera rétabli dès qu'il le décidera.", 403), { code: 'acces-suspendu' });
        if (!u) {
          // Compte inconnu sur cet ordinateur (non relié au cloud, ou compte créé à l'instant ailleurs) :
          // vérification par le serveur en ligne, puis ouverture de la session directement sur celui-ci.
          const enLigne = await connexionEnLigne(body);
          if (enLigne && enLigne.suspendu) throw Object.assign(new ErreurMetier("Votre accès est suspendu par l'administrateur. Il sera rétabli dès qu'il le décidera.", 403), { code: 'acces-suspendu' });
          if (enLigne && enLigne.local) { tentatives.delete(ip); return ouvrirSession(req, res, enLigne.local, 'Connexion (poste relié au cloud)'); }
          if (enLigne) { tentatives.delete(ip); return envoyer(res, 200, { ok: true, ...enLigne }); }
          t.n += 1; if (t.n >= 5) { t.jusqua = Date.now() + 5 * 60000; t.n = 0; }
          tentatives.set(ip, t);
          throw new ErreurMetier('Identifiant ou mot de passe incorrect.', 401);
        }
        tentatives.delete(ip);
        if (posteARelier()) relierPoste(body); // liaison au cloud en arrière-plan
        const extra = {};
        if (body.jeton === true) extra.jeton = auth.emettreJeton(u);
        if (body.poste && relais) extra.jetonPoste = auth.emettreJetonPoste(u, body.poste);
        return ouvrirSession(req, res, u, 'Connexion', extra);
      }
      if (chemin.startsWith('/api/relais/')) {
        if (!relais) return envoyer(res, 404, { erreur: 'Relais indisponible sur ce serveur.' });
        if (chemin === '/api/relais/jeton' && req.method === 'POST') {
          const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
          const t = tentatives.get(ip) || { n: 0, jusqua: 0 };
          if (t.jusqua > Date.now()) throw new ErreurMetier('Trop de tentatives. Réessayez dans quelques minutes.', 429);
          const body = await lireCorps(req, 10000);
          const u = await auth.connecter(body.identifiant, body.motDePasse);
          if (!u) { t.n += 1; if (t.n >= 5) { t.jusqua = Date.now() + 5 * 60000; t.n = 0; } tentatives.set(ip, t); throw new ErreurMetier('Identifiant ou mot de passe incorrect.', 401); }
          if (u.suspendu) throw Object.assign(new ErreurMetier("Votre accès est suspendu par l'administrateur. Il sera rétabli dès qu'il le décidera.", 403), { code: 'acces-suspendu' });
          await svc.audit(store, u, 'Ordinateur relié au cloud', String(body.poste || '').slice(0, 12));
          return envoyer(res, 200, { ok: true, jetonPoste: auth.emettreJetonPoste(u, body.poste) });
        }
        const ctx = await relais.identifier(req);
        if (ctx && !limiteur.accepter(`p:${ctx.user._id}`, 2400)) return envoyer(res, 429, { erreur: 'Trop de requêtes.' }, { 'Retry-After': '10' });
        if (!ctx) return envoyer(res, 401, { erreur: 'Liaison de ce poste refusée : reconnectez-vous sur cet ordinateur.' });
        // Titulaire du poste suspendu : le poste est informé (écran bloqué) et ne reçoit plus rien.
        if (ctx.suspendu) return envoyer(res, 423, { erreur: 'Accès suspendu par l\'administrateur.', code: 'acces-suspendu', utilisateur: ctx.user._id });
        if (chemin === '/api/relais/etat') return envoyer(res, 200, { ok: true, utilisateur: ctx.user.identifiant, agence: ctx.agence });
        if (chemin === '/api/relais/flux') return relais.abonner(ctx, req, res);
        if (chemin === '/api/relais/lire' && req.method === 'GET') return envoyer(res, 200, await relais.lire(ctx, url.searchParams));
        if (req.headers['x-requested-with'] !== 'gestion-fonds') return envoyer(res, 403, { erreur: 'Requête refusée.' });
        if (chemin === '/api/relais/ecrire' && req.method === 'POST') return envoyer(res, 200, await relais.ecrire(ctx, await lireCorps(req, 16 * 1024 * 1024)));
        if (chemin === '/api/relais/compteur' && req.method === 'POST') return envoyer(res, 200, await relais.compteur(ctx, await lireCorps(req, 4000)));
        return envoyer(res, 404, { erreur: 'Ressource introuvable.' });
      }
      if (chemin === '/api/login/jeton' && req.method === 'POST') {
        if (req.headers['x-requested-with'] !== 'gestion-fonds') return envoyer(res, 403, { erreur: 'Requête refusée.' });
        const body = await lireCorps(req, 4000);
        const u = await auth.lireJeton(body.jeton);
        if (!u) throw new ErreurMetier('Lien de connexion expiré : reconnectez-vous.', 401);
        return ouvrirSession(req, res, u, 'Connexion (depuis un ordinateur non relié au cloud)');
      }
      if (chemin.startsWith('/api/installation')) {
        const vierge = (await store.col('utilisateurs').countDocuments({})) === 0;
        if (req.method === 'GET') return envoyer(res, 200, { premiereUtilisation: vierge, cloudPossible: MODE === 'double', defaut: DEFAUT_CLOUD });
        if (!vierge) return envoyer(res, 403, { erreur: 'L\'application est déjà initialisée : connectez-vous.' });
        if (req.headers['x-requested-with'] !== 'gestion-fonds') return envoyer(res, 403, { erreur: 'Requête refusée.' });
        const body = await lireCorps(req, 20000);
        if (chemin === '/api/installation/admin' && req.method === 'POST') {
          const identifiant = String(body.identifiant || '').trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,40}$/.test(identifiant)) throw new ErreurMetier('Identifiant invalide (3 à 40 caractères : lettres, chiffres, . _ -).');
          if (String(body.motDePasse || '').length < 8) throw new ErreurMetier('Mot de passe : 8 caractères minimum.');
          if (body.motDePasse !== body.confirmation) throw new ErreurMetier('Les deux mots de passe ne sont pas identiques.');
          const { sel, hash } = auth.hacher(body.motDePasse);
          const _id = crypto.randomUUID();
          await store.col('utilisateurs').insertOne({ _id, identifiant, nom: svc.texte(body.nom, 120) || 'Administrateur', role: 'admin', sel, hash, mdpAdmin: chiffrerMdp(_id, body.motDePasse), actif: true, creeLe: new Date().toISOString() });
          await svc.audit(store, null, 'Compte administrateur créé (premier démarrage)', identifiant);
          return envoyer(res, 200, { ok: true });
        }
        if (chemin === '/api/installation/cloud' && req.method === 'POST') {
          if (MODE !== 'double') throw new ErreurMetier('Indisponible dans ce mode.');
          const uri = uriSaisie(body); const base = nomBase(body.base);
          const t = await testerCloud(uri, base);
          if (!t.ok) throw new ErreurMetier(t.message);
          majEnv({ MONGODB_URI: uri, MONGODB_DB: base });
          await store.majMeta({ cloud: { uri, base } });
          await configurerCloud();
          await synchro.synchroniserMaintenant();
          for (let i = 0; i < 40 && !(await store.col('utilisateurs').countDocuments({})); i += 1) await new Promise((r) => setTimeout(r, 500));
          const n = await store.col('utilisateurs').countDocuments({});
          if (!n) throw new ErreurMetier('Connexion réussie, mais aucun utilisateur n\'existe encore dans le cloud. Créez plutôt le compte administrateur.');
          return envoyer(res, 200, { ok: true, utilisateurs: n });
        }
        return envoyer(res, 404, { erreur: 'Ressource introuvable.' });
      }
      if (chemin === '/api/logout' && req.method === 'POST') {
        return envoyer(res, 200, { ok: true }, { 'Set-Cookie': `sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${cookieSecurise(req) ? '; Secure' : ''}` });
      }
      if (chemin === '/api/mise-a-jour/paquet' && req.method === 'GET') {
        if (sea) return envoyer(res, 404, { erreur: 'Indisponible.' });
        return envoyer(res, 200, miseAJour.paquet(APP_DIR, VERSION));
      }
      if (chemin === '/api/sante') {
        return envoyer(res, 200, { ok: true, version: VERSION, stockage: synchro ? synchro.etat().mode : MODE, inactifDepuis: Math.round((Date.now() - derniereActivite) / 1000), fenetres: clients.size });
      }

      if (chemin.startsWith('/api/')) {
        const user = await auth.lire(cookies(req).sid);
        if (!user) return envoyer(res, 401, { erreur: 'Session expirée, veuillez vous reconnecter.' });
        // Limite par session (et non par adresse IP : tout un bureau peut partager la même adresse).
        if (!limiteur.accepter(`s:${user._id}`, 600)) {
          return envoyer(res, 429, { erreur: 'Trop de requêtes en peu de temps : patientez quelques secondes.' }, { 'Retry-After': '10' });
        }
        // Compte suspendu : seule l'attente de la réactivation reste possible (aucune donnée).
        if (user.suspendu && chemin === '/api/acces') return envoyer(res, 200, { etat: 'suspendu' });
        if (user.suspendu && chemin !== '/api/evenements') {
          return envoyer(res, 423, { erreur: "Votre accès est suspendu par l'administrateur.", code: 'acces-suspendu' });
        }
        if (chemin === '/api/acces') return envoyer(res, 200, { etat: 'actif' });
        user.permissions = await droits.permissionsUtilisateur(user);
        delete user.permissionsPerso;
        // Agence en vigueur : imposée pour un utilisateur rattaché à une agence ; au choix (en-tête X-Agence) sinon.
        user.agence = user.agenceId || null;
        if (!user.agenceId && req.headers['x-agence'] && req.headers['x-agence'] !== 'toutes') {
          const choix = String(req.headers['x-agence']).slice(0, 80);
          if (await store.col('agences').findOne({ _id: choix })) user.agence = choix;
        }
        // Une seule agence active : elle s'applique d'office (fonctionnement identique à une structure sans agences).
        if (!user.agence) {
          const actives = (await store.col('agences').find({})).filter((g) => g.actif !== false);
          if (actives.length === 1) user.agence = actives[0]._id;
        }

        if (chemin === '/api/evenements') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 3000\n\n');
          res.gf = { userId: user._id, v: user.versionSession, etat: user.suspendu ? 'suspendu' : 'actif', depuis: Date.now() };
          res.write(`event: acces\ndata: ${JSON.stringify({ etat: res.gf.etat })}\n\n`);
          if (!user.suspendu) res.write(`event: version\ndata: ${JSON.stringify({ version: VERSION, majPrete: !!majPrete })}\n\n`);
          // Plafond de fenêtres temps réel par utilisateur : la plus ancienne est fermée au-delà.
          const miennes = [...clients].filter((c) => c.gf && c.gf.userId === user._id).sort((a, b) => a.gf.depuis - b.gf.depuis);
          while (miennes.length >= 20) miennes.shift().end();
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return undefined;
        }
        if (chemin === '/api/stockage/sauvegarde' && req.method === 'GET') {
          if (user.role !== 'admin') return envoyer(res, 403, { erreur: "Vous n'avez pas les droits nécessaires pour cette action." });
          const contenu = store.exporter ? store.exporter() : { erreur: 'Sauvegarde disponible uniquement avec le stockage local.' };
          await svc.audit(store, user, 'Sauvegarde téléchargée', '');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="sauvegarde-gestion-fonds-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store', ...SECURITE });
          return res.end(JSON.stringify(contenu));
        }
        // Protection CSRF : les requêtes d'écriture doivent venir de l'application.
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'gestion-fonds') {
          return envoyer(res, 403, { erreur: 'Requête refusée.' });
        }
        return await dansAgence(user.agence, async () => {
        for (const rt of routes) {
          if (rt.method !== req.method) continue;
          const m = chemin.match(rt.re);
          if (!m) continue;
          if (user.doitChanger && !(rt.method === 'GET' && chemin === '/api/me') && chemin !== '/api/me/mot-de-passe') {
            return envoyer(res, 403, { erreur: 'Changez votre mot de passe provisoire pour continuer.', code: 'changement-requis' });
          }
          if (rt.perm && ![].concat(rt.perm).some((x) => user.permissions.includes(x))) return envoyer(res, 403, { erreur: "Vous n'avez pas les droits nécessaires pour cette action." });
          const body = req.method === 'GET' ? {} : await lireCorps(req);
          const out = await rt.fn({ user, body, q: url.searchParams, p: m.groups || {} });
          // Cloud prioritaire : l'enregistrement n'est confirmé qu'une fois parti dans le cloud
          // (sinon il reste sur ce poste et partira dès le retour de la connexion).
          let cloud = {};
          if (req.method !== 'GET' && synchro && synchro.attendreEnvoi) cloud = { 'X-Cloud': (await synchro.attendreEnvoi(8000)) ? 'ok' : 'attente' };
          return envoyer(res, 200, out === undefined ? { ok: true } : out, cloud);
        }
        return envoyer(res, 404, { erreur: 'Ressource introuvable.' });
        });
      }

      // Fichiers statiques
      if (req.method !== 'GET' && req.method !== 'HEAD') return envoyer(res, 405, { erreur: 'Méthode non autorisée.' });
      const rel = chemin === '/' ? '/index.html' : decodeURIComponent(chemin);
      const contenu = rel.includes('..') ? null : lireStatique(rel);
      if (!contenu) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITE });
        return res.end('Introuvable');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITE });
      return res.end(req.method === 'HEAD' ? undefined : contenu);
    } catch (e) {
      if (e instanceof ErreurMetier || e.status) return envoyer(res, e.status || 400, { erreur: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });
      console.error(e);
      return envoyer(res, 500, { erreur: 'Erreur interne du serveur.' });
    }
  });

  const port = Number(process.env.PORT || PORT);
  let essaisPort = 0;
  serveur.on('error', (e) => {
    // Après une mise à jour, l'ancien processus libère le port quelques instants plus tard.
    if (e.code === 'EADDRINUSE' && process.env.GF_REDEMARRE === '1' && essaisPort < 40) {
      essaisPort += 1;
      setTimeout(() => serveur.listen(port), 500);
      return;
    }
    if (e.code === 'EADDRINUSE') console.error(`Le port ${port} est déjà utilisé : l'application est peut-être déjà ouverte (http://localhost:${port}). Sinon, changez PORT dans ${FICHIER_ENV}.`);
    else console.error(e.message);
    terminerAvecErreur();
  });
  serveur.listen(port, () => {
    console.log(`Application disponible sur http://localhost:${port}`);
    const ouvrir = process.env.OUVRIR_NAVIGATEUR === 'true' || (sea && process.env.OUVRIR_NAVIGATEUR !== 'false');
    if (ouvrir) {
      console.log('Laissez cette fenêtre ouverte pendant l\'utilisation. Fermez-la pour arrêter l\'application.');
      ouvrirNavigateur(`http://localhost:${port}`);
    }
  });
  const arret = async () => {
    serveur.close();
    if (synchro) await synchro.arreter();
    await store.close();
    process.exit(0);
  };
  /** Relance le serveur avec les fichiers mis à jour (même port, mêmes données). */
  redemarrer = async () => {
    if (redemarrer.enCours) return;
    redemarrer.enCours = true;
    console.log('Redémarrage pour charger la nouvelle version…');
    diffuser('redemarrage', { version: majPrete && majPrete.version });
    for (const c of clients) c.end();
    serveur.close();
    try { if (synchro) await synchro.arreter(); await store.close(); } catch (e) { console.error(e.message); }
    const { spawn } = require('child_process');
    let sortie = 'ignore';
    try { fs.mkdirSync(path.join(APP_DIR, 'journaux'), { recursive: true }); sortie = fs.openSync(path.join(APP_DIR, 'journaux', 'serveur.log'), 'a'); } catch { /* sans journal */ }
    spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', sortie, sortie],
      env: { ...process.env, GF_REDEMARRE: '1' },
    }).unref();
    process.exit(0);
  };
  // Un serveur relancé après mise à jour n'est plus suivi par le lanceur : il s'arrête seul
  // quand plus aucune fenêtre ne l'utilise.
  if (process.env.GF_REDEMARRE === '1' && MODE === 'double') {
    const limite = Number(process.env.GF_INACTIF_MS) || 180000;
    setInterval(() => { if (!clients.size && Date.now() - derniereActivite > limite) arret(); }, Math.min(30000, limite)).unref();
  }
  process.on('SIGHUP', arret); // fermeture de la fenêtre sous Windows
  process.on('SIGINT', arret); process.on('SIGTERM', arret);
}

/** Dans l'exécutable lancé par double-clic, garder la fenêtre ouverte pour lire l'erreur. */
function terminerAvecErreur() {
  if (sea && process.stdin.isTTY) {
    console.error('\nAppuyez sur Entrée pour fermer.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else process.exit(1);
}

// Configuration seule (utilisée par l'installateur) : crée le fichier .env puis s'arrête.
if (process.argv.includes('--configurer')) {
  assistantConfiguration().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
} else if (process.argv.includes('--verifier-installation')) {
  require('mongodb');
  console.log('INSTALLATION_OK');
  process.exit(0);
}

// Auto-test utilisé par le script de construction de l'exécutable.
if (process.argv.includes('--verifier')) {
  const { MongoClient } = require('mongodb');
  new MongoClient('mongodb://127.0.0.1:1'); // eslint-disable-line no-new
  if (sea && !lireStatique('/index.html')) { console.error('Interface absente de l\'exécutable'); process.exit(1); }
  console.log('VERIFICATION_OK');
  process.exit(0);
}

if (!process.argv.includes('--configurer')) demarrer().catch((e) => {
  console.error('Échec du démarrage :', e.message);
  if (/auth|bad auth|Authentication/i.test(e.message)) console.error(`Identifiants MongoDB refusés : vérifiez MONGODB_URI dans ${FICHIER_ENV}.`);
  else if (/ENOTFOUND|querySrv|Server selection timed out|ECONNREFUSED/i.test(e.message)) console.error("Cluster injoignable : vérifiez la connexion Internet et l'autorisation de votre adresse IP dans Atlas (Network Access).");
  terminerAvecErreur();
});
