'use strict';
/* =====================================================================
   Stock par bons de commande : bons de l'État-Major Général, stock du dépôt,
   livraisons aux unités (bons de livraison signés), traçabilité, rapports.
   ===================================================================== */
const CM = { ref: { articles: [], regions: [], unites: [], types: [], typesMouvement: {} } };
const ETATS_BON = { a_livrer: ['À livrer', 'warn'], partiel: ['Livraison partielle', 'int'], livre: ['Entièrement livré', 'in'], cloture: ['Clôturé', ''], annule: ['Annulé', 'out'] };
const STATUTS_BL = { a_signer: ['À faire signer', 'warn'], signe: ['Signé', 'in'], annule: ['Annulé', 'out'] };
const BADGE_MVT = { entree: 'in', livraison: 'out', ajustement: 'warn', annulation: '' };
// Articles proposés par défaut dans un nouveau bon (colonnes habituelles des bons de vivres).
const COLONNES_DEFAUT = ['Riz', 'Farine de maïs', 'Farine de manioc', 'Farine bouillie', 'Haricot', 'Poisson salé', 'Viande', 'Huile végétale', 'Sel', 'Tomate', 'Oignon'];

async function chargerRefStock() { CM.ref = await api('GET', '/api/stock/referentiel'); return CM.ref; }
const nq = (x) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(Number(x) || 0).replace(/ /g, ' ');
const normTxt = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const artDe = (id) => CM.ref.articles.find((a) => a._id === id) || { designation: '?', conditionnement: '', unite: '' };
const regionDe = (id) => CM.ref.regions.find((r) => r._id === id) || { nom: '' };
const opts = (liste, sel, lib = (x) => x.nom, vide = '') => (vide ? `<option value="">${esc(vide)}</option>` : '')
  + liste.map((x) => `<option value="${x._id}" ${x._id === sel ? 'selected' : ''}>${esc(lib(x))}</option>`).join('');
const actifs = (l, sel) => l.filter((x) => x.actif !== false || x._id === sel);
const badgeEtat = (e) => `<span class="badge ${(ETATS_BON[e] || [])[1] || ''}">${esc((ETATS_BON[e] || [e])[0])}</span>`;
const badgeBL = (s) => `<span class="badge ${(STATUTS_BL[s] || [])[1] || ''}">${esc((STATUTS_BL[s] || [s])[0])}</span>`;
const barreAvancement = (p) => `<div class="avancement" title="${p} % livré"><span style="width:${Math.min(100, p)}%"></span></div><small class="muted">${nq(p)} %</small>`;
const consolideStock = () => !S.me.agenceId && !S.agence && agencesActives().length > 1;
const thAg = () => (consolideStock() ? '<th>Dépôt</th>' : '');
const tdAg = (x) => (consolideStock() ? `<td>${esc(nomAgenceId(x.agenceId))}</td>` : '');
/** Les saisies se font toujours dans un dépôt (agence) précis. */
function depotSaisie() {
  if (!consolideStock()) return true;
  toast("Choisissez d'abord le dépôt (agence) concerné dans le sélecteur « Agence » en haut du menu.", 'err');
  return false;
}
const paramUrl = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k);
function modaleLarge() { $('#modal .modal-box').classList.add('large'); }

/* ------------------------------------------------- Alertes (menu et bannières) */
async function majBadgeStock() {
  const b = $('#badge-stock');
  if (!b) return;
  if (!peut('stock.voir')) { b.hidden = true; return; }
  try {
    const a = await api('GET', '/api/stock/alertes');
    CM.alertes = a;
    const n = a.reappro.length + a.seuil.length;
    b.textContent = n; b.hidden = !n;
    b.title = n ? `${n} article(s) à réapprovisionner` : '';
  } catch { b.hidden = true; }
}
function banniereAlertes(a) {
  if (!a) return '';
  const r = [];
  if (a.reappro.length) {
    r.push(`<div class="card alerte-stock danger"><b>⚠ Réapprovisionnement nécessaire</b> – le stock ne couvre pas les bons en cours :
      ${a.reappro.map((x) => `<span class="puce">${consolideStock() ? `${esc(nomAgenceId(x.agenceId))} · ` : ''}<b>${esc(x.designation)}</b> : acheter ${nq(x.besoin)} ${esc(x.unite)} <small>(stock ${nq(x.stock)}, reste à livrer ${nq(x.reste)})</small></span>`).join('')}</div>`);
  }
  if (a.seuil.length) r.push(`<div class="card alerte-stock"><b>Stock sous le minimum</b> : ${a.seuil.map((x) => `<span class="puce">${esc(x.designation)} ${nq(x.stock)} / min ${nq(x.seuilMin)} ${esc(x.unite)}</span>`).join('')}</div>`);
  if (a.nonSignesAnciens) r.push(`<div class="card alerte-stock"><b>${a.nonSignesAnciens} bon(s) de livraison</b> de plus de 3 jours ne sont toujours pas signés par l'unité. <a href="#/livraisons?statut=a_signer">Voir</a></div>`);
  return r.join('');
}

/* =================================================== Situation du stock */
PAGES.stock = {
  perm: 'stock.voir',
  async render() {
    await chargerRefStock();
    const [sit, al, bons] = await Promise.all([api('GET', '/api/stock/situation'), api('GET', '/api/stock/alertes'), api('GET', '/api/stock/bons?etat=ouverts')]);
    CM.alertes = al;
    const k = (lbl, val, sub, cls = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
    return `${tete('Situation du stock', `${esc(nomAgenceVue())} · stock physique, reste à livrer aux unités et besoins d'achat, en temps réel`,
      `<span class="actions"><button class="btn primary" data-perm="stock.livrer" data-action="cmd-livrer">Livrer une unité</button><button class="btn" data-perm="stock.entrees" data-action="cmd-entree">+ Entrée en stock</button><button class="btn" data-perm="stock.corriger" data-action="cmd-inventaire">Inventaire</button><a class="btn" data-perm="stock.referentiel" href="#/referentiel-stock?onglet=articles">Articles</a></span>`)}
    ${banniereAlertes(al)}
    <div class="kpis">
      ${k('Bons de commande en cours', bons.length, `${bons.filter((b) => b.etat === 'partiel').length} en livraison partielle · <a href="#/bons-commande">Voir</a>`, 'main')}
      ${k('Articles à réapprovisionner', al.reappro.length, al.reappro.length ? 'Le stock ne couvre pas les restes à livrer' : 'Le stock couvre les bons en cours', al.reappro.length ? 'danger' : '')}
      ${k('Sous le stock minimum', al.seuil.length, 'Seuils définis par article', al.seuil.length ? 'alerte' : '')}
      ${k('Bons de livraison à faire signer', al.nonSignes, '<a href="#/livraisons?statut=a_signer">Voir la liste</a>', al.nonSignes ? 'alerte' : '')}
    </div>
    <div class="card"><div class="card-head"><h2>Stock par article</h2></div><div class="table-wrap"><table class="data">
      <thead><tr>${thAg()}<th>Article</th><th class="num">En stock</th><th class="num">Reste à livrer</th><th class="num">Après livraisons</th><th class="num">À acheter</th><th class="num">Minimum</th><th>Alerte</th></tr></thead>
      <tbody>${sit.filter((l) => l.stock || l.resteALivrer || l.seuilMin).map((l) => `<tr class="${l.alerte === 'reappro' || l.alerte === 'negatif' ? 'rupture-ligne' : l.alerte ? 'alerte-ligne' : ''}">${tdAg(l)}
        <td><b>${esc(l.designation)}</b><br><small class="muted">${esc(l.conditionnement)}</small></td>
        <td class="num"><b>${nq(l.stock)}</b></td><td class="num">${l.resteALivrer ? `${nq(l.resteALivrer)}<br><small class="muted">${l.nbBons} bon(s)</small>` : '—'}</td>
        <td class="num ${l.apresLivraisons < 0 ? 'neg' : ''}">${nq(l.apresLivraisons)}</td>
        <td class="num">${l.besoin ? `<b class="neg">${nq(l.besoin)}</b>${l.valeurBesoin ? `<br><small class="muted">≈ ${money(l.valeurBesoin)}</small>` : ''}` : '—'}</td>
        <td class="num">${l.seuilMin ? nq(l.seuilMin) : '—'}</td>
        <td>${l.alerte === 'negatif' ? '<span class="badge out">Stock négatif</span>' : l.alerte === 'reappro' ? '<span class="badge out">À réapprovisionner</span>' : l.alerte === 'seuil' ? '<span class="badge warn">Sous le minimum</span>' : '<span class="badge in">Couvert</span>'}</td></tr>`).join('')
      || vide(8, 'Aucun stock ni bon de commande en cours. Commencez par enregistrer un bon de commande (menu Bons de commande) puis les entrées en stock.')}</tbody>
    </table></div></div>`;
  },
};

/* ===================================================== Bons de commande */
PAGES['bons-commande'] = {
  perm: 'stock.voir',
  f: { etat: 'ouverts', regionId: '', typeId: '' },
  async render() {
    await chargerRefStock();
    const f = this.f;
    const bons = await api('GET', `/api/stock/bons?${qs({ etat: f.etat === 'tous' ? '' : f.etat, regionId: f.regionId, typeId: f.typeId })}`);
    return `${tete('Bons de commande', "Bons reçus de l'État-Major Général : quantités commandées par unité, livrées et restant à livrer",
      '<span class="actions"><button class="btn primary" data-perm="stock.bons" data-action="cmd-bon-edit">+ Nouveau bon de commande</button></span>')}
    <div class="filters">
      <label>État<select data-f="etat">${[['ouverts', 'En cours (à livrer)'], ['tous', 'Tous'], ['livre', 'Entièrement livrés'], ['cloture', 'Clôturés'], ['annule', 'Annulés']].map(([k, v]) => `<option value="${k}" ${k === f.etat ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Région<select data-f="regionId">${opts(CM.ref.regions, f.regionId, (r) => r.nom, 'Toutes')}</select></label>
      <label>Type de bon<select data-f="typeId">${opts(CM.ref.types, f.typeId, (t) => t.nom, 'Tous')}</select></label>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr>${thAg()}<th>N°</th><th>Référence EMG</th><th>Type</th><th>Région</th><th>Édition</th><th>Date</th><th class="num">Unités</th><th>Livré</th><th>État</th><th></th></tr></thead>
      <tbody>${bons.map((b) => `<tr>${tdAg(b)}<td class="nowrap"><a href="#/bon-commande?id=${b._id}"><b>${esc(b.numero)}</b></a></td><td>${esc(b.reference)}</td><td>${esc(b.typeNom)}</td>
        <td>${esc(b.regionNom)}</td><td>${esc(b.edition)}</td><td class="nowrap">${fd(b.dateBon)}</td><td class="num">${b.nbUnites}</td><td class="nowrap">${barreAvancement(b.avancement)}</td>
        <td>${badgeEtat(b.etat)}</td><td class="nowrap"><a class="btn sm" href="#/bon-commande?id=${b._id}">Ouvrir</a></td></tr>`).join('') || vide(11, 'Aucun bon de commande.')}</tbody>
    </table></div></div>`;
  },
  mount(root) {
    $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { this.f[el.dataset.f] = el.value; afficherPage(); }));
  },
};

