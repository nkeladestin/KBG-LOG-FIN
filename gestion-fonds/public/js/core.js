'use strict';
/* =====================================================================
   Noyau de l'application : API, état, formats, modale, période, routeur,
   synchronisation temps réel.
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  me: null, params: null, comptes: [], fournisseurs: [],
  periode: null, route: 'tableau', filtres: {},
};

/* ----------------------------------------------------------- Agences */
S.agence = (() => { try { return sessionStorage.getItem('gf-agence') || ''; } catch { return ''; } })();
/** Nom de l'agence affichée : celle de l'utilisateur, celle choisie, ou le consolidé. */
const agencesActives = () => ((S.me && S.me.agences) || []).filter((g) => g.actif);
const nomAgenceVue = () => (S.me && S.me.agenceId ? S.me.agenceNom
  : S.agence ? (agencesActives().find((g) => g._id === S.agence) || {}).nom || ''
    : agencesActives().length === 1 ? agencesActives()[0].nom : 'Toutes les agences (consolidé)');
function majSelecteurAgence() {
  const z = $('#agence-zone');
  if (!S.me) { z.hidden = true; return; }
  const actives = (S.me.agences || []).filter((g) => g.actif);
  if (S.me.agenceId) {
    S.agence = '';
    z.hidden = false; $('#agence-sel').hidden = true; $('#agence-fixe').hidden = false; $('#agence-fixe').textContent = S.me.agenceNom || '';
    return;
  }
  if (S.agence && !actives.some((g) => g._id === S.agence)) S.agence = '';
  // Une seule agence : pas de choix à faire (elle s'applique d'office).
  if (actives.length <= 1) { S.agence = ''; z.hidden = true; return; }
  z.hidden = false; $('#agence-fixe').hidden = true;
  const sel = $('#agence-sel'); sel.hidden = false;
  sel.innerHTML = `<option value="">Toutes les agences (consolidé)</option>${actives.map((g) => `<option value="${g._id}">${esc(g.nom)}</option>`).join('')}`;
  sel.value = S.agence;
}
async function changerAgence(id) {
  S.agence = id || '';
  try { sessionStorage.setItem('gf-agence', S.agence); } catch { /* indisponible */ }
  await chargerReference().catch(() => {});
  await router();
}

/* ------------------------------------------------------------ Droits */
/** Vrai si l'utilisateur possède au moins une des permissions indiquées. */
const peut = (...perms) => !!(S.me && S.me.permissions && perms.some((p) => S.me.permissions.includes(p)));
/**
 * Masque tout élément portant data-perm="a,b" si l'utilisateur n'a aucune de ces permissions.
 * anime = vrai : un accès retiré pendant l'utilisation s'estompe à l'écran avant de disparaître.
 */
function appliquerDroits(racine, anime = false) {
  $$('[data-perm]', racine).forEach((el) => {
    const autorise = peut(...el.dataset.perm.split(','));
    if (autorise) { el.classList.remove('droit-retire'); el.hidden = false; return; }
    if (el.hidden) return;
    if (!anime) { el.hidden = true; return; }
    el.classList.add('droit-retire');
    setTimeout(() => { if (el.classList.contains('droit-retire')) { el.hidden = true; el.classList.remove('droit-retire'); majMenu(); } }, 900);
  });
}
/** Groupes du menu sans aucune entrée autorisée : masqués. */
function majMenu() {
  $$('#nav .nav-group').forEach((g) => {
    let el = g.nextElementSibling; let visible = false;
    while (el && !el.classList.contains('nav-group')) { if (!el.hidden && !el.classList.contains('droit-retire')) visible = true; el = el.nextElementSibling; }
    g.hidden = !visible;
  });
}

/**
 * Relit les droits de l'utilisateur connecté (appelé dès que l'administrateur modifie
 * un rôle ou un compte, sur n'importe quel appareil) et les applique immédiatement.
 */
