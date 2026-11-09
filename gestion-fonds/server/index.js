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
const { createAuth, ROLES } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const MODE = (process.env.DB_MODE || 'double').toLowerCase(); // double | cloud | memory
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
let derniereActivite = Date.now();
let tempo = null; const enAttente = new Set();
function broadcast(collection) {
  enAttente.add(collection || '*');
  if (tempo) return;
  tempo = setTimeout(() => {
    const data = JSON.stringify({ collections: [...enAttente], quand: Date.now() });
    enAttente.clear(); tempo = null;
    for (const res of clients) res.write(`event: maj\ndata: ${data}\n\n`);
  }, 150);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------- Utilitaires */
const NIVEAU = { lecture: 1, saisie: 2, admin: 3 };
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
    if (!process.env.MONGODB_URI) { console.error('DB_MODE=cloud exige MONGODB_URI.'); terminerAvecErreur(); return; }
    store = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'gestion_fonds');
    await store.connect();
    console.log(`Stockage : cloud uniquement (base « ${process.env.MONGODB_DB || 'gestion_fonds'} »)`);
  } else {
    // DOUBLE STOCKAGE : base locale durable sur ce PC + réplication vers MongoDB Atlas.
    if (!fs.existsSync(FICHIER_ENV) && !process.env.MONGODB_URI && process.stdin.isTTY) await assistantConfiguration();
    const { LocalStore } = require('./local');
    const { Synchro } = require('./sync');
    const dossier = path.resolve(APP_DIR, process.env.DOSSIER_DONNEES || 'donnees');
    store = new LocalStore(dossier);
    await store.connect();
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

  const svc = createServices(store, broadcast);
  const rep = createReports(store, svc);
  const auth = createAuth(store, secret);
  store.watch((ev) => { if (ev.collection !== 'audit' && ev.collection !== 'compteurs') broadcast(ev.collection); });

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
  const mdp = await auth.initialiserAdmin(process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD);
  if (mdp) console.log(`Compte administrateur créé : identifiant « ${process.env.ADMIN_USER || 'admin'} », mot de passe : ${mdp}`);

  const tentatives = new Map();

  /* ------------------------------------------------------------ Routes */
  const routes = [];
  const r = (method, motif, niveau, fn) => routes.push({ method, re: new RegExp(`^${motif.replace(/:(\w+)/g, '(?<$1>[\\w-]+)')}$`), niveau, fn });

  r('GET', '/api/me', 1, async ({ user }) => ({ ...user, roleLibelle: ROLES[user.role] }));
  r('POST', '/api/me/mot-de-passe', 1, async ({ user, body }) => {
    const u = await auth.connecter(user.identifiant, body.ancien);
    if (!u) throw new ErreurMetier('Mot de passe actuel incorrect.');
    if (String(body.nouveau || '').length < 8) throw new ErreurMetier('Le nouveau mot de passe doit contenir au moins 8 caractères.');
    const { sel, hash } = auth.hacher(body.nouveau);
    await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: { sel, hash, versionSession: (u.versionSession || 0) + 1 } });
    return { ok: true };
  });

  r('GET', '/api/parametres', 1, () => svc.getParametres());
  r('PUT', '/api/parametres', 3, ({ user, body }) => svc.setParametres(user, body));

  r('GET', '/api/comptes', 1, () => svc.listeComptes());
  r('POST', '/api/comptes', 3, ({ user, body }) => svc.enregistrerCompte(user, body));
  r('PUT', '/api/comptes/:id', 3, ({ user, body, p }) => svc.enregistrerCompte(user, body, p.id));

  r('GET', '/api/fournisseurs', 1, () => svc.listeFournisseurs());
  r('POST', '/api/fournisseurs', 2, ({ user, body }) => svc.enregistrerFournisseur(user, body));
  r('PUT', '/api/fournisseurs/:id', 2, ({ user, body, p }) => svc.enregistrerFournisseur(user, body, p.id));

  r('GET', '/api/operations', 1, async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    const f = { date: { $gte: debut, $lte: fin } };
    if (q.get('compteId')) f.compteId = q.get('compteId');
    if (q.get('nature')) f.nature = q.get('nature');
    return store.col('operations').find(f, { sort: { date: -1, numero: -1 } });
  });
  r('POST', '/api/operations/entree', 2, ({ user, body }) => svc.entreeBanque(user, body));
  r('POST', '/api/operations/versement-caisse', 2, ({ user, body }) => svc.versementCaisse(user, body));
  r('POST', '/api/operations/virement', 2, ({ user, body }) => svc.virementFournisseur(user, body));
  r('POST', '/api/operations/transfert-caisse', 2, ({ user, body }) => svc.transfertCaisse(user, body));
  r('POST', '/api/operations/:id/annuler', 3, ({ user, body, p }) => svc.annulerOperation(user, p.id, body.motif));

  r('GET', '/api/ordres', 1, async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return store.col('ordres').find({ date: { $gte: debut, $lte: fin } }, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/ordres/:id', 1, async ({ p }) => {
    const o = await store.col('ordres').findOne({ _id: p.id });
    if (!o) throw new ErreurMetier('Ordre introuvable.', 404);
    return o;
  });

  r('GET', '/api/bons', 1, async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    const f = { date: { $gte: debut, $lte: fin } };
    if (q.get('type')) f.type = q.get('type');
    return store.col('bons').find(f, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/bons/:id', 1, async ({ p }) => {
    const b = await store.col('bons').findOne({ _id: p.id });
    if (!b) throw new ErreurMetier('Bon introuvable.', 404);
    return b;
  });
  r('POST', '/api/bons', 2, ({ user, body }) => svc.bonManuel(user, body));
  r('POST', '/api/bons/:id/annuler', 3, ({ user, body, p }) => svc.annulerBon(user, p.id, body.motif));

  r('GET', '/api/caisse/solde', 1, async ({ q }) => {
    const d = q.get('date') ? svc.exigerDate(q.get('date')) : null;
    const avant = d ? new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10) : null;
    return { date: d, solde: await svc.soldeCaisse(store, avant) };
  });
  r('GET', '/api/clotures', 1, () => store.col('clotures').find({}, { sort: { date: -1 }, limit: 60 }));
  r('POST', '/api/clotures', 2, ({ user, body }) => svc.cloturerJournee(user, body.date));

  r('GET', '/api/pv', 1, async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return store.col('pv').find({ date: { $gte: debut, $lte: fin } }, { sort: { date: -1, numero: -1 } });
  });
  r('GET', '/api/pv/:id', 1, async ({ p }) => {
    const d = await store.col('pv').findOne({ _id: p.id });
    if (!d) throw new ErreurMetier('PV introuvable.', 404);
    return d;
  });
  r('POST', '/api/pv', 2, ({ user, body }) => svc.creerPV(user, body));

  r('GET', '/api/previsions/:annee', 1, ({ p }) => svc.getPrevisions(p.annee));
  r('PUT', '/api/previsions/:annee', 2, ({ user, body, p }) => svc.setPrevisions(user, p.annee, body));

  r('GET', '/api/etats/journal-banque', 1, ({ q }) => { const { debut, fin } = periode(q, svc); return rep.journalBanque(debut, fin, q.get('compteId') || null); });
  r('GET', '/api/etats/livre-caisse', 1, ({ q }) => { const { debut, fin } = periode(q, svc); return rep.livreCaisse(debut, fin); });
  r('GET', '/api/etats/tresorerie', 1, ({ q }) => { const { debut, fin } = periode(q, svc); return rep.tresorerie(debut, fin); });
  r('GET', '/api/etats/rapport', 1, ({ q }) => { const { debut, fin } = periode(q, svc); return rep.rapport(debut, fin); });
  r('GET', '/api/tableau-de-bord', 1, () => rep.tableauDeBord());

  /* ---------------------------------------------- Double stockage */
  const etatStockage = () => (synchro ? synchro.etat() : { mode: MODE, cloud: MODE === 'cloud' ? 'connecte' : 'desactive', enLigne: MODE === 'cloud', enAttente: 0, local: { ok: false }, conflits: [] });
  r('GET', '/api/stockage', 1, async () => etatStockage());
  r('POST', '/api/stockage/synchroniser', 2, async () => (synchro ? synchro.synchroniserMaintenant() : etatStockage()));
  const DEFAUT_CLOUD = (() => { try { return require('./cloud-defaut.json'); } catch { return {}; } })();
  /** Décompose une chaîne mongodb+srv:// en utilisateur / mot de passe / adresse du cluster. */
  function decomposer(uri) {
    try {
      const u = new URL(uri);
      return { utilisateur: decodeURIComponent(u.username), motDePasse: decodeURIComponent(u.password), hote: u.host };
    } catch { return { utilisateur: '', motDePasse: '', hote: '' }; }
  }
  r('GET', '/api/stockage/config', 3, async () => {
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
  r('POST', '/api/stockage/tester', 3, async ({ body }) => testerCloud(uriSaisie(body), nomBase(body.base)));
  r('PUT', '/api/stockage/config', 3, async ({ user, body }) => {
    if (MODE !== 'double') throw new ErreurMetier('Paramétrage disponible uniquement avec le stockage local.');
    const poste = String(body.poste || posteCourant()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'P1';
    if (body.active === false) {
      majEnv({ MONGODB_URI: '', POSTE: poste });
      await configurerCloud();
      await svc.audit(store, user, 'Connexion cloud désactivée', '', 'Stockage local uniquement');
      return etatStockage();
    }
    const uri = uriSaisie(body); const base = nomBase(body.base);
    const t = await testerCloud(uri, base);
    if (!t.ok) throw new ErreurMetier(t.message);
    majEnv({ MONGODB_URI: uri, MONGODB_DB: base, POSTE: poste });
    await configurerCloud();
    await svc.audit(store, user, 'Connexion cloud activée', base, `Poste ${poste}`);
    return { ...etatStockage(), message: t.message };
  });
  r('POST', '/api/stockage/renvoyer', 3, async ({ user }) => {
    if (!synchro || !store.toutRenvoyer) throw new ErreurMetier('Disponible uniquement en mode double stockage.');
    const n = await store.toutRenvoyer();
    await svc.audit(store, user, 'Renvoi complet vers le cloud', '', `${n} documents`);
    return { ...etatStockage(), renvoyes: n };
  });

  r('GET', '/api/audit', 3, async ({ q }) => {
    const { debut, fin } = periode(q, svc);
    return store.col('audit').find({ quand: { $gte: debut, $lte: `${fin}T23:59:59.999Z` } }, { sort: { quand: -1 }, limit: 1000 });
  });

  r('GET', '/api/utilisateurs', 3, async () => (await store.col('utilisateurs').find({}, { sort: { identifiant: 1 } }))
    .map(({ sel, hash, ...u }) => u));
  r('POST', '/api/utilisateurs', 3, async ({ user, body }) => {
    const identifiant = String(body.identifiant || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(identifiant)) throw new ErreurMetier('Identifiant invalide (3 à 40 caractères : lettres, chiffres, . _ -).');
    if (!ROLES[body.role]) throw new ErreurMetier('Rôle invalide.');
    if (String(body.motDePasse || '').length < 8) throw new ErreurMetier('Mot de passe : 8 caractères minimum.');
    const { sel, hash } = auth.hacher(body.motDePasse);
    try {
      await store.col('utilisateurs').insertOne({ identifiant, nom: svc.texte(body.nom, 120) || identifiant, role: body.role, sel, hash, actif: true, creeLe: new Date().toISOString() });
    } catch (e) {
      if (e.code === 11000) throw new ErreurMetier('Cet identifiant existe déjà.');
      throw e;
    }
    await svc.audit(store, user, 'Utilisateur créé', identifiant, ROLES[body.role]);
    return { ok: true };
  });
  r('PUT', '/api/utilisateurs/:id', 3, async ({ user, body, p }) => {
    const u = await store.col('utilisateurs').findOne({ _id: p.id });
    if (!u) throw new ErreurMetier('Utilisateur introuvable.', 404);
    const maj = {};
    if (body.nom !== undefined) maj.nom = svc.texte(body.nom, 120);
    if (body.role !== undefined) { if (!ROLES[body.role]) throw new ErreurMetier('Rôle invalide.'); maj.role = body.role; }
    if (body.actif !== undefined) maj.actif = !!body.actif;
    if (u._id === user._id && (maj.actif === false || (maj.role && maj.role !== 'admin'))) throw new ErreurMetier('Vous ne pouvez pas désactiver ou rétrograder votre propre compte.');
    if (body.motDePasse) {
      if (String(body.motDePasse).length < 8) throw new ErreurMetier('Mot de passe : 8 caractères minimum.');
      Object.assign(maj, auth.hacher(body.motDePasse));
    }
    if (body.motDePasse || maj.actif === false || maj.role) maj.versionSession = (u.versionSession || 0) + 1;
    await store.col('utilisateurs').updateOne({ _id: u._id }, { $set: maj });
    await svc.audit(store, user, 'Utilisateur modifié', u.identifiant, Object.keys(maj).filter((k) => !['sel', 'hash', 'versionSession'].includes(k)).join(', ') + (body.motDePasse ? ' (mot de passe réinitialisé)' : ''));
    return { ok: true };
  });

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
        if (!u) {
          t.n += 1; if (t.n >= 5) { t.jusqua = Date.now() + 5 * 60000; t.n = 0; }
          tentatives.set(ip, t);
          throw new ErreurMetier('Identifiant ou mot de passe incorrect.', 401);
        }
        tentatives.delete(ip);
        await svc.audit(store, u, 'Connexion', u.identifiant);
        return envoyer(res, 200, { ok: true }, { 'Set-Cookie': `sid=${auth.emettre(u)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200${cookieSecurise(req) ? '; Secure' : ''}` });
      }
      if (chemin === '/api/logout' && req.method === 'POST') {
        return envoyer(res, 200, { ok: true }, { 'Set-Cookie': `sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${cookieSecurise(req) ? '; Secure' : ''}` });
      }
      if (chemin === '/api/sante') {
        return envoyer(res, 200, { ok: true, stockage: synchro ? synchro.etat().mode : MODE, inactifDepuis: Math.round((Date.now() - derniereActivite) / 1000), fenetres: clients.size });
      }

      if (chemin.startsWith('/api/')) {
        const user = await auth.lire(cookies(req).sid);
        if (!user) return envoyer(res, 401, { erreur: 'Session expirée, veuillez vous reconnecter.' });

        if (chemin === '/api/evenements') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 3000\n\n');
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
        for (const rt of routes) {
          if (rt.method !== req.method) continue;
          const m = chemin.match(rt.re);
          if (!m) continue;
          if (NIVEAU[user.role] < rt.niveau) return envoyer(res, 403, { erreur: "Vous n'avez pas les droits nécessaires pour cette action." });
          const body = req.method === 'GET' ? {} : await lireCorps(req);
          const out = await rt.fn({ user, body, q: url.searchParams, p: m.groups || {} });
          return envoyer(res, 200, out === undefined ? { ok: true } : out);
        }
        return envoyer(res, 404, { erreur: 'Ressource introuvable.' });
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
      if (e instanceof ErreurMetier || e.status) return envoyer(res, e.status || 400, { erreur: e.message });
      console.error(e);
      return envoyer(res, 500, { erreur: 'Erreur interne du serveur.' });
    }
  });

  const port = Number(process.env.PORT || PORT);
  serveur.on('error', (e) => {
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