/* --------------------------------------------------- Fiche d'un bon */
PAGES['bon-commande'] = {
  perm: 'stock.voir',
  async render() {
    await chargerRefStock();
    const b = await api('GET', `/api/stock/bons/${paramUrl('id')}`);
    this.bon = b;
    const cols = CM.ref.articles.filter((a) => b.totaux[a._id]);
    const ouvert = b.statut === 'en_cours';
    const cellule = (v) => (v ? `<td class="num cel-bon ${v.reste ? '' : 'solde'}"><b>${nq(v.reste)}</b><small>${nq(v.livre)} / ${nq(v.commande)}</small></td>` : '<td class="num muted">—</td>');
    return `${tete(`Bon de commande ${esc(b.numero)}`, `${esc(b.reference)} · ${esc(b.typeNom)} · ${esc(b.regionNom)} · ${esc(b.edition)}`,
      `<span class="actions"><a class="btn" href="#/bons-commande">← Liste</a><button class="btn" data-action="cmd-bon-imprimer">Imprimer</button>
      ${ouvert ? '<button class="btn" data-perm="stock.bons" data-action="cmd-bon-edit" data-id="' + b._id + '">Modifier</button>' : ''}
      ${ouvert ? `<button class="btn" data-perm="stock.bons" data-action="cmd-bon-statut" data-statut="cloturer">Clôturer</button>` : ''}
      ${b.statut === 'cloture' ? `<button class="btn" data-perm="stock.bons" data-action="cmd-bon-statut" data-statut="rouvrir">Rouvrir</button>` : ''}
      ${b.statut !== 'annule' && !b.livraisons.some((l) => l.statut !== 'annule') ? `<button class="btn danger" data-perm="stock.bons" data-action="cmd-bon-statut" data-statut="annuler">Annuler le bon</button>` : ''}</span>`)}
    <div class="kpis">
      <div class="kpi main"><div class="lbl">État</div><div class="val">${esc((ETATS_BON[b.etat] || [b.etat])[0])}</div><div class="sub">${nq(b.avancement)} % livré</div></div>
      <div class="kpi"><div class="lbl">Date du bon</div><div class="val">${fd(b.dateBon)}</div><div class="sub">${b.dateReception ? `Reçu le ${fd(b.dateReception)}` : ''}${b.dateDebut ? ` · période du ${fd(b.dateDebut)} au ${fd(b.dateFin)}` : ''}</div></div>
      <div class="kpi"><div class="lbl">Unités / effectif</div><div class="val">${b.lignes.length}</div><div class="sub">Effectif total ${nq(b.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}${b.autonomie ? ` · autonomie ${b.autonomie} j` : ''}</div></div>
      <div class="kpi"><div class="lbl">Livraisons</div><div class="val">${b.livraisons.filter((l) => l.statut !== 'annule').length}</div><div class="sub">${b.livraisons.filter((l) => l.statut === 'a_signer').length} à faire signer</div></div>
    </div>
    ${b.observations ? `<div class="card"><b>Observations :</b> ${esc(b.observations)}</div>` : ''}
    <div class="card"><div class="card-head"><h2>Quantités par unité</h2><small class="muted">En gras : reste à livrer · en dessous : livré / commandé</small></div><div class="table-wrap"><table class="data grille-etat">
      <thead><tr><th>Unité</th><th class="num">Eff.</th>${cols.map((a) => `<th class="num">${esc(a.designation)}<br><small>${esc(a.conditionnement)}</small></th>`).join('')}<th></th></tr></thead>
      <tbody>${b.lignes.map((l) => `<tr><td><b>${esc(l.uniteNom)}</b></td><td class="num">${nq(l.effectif)}</td>${cols.map((a) => cellule(l.articles[a._id])).join('')}
        <td class="nowrap">${ouvert && Object.values(l.articles).some((v) => v.reste) ? `<button class="btn sm primary" data-perm="stock.livrer" data-action="cmd-livrer" data-bon="${b._id}" data-unite="${l.uniteId}">Livrer</button>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="tot"><td>Total</td><td class="num">${nq(b.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}</td>${cols.map((a) => cellule(b.totaux[a._id])).join('')}<td></td></tr></tfoot>
    </table></div></div>
    <div class="card"><div class="card-head"><h2>Livraisons sur ce bon</h2></div><div class="table-wrap"><table class="data">
      <thead><tr><th>N° BL</th><th>Date</th><th>Unité</th><th>Articles</th><th>Statut</th><th>Saisi par</th><th></th></tr></thead>
      <tbody>${b.livraisons.map((l) => ligneBL(l, false)).join('') || vide(7, 'Aucune livraison.')}</tbody>
    </table></div></div>
    <div class="card"><div class="card-head"><h2>Historique du bon</h2></div><div class="table-wrap"><table class="data">
      <thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Détails</th></tr></thead>
      <tbody>${(b.historique || []).slice().reverse().map((h) => `<tr><td class="nowrap">${fdt(h.quand)}</td><td>${esc(h.nom || h.par)}</td><td>${esc(h.action)}</td><td><small>${esc(h.details || '')}</small></td></tr>`).join('')}</tbody>
    </table></div></div>`;
  },
};
const resumeLignesBL = (l) => l.lignes.map((x) => `${nq(x.quantite)} ${esc(x.designation)}`).join(', ');
function ligneBL(l, avecBon = true) {
  return `<tr class="${l.statut === 'annule' ? 'muted barre' : ''}">${avecBon ? tdAg(l) : ''}<td class="nowrap"><b>${esc(l.numero)}</b></td><td class="nowrap">${fd(l.date)}</td><td>${esc(l.uniteNom)}${avecBon ? `<br><small class="muted">${esc(l.regionNom)}</small>` : ''}</td>
    ${avecBon ? `<td><a href="#/bon-commande?id=${l.bonId}">${esc(l.bonReference)}</a><br><small class="muted">${esc(l.typeNom)} · ${esc(l.edition)}</small></td>` : ''}
    <td><small>${resumeLignesBL(l)}</small></td>
    <td>${badgeBL(l.statut)}${l.signature ? `<br><small class="muted">${esc([l.signature.grade, l.signature.nom].filter(Boolean).join(' '))}</small>` : ''}${l.annulation ? `<br><small class="muted">${esc(l.annulation.motif)}</small>` : ''}</td>
    <td><small>${esc(l.nomCreateur)}<br>${fdt(l.creeLe)}</small></td>
    <td class="nowrap"><button class="btn sm" data-action="cmd-bl-voir" data-id="${l._id}">BL</button>
      ${l.statut === 'a_signer' ? `<button class="btn sm primary" data-perm="stock.livrer" data-action="cmd-bl-signer" data-id="${l._id}" data-num="${esc(l.numero)}">Signé</button>` : ''}
      ${l.statut !== 'annule' ? `<button class="btn sm danger" data-perm="stock.corriger" data-action="cmd-bl-annuler" data-id="${l._id}" data-num="${esc(l.numero)}">Annuler</button>` : ''}</td></tr>`;
}
ACTIONS['cmd-bon-imprimer'] = () => docBonCommande(PAGES['bon-commande'].bon);
ACTIONS['cmd-bon-statut'] = (ds) => {
  const b = PAGES['bon-commande'].bon;
  const t = { cloturer: ['Clôturer le bon', "Le reste à livrer ne sera plus dû (fin d'édition, unité dissoute…). Le bon pourra être rouvert.", 'Motif de la clôture'], rouvrir: ['Rouvrir le bon', 'Le reste à livrer redevient dû.', 'Commentaire (facultatif)'], annuler: ['Annuler le bon', "Le bon restera consultable mais ne sera plus pris en compte.", "Motif de l'annulation"] }[ds.statut];
  ouvrirModale(`${t[0]} ${b.numero}`, `<form id="f"><p style="margin-top:0">${t[1]}</p><div class="form-grid"><label class="full">${t[2]}<textarea name="motif" ${ds.statut === 'rouvrir' ? '' : 'required'}></textarea></label></div>${piedForm('Confirmer')}</form>`,
    (m) => lierFormulaire($('#f', m), async (d) => { await api('POST', `/api/stock/bons/${b._id}/statut`, { ...d, action: ds.statut }); fermerModale(); toast('Bon mis à jour.', 'ok'); afficherPage(); }));
};

/* ------------------------------------------- Saisie / modification d'un bon */
/** Lecture d'un tableau copié depuis Excel (tabulations, cellules entre guillemets). */
function lireCollage(txt) {
  const lignes = []; let ligne = []; let cel = ''; let q = false;
  for (let i = 0; i < txt.length; i += 1) {
    const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { cel += '"'; i += 1; } else if (c === '"') q = false; else cel += c; continue; }
    if (c === '"' && cel === '') q = true;
    else if (c === '\t') { ligne.push(cel); cel = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i += 1; ligne.push(cel); lignes.push(ligne); ligne = []; cel = ''; } else cel += c;
  }
  if (cel !== '' || ligne.length) { ligne.push(cel); lignes.push(ligne); }
  return lignes.map((l) => l.map((x) => x.trim()));
}
/** Retrouve l'article d'un en-tête de colonne (« Farine \n Mais » → Farine de maïs, « Huile Végetal » → Huile végétale). */
function articlePourEntete(h) {
  const mots = normTxt(h).split(' ').filter((m) => m && m !== 'de' && m !== 'du');
  if (!mots.length) return null;
  const candidats = CM.ref.articles.filter((a) => a.actif !== false).filter((a) => {
    const am = normTxt(a.designation).split(' ').filter((m) => m !== 'de' && m !== 'du');
    return mots.every((m) => am.some((x) => x.startsWith(m) || m.startsWith(x))) && am.length <= mots.length + 1;
  });
  return candidats.sort((a, b) => normTxt(a.designation).length - normTxt(b.designation).length)[0] || null;
}
function analyserCollage(txt) {
  const t = lireCollage(txt).filter((l) => l.some(Boolean));
  const iEnt = t.findIndex((l) => l.some((c) => /^unit/i.test(normTxt(c))));
  if (iEnt < 0) throw new Error('Ligne d\'en-tête introuvable : copiez le tableau avec la ligne « UNITES / EFF / Riz / … ».');
  const ent = t[iEnt];
  const cNom = ent.findIndex((c) => /^unit/i.test(normTxt(c)));
  const cEff = ent.findIndex((c) => /^eff/i.test(normTxt(c)));
  const colonnes = []; const inconnues = [];
  ent.forEach((h, i) => {
    if (i === cNom || i === cEff || !h || /^(n|no|n serie|serie|numero)$|^(montant|total|obn|ingredient|prix)/.test(normTxt(h))) return;
    const a = articlePourEntete(h);
    if (a) colonnes.push([i, a]); else inconnues.push(h.replace(/\s+/g, ' '));
  });
  const nombre = (v) => { const x = Number(String(v || '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
  const unites = [];
  for (const l of t.slice(iEnt + 1)) {
    const nom = (l[cNom] || '').replace(/\s+/g, ' ').trim();
    if (!nom || /^(total|prix|montant|conditionn|unite)/i.test(normTxt(nom))) continue;
    const q = {};
    for (const [i, a] of colonnes) { const x = nombre(l[i]); if (x) q[a._id] = x; }
    if (!Object.keys(q).length && !(cEff >= 0 && nombre(l[cEff]))) continue;
    unites.push({ nom, effectif: cEff >= 0 ? (nombre(l[cEff]) || 0) : 0, quantites: q });
  }
  if (!unites.length) throw new Error('Aucune unité trouvée sous la ligne d\'en-tête.');
  return { colonnes: colonnes.map(([, a]) => a._id), inconnues, unites };
}

ACTIONS['cmd-bon-edit'] = async (ds) => {
  if (!depotSaisie()) return;
  await chargerRefStock();
  const b = ds.id ? await api('GET', `/api/stock/bons/${ds.id}`) : null;
  if (!CM.ref.regions.some((r) => r.actif !== false)) { toast("Créez d'abord les régions militaires et leurs unités (menu Stock → Régions, unités et articles).", 'err'); if (peut('stock.referentiel')) location.hash = '#/referentiel-stock'; return; }
  // État de la grille : colonnes (articles) et lignes (unités)
  const G = {
    cols: b ? CM.ref.articles.filter((a) => b.lignes.some((l) => l.quantites[a._id])).map((a) => a._id)
      : CM.ref.articles.filter((a) => a.actif !== false && COLONNES_DEFAUT.includes(a.designation)).map((a) => a._id),
    lignes: b ? b.lignes.map((l) => ({ uniteId: l.uniteId, effectif: l.effectif, quantites: { ...l.quantites } })) : [],
  };
  const titre = b ? `Modifier le bon ${b.numero}` : `Nouveau bon de commande – ${nomAgenceVue()}`;
  ouvrirModale(titre, `<form id="f" data-garder="1"><div class="form-grid">
    <label>Référence EMG (n° du bon)<input name="reference" value="${esc(b ? b.reference : '')}" required placeholder="ex. 2234/EMG/EM LOG/DEPT RAV/DIR CLI/26"></label>
    <label>Type de bon<span class="champ-ajout"><select name="typeId" required>${opts(actifs(CM.ref.types, b && b.typeId), b && b.typeId)}</select>${peut('stock.referentiel') ? '<button type="button" class="btn sm" id="aj-type" title="Nouveau type de bon">+</button>' : ''}</span></label>
    <label>Région militaire<select name="regionId" required>${opts(actifs(CM.ref.regions, b && b.regionId), b && b.regionId, (r) => r.nom, '— Choisir —')}</select></label>
    <label>Édition<input name="edition" value="${esc(b ? b.edition : '')}" required placeholder="ex. Mai 2026"></label>
    <label>Date du bon<input type="date" name="dateBon" value="${b ? b.dateBon : today()}" required></label>
    <label>Date de réception<input type="date" name="dateReception" value="${b ? b.dateReception : today()}"></label>
    <label>Période du<input type="date" name="dateDebut" value="${b ? b.dateDebut : ''}"></label>
    <label>au<input type="date" name="dateFin" value="${b ? b.dateFin : ''}"></label>
    <label>Autonomie (jours)<input type="number" min="0" name="autonomie" value="${b ? b.autonomie || '' : ''}"></label>
    <label class="full">Observations<input name="observations" value="${esc(b ? b.observations : '')}"></label>
  </div>
  <div class="bon-outils">
    <details><summary>Articles du bon (colonnes)</summary><div class="choix-articles" id="choix-art"></div>${peut('stock.referentiel') ? '<button type="button" class="btn sm" id="aj-article">+ Nouvel article</button>' : ''}</details>
    <button type="button" class="btn sm" id="coller">Coller depuis Excel</button>
  </div>
  <div class="table-wrap grille-bon-wrap"><table class="data grille-bon" id="grille"></table></div>
  <div class="bon-ajout"><select id="aj-unite"></select><button type="button" class="btn sm" id="aj-btn">+ Ajouter l'unité</button><button type="button" class="btn sm" id="aj-toutes">+ Toutes les unités de la région</button>
    ${peut('stock.referentiel', 'stock.bons') ? '<button type="button" class="btn sm" id="aj-nouvelle">+ Nouvelle unité</button>' : ''}</div>
  ${piedForm(b ? 'Enregistrer les modifications' : 'Enregistrer le bon')}</form>`, (m) => {
    modaleLarge();
    const f = $('#f', m);
    const region = () => $('[name=regionId]', f).value;
    const unitesRegion = () => CM.ref.unites.filter((u) => u.actif !== false && u.regionId === region());
    const lireGrille = () => {
      $$('[data-q]', f).forEach((el) => { const [i, a] = el.dataset.q.split('|'); const v = el.value.trim(); if (v === '') delete G.lignes[i].quantites[a]; else G.lignes[i].quantites[a] = Number(v); });
      $$('[data-eff]', f).forEach((el) => { G.lignes[el.dataset.eff].effectif = Number(el.value) || 0; });
    };
    const dessiner = () => {
      const cols = G.cols.map(artDe);
      const tot = (a) => G.lignes.reduce((s, l) => s + (Number(l.quantites[a]) || 0), 0);
      $('#grille', f).innerHTML = `<thead><tr><th>Unité</th><th class="num">Effectif</th>${cols.map((a) => `<th class="num">${esc(a.designation)}<br><small>${esc(a.conditionnement)}</small></th>`).join('')}<th></th></tr></thead>
        <tbody>${G.lignes.map((l, i) => { const u = CM.ref.unites.find((x) => x._id === l.uniteId) || { nom: '?' }; return `<tr><td class="nowrap"><b>${esc(u.nom)}</b>${u.regionId !== region() ? `<br><small class="muted">${esc(regionDe(u.regionId).nom)}</small>` : ''}</td>
          <td><input type="number" min="0" step="1" data-eff="${i}" value="${l.effectif || ''}"></td>
          ${G.cols.map((a) => `<td><input type="number" min="0" step="any" inputmode="decimal" data-q="${i}|${a}" value="${l.quantites[a] ?? ''}"></td>`).join('')}
          <td><button type="button" class="icon-btn" data-retirer="${i}" title="Retirer l'unité">×</button></td></tr>`; }).join('') || `<tr><td colspan="${G.cols.length + 3}" class="empty">Ajoutez les unités du bon (ci-dessous), ou collez le tableau depuis Excel.</td></tr>`}</tbody>
        <tfoot><tr class="tot"><td>Total</td><td class="num">${nq(G.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}</td>${G.cols.map((a) => `<td class="num">${nq(tot(a))}</td>`).join('')}<td></td></tr></tfoot>`;
      const dispo = unitesRegion().filter((u) => !G.lignes.some((l) => l.uniteId === u._id));
      $('#aj-unite', f).innerHTML = dispo.length ? dispo.map((u) => `<option value="${u._id}">${esc(u.nom)}${u.effectif ? ` (${u.effectif})` : ''}</option>`).join('') : `<option value="">${region() ? 'Toutes les unités de la région sont dans le bon' : 'Choisissez d\'abord la région'}</option>`;
      $('#choix-art', f).innerHTML = CM.ref.articles.filter((a) => a.actif !== false || G.cols.includes(a._id)).map((a) => `<label class="check"><input type="checkbox" value="${a._id}" ${G.cols.includes(a._id) ? 'checked' : ''}> ${esc(a.designation)}</label>`).join('');
    };
    f.addEventListener('change', (e) => {
      if (e.target.closest('#choix-art')) {
        lireGrille();
        const a = e.target.value;
        if (e.target.checked) G.cols = CM.ref.articles.map((x) => x._id).filter((x) => x === a || G.cols.includes(x));
        else if (G.lignes.some((l) => l.quantites[a])) { e.target.checked = true; toast('Cet article a des quantités : videz-les avant de retirer la colonne.', 'err'); return; } else G.cols = G.cols.filter((x) => x !== a);
        dessiner();
      } else if (e.target.name === 'regionId') { lireGrille(); dessiner(); }
    });
    f.addEventListener('input', (e) => { if (e.target.dataset.q || e.target.dataset.eff) { lireGrille(); const i = G.cols.indexOf(String(e.target.dataset.q || '').split('|')[1]); if (i >= 0) { const td = $$('#grille tfoot td', f)[i + 2]; if (td) td.textContent = nq(G.lignes.reduce((s, l) => s + (Number(l.quantites[G.cols[i]]) || 0), 0)); } } });
    f.addEventListener('click', (e) => {
      const r = e.target.closest('[data-retirer]');
      if (!r) return;
      lireGrille();
      const i = Number(r.dataset.retirer);
      if (Object.keys(G.lignes[i].quantites).length && !confirm('Retirer cette unité et ses quantités du bon ?')) return;
      G.lignes.splice(i, 1); dessiner();
    });
    const ajouter = (u) => { if (!G.lignes.some((l) => l.uniteId === u._id)) G.lignes.push({ uniteId: u._id, effectif: u.effectif || 0, quantites: {} }); };
    $('#aj-btn', f).addEventListener('click', () => { const u = CM.ref.unites.find((x) => x._id === $('#aj-unite', f).value); if (!u) return; lireGrille(); ajouter(u); dessiner(); });
    $('#aj-toutes', f).addEventListener('click', () => { if (!region()) { toast('Choisissez d\'abord la région.', 'err'); return; } lireGrille(); unitesRegion().forEach(ajouter); dessiner(); });
    const creerUnite = async (nom, effectif) => {
      const r = await api('POST', '/api/stock/unites', { nom, effectif, regionId: region() });
      await chargerRefStock();
      return CM.ref.unites.find((u) => u._id === r._id);
    };
    if ($('#aj-nouvelle', f)) $('#aj-nouvelle', f).addEventListener('click', async () => {
      if (!region()) { toast('Choisissez d\'abord la région.', 'err'); return; }
      const nom = prompt(`Nom de la nouvelle unité (région ${regionDe(region()).nom}) :`);
      if (!nom || !nom.trim()) return;
      const eff = Number(prompt('Effectif :', '0')) || 0;
      try { lireGrille(); ajouter(await creerUnite(nom.trim(), eff)); dessiner(); } catch (x) { toast(x.message, 'err'); }
    });
    if ($('#aj-type', f)) $('#aj-type', f).addEventListener('click', async () => {
      const nom = prompt('Nom du nouveau type de bon (ex. Bon de ravitaillement, Bon d\'urgence) :');
      if (!nom || !nom.trim()) return;
      const mensuel = confirm('Les quantités de ce type de bon sont-elles MENSUELLES ?\n\nOK = mensuelles · Annuler = temporaires');
      try {
        const r = await api('POST', '/api/stock/types', { nom: nom.trim(), nature: mensuel ? 'mensuel' : 'temporaire' });
        await chargerRefStock();
        $('[name=typeId]', f).innerHTML = opts(actifs(CM.ref.types, r._id), r._id);
        toast(`Type « ${nom.trim()} » créé.`, 'ok');
      } catch (x) { toast(x.message, 'err'); }
    });
    if ($('#aj-article', f)) $('#aj-article', f).addEventListener('click', async () => {
      const designation = prompt("Désignation du nouvel article (ex. Sucre, Lait en poudre) :");
      if (!designation || !designation.trim()) return;
      const conditionnement = prompt('Conditionnement (ex. Sac 50 kg, Carton 24 boîtes, Kg) :', '') || '';
      try {
        const r = await api('POST', '/api/stock/articles', { designation: designation.trim(), conditionnement, unite: (conditionnement.split(' ')[0] || 'unité').toLowerCase() });
        lireGrille(); await chargerRefStock();
        G.cols = CM.ref.articles.map((a) => a._id).filter((a) => a === r._id || G.cols.includes(a));
        dessiner(); toast(`Article « ${designation.trim()} » créé et ajouté au bon.`, 'ok');
      } catch (x) { toast(x.message, 'err'); }
    });
    $('#coller', f).addEventListener('click', () => {
      if (!region()) { toast("Choisissez d'abord la région du bon.", 'err'); return; }
      const zone = document.createElement('div');
      zone.className = 'collage';
      zone.innerHTML = `<p><b>Coller le tableau du bon</b> : dans Excel, sélectionnez le tableau à partir de la ligne d'en-tête (N° · UNITES · EFF · Riz · Farine Maïs…), copiez (Ctrl+C), puis collez ici (Ctrl+V).</p>
        <textarea rows="6" placeholder="Collez ici…"></textarea><div class="form-foot"><button type="button" class="btn" data-x="annuler">Fermer</button><button type="button" class="btn primary" data-x="ok">Importer dans le bon</button></div><p class="form-error" hidden></p>`;
      $('#coller', f).after(zone);
      $('textarea', zone).focus();
      zone.addEventListener('click', async (e) => {
        const x = e.target.dataset.x;
        if (x === 'annuler') zone.remove();
        if (x !== 'ok') return;
        const err = $('.form-error', zone);
        try {
          const res = analyserCollage($('textarea', zone).value);
          lireGrille();
          const nouvelles = [];
          for (const ul of res.unites) {
            let u = unitesRegion().find((y) => normTxt(y.nom) === normTxt(ul.nom));
            if (!u) nouvelles.push(ul);
          }
          if (nouvelles.length && !confirm(`${nouvelles.length} unité(s) n'existent pas encore dans la région ${regionDe(region()).nom} et seront créées :\n\n${nouvelles.map((n) => `• ${n.nom}`).join('\n')}\n\nContinuer ?`)) return;
          for (const n of nouvelles) await creerUnite(n.nom, n.effectif);
          for (const ul of res.unites) {
            const u = unitesRegion().find((y) => normTxt(y.nom) === normTxt(ul.nom));
            let l = G.lignes.find((y) => y.uniteId === u._id);
            if (!l) { l = { uniteId: u._id, effectif: 0, quantites: {} }; G.lignes.push(l); }
            l.effectif = ul.effectif || l.effectif || u.effectif || 0;
            Object.assign(l.quantites, ul.quantites);
          }
          G.cols = CM.ref.articles.map((a) => a._id).filter((a) => G.cols.includes(a) || res.colonnes.includes(a));
          zone.remove(); dessiner();
          toast(`${res.unites.length} unité(s) importée(s)${res.inconnues.length ? ` – colonnes ignorées (article inconnu) : ${res.inconnues.join(', ')}` : ''}.`, res.inconnues.length ? 'err' : 'ok');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    });
    dessiner();
    lierFormulaire(f, async (d) => {
      lireGrille();
      const corps = { ...d, lignes: G.lignes.map((l) => ({ uniteId: l.uniteId, effectif: l.effectif, quantites: Object.fromEntries(Object.entries(l.quantites).filter(([a, v]) => G.cols.includes(a) && Number(v) > 0)) })) };
      const r = await api(b ? 'PUT' : 'POST', b ? `/api/stock/bons/${b._id}` : '/api/stock/bons', corps);
      fermerModale(); toast(b ? 'Bon modifié (historique mis à jour).' : `Bon de commande ${r.numero} enregistré.`, 'ok');
      if (b) afficherPage(); else location.hash = `#/bon-commande?id=${r._id}`;
    });
  });
};

/* ============================================================ Livraison */
ACTIONS['cmd-livrer'] = async (ds) => {
  if (!depotSaisie()) return;
  let bonId = ds.bon; let uniteId = ds.unite;
  if (!bonId) {
    const bons = await api('GET', '/api/stock/bons?etat=ouverts');
    if (!bons.length) { toast('Aucun bon de commande en cours à livrer.', 'err'); return; }
    ouvrirModale('Livrer une unité', `<form id="f"><div class="form-grid">
      <label class="full">Bon de commande<select name="bon" required>${bons.map((b) => `<option value="${b._id}">${esc(b.reference)} – ${esc(b.typeNom)} – ${esc(b.edition)} (${esc(b.regionNom)})</option>`).join('')}</select></label>
      <label class="full">Unité<select name="unite" required></select></label>
    </div>${piedForm('Continuer')}</form>`, (m) => {
      const f = $('#f', m);
      const charger = async () => {
        const b = await api('GET', `/api/stock/bons/${$('[name=bon]', f).value}`);
        const u = b.lignes.filter((l) => Object.values(l.articles).some((v) => v.reste));
        $('[name=unite]', f).innerHTML = u.map((l) => `<option value="${l.uniteId}">${esc(l.uniteNom)}</option>`).join('') || '<option value="">Tout est livré sur ce bon</option>';
      };
      $('[name=bon]', f).addEventListener('change', charger); charger();
      lierFormulaire(f, async (d) => { if (!d.unite) throw new Error('Aucune unité à livrer sur ce bon.'); await ACTIONS['cmd-livrer']({ bon: d.bon, unite: d.unite }); });
    });
    return;
  }
  const p = await api('GET', `/api/stock/bons/${bonId}/livraison/${uniteId}`);
  const lignes = p.lignes.filter((l) => l.commande || l.livre);
  ouvrirModale(`Livraison – ${p.unite.nom}`, `<form id="f"><p class="muted" style="margin-top:0">Bon ${esc(p.bon.reference)} · ${esc(p.bon.typeNom)} · ${esc(p.bon.edition)} · ${esc(p.bon.regionNom)}</p>
    <div class="table-wrap"><table class="data table-livraison"><thead><tr><th>Article</th><th class="num col-sec">Commandé</th><th class="num col-sec">Déjà livré</th><th class="num">Reste</th><th class="num">Stock</th><th class="num">À livrer</th></tr></thead>
    <tbody>${lignes.map((l) => `<tr><td><b>${esc(l.designation)}</b><br><small class="muted">${esc(l.conditionnement)}</small></td><td class="num col-sec">${nq(l.commande)}</td><td class="num col-sec">${nq(l.livre)}</td><td class="num"><b>${nq(l.reste)}</b></td>
      <td class="num ${l.stock < l.reste ? 'neg' : ''}">${nq(l.stock)}</td>
      <td><input type="number" min="0" step="any" inputmode="decimal" data-art="${l.articleId}" max="${Math.max(0, Math.min(l.reste, l.stock))}" value="${Math.max(0, Math.min(l.reste, l.stock)) || ''}" ${l.reste ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div>
    <div class="form-grid">
      <label>Date<input type="date" name="date" value="${today()}" required></label>
      <label>Réceptionnaire (nom, grade)<input name="receptionnaire" placeholder="ex. Lt KABEYA"></label>
      <label>Véhicule / transport<input name="vehicule"></label>
      <label>Observations<input name="observations"></label>
    </div>
    <p class="help">Le bon de livraison est généré automatiquement ; imprimez-le et faites-le signer par l'unité.</p>
    ${piedForm('Valider la livraison et imprimer le BL')}</form>`, (m) => {
    modaleLarge();
    lierFormulaire($('#f', m), async (d) => {
      const l = $$('[data-art]', m).filter((x) => Number(x.value) > 0).map((x) => ({ articleId: x.dataset.art, quantite: Number(x.value) }));
      if (!l.length) throw new Error('Indiquez au moins une quantité à livrer.');
      const bl = await api('POST', '/api/stock/livraisons', { ...d, bonId, uniteId, lignes: l });
      fermerModale(); toast(`Livraison enregistrée : bon de livraison ${bl.numero}.`, 'ok'); afficherPage(); majBadgeStock();
      docBonLivraison(bl);
    });
  });
};
ACTIONS['cmd-bl-voir'] = async (ds) => docBonLivraison(await api('GET', `/api/stock/livraisons/${ds.id}`));
ACTIONS['cmd-bl-signer'] = (ds) => {
  ouvrirModale(`Bon de livraison ${ds.num} signé par l'unité`, `<form id="f"><p style="margin-top:0">Enregistrez qui a signé le bon de livraison papier pour l'unité.</p><div class="form-grid">
    <label>Grade<input name="grade" placeholder="ex. Lt, Capt, Adj"></label>
    <label>Nom du signataire<input name="nom" required></label>
    <label>Fonction<input name="fonction" placeholder="ex. Officier logistique"></label>
    <label>Date de signature<input type="date" name="date" value="${today()}" required></label>
  </div>${piedForm('Enregistrer la signature')}</form>`, (m) => lierFormulaire($('#f', m), async (d) => {
    await api('POST', `/api/stock/livraisons/${ds.id}/signature`, d); fermerModale(); toast('Signature enregistrée.', 'ok'); afficherPage(); majBadgeStock();
  }));
};
ACTIONS['cmd-bl-annuler'] = (ds) => {
  ouvrirModale(`Annuler la livraison ${ds.num}`, `<form id="f"><p style="margin-top:0">Les marchandises sont remises en stock et le reste à livrer de l'unité est rétabli. Un mouvement de retour est enregistré dans la traçabilité.</p><div class="form-grid">
    <label class="full">Motif (obligatoire)<textarea name="motif" required placeholder="ex. marchandises retournées par l'unité, erreur d'unité…"></textarea></label></div>${piedForm("Confirmer l'annulation")}</form>`,
  (m) => lierFormulaire($('#f', m), async (d) => { await api('POST', `/api/stock/livraisons/${ds.id}/annuler`, d); fermerModale(); toast('Livraison annulée, marchandises remises en stock.', 'ok'); afficherPage(); majBadgeStock(); }));
};

/* ------------------------------------------------------- Entrée en stock */
ACTIONS['cmd-entree'] = async () => {
  if (!depotSaisie()) return;
  await chargerRefStock();
  const bons = await api('GET', '/api/stock/bons?etat=ouverts');
  ouvrirModale(`Entrée en stock – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Fournisseur<input name="fournisseur" list="dl-fourn"></label>
    <label>Pièce (facture, bon de réception)<input name="document"></label>
    <label>Pour le bon (facultatif)<select name="bonId"><option value="">—</option>${bons.map((b) => `<option value="${b._id}">${esc(b.reference)} – ${esc(b.edition)}</option>`).join('')}</select></label>
    <label class="full">Observations<input name="observations"></label>
  </div>
  <div class="table-wrap"><table class="data"><thead><tr><th>Article</th><th class="num">Quantité reçue</th><th class="num">Prix unitaire (${esc(S.params.devise)})</th></tr></thead>
  <tbody>${actifs(CM.ref.articles).map((a) => `<tr><td><b>${esc(a.designation)}</b><br><small class="muted">${esc(a.conditionnement)}</small></td>
    <td><input type="number" min="0" step="any" inputmode="decimal" data-art="${a._id}"></td><td><input type="number" min="0" step="any" inputmode="decimal" data-prix="${a._id}" value="${a.prixUnitaire || ''}"></td></tr>`).join('')}</tbody></table></div>
  <datalist id="dl-fourn">${S.fournisseurs.map((x) => `<option value="${esc(x.nom)}">`).join('')}</datalist>${piedForm('Enregistrer et imprimer')}</form>`, (m) => {
    modaleLarge();
    lierFormulaire($('#f', m), async (d) => {
      const l = $$('[data-art]', m).filter((x) => Number(x.value) > 0).map((x) => ({ articleId: x.dataset.art, quantite: Number(x.value), prixUnitaire: $(`[data-prix="${x.dataset.art}"]`, m).value }));
      if (!l.length) throw new Error('Indiquez au moins une quantité reçue.');
      const mv = await api('POST', '/api/stock/entrees', { ...d, lignes: l });
      fermerModale(); toast(`Entrée enregistrée (${mv.numero}).`, 'ok'); afficherPage(); majBadgeStock(); docMouvementCmd(mv);
    });
  });
};

/* ------------------------------------------------------------- Inventaire */
ACTIONS['cmd-inventaire'] = async () => {
  if (!depotSaisie()) return;
  await chargerRefStock();
  const sit = await api('GET', '/api/stock/situation');
  ouvrirModale(`Inventaire – ${nomAgenceVue()}`, `<form id="f"><p style="margin-top:0">Saisissez les quantités comptées physiquement. Seuls les articles saisis sont ajustés ; chaque écart est enregistré avec le motif.</p>
    <div class="form-grid"><label>Date<input type="date" name="date" value="${today()}" required></label><label>Motif<input name="motif" required placeholder="ex. Inventaire mensuel, avarie, casse…"></label></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Article</th><th class="num">Stock enregistré</th><th class="num">Quantité comptée</th><th class="num">Écart</th></tr></thead>
    <tbody>${actifs(CM.ref.articles).map((a) => { const s = (sit.find((l) => l.articleId === a._id) || {}).stock || 0; return `<tr><td><b>${esc(a.designation)}</b><br><small class="muted">${esc(a.conditionnement)}</small></td><td class="num">${nq(s)}</td>
      <td><input type="number" min="0" step="any" inputmode="decimal" data-art="${a._id}" data-theo="${s}"></td><td class="num" data-ecart="${a._id}"></td></tr>`; }).join('')}</tbody></table></div>
    ${piedForm("Enregistrer l'ajustement")}</form>`, (m) => {
    modaleLarge();
    $('#f', m).addEventListener('input', (e) => { const x = e.target; if (!x.dataset.art) return; const c = $(`[data-ecart="${x.dataset.art}"]`, m); const v = x.value === '' ? null : Number(x.value) - Number(x.dataset.theo); c.innerHTML = v == null ? '' : `<b class="${v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${nq(v)}</b>`; });
    lierFormulaire($('#f', m), async (d) => {
      const l = $$('[data-art]', m).filter((x) => x.value !== '').map((x) => ({ articleId: x.dataset.art, compte: Number(x.value) }));
      const mv = await api('POST', '/api/stock/ajustements', { ...d, lignes: l });
      fermerModale(); toast(`Ajustement enregistré (${mv.numero}).`, 'ok'); afficherPage(); majBadgeStock(); docMouvementCmd(mv);
    });
  });
};

/* ============================================================ Livraisons */
PAGES.livraisons = {
  perm: 'stock.voir',
  f: { statut: '', uniteId: '' },
  async render() {
    await chargerRefStock();
    if (paramUrl('statut') !== null) this.f.statut = paramUrl('statut');
    const f = this.f;
    const liste = await api('GET', `/api/stock/livraisons?${qs({ ...per(), statut: f.statut, uniteId: f.uniteId })}`);
    this.liste = liste;
    return `${tete('Livraisons aux unités', 'Bons de livraison générés à chaque retrait, signés sur papier par l\'unité',
      '<span class="actions"><button class="btn primary" data-perm="stock.livrer" data-action="cmd-livrer">Livrer une unité</button><button class="btn" data-perm="stock.etats" data-action="cmd-imprimer-livraisons">Imprimer la liste</button></span>')}
    ${barrePeriode(`<label>Statut<select data-f="statut"><option value="">Tous</option>${Object.entries(STATUTS_BL).map(([k, v]) => `<option value="${k}" ${k === f.statut ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
      <label>Unité<select data-f="uniteId">${opts(CM.ref.unites, f.uniteId, (u) => `${u.nom} (${regionDe(u.regionId).nom})`, 'Toutes')}</select></label>`)}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr>${thAg()}<th>N° BL</th><th>Date</th><th>Unité</th><th>Bon de commande</th><th>Articles livrés</th><th>Statut</th><th>Saisi par</th><th></th></tr></thead>
      <tbody>${liste.map((l) => ligneBL(l)).join('') || vide(9, 'Aucune livraison sur la période.')}</tbody>
    </table></div></div>`;
  },
  mount(root) {
    lierPeriode(root, () => afficherPage());
    $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { this.f[el.dataset.f] = el.value; if (location.hash.includes('?')) location.hash = '#/livraisons'; else afficherPage(); }));
  },
};
ACTIONS['cmd-imprimer-livraisons'] = () => docListeLivraisons(PAGES.livraisons.liste, S.periode);

/* ============================================ Traçabilité (mouvements) */
PAGES['mouvements-stock'] = {
  perm: 'stock.voir',
  f: { type: '', articleId: '', uniteId: '', utilisateur: '' },
  async render() {
    await chargerRefStock();
    const f = this.f;
    const r = await api('GET', `/api/stock/mouvements?${qs({ ...per(), ...f })}`);
    this.r = r;
    const fiche = !!f.articleId;
    const a = fiche ? artDe(f.articleId) : null;
    const auteurs = [...new Set(r.mouvements.map((m) => `${m.creePar}|${m.nomCreateur}`))];
    return `${tete('Traçabilité du stock', "Toutes les entrées, livraisons, ajustements et annulations : horodatés, avec l'utilisateur qui les a faits",
      `<span class="actions"><button class="btn" data-action="cmd-imprimer-mvts">${fiche ? 'Imprimer la fiche de stock' : 'Imprimer le journal'}</button></span>`)}
    ${barrePeriode(`<label>Type<select data-f="type"><option value="">Tous</option>${Object.entries(CM.ref.typesMouvement).map(([k, v]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Article (fiche de stock)<select data-f="articleId">${opts(CM.ref.articles, f.articleId, (x) => x.designation, 'Tous')}</select></label>
      <label>Unité<select data-f="uniteId">${opts(CM.ref.unites, f.uniteId, (u) => u.nom, 'Toutes')}</select></label>
      <label>Utilisateur<select data-f="utilisateur"><option value="">Tous</option>${auteurs.map((x) => { const [id, nom] = x.split('|'); return `<option value="${esc(id)}" ${id === f.utilisateur ? 'selected' : ''}>${esc(nom)}</option>`; }).join('')}</select></label>`)}
    ${fiche ? `<div class="card"><b>Fiche de stock : ${esc(a.designation)}</b> (${esc(a.conditionnement)}) · solde au début de la période : <b>${nq(r.soldeInitial)}</b></div>` : ''}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr>${thAg()}<th>N°</th><th>Date</th><th>Type</th><th>Objet</th><th>${fiche ? 'Entrée' : 'Articles'}</th>${fiche ? '<th class="num">Sortie</th><th class="num">Stock</th>' : ''}<th>Saisi par / le</th><th></th></tr></thead>
      <tbody>${r.mouvements.map((m) => `<tr class="${m.annulePar ? 'muted barre' : ''}">${tdAg(m)}<td class="nowrap"><b>${esc(m.numero)}</b></td><td class="nowrap">${fd(m.date)}</td>
        <td><span class="badge ${BADGE_MVT[m.type] || ''}">${esc(CM.ref.typesMouvement[m.type] || m.type)}</span>${m.annulePar ? `<br><small>annulé par ${esc(m.annulePar)}</small>` : ''}</td>
        <td>${objetMouvement(m)}</td>
        ${fiche ? `<td class="num">${m.quantiteArticle > 0 ? nq(m.quantiteArticle) : ''}</td><td class="num">${m.quantiteArticle < 0 ? nq(-m.quantiteArticle) : ''}</td><td class="num"><b>${nq(m.solde)}</b></td>`
    : `<td><small>${m.lignes.map((l) => `${l.quantite > 0 ? '+' : ''}${nq(l.quantite)} ${esc(l.designation)}`).join('<br>')}</small></td>`}
        <td><small>${esc(m.nomCreateur)}<br>${fdt(m.creeLe)}</small></td>
        <td class="nowrap"><button class="btn sm" data-action="cmd-mvt-voir" data-id="${m._id}">Voir</button>
          ${['entree', 'ajustement'].includes(m.type) && !m.annulePar ? `<button class="btn sm danger" data-perm="stock.corriger" data-action="cmd-mvt-annuler" data-id="${m._id}" data-num="${esc(m.numero)}">Annuler</button>` : ''}</td></tr>`).join('') || vide(fiche ? 10 : 8, 'Aucun mouvement sur la période.')}</tbody>
    </table></div></div>`;
  },
  mount(root) {
    lierPeriode(root, () => afficherPage());
    $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { this.f[el.dataset.f] = el.value; afficherPage(); }));
  },
};
function objetMouvement(m) {
  if (m.type === 'livraison') return `${esc(m.uniteNom)} – BL ${esc(m.livraisonNumero)}<br><small class="muted">Bon ${esc(m.bonReference)} · ${esc(m.edition || '')}</small>`;
  if (m.type === 'entree') return `${esc(m.fournisseur || 'Entrée')}${m.document ? ` – ${esc(m.document)}` : ''}${m.bonReference ? `<br><small class="muted">pour le bon ${esc(m.bonReference)}</small>` : ''}`;
  if (m.type === 'annulation') return `${esc(m.libelle)}<br><small class="muted">${esc(m.motif || '')}</small>`;
  return `${esc(m.motif || m.libelle || '')}`;
}
ACTIONS['cmd-mvt-voir'] = async (ds) => docMouvementCmd(await api('GET', `/api/stock/mouvements/${ds.id}`));
ACTIONS['cmd-mvt-annuler'] = (ds) => demanderMotif(`Annuler le mouvement ${ds.num}`, 'Un mouvement inverse est enregistré : le stock est corrigé et les deux mouvements restent visibles dans la traçabilité.', `/api/stock/mouvements/${ds.id}/annuler`);
ACTIONS['cmd-imprimer-mvts'] = () => docMouvementsCmd(PAGES['mouvements-stock'].r, PAGES['mouvements-stock'].f, S.periode);

/* ================================================================ Rapports */
PAGES['etats-stock'] = {
  perm: 'stock.etats',
  f: { rapport: 'unite', regionId: '', typeId: '', ouverts: '1', toutes: '0' },
  async render() {
    await chargerRefStock();
    const f = this.f;
    let corps = '';
    if (f.rapport === 'situation') {
      this.d = await api('GET', '/api/stock/situation');
      corps = tableSituation(this.d);
    } else {
      const p = f.toutes === '1' ? {} : per();
      this.d = await api('GET', `/api/stock/consolidation?${qs({ groupe: f.rapport, regionId: f.regionId, typeId: f.typeId, ouverts: f.ouverts, ...p })}`);
      corps = tableConsolidation(this.d);
    }
    const RAPPORTS = { unite: 'Consolidation par unité', region: 'Consolidation par région', type: 'Consolidation par type de bon', bon: 'Récapitulatif par bon de commande', situation: 'État du stock et besoins d\'achat' };
    this.titre = RAPPORTS[f.rapport];
    return `${tete('Rapports de stock', 'Consolidations commandé / livré / reste à livrer, état du stock. Fiches de stock : menu Traçabilité ; livraisons : menu Livraisons.',
      '<span class="actions"><button class="btn primary" data-action="cmd-imprimer-rapport">Imprimer / PDF</button></span>')}
    <div class="filters">
      <label>Rapport<select data-f="rapport">${Object.entries(RAPPORTS).map(([k, v]) => `<option value="${k}" ${k === f.rapport ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${f.rapport === 'situation' ? '' : `<label>Bons<select data-f="ouverts"><option value="1" ${f.ouverts === '1' ? 'selected' : ''}>En cours seulement</option><option value="0" ${f.ouverts === '0' ? 'selected' : ''}>Tous (sauf annulés)</option></select></label>
      <label>Région<select data-f="regionId">${opts(CM.ref.regions, f.regionId, (r) => r.nom, 'Toutes')}</select></label>
      <label>Type de bon<select data-f="typeId">${opts(CM.ref.types, f.typeId, (t) => t.nom, 'Tous')}</select></label>
      <label>Date des bons<select data-f="toutes"><option value="0" ${f.toutes === '0' ? 'selected' : ''}>Période ci-dessous</option><option value="1" ${f.toutes === '1' ? 'selected' : ''}>Toutes dates</option></select></label>`}
    </div>
    ${f.rapport === 'situation' || f.toutes === '1' ? '' : barrePeriode()}
    ${corps}`;
  },
  mount(root) {
    lierPeriode(root, () => afficherPage());
    $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { this.f[el.dataset.f] = el.value; afficherPage(); }));
  },
};
function tableSituation(d) {
  return `<div class="card"><div class="table-wrap"><table class="data"><thead><tr>${thAg()}<th>Article</th><th class="num">En stock</th><th class="num">Reste à livrer</th><th class="num">Après livraisons</th><th class="num">À acheter</th><th class="num">Valeur estimée</th></tr></thead>
    <tbody>${d.filter((l) => l.stock || l.resteALivrer).map((l) => `<tr>${tdAg(l)}<td>${esc(l.designation)} <small class="muted">${esc(l.conditionnement)}</small></td><td class="num">${nq(l.stock)}</td><td class="num">${nq(l.resteALivrer)}</td><td class="num">${nq(l.apresLivraisons)}</td><td class="num">${l.besoin ? `<b class="neg">${nq(l.besoin)}</b>` : '—'}</td><td class="num">${l.valeurBesoin ? nb(l.valeurBesoin) : ''}</td></tr>`).join('') || vide(7, 'Aucun stock.')}</tbody></table></div></div>`;
}
function tableConsolidation(d) {
  const libGroupe = { unite: 'Unité', region: 'Région', type: 'Type de bon', bon: 'Bon de commande' }[d.groupe];
  if (!d.lignes.length) return `<div class="card"><p class="empty">Aucun bon de commande pour ces critères.</p></div>`;
  const tot = (a, k) => d.lignes.reduce((s, l) => s + ((l.articles[a] || {})[k] || 0), 0);
  return `<div class="card"><p class="muted" style="margin-top:0">${d.nbBons} bon(s) · par article : <b>reste à livrer</b>, puis livré / commandé</p><div class="table-wrap"><table class="data grille-etat">
    <thead><tr>${thAg()}<th>${libGroupe}</th><th class="num">Eff.</th>${d.articles.map((a) => `<th class="num">${esc(a.designation)}<br><small>${esc(a.conditionnement)}</small></th>`).join('')}</tr></thead>
    <tbody>${d.lignes.map((l) => `<tr>${tdAg(l)}<td><b>${esc(l.libelle)}</b>${l.sous ? `<br><small class="muted">${esc(l.sous)}</small>` : ''}</td><td class="num">${nq(l.effectif)}</td>
      ${d.articles.map((a) => { const v = l.articles[a._id]; return v ? `<td class="num cel-bon ${v.reste ? '' : 'solde'}"><b>${nq(v.reste)}</b><small>${nq(v.livre)} / ${nq(v.commande)}</small></td>` : '<td class="num muted">—</td>'; }).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr class="tot">${consolideStock() ? '<td></td>' : ''}<td>Total</td><td class="num">${nq(d.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}</td>${d.articles.map((a) => `<td class="num cel-bon"><b>${nq(tot(a._id, 'reste'))}</b><small>${nq(tot(a._id, 'livre'))} / ${nq(tot(a._id, 'commande'))}</small></td>`).join('')}</tr></tfoot>
  </table></div></div>`;
}
ACTIONS['cmd-imprimer-rapport'] = () => {
  const p = PAGES['etats-stock'];
  docRapportStock(p.titre, p.f, p.d, p.f.rapport === 'situation' || p.f.toutes === '1' ? null : S.periode);
};

/* ============================================ Régions, unités, articles */
PAGES['referentiel-stock'] = {
  perm: 'stock.voir',
  onglet: 'unites',
  async render() {
    await chargerRefStock();
    if (paramUrl('onglet')) this.onglet = paramUrl('onglet');
    const o = this.onglet; const R = CM.ref; const ed = peut('stock.referentiel');
    const ong = [['unites', `Unités (${R.unites.length})`], ['regions', `Régions militaires (${R.regions.length})`], ['articles', `Articles (${R.articles.length})`], ['types', 'Types de bons']];
    const actif = (x) => (x.actif === false ? '<span class="badge">Inactif</span>' : '<span class="badge in">Actif</span>');
    const btn = (k, id) => (ed ? `<button class="btn sm" data-action="cmd-ref-edit" data-type="${k}" data-id="${id}">Modifier</button>` : '');
    let t = '';
    if (o === 'unites') t = `<thead><tr><th>Unité</th><th>Région</th><th class="num">Effectif</th><th>Statut</th><th></th></tr></thead><tbody>${R.unites.slice().sort((a, b) => regionDe(a.regionId).nom.localeCompare(regionDe(b.regionId).nom) || a.nom.localeCompare(b.nom)).map((u) => `<tr><td><b>${esc(u.nom)}</b></td><td>${esc(regionDe(u.regionId).nom)}</td><td class="num">${nq(u.effectif)}</td><td>${actif(u)}</td><td>${btn('unites', u._id)}</td></tr>`).join('') || vide(5, 'Aucune unité.')}</tbody>`;
    if (o === 'regions') t = `<thead><tr><th>Région militaire</th><th>Code</th><th class="num">Unités</th><th>Statut</th><th></th></tr></thead><tbody>${R.regions.map((r) => `<tr><td><b>${esc(r.nom)}</b>${r.observations ? `<br><small class="muted">${esc(r.observations)}</small>` : ''}</td><td>${esc(r.code)}</td><td class="num">${R.unites.filter((u) => u.regionId === r._id).length}</td><td>${actif(r)}</td><td>${btn('regions', r._id)}</td></tr>`).join('') || vide(5, 'Aucune région : commencez par créer les régions militaires.')}</tbody>`;
    if (o === 'articles') t = `<thead><tr><th>Article</th><th>Conditionnement</th><th>Unité de compte</th><th class="num">Prix unitaire</th><th class="num">Stock minimum</th><th>Statut</th><th></th></tr></thead><tbody>${R.articles.map((a) => `<tr><td><b>${esc(a.designation)}</b></td><td>${esc(a.conditionnement)}</td><td>${esc(a.unite)}</td><td class="num">${a.prixUnitaire ? nb(a.prixUnitaire) : '—'}</td><td class="num">${a.seuilMin ? nq(a.seuilMin) : '—'}</td><td>${actif(a)}</td><td class="nowrap">${btn('articles', a._id)}${ed ? ` <button class="btn sm danger" data-action="cmd-art-suppr" data-id="${a._id}">Supprimer</button>` : ''}</td></tr>`).join('') || vide(7, 'Aucun article.')}</tbody>`;
    if (o === 'types') t = `<thead><tr><th>Type de bon</th><th>Quantités</th><th>Statut</th><th></th></tr></thead><tbody>${R.types.map((x) => `<tr><td><b>${esc(x.nom)}</b></td><td>${x.nature === 'mensuel' ? 'Mensuelles' : 'Temporaires'}</td><td>${actif(x)}</td><td class="nowrap">${btn('types', x._id)}${ed ? ` <button class="btn sm danger" data-action="cmd-type-suppr" data-id="${x._id}">Supprimer</button>` : ''}</td></tr>`).join('') || vide(4, 'Aucun type de bon.')}</tbody>`;
    const nouveau = { unites: '+ Nouvelle unité', regions: '+ Nouvelle région', articles: '+ Nouvel article', types: '+ Nouveau type' }[o];
    return `${tete('Régions, unités et articles', 'Référentiel commun à tous les dépôts', ed ? `<button class="btn primary" data-action="cmd-ref-edit" data-type="${o}">${nouveau}</button>` : '')}
    <div class="tabs">${ong.map(([k, v]) => `<button data-onglet="${k}" class="${k === o ? 'active' : ''}">${v}</button>`).join('')}</div>
    <div class="card"><div class="table-wrap"><table class="data">${t}</table></div></div>`;
  },
  mount(root) { $$('[data-onglet]', root).forEach((b) => b.addEventListener('click', () => { this.onglet = b.dataset.onglet; if (location.hash.includes('?')) location.hash = '#/referentiel-stock'; else afficherPage(); })); },
};
ACTIONS['cmd-ref-edit'] = (ds) => {
  const k = ds.type; const x = (CM.ref[k] || []).find((y) => y._id === ds.id) || {};
  const statut = ds.id ? `<label>Statut<select name="actif"><option value="1">Actif</option><option value="0" ${x.actif === false ? 'selected' : ''}>Inactif</option></select></label>` : '';
  const champs = {
    unites: `<label>Nom de l'unité<input name="nom" value="${esc(x.nom)}" required placeholder="ex. Bn QG 3ZDef"></label><label>Région militaire<select name="regionId" required>${opts(actifs(CM.ref.regions, x.regionId), x.regionId, (r) => r.nom, '— Choisir —')}</select></label>
      <label>Effectif<input type="number" min="0" name="effectif" value="${x.effectif || ''}"></label>${statut}<label class="full">Observations<input name="observations" value="${esc(x.observations)}"></label>`,
    regions: `<label>Nom de la région<input name="nom" value="${esc(x.nom)}" required placeholder="ex. 3ZDef – Ops Kisangani"></label><label>Code<input name="code" value="${esc(x.code)}"></label>${statut}<label class="full">Observations<input name="observations" value="${esc(x.observations)}"></label>`,
    articles: `<label>Désignation<input name="designation" value="${esc(x.designation)}" required></label><label>Conditionnement<input name="conditionnement" value="${esc(x.conditionnement)}" placeholder="ex. Sac 50 kg"></label>
      <label>Unité de compte<input name="unite" value="${esc(x.unite || 'sac')}" placeholder="sac, kg, bidon, carton…"></label><label>Prix unitaire (${esc(S.params.devise)})<input type="number" min="0" step="any" name="prixUnitaire" value="${x.prixUnitaire || ''}"></label>
      <label>Stock minimum (alerte)<input type="number" min="0" step="any" name="seuilMin" value="${x.seuilMin || ''}"></label>${statut}`,
    types: `<label>Nom du type<input name="nom" value="${esc(x.nom)}" required></label><label>Quantités<select name="nature"><option value="mensuel">Mensuelles</option><option value="temporaire" ${x.nature !== 'mensuel' ? 'selected' : ''}>Temporaires</option></select></label>${statut}`,
  }[k];
  const titres = { unites: 'Unité', regions: 'Région militaire', articles: 'Article', types: 'Type de bon' };
  ouvrirModale(`${ds.id ? 'Modifier' : 'Nouveau / nouvelle'} : ${titres[k]}`, `<form id="f"><div class="form-grid">${champs}</div>${piedForm()}</form>`, (m) => lierFormulaire($('#f', m), async (d) => {
    if (d.actif !== undefined) d.actif = d.actif === '1';
    await api(ds.id ? 'PUT' : 'POST', `/api/stock/${k}${ds.id ? `/${ds.id}` : ''}`, d);
    fermerModale(); toast('Enregistré.', 'ok'); afficherPage();
  }));
};

ACTIONS['cmd-art-suppr'] = async (ds) => {
  const a = artDe(ds.id);
  const u = await api('GET', `/api/stock/articles/${ds.id}/utilisations`);
  if (u.bons || u.mouvements || u.livraisons) {
    const detail = [u.bons && `${u.bons} bon(s) de commande`, u.mouvements && `${u.mouvements} mouvement(s) de stock`, u.livraisons && `${u.livraisons} livraison(s)`].filter(Boolean).join(', ');
    ouvrirModale(`Supprimer « ${a.designation} »`, `<form id="f"><p style="margin-top:0">Cet article figure dans ${esc(detail)}. Pour garder la traçabilité, il ne peut pas être supprimé.</p>
      <p>${a.actif === false ? 'Il est déjà désactivé : il n\'apparaît plus dans les nouvelles saisies.' : 'Vous pouvez le <b>désactiver</b> : il n\'apparaîtra plus dans les nouveaux bons, entrées et inventaires, mais l\'historique reste intact.'}</p>
      <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Fermer</button>${a.actif === false ? '' : '<button class="btn primary" type="submit">Désactiver l\'article</button>'}</div></form>`,
    (m) => lierFormulaire($('#f', m), async () => {
      await api('PUT', `/api/stock/articles/${ds.id}`, { ...a, actif: false });
      fermerModale(); toast(`« ${a.designation} » désactivé.`, 'ok'); afficherPage();
    }));
    return;
  }
  ouvrirModale(`Supprimer « ${a.designation} »`, `<form id="f"><p style="margin-top:0">Cet article n'a encore servi dans aucun bon, mouvement ni livraison. Il sera supprimé définitivement de la liste des articles (opération tracée dans le journal d'audit).</p>
    <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn danger" type="submit">Supprimer définitivement</button></div></form>`,
  (m) => lierFormulaire($('#f', m), async () => {
    await api('POST', `/api/stock/articles/${ds.id}/supprimer`);
    fermerModale(); toast(`Article « ${a.designation} » supprimé.`, 'ok'); afficherPage();
  }));
};

ACTIONS['cmd-type-suppr'] = async (ds) => {
  const t = CM.ref.types.find((x) => x._id === ds.id) || {};
  const u = await api('GET', `/api/stock/types/${ds.id}/utilisations`);
  if (u.bons) {
    ouvrirModale(`Supprimer le type « ${t.nom} »`, `<form id="f"><p style="margin-top:0">${u.bons} bon(s) de commande utilisent ce type. Pour garder la traçabilité, il ne peut pas être supprimé.</p>
      <p>${t.actif === false ? 'Il est déjà désactivé : il n\'est plus proposé pour les nouveaux bons.' : 'Vous pouvez le <b>désactiver</b> : il ne sera plus proposé pour les nouveaux bons ; les bons existants gardent leur type.'}</p>
      <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Fermer</button>${t.actif === false ? '' : '<button class="btn primary" type="submit">Désactiver le type</button>'}</div></form>`,
    (m) => lierFormulaire($('#f', m), async () => {
      await api('PUT', `/api/stock/types/${ds.id}`, { ...t, actif: false });
      fermerModale(); toast(`Type « ${t.nom} » désactivé.`, 'ok'); afficherPage();
    }));
    return;
  }
  ouvrirModale(`Supprimer le type « ${t.nom} »`, `<form id="f"><p style="margin-top:0">Aucun bon de commande n'utilise ce type. Il sera supprimé définitivement (opération tracée dans le journal d'audit).</p>
    <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn danger" type="submit">Supprimer définitivement</button></div></form>`,
  (m) => lierFormulaire($('#f', m), async () => {
    await api('POST', `/api/stock/types/${ds.id}/supprimer`);
    fermerModale(); toast(`Type « ${t.nom} » supprimé.`, 'ok'); afficherPage();
  }));
};

/* ================================================================ Documents */
function docBonLivraison(l) {
  const html = `${entete('Bon de livraison', { numero: l.numero, date: l.date })}
  ${l.statut === 'annule' ? `<div class="annule-tampon">Annulé – ${esc(l.annulation.motif)}</div>` : ''}
  <div class="kv" style="margin-top:10px">
    <div>Unité bénéficiaire</div><div><b>${esc(l.uniteNom)}</b>${l.effectif ? ` – effectif ${nq(l.effectif)}` : ''}</div>
    <div>Région militaire</div><div>${esc(l.regionNom)}</div>
    <div>Bon de commande</div><div><b>${esc(l.bonReference)}</b> (${esc(l.typeNom)} – ${esc(l.edition)}) · réf. interne ${esc(l.bonNumero)}</div>
    ${l.receptionnaire ? `<div>Réceptionnaire</div><div>${esc(l.receptionnaire)}</div>` : ''}
    ${l.vehicule ? `<div>Véhicule / transport</div><div>${esc(l.vehicule)}</div>` : ''}
    ${l.observations ? `<div>Observations</div><div>${esc(l.observations)}</div>` : ''}
  </div>
  <table class="dt" style="margin-top:12px"><thead><tr><th>N°</th><th>Article</th><th>Conditionnement</th><th class="num">Quantité livrée</th><th>Unité</th></tr></thead>
  <tbody>${l.lignes.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.designation)}</td><td>${esc(x.conditionnement)}</td><td class="num"><b>${nq(x.quantite)}</b></td><td>${esc(x.unite)}</td></tr>`).join('')}</tbody></table>
  <p class="note">Établi par ${esc(l.nomCreateur)} le ${fdt(l.creeLe)}. L'unité reconnaît avoir reçu les quantités ci-dessus en bon état.</p>
  ${l.signature ? `<p class="note">Signé pour l'unité par ${esc([l.signature.grade, l.signature.nom].filter(Boolean).join(' '))}${l.signature.fonction ? `, ${esc(l.signature.fonction)}` : ''}, le ${fd(l.signature.date)}.</p>` : ''}
  ${signatures([{ titre: 'Le Magasinier' }, { titre: "Pour l'unité (nom, grade, signature)" }, { titre: 'Le Responsable du dépôt' }])}`;
  // Deux exemplaires : dépôt et unité
  ouvrirDocument(`Bon de livraison ${l.numero}`, feuille(`${html}<p class="exemplaire">Exemplaire dépôt</p>`) + feuille(`${html}<p class="exemplaire">Exemplaire unité</p>`), { fichier: `BL_${l.numero}` });
}
function docMouvementCmd(m) {
  const titre = CM.ref.typesMouvement[m.type] || 'Mouvement de stock';
  const html = `${entete(titre, { numero: m.numero, date: m.date })}
  <div class="kv" style="margin-top:10px">
    <div>Objet</div><div>${esc(m.libelle || '')}</div>
    ${m.fournisseur ? `<div>Fournisseur</div><div>${esc(m.fournisseur)}</div>` : ''}${m.document ? `<div>Pièce</div><div>${esc(m.document)}</div>` : ''}
    ${m.bonReference ? `<div>Bon de commande</div><div>${esc(m.bonReference)} (${esc(m.edition || '')})</div>` : ''}${m.uniteNom ? `<div>Unité</div><div>${esc(m.uniteNom)}</div>` : ''}
    ${m.motif ? `<div>Motif</div><div>${esc(m.motif)}</div>` : ''}${m.annulePar ? `<div>Annulé</div><div>par ${esc(m.annulePar)} – ${esc(m.motifAnnulation || '')}</div>` : ''}
  </div>
  <table class="dt" style="margin-top:12px"><thead><tr><th>Article</th><th>Conditionnement</th>${m.type === 'ajustement' ? '<th class="num">Enregistré</th><th class="num">Compté</th>' : ''}<th class="num">Quantité</th>${m.type === 'entree' ? '<th class="num">Prix unit.</th><th class="num">Montant</th>' : ''}</tr></thead>
  <tbody>${m.lignes.map((l) => `<tr><td>${esc(l.designation)}</td><td>${esc(l.conditionnement || '')}</td>${m.type === 'ajustement' ? `<td class="num">${nq(l.theorique)}</td><td class="num">${nq(l.compte)}</td>` : ''}<td class="num"><b>${l.quantite > 0 ? '+' : ''}${nq(l.quantite)}</b></td>${m.type === 'entree' ? `<td class="num">${l.prixUnitaire == null ? '' : nb(l.prixUnitaire)}</td><td class="num">${l.montant == null ? '' : nb(l.montant)}</td>` : ''}</tr>`).join('')}</tbody>
  ${m.type === 'entree' && m.montant != null ? `<tfoot><tr class="tot"><td colspan="4">Montant total</td><td class="num">${nb(m.montant)}</td></tr></tfoot>` : ''}</table>
  <p class="note">Saisi par ${esc(m.nomCreateur)} le ${fdt(m.creeLe)}.</p>
  ${signatures([{ titre: 'Le Magasinier' }, { titre: m.type === 'entree' ? 'Le Livreur' : 'Le Contrôleur' }, { titre: 'Le Responsable du dépôt' }])}`;
  ouvrirDocument(`${titre} ${m.numero}`, feuille(html), { fichier: `Stock_${m.numero}` });
}
function docBonCommande(b) {
  const cols = CM.ref.articles.filter((a) => b.totaux[a._id]);
  const cel = (v) => (v ? `<td class="num">${nq(v.commande)}${v.livre ? `<br><small>livré ${nq(v.livre)}</small>` : ''}</td>` : '<td></td>');
  const html = `${entete('Bon de commande', { numero: b.reference, date: b.dateBon, meta: [`Réf. interne : <b>${esc(b.numero)}</b>`, `Type : <b>${esc(b.typeNom)}</b> · ${esc(b.edition)}`, `Région : <b>${esc(b.regionNom)}</b>`] })}
  ${b.statut === 'annule' ? '<div class="annule-tampon">Annulé</div>' : ''}
  <table class="dt petit" style="margin-top:10px"><thead><tr><th>Unité</th><th class="num">Eff.</th>${cols.map((a) => `<th class="num">${esc(a.designation)}<br><small>${esc(a.conditionnement)}</small></th>`).join('')}</tr></thead>
  <tbody>${b.lignes.map((l) => `<tr><td>${esc(l.uniteNom)}</td><td class="num">${nq(l.effectif)}</td>${cols.map((a) => cel(l.articles[a._id])).join('')}</tr>`).join('')}</tbody>
  <tfoot><tr class="tot"><td>Total</td><td class="num">${nq(b.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}</td>${cols.map((a) => cel(b.totaux[a._id])).join('')}</tr>
  <tr><td colspan="2">Reste à livrer</td>${cols.map((a) => `<td class="num"><b>${nq(b.totaux[a._id].reste)}</b></td>`).join('')}</tr></tfoot></table>
  <p class="note">État : ${esc((ETATS_BON[b.etat] || [b.etat])[0])} (${nq(b.avancement)} % livré)${b.autonomie ? ` · autonomie ${b.autonomie} jours` : ''}${b.observations ? ` · ${esc(b.observations)}` : ''}.</p>`;
  ouvrirDocument(`Bon de commande ${b.reference}`, feuille(html), { paysage: cols.length > 6, fichier: `BC_${b.numero}` });
}
function docListeLivraisons(liste, periode) {
  const html = `${entete('Livraisons effectuées', { periode })}
  <table class="dt petit" style="margin-top:10px"><thead><tr>${consolideStock() ? '<th>Dépôt</th>' : ''}<th>N° BL</th><th>Date</th><th>Unité</th><th>Région</th><th>Bon</th><th>Articles</th><th>Statut</th></tr></thead>
  <tbody>${liste.map((l) => `<tr>${consolideStock() ? `<td>${esc(nomAgenceId(l.agenceId))}</td>` : ''}<td>${esc(l.numero)}</td><td>${fd(l.date)}</td><td>${esc(l.uniteNom)}</td><td>${esc(l.regionNom)}</td><td>${esc(l.bonReference)}</td><td>${l.lignes.map((x) => `${nq(x.quantite)} ${esc(x.designation)}`).join(', ')}</td><td>${esc(STATUTS_BL[l.statut][0])}</td></tr>`).join('')}</tbody></table>
  <div class="doc-h">Total livré (hors livraisons annulées)</div>
  <table class="dt petit"><tbody>${Object.entries(liste.filter((l) => l.statut !== 'annule').flatMap((l) => l.lignes).reduce((o, x) => { o[x.designation] = (o[x.designation] || 0) + x.quantite; return o; }, {})).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num"><b>${nq(v)}</b></td></tr>`).join('') || '<tr><td>Aucune livraison</td></tr>'}</tbody></table>`;
  ouvrirDocument('Livraisons effectuées', feuille(html), { paysage: true, fichier: 'Livraisons' });
}
function docMouvementsCmd(r, f, periode) {
  const fiche = !!f.articleId; const a = fiche ? artDe(f.articleId) : null;
  const liste = r.mouvements.slice().reverse();
  const html = `${entete(fiche ? `Fiche de stock – ${a.designation}` : 'Journal des mouvements de stock', { periode, meta: fiche ? [`Conditionnement : <b>${esc(a.conditionnement)}</b>`] : [] })}
  <table class="dt petit" style="margin-top:10px"><thead><tr><th>Date</th><th>N°</th><th>Type</th><th>Unité / fournisseur</th><th>Bon / édition</th>${fiche ? '<th class="num">Entrée</th><th class="num">Sortie</th><th class="num">Stock</th>' : '<th>Articles</th>'}<th>Saisi par / le</th></tr></thead>
  <tbody>${fiche ? `<tr><td colspan="5"><i>Stock au début de la période</i></td><td></td><td></td><td class="num"><b>${nq(r.soldeInitial)}</b></td><td></td></tr>` : ''}
  ${liste.map((m) => `<tr><td>${fd(m.date)}</td><td>${esc(m.numero)}</td><td>${esc(CM.ref.typesMouvement[m.type] || m.type)}${m.annulePar ? ' (annulé)' : ''}</td><td>${esc(m.uniteNom || m.fournisseur || m.motif || '')}</td><td>${esc([m.bonReference, m.edition].filter(Boolean).join(' – '))}</td>
    ${fiche ? `<td class="num">${m.quantiteArticle > 0 ? nq(m.quantiteArticle) : ''}</td><td class="num">${m.quantiteArticle < 0 ? nq(-m.quantiteArticle) : ''}</td><td class="num"><b>${nq(m.solde)}</b></td>` : `<td>${m.lignes.map((l) => `${l.quantite > 0 ? '+' : ''}${nq(l.quantite)} ${esc(l.designation)}`).join(', ')}</td>`}
    <td>${esc(m.nomCreateur)} – ${fdt(m.creeLe)}</td></tr>`).join('')}</tbody></table>`;
  ouvrirDocument(fiche ? `Fiche de stock ${a.designation}` : 'Journal des mouvements', feuille(html), { paysage: true, fichier: fiche ? `Fiche_stock_${a.designation}` : 'Mouvements_stock' });
}
function docRapportStock(titre, f, d, periode) {
  const meta = [f.regionId && `Région : <b>${esc(regionDe(f.regionId).nom)}</b>`, f.typeId && `Type : <b>${esc((CM.ref.types.find((t) => t._id === f.typeId) || {}).nom)}</b>`, f.rapport !== 'situation' && (f.ouverts === '1' ? 'Bons en cours' : 'Tous les bons (hors annulés)')].filter(Boolean);
  let corps;
  if (f.rapport === 'situation') {
    corps = `<table class="dt"><thead><tr>${consolideStock() ? '<th>Dépôt</th>' : ''}<th>Article</th><th>Conditionnement</th><th class="num">En stock</th><th class="num">Reste à livrer</th><th class="num">Après livraisons</th><th class="num">À acheter</th><th class="num">Valeur estimée</th></tr></thead>
    <tbody>${d.filter((l) => l.stock || l.resteALivrer).map((l) => `<tr>${consolideStock() ? `<td>${esc(nomAgenceId(l.agenceId))}</td>` : ''}<td>${esc(l.designation)}</td><td>${esc(l.conditionnement)}</td><td class="num">${nq(l.stock)}</td><td class="num">${nq(l.resteALivrer)}</td><td class="num">${nq(l.apresLivraisons)}</td><td class="num"><b>${l.besoin ? nq(l.besoin) : ''}</b></td><td class="num">${l.valeurBesoin ? nb(l.valeurBesoin) : ''}</td></tr>`).join('')}</tbody></table>`;
  } else {
    const lib = { unite: 'Unité', region: 'Région', type: 'Type de bon', bon: 'Bon de commande' }[d.groupe];
    const tot = (a, k) => d.lignes.reduce((s, l) => s + ((l.articles[a] || {})[k] || 0), 0);
    const cel = (v) => (v ? `<td class="num">${nq(v.commande)}<br><small>L ${nq(v.livre)} · <b>R ${nq(v.reste)}</b></small></td>` : '<td></td>');
    corps = `<p class="note">Par article : quantité commandée, puis L = livré, R = reste à livrer. ${d.nbBons} bon(s).</p>
    <table class="dt petit"><thead><tr>${consolideStock() ? '<th>Dépôt</th>' : ''}<th>${lib}</th><th class="num">Eff.</th>${d.articles.map((a) => `<th class="num">${esc(a.designation)}<br><small>${esc(a.conditionnement)}</small></th>`).join('')}</tr></thead>
    <tbody>${d.lignes.map((l) => `<tr>${consolideStock() ? `<td>${esc(nomAgenceId(l.agenceId))}</td>` : ''}<td>${esc(l.libelle)}${l.sous ? `<br><small>${esc(l.sous)}</small>` : ''}</td><td class="num">${nq(l.effectif)}</td>${d.articles.map((a) => cel(l.articles[a._id])).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr class="tot">${consolideStock() ? '<td></td>' : ''}<td>Total</td><td class="num">${nq(d.lignes.reduce((s, l) => s + (l.effectif || 0), 0))}</td>${d.articles.map((a) => cel({ commande: tot(a._id, 'commande'), livre: tot(a._id, 'livre'), reste: tot(a._id, 'reste') })).join('')}</tr></tfoot></table>`;
  }
  ouvrirDocument(titre, feuille(`${entete(titre, { periode, meta })}<div style="margin-top:10px">${corps}</div>`), { paysage: true, fichier: titre.replace(/\s+/g, '_') });
}