let relectureDroits = null;
async function rafraichirDroits() {
  if (!S.me || relectureDroits) return relectureDroits;
  relectureDroits = (async () => {
    const avant = S.me;
    let me;
    try { me = await api('GET', '/api/me'); } catch (e) {
      // Compte désactivé ou supprimé : api() a déjà affiché l'écran de connexion.
      if (!S.me || $('#app').hidden) {
        const err = $('#login-error');
        err.textContent = "Votre accès a été retiré par l'administrateur."; err.hidden = false;
      }
      return;
    }
    // Changement d'agence décidé par l'administrateur : l'écran est rechargé avec les données de la nouvelle agence.
    if ((avant.agenceId || '') !== (me.agenceId || '')) { toast("L'administrateur a changé votre agence.", 'err'); setTimeout(() => location.reload(), 1200); return; }
    S.me = { ...avant, agences: me.agences, agenceNom: me.agenceNom };
    majSelecteurAgence();
    const retires = (avant.permissions || []).filter((p) => !(me.permissions || []).includes(p));
    const ajoutes = (me.permissions || []).filter((p) => !(avant.permissions || []).includes(p));
    S.me = me;
    $('#user-nom').textContent = me.nom;
    $('#user-role').textContent = me.roleLibelle + (me.agenceId ? ` · ${me.agenceNom}` : '');
    if (!retires.length && !ajoutes.length) return;
    appliquerDroits(document, true);
    majMenu();
    if (retires.length) {
      if (!$('#modal').hidden && !me.doitChanger && !$('#modal-body form[data-garder]')) fermerModale();
      if (!$('#doc').hidden) fermerDocument();
      toast("L'administrateur a modifié vos accès : certaines fonctions ne sont plus disponibles.", 'err');
    } else toast("L'administrateur vous a donné de nouveaux accès.", 'ok');
    // Page devenue interdite : retour au tableau de bord ; sinon la page est redessinée avec les nouveaux droits.
    const page = PAGES[S.route];
    if (page && page.perm && !peut(...page.perm.split(','))) { if (page.dirty) page.dirty = false; location.hash = '#/tableau'; await router(); }
    else if (!(page && page.dirty)) await afficherPage();
  })().finally(() => { relectureDroits = null; });
  return relectureDroits;
}

