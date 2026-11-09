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
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (r.status === 401 && !url.endsWith('/login')) { afficherLogin(); throw new Error('Session expirée.'); }
  if (!r.ok) throw new Error((data && data.erreur) || `Erreur ${r.status}`);
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
  S.route = PAGES[route] ? route : 'tableau';
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
    if (PAGES[S.route].mount) PAGES[S.route].mount(main);
    window.scrollTo(0, y);
  } catch (e) {
    if (id === rendu) main.innerHTML = `<div class="card"><p class="form-error">${esc(e.message)}</p></div>`;
  }
}

/* --------------------------------------------------- Temps réel (SSE) */
let es = null;
function connecterTempsReel() {
  if (es) es.close();
  es = new EventSource('/api/evenements');
  const live = $('#live');
  es.onopen = () => { live.className = 'live on'; $('#live-txt').textContent = 'Synchronisé en temps réel'; };
  es.onerror = () => { live.className = 'live off'; $('#live-txt').textContent = 'Reconnexion…'; };
  es.addEventListener('maj', async (ev) => {
    let cols = [];
    try { cols = JSON.parse(ev.data).collections || []; } catch { cols = []; }
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
  if (e.mode === 'cloud') return ['on', 'Cloud uniquement'];
  if (e.cloud === 'desactive') return ['on', 'Stockage local (cloud non paramétré)'];
  if (e.enLigne) return e.enAttente ? ['off', `Local ✓ · Cloud : envoi de ${e.enAttente}…`] : ['on', 'Local ✓ · Cloud ✓ synchronisé'];
  return [e.cloud === 'connexion' ? 'off' : 'err', `Local ✓ · Cloud hors ligne${e.enAttente ? ` (${e.enAttente} en attente)` : ''}`];
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
  $('#app').hidden = true; $('#login').hidden = false;
}

async function demarrerApp() {
  S.me = await api('GET', '/api/me');
  document.body.classList.toggle('is-admin', S.me.role === 'admin');
  document.body.classList.toggle('is-lecture', S.me.role === 'lecture');
  $('#user-nom').textContent = S.me.nom;
  $('#user-role').textContent = S.me.roleLibelle;
  await chargerReference();
  initPeriode();
  $('#login').hidden = true; $('#app').hidden = false;
  connecterTempsReel();
  majStockage();
  if (!window.__stockTimer) window.__stockTimer = setInterval(majStockage, 15000);
  await router();
}

document.addEventListener('DOMContentLoaded', () => {
  lierFormulaire($('#login-form'), async (data) => {
    try {
      await api('POST', '/api/login', data);
    } catch (e) {
      $('#login-error').textContent = e.message; $('#login-error').hidden = false; return;
    }
    $('#login-error').hidden = true;
    $('#login-form').reset();
    await demarrerApp();
  });
  window.addEventListener('hashchange', router);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'close-modal') fermerModale();
    else if (a === 'logout') api('POST', '/api/logout').finally(afficherLogin);
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
    if (!$('#modal').hidden) fermerModale();
    else if (!$('#doc').hidden) fermerDocument();
  });
  demarrerApp().catch(() => afficherLogin());
  // Application installable (PWA) : mise en cache de l'interface.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  const reseau = () => { $('#hors-ligne').hidden = navigator.onLine; };
  window.addEventListener('online', () => { reseau(); if (S.me) { connecterTempsReel(); afficherPage(); } });
  window.addEventListener('offline', reseau);
  reseau();
  // Signal de présence pour l'application de bureau (arrêt du serveur quand la fenêtre est fermée).
  setInterval(() => { fetch('/api/sante', { cache: 'no-store' }).catch(() => {}); }, 10000);
});

/** Actions déclenchées par data-action="…" (remplies par pages.js). */
const ACTIONS = {};

function modaleMotDePasse() {
  ouvrirModale('Changer mon mot de passe', `<form id="f-mdp"><div class="form-grid">
    <label class="full">Mot de passe actuel<input type="password" name="ancien" required autocomplete="current-password"></label>
    <label class="full">Nouveau mot de passe (8 caractères minimum)<input type="password" name="nouveau" minlength="8" required autocomplete="new-password"></label>
  </div><p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div></form>`,
  (b) => lierFormulaire($('#f-mdp', b), async (d) => { await api('POST', '/api/me/mot-de-passe', d); fermerModale(); toast('Mot de passe modifié. Reconnectez-vous.', 'ok'); afficherLogin(); }));
}