/* ----------------------------------------------------------- Formats */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nb(n) {
  const d = (S.params && S.params.decimales) || 0;
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(n) || 0).replace(/ /g, ' ');
}
const money = (n) => `${nb(n)} ${esc((S.params && S.params.devise) || '')}`;
const fd = (d) => (d ? d.split('-').reverse().join('/') : '');
const fdt = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`; };
const MOIS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dLong = (d) => { const [a, m, j] = d.split('-').map(Number); return `${j === 1 ? '1er' : j} ${MOIS_L[m - 1]} ${a}`; };
const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());

/* --------------------------------------------------------------- API */
async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'gestion-fonds' }, credentials: 'same-origin' };
  if (S.agence) opt.headers['X-Agence'] = S.agence; // agence choisie (ignorée par le serveur pour un compte rattaché)
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (r.status === 401 && !url.endsWith('/login')) { afficherLogin(); throw new Error('Session expirée.'); }
  if (r.status === 403 && data && data.code === 'changement-requis') { modaleMotDePasse(true); throw new Error(data.erreur); }
  if (r.status === 423 && data && data.code === 'acces-suspendu') { suspendre(); throw Object.assign(new Error(data.erreur), { suspendu: true }); }
  if (!r.ok) throw new Error((data && data.erreur) || `Erreur ${r.status}`);
  // Cloud prioritaire : le serveur de l'ordinateur indique si l'enregistrement est déjà dans le cloud.
  const cloud = r.headers.get('X-Cloud');
  if (cloud === 'attente') {
    if (!S.alerteHorsLigne || Date.now() - S.alerteHorsLigne > 60000) {
      S.alerteHorsLigne = Date.now();
      toast("Pas de connexion au cloud : l'enregistrement est conservé sur cet ordinateur et partira automatiquement dès le retour de la connexion.", 'err');
    }
    majStockage();
  } else if (cloud === 'ok' && S.stockage && !S.stockage.enLigne) majStockage();
  return data;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

/* ------------------------------------------------------ Notifications */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}

/* ------------------------------------------------------------ Modale */
function ouvrirModale(titre, html, onMount) {
  $('#modal-title').textContent = titre;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const fermer = $('#modal .modal-box header .icon-btn'); if (fermer) fermer.hidden = false;
  appliquerDroits($('#modal-body'));
  if (onMount) onMount($('#modal-body'));
  const first = $('#modal-body input:not([type=hidden]):not([readonly]), #modal-body select');
  if (first) first.focus();
}
function fermerModale() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }

/** Lie un formulaire : sérialise, appelle submit(data), affiche les erreurs. */
function lierFormulaire(form, submit) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error');
    if (err) err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      await submit(data, form);
    } catch (ex) {
      if (err) { err.textContent = ex.message; err.hidden = false; } else toast(ex.message, 'err');
    } finally { if (btn) btn.disabled = false; }
  });
}

/* ------------------------------------------------------------ Période */
const TYPES_PERIODE = { jour: 'Journalière', semaine: 'Hebdomadaire', mois: 'Mensuelle', trimestre: 'Trimestrielle', semestre: 'Semestrielle', annee: 'Annuelle', perso: 'Personnalisée' };

function calculerPeriode(type, ref, debut, fin) {
  const d = new Date(`${ref || today()}T12:00:00`);
  const y = d.getFullYear(); const m = d.getMonth();
  switch (type) {
    case 'jour': return { debut: iso(d), fin: iso(d) };
    case 'semaine': { const j = (d.getDay() + 6) % 7; const l = new Date(d); l.setDate(d.getDate() - j); const s = new Date(l); s.setDate(l.getDate() + 6); return { debut: iso(l), fin: iso(s) }; }
    case 'mois': return { debut: iso(new Date(y, m, 1)), fin: iso(new Date(y, m + 1, 0)) };
    case 'trimestre': { const q = Math.floor(m / 3) * 3; return { debut: iso(new Date(y, q, 1)), fin: iso(new Date(y, q + 3, 0)) }; }
    case 'semestre': { const s = m < 6 ? 0 : 6; return { debut: iso(new Date(y, s, 1)), fin: iso(new Date(y, s + 6, 0)) }; }
    case 'annee': return { debut: `${y}-01-01`, fin: `${y}-12-31` };
    default: return { debut: debut || iso(new Date(y, m, 1)), fin: fin || today() };
  }
}

function libellePeriode(p) {
  if (p.debut === p.fin) return `Journée du ${fd(p.debut)}`;
  return `Du ${fd(p.debut)} au ${fd(p.fin)}`;
}

function initPeriode() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('gf-periode') || 'null'); } catch { saved = null; }
  const type = (saved && TYPES_PERIODE[saved.type]) ? saved.type : 'mois';
  const ref = today();
  S.periode = { type, ref, ...calculerPeriode(type, ref, saved && saved.debut, saved && saved.fin) };
}

/** Barre de sélection de période ; onChange est appelé après modification. */
function barrePeriode(extra = '') {
  const p = S.periode;
  return `<div class="filters" id="filtres">
    <label>Périodicité<select data-per="type">${Object.entries(TYPES_PERIODE).map(([k, v]) => `<option value="${k}" ${k === p.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${p.type === 'perso'
    ? `<label>Du<input type="date" data-per="debut" value="${p.debut}"></label><label>Au<input type="date" data-per="fin" value="${p.fin}"></label>`
    : `<label>Date de référence<input type="date" data-per="ref" value="${p.ref}"></label>`}
    ${extra}
    <span class="periode-lbl">${esc(libellePeriode(p))}</span>
  </div>`;
}

function lierPeriode(root, onChange) {
  $$('[data-per]', root).forEach((el) => el.addEventListener('change', () => {
    const p = { ...S.periode, [el.dataset.per]: el.value };
    if (el.dataset.per === 'type' && p.type === 'perso') { p.debut = S.periode.debut; p.fin = S.periode.fin; }
    const c = calculerPeriode(p.type, p.ref, p.debut, p.fin);
    if (c.fin < c.debut) { toast('La date de fin doit suivre la date de début.', 'err'); return; }
    S.periode = { ...p, ...c };
    try { localStorage.setItem('gf-periode', JSON.stringify({ type: p.type, debut: c.debut, fin: c.fin })); } catch { /* stockage indisponible */ }
    onChange();
  }));
}

/* ---------------------------------------------------------- Données de référence */
async function chargerReference() {
  const [params, comptes, fournisseurs] = await Promise.all([api('GET', '/api/parametres'), api('GET', '/api/comptes'), api('GET', '/api/fournisseurs')]);
  S.params = params; S.comptes = comptes; S.fournisseurs = fournisseurs;
  $('#brand-nom').textContent = params.entreprise.sigle || params.entreprise.nom || 'Gestion des fonds';
}
const optionsComptes = (sel, tous = false) => (tous ? '<option value="">Tous les comptes</option>' : '')
  + S.comptes.filter((c) => c.actif !== false || c._id === sel).map((c) => `<option value="${c._id}" ${c._id === sel ? 'selected' : ''}>${esc(c.banque)} – ${esc(c.numero)}${c.intitule ? ` (${esc(c.intitule)})` : ''}</option>`).join('');
const optionsListe = (liste, sel) => liste.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');

/* ------------------------------------------------------------ Routeur */
const PAGES = {};
let rendu = 0;
async function router() {
  const route = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'tableau';
  S.route = PAGES[route] && (!PAGES[route].perm || peut(...PAGES[route].perm.split(','))) ? route : 'tableau';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === S.route));
  document.body.classList.remove('menu-ouvert');
  const lien = $(`#nav a[data-route="${S.route}"]`);
  if (lien) $('#mobile-titre').textContent = lien.textContent;
  await afficherPage();
}
async function afficherPage() {
  const id = ++rendu;
  const main = $('#main');
  try {
    const html = await PAGES[S.route].render();
    if (id !== rendu) return;
    const y = window.scrollY;
    main.innerHTML = html;
    appliquerDroits(main);
    if (PAGES[S.route].mount) PAGES[S.route].mount(main);
    window.scrollTo(0, y);
  } catch (e) {
    if (id === rendu) main.innerHTML = `<div class="card"><p class="form-error">${esc(e.message)}</p></div>`;
  }
}

/* ------------------------------------- Accès suspendu / rétabli en direct */
S.suspendu = false;
function suspendre() {
  if (S.suspendu) return;
  S.suspendu = true;
  document.body.classList.add('suspendu');
  $('#acces-bloque').hidden = false;
  if (!$('#modal').hidden) fermerModale();
  if (!$('#doc').hidden) fermerDocument();
  // Plus aucune donnée à l'écran pendant la suspension.
  rendu += 1; $('#main').innerHTML = '';
  if (!es) connecterTempsReel(); // pour être prévenu de la réactivation
}
function lever() { S.suspendu = false; document.body.classList.remove('suspendu'); $('#acces-bloque').hidden = true; }
async function retablir() {
  if (!S.suspendu) return;
  lever();
  toast("L'administrateur a rétabli votre accès.", 'ok');
  // Application jamais chargée (suspendu dès l'ouverture) : chargement complet ; sinon reprise sur place.
  if (!S.me || $('#app').hidden) { location.reload(); return; }
  await rafraichirDroits().catch(() => {});
  await chargerReference().catch(() => {});
  afficherPage();
}

/* --------------------------------------------------- Temps réel (SSE) */
let es = null;
function connecterTempsReel() {
  if (es) es.close();
  es = new EventSource('/api/evenements');
  const live = $('#live');
  es.onopen = () => {
    live.className = 'live on'; $('#live-txt').textContent = 'Synchronisé en temps réel';
    // Reconnexion : des droits ont pu changer pendant la coupure.
    if (es.dejaOuvert) rafraichirDroits();
    es.dejaOuvert = true;
  };
  es.addEventListener('acces', (ev) => {
    let etat = 'actif'; try { etat = JSON.parse(ev.data).etat; } catch { /* ignoré */ }
    if (etat === 'suspendu') suspendre();
    else if (etat === 'actif') retablir();
    else if (etat === 'ferme') { lever(); afficherLogin(); const e = $('#login-error'); e.textContent = 'Votre session a été fermée par l\'administrateur (compte supprimé ou mot de passe redéfini).'; e.hidden = false; }
  });
  es.addEventListener('version', (ev) => { try { const j = JSON.parse(ev.data); controlerVersion(j.version); if (j.majPrete) miseAJourPrete(); } catch { /* ignoré */ } });
  es.addEventListener('mise-a-jour', () => miseAJourPrete());
  es.addEventListener('redemarrage', () => { $('#maj-bandeau').hidden = false; $('#maj-txt').textContent = 'Installation de la mise à jour… l\'application se recharge dans quelques secondes.'; $('#maj-btn').hidden = true; });
  es.onerror = () => { live.className = 'live off'; $('#live-txt').textContent = 'Reconnexion…'; };
  es.addEventListener('maj', async (ev) => {
    let cols = [];
    try { cols = JSON.parse(ev.data).collections || []; } catch { cols = []; }
    if (cols.some((c) => ['roles', 'utilisateurs', 'agences', '*'].includes(c))) await rafraichirDroits();
    if (!S.me || $('#app').hidden) return;
    if (cols.some((c) => ['parametres', 'comptes', 'fournisseurs', '*'].includes(c))) await chargerReference().catch(() => {});
    majStockage();
    if (!$('#doc').hidden) return;
    // Ne pas écraser un formulaire en cours de saisie sur la page.
    if (PAGES[S.route] && PAGES[S.route].dirty) toast('De nouvelles données ont été enregistrées par un autre utilisateur.');
    else afficherPage();
  });
}

/* ------------------------------------------- Indicateur du double stockage */
S.stockage = null;
function libelleStockage(e) {
  if (!e || e.mode === 'memory') return ['off', 'Démonstration (mémoire)'];
  if (e.mode === 'cloud') return ['on', 'Cloud ✓ (en ligne)'];
  if (e.cloud === 'desactive') return ['err', 'Cloud non relié : connectez-vous pour relier ce poste'];
  if (e.cloud === 'refuse') return ['err', 'Cloud : liaison refusée, reconnectez-vous'];
  if (e.enLigne) return e.enAttente ? ['off', `Cloud ✓ · envoi de ${e.enAttente} donnée(s)…`] : ['on', 'Cloud ✓ à jour en temps réel'];
  return [e.cloud === 'connexion' ? 'off' : 'err', e.enAttente ? `Hors connexion : ${e.enAttente} donnée(s) en attente d'envoi au cloud` : 'Hors connexion : travail sur la copie locale'];
}
async function majStockage() {
  try { S.stockage = await api('GET', '/api/stockage'); } catch { return; }
  const [cls, txt] = libelleStockage(S.stockage);
  $('#stock').className = `live stock ${cls}`;
  $('#mobile-stock').className = `mobile-stock ${cls}`;
  $('#mobile-stock').title = txt;
  $('#stock-txt').textContent = txt;
}

/* ------------------------------------------------------- Session */
function afficherLogin() {
  if (es) { es.close(); es = null; }
  // Rien de la session précédente ne reste à l'écran ; le prochain utilisateur arrive sur le tableau de bord.
  S.me = null;
  rendu += 1; $('#main').innerHTML = '';
  if (!$('#modal').hidden) fermerModale();
  if (!$('#doc').hidden) fermerDocument();
  if (location.hash && location.hash !== '#/tableau') history.replaceState(null, '', `${location.pathname}#/tableau`);
  $('#app').hidden = true; $('#login').hidden = false;
}

async function demarrerApp() {
  try { S.me = await api('GET', '/api/me'); } catch (e) {
    if (e.suspendu) { $('#login').hidden = true; $('#installation').hidden = true; return; } // écran bloqué, en attente de la réactivation
    throw e;
  }
  if (S.me.doitChanger) { $('#login').hidden = true; modaleMotDePasse(true); return; }
  appliquerDroits(document);
  majMenu();
  $('#user-nom').textContent = S.me.nom;
  $('#user-role').textContent = S.me.roleLibelle + (S.me.agenceId ? ` · ${S.me.agenceNom}` : '');
  majSelecteurAgence();
  await chargerReference();
  initPeriode();
  $('#login').hidden = true; $('#app').hidden = false;
  connecterTempsReel();
  await majStockage();
  if (!window.__stockTimer) window.__stockTimer = setInterval(majStockage, 15000);
  await router();
  if (S.stockage && S.stockage.mode === 'local' && !S.stockage.relaisPossible && peut('stockage.gerer') && !sessionStorage.getItem('gf-cloud-plus-tard')) modaleRelierCloud();
}

document.addEventListener('DOMContentLoaded', () => {
  lierFormulaire($('#login-form'), async (data) => {
    const btn = $('#login-form button[type=submit]');
    btn.textContent = 'Connexion en cours…';
    let r;
    try {
      r = await api('POST', '/api/login', data);
    } catch (e) {
      $('#login-error').textContent = e.message; $('#login-error').hidden = false; return;
    } finally { btn.textContent = 'Se connecter'; }
    $('#login-error').hidden = true;
    if (r && r.enLigne && r.jeton) {
      // Compte vérifié par le serveur en ligne : la fenêtre s'y ouvre, session déjà ouverte.
      btn.textContent = 'Ouverture de la version en ligne…'; btn.disabled = true;
      location.href = `${r.enLigne}/#jeton=${encodeURIComponent(r.jeton)}`;
      return;
    }
    $('#login-form').reset();
    await demarrerApp();
  });
  window.addEventListener('hashchange', router);
  $('#agence-sel').addEventListener('change', (e) => changerAgence(e.target.value));
  $('#acces-deconnexion').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'gestion-fonds' } }); } catch { /* hors ligne */ }
    lever(); afficherLogin();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'close-modal') { if (!(S.me && S.me.doitChanger)) fermerModale(); }
    else if (a === 'logout') { if (S.me) S.me.doitChanger = false; fermerModale(); api('POST', '/api/logout').finally(afficherLogin); }
    else if (a === 'mdp') modaleMotDePasse();
    else if (a === 'close-doc') fermerDocument();
    else if (a === 'menu') document.body.classList.toggle('menu-ouvert');
    else if (a === 'menu-fermer') document.body.classList.remove('menu-ouvert');
    else if (a === 'print-doc') imprimerDocument(false);
    else if (a === 'pdf-doc') imprimerDocument(true);
    else if (ACTIONS[a]) { e.preventDefault(); ACTIONS[a](el.dataset, el); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden && !(S.me && S.me.doitChanger)) fermerModale();
    else if (!$('#doc').hidden) fermerDocument();
  });
  const jeton = (location.hash.match(/^#jeton=([^&]+)/) || [])[1];
  if (jeton) {
    // Arrivée depuis un ordinateur non relié au cloud : ouverture de session par jeton à usage unique.
    history.replaceState(null, '', `${location.pathname}#/tableau`);
    api('POST', '/api/login/jeton', { jeton: decodeURIComponent(jeton) }).then(() => demarrerApp()).catch((e) => {
      afficherLogin(); $('#login-error').textContent = e.message; $('#login-error').hidden = false;
    });
  } else verifierInstallation().then((vierge) => { if (!vierge) demarrerApp().catch(() => afficherLogin()); });
  // Application installable (PWA) : mise en cache de l'interface.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  }
  const reseau = () => { $('#hors-ligne').hidden = navigator.onLine; };
  window.addEventListener('online', () => { reseau(); if (S.me) { connecterTempsReel(); afficherPage(); } });
  window.addEventListener('offline', reseau);
  reseau();
  // Signal de présence pour l'application de bureau (arrêt du serveur quand la fenêtre est fermée).
  // Il sert aussi à détecter une nouvelle version de l'application (serveur en ligne ou PC mis à jour).
  const sante = () => fetch('/api/sante', { cache: 'no-store' }).then((r) => r.json()).then((j) => controlerVersion(j.version)).catch(() => {});
  sante();
  setInterval(sante, 10000);
  setInterval(() => { if (S.majEnAttente) rechargerSiPossible(); }, 5000);
  $('#maj-btn').addEventListener('click', () => appliquerMiseAJour(true));
});

/* ------------------------------- Ce PC n'est pas relié au cloud */
async function modaleRelierCloud() {
  let cfg = {};
  try { cfg = await api('GET', '/api/stockage/config'); } catch { return; }
  ouvrirModale('Relier cet ordinateur au cloud', `<form id="f-relier">
    <p style="margin-top:0"><b>Cet ordinateur n'est pas relié au cloud.</b> Les comptes et les opérations créés ici restent sur ce PC : ils ne fonctionnent pas sur les autres ordinateurs ni sur les téléphones.</p>
    <p class="muted" style="font-size:13px">Saisissez le mot de passe de l'utilisateur de base de données <b>${esc(cfg.utilisateur || '')}</b> (défini dans MongoDB Atlas, rubrique Database Access). Il n'est demandé qu'une seule fois : il reste enregistré, même après une réinstallation.</p>
    <div class="form-grid">
      <label class="full">Mot de passe de la base de données<input type="password" name="motDePasse" required autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <label>Adresse du cluster<input name="hote" value="${esc(cfg.hote || '')}" required autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <label>Utilisateur de base de données<input name="utilisateur" value="${esc(cfg.utilisateur || '')}" required autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <input type="hidden" name="base" value="${esc(cfg.base || 'gestion_fonds')}"><input type="hidden" name="poste" value="${esc(cfg.poste || 'P1')}">
    </div>
    <p class="form-error" hidden></p>
    <div class="form-foot"><button type="button" class="btn" id="plus-tard">Plus tard</button><button class="btn primary" type="submit">Relier au cloud</button></div></form>`, (b) => {
    $('#plus-tard', b).addEventListener('click', () => { try { sessionStorage.setItem('gf-cloud-plus-tard', '1'); } catch { /* */ } fermerModale(); });
    lierFormulaire($('#f-relier', b), async (d) => {
      const btn = $('#f-relier button[type=submit]'); btn.textContent = 'Connexion en cours…';
      try {
        const r = await api('PUT', '/api/stockage/config', { ...d, active: true });
        fermerModale(); toast(`${r.message || 'Connexion réussie.'} Les comptes et opérations de ce PC partent vers le cloud.`, 'ok');
        await majStockage(); afficherPage();
      } finally { btn.textContent = 'Relier au cloud'; }
    });
  });
}

/* ---------------------------------------------- Premier démarrage */
async function verifierInstallation() {
  let etat;
  try { etat = await (await fetch('/api/installation', { cache: 'no-store' })).json(); } catch { return false; }
  if (!etat.premiereUtilisation) return false;
  const montrerInstallation = () => { $('#login').hidden = true; $('#app').hidden = true; $('#installation').hidden = false; };
  if (etat.defaut && etat.defaut.serveurEnLigne && etat.cloudPossible) {
    // Ordinateur neuf d'une structure qui utilise déjà l'application : on se connecte directement
    // avec son identifiant (vérifié par le serveur en ligne).
    afficherLogin();
    const lien = $('#lien-installation'); lien.hidden = false;
    lien.onclick = (e) => { e.preventDefault(); lien.hidden = true; montrerInstallation(); };
  } else montrerInstallation();
  const d = etat.defaut || {};
  $('#inst-cloud [name=hote]').value = d.hote || ''; $('#inst-cloud [name=utilisateur]').value = d.utilisateur || '';
  if (!etat.cloudPossible) $('[data-inst=cloud]').hidden = true;
  $$('[data-inst]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-inst]').forEach((x) => x.classList.toggle('active', x === b));
    $('#inst-admin').hidden = b.dataset.inst !== 'admin'; $('#inst-cloud').hidden = b.dataset.inst !== 'cloud';
  }));
  const fin = (msg) => { $('#installation').hidden = true; afficherLogin(); toast(msg, 'ok'); };
  lierFormulaire($('#inst-admin'), async (x) => {
    await api('POST', '/api/installation/admin', x);
    $('#login-form [name=identifiant]').value = x.identifiant;
    fin('Compte administrateur créé : connectez-vous.');
  });
  lierFormulaire($('#inst-cloud'), async (x) => {
    const btn = $('#inst-cloud button[type=submit]'); btn.textContent = 'Connexion au cloud en cours… (jusqu\'à 30 s)';
    try { const r = await api('POST', '/api/installation/cloud', x); fin(`${r.utilisateurs} compte(s) récupéré(s) : connectez-vous avec votre identifiant habituel.`); } finally { btn.textContent = 'Récupérer les comptes et les données'; }
  });
  return true;
}

/** Actions déclenchées par data-action="…" (remplies par pages.js). */
const ACTIONS = {};

function modaleMotDePasse(obligatoire = false) {
  ouvrirModale(obligatoire ? 'Choisissez votre mot de passe personnel' : 'Changer mon mot de passe', `<form id="f-mdp">
    ${obligatoire ? '<p style="margin-top:0">Votre accès a été créé (ou réinitialisé) par l\'administrateur avec un mot de passe provisoire. Pour votre sécurité, choisissez maintenant votre mot de passe personnel.</p>' : ''}
    <div class="form-grid">
    <label class="full">${obligatoire ? 'Mot de passe provisoire' : 'Mot de passe actuel'}<input type="password" name="ancien" required autocomplete="current-password"></label>
    <label class="full">Nouveau mot de passe (8 caractères minimum)<input type="password" name="nouveau" minlength="8" required autocomplete="new-password"></label>
    <label class="full">Confirmer le nouveau mot de passe<input type="password" name="confirmation" minlength="8" required autocomplete="new-password"></label>
  </div><p class="form-error" hidden></p><div class="form-foot">${obligatoire ? '<button type="button" class="btn" data-action="logout">Se déconnecter</button>' : '<button type="button" class="btn" data-action="close-modal">Annuler</button>'}<button class="btn primary" type="submit">Enregistrer</button></div></form>`,
  (b) => {
    const x = $('#modal .modal-box header .icon-btn'); if (x) x.hidden = obligatoire;
    lierFormulaire($('#f-mdp', b), async (d) => {
      if (d.nouveau !== d.confirmation) throw new Error('Les deux nouveaux mots de passe ne sont pas identiques.');
      await api('POST', '/api/me/mot-de-passe', { ancien: d.ancien, nouveau: d.nouveau });
      if (S.me) S.me.doitChanger = false;
      fermerModale(); toast('Mot de passe enregistré. Connectez-vous avec votre nouveau mot de passe.', 'ok'); afficherLogin();
    });
  });
}

/* ----------------------------------------- Mises à jour de l'application
   Chaque appareil connaît la version qu'il affiche. Quand le serveur annonce une autre version
   (déploiement sur Render, ou PC mis à jour automatiquement), la page se recharge d'elle-même,
   sans jamais interrompre une saisie en cours. */
S.versionAffichee = null;
S.majEnAttente = false;
S.majServeurPrete = false;
const saisieEnCours = () => !!((PAGES[S.route] && PAGES[S.route].dirty) || (!$('#modal').hidden && S.me && !$('#app').hidden));
function controlerVersion(v) {
  if (!v) return;
  if (!S.versionAffichee) { S.versionAffichee = v; return; }
  if (v !== S.versionAffichee && !S.majEnAttente) {
    S.majEnAttente = true;
    $('#maj-bandeau').hidden = false;
    $('#maj-txt').textContent = 'Une nouvelle version de l\'application est disponible.';
    $('#maj-btn').hidden = false; $('#maj-btn').textContent = 'Mettre à jour maintenant';
    rechargerSiPossible();
  }
}
/** Le serveur de ce PC a téléchargé une mise à jour : il redémarre dès qu'aucune saisie n'est en cours. */
function miseAJourPrete() {
  if (S.majServeurPrete) return;
  S.majServeurPrete = true; S.majEnAttente = true;
  $('#maj-bandeau').hidden = false;
  $('#maj-txt').textContent = 'Une mise à jour a été téléchargée. Elle s\'installera dès que vous aurez terminé votre saisie.';
  $('#maj-btn').hidden = false; $('#maj-btn').textContent = 'Installer maintenant';
  rechargerSiPossible();
}
function rechargerSiPossible() {
  if (!S.majEnAttente || saisieEnCours()) return;
  appliquerMiseAJour(false);
}
let majLancee = false;
async function appliquerMiseAJour(force) {
  if (majLancee) return;
  if (force && saisieEnCours() && !confirm('Une saisie est en cours : elle sera perdue. Mettre à jour maintenant ?')) return;
  majLancee = true;
  $('#maj-txt').textContent = 'Mise à jour en cours… l\'application se recharge.';
  $('#maj-btn').hidden = true;
  if (S.majServeurPrete) {
    try { await api('POST', '/api/mise-a-jour/appliquer'); } catch { /* le serveur redémarre */ }
    // Attendre que le serveur revienne avec la nouvelle version.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const j = await (await fetch('/api/sante', { cache: 'no-store' })).json(); if (j.version && j.version !== S.versionAffichee) break; } catch { /* redémarrage */ }
    }
  }
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) await reg.update(); } catch { /* ignoré */ }
  location.reload();
}
