'use strict';
/* =====================================================================
   Gestion de stock : pages, formulaires et documents imprimables.
   ===================================================================== */
const SK = { articles: [], categories: [], ref: { motifs: {}, natures: {}, modes: {}, statuts: {} } };
const TYPES_MVT = {
  reception: ['Réception', 'in'], sortie: ['Sortie', 'out'], transfert_sortie: ['Transfert (envoi)', 'int'], transfert_entree: ['Transfert (réception)', 'int'],
  transfert_annule: ['Transfert annulé', 'warn'], perte: ['Perte', 'out'], ajustement: ["Ajustement d'inventaire", 'warn'],
};
const BADGE_STATUT = { disponible: 'in', quarantaine: 'warn', bloque: 'warn', perime: 'out', epuise: '', sorti: '' };
const UNITES = ['kg', 'tonne', 'sac 25 kg', 'sac 50 kg', 'sac 100 kg', 'litre', 'bidon 20 L', 'caisse', 'carton', 'pièce', 'palette', 'botte'];

async function chargerStock() {
  const [articles, categories, ref] = await Promise.all([api('GET', '/api/stock/articles'), api('GET', '/api/stock/categories'), SK.ref.statuts.disponible ? SK.ref : api('GET', '/api/stock/referentiel')]);
  Object.assign(SK, { articles, categories, ref });
}
const nq = (x) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(Number(x) || 0).replace(/ /g, ' ');
const nomCat = (id) => (SK.categories.find((c) => c._id === id) || {}).nom || '';
const optArticles = (sel, actifs = true) => SK.articles.filter((a) => !actifs || a.actif !== false || a._id === sel)
  .map((a) => `<option value="${a._id}" ${a._id === sel ? 'selected' : ''}>${esc(a.code)} – ${esc(a.designation)} (${esc(a.unite)})</option>`).join('');
const optCategories = (sel, tous = false) => (tous ? '<option value="">Toutes</option>' : '') + SK.categories.map((c) => `<option value="${c._id}" ${c._id === sel ? 'selected' : ''}>${esc(c.nom)}</option>`).join('');
const consolide = () => !S.me.agenceId && !S.agence && agencesActives().length > 1;
const colAgence = (x) => (consolide() ? `<td>${esc(x.agence || '')}</td>` : '');
const thAgence = () => (consolide() ? '<th>Agence</th>' : '');
const badgeStatut = (st) => `<span class="badge ${BADGE_STATUT[st] || ''}">${esc(SK.ref.statuts[st] || st)}</span>`;
function joursAvant(d) { if (!d) return null; return Math.round((Date.parse(d) - Date.parse(today())) / 86400000); }
function badgePeremption(d, alerte = 30) {
  if (!d) return '<span class="muted">—</span>';
  const j = joursAvant(d);
  const cls = j <= 0 ? 'out' : j <= 7 ? 'out' : j <= alerte ? 'warn' : '';
  return `${fd(d)}<br><span class="badge ${cls}">${j <= 0 ? 'périmé' : `J-${j}`}</span>`;
}
/** Les saisies se font toujours dans une agence précise. */
function agenceSaisie() {
  if (!consolide()) return true;
  toast("Choisissez d'abord l'agence concernée dans le sélecteur « Agence » en haut du menu.", 'err');
  return false;
}
const autresAgences = () => agencesActives().filter((g) => g._id !== (S.me.agenceId || S.agence || (agencesActives().length === 1 ? agencesActives()[0]._id : '')));

/* =================================================== Situation du stock */
PAGES.stock = {
  perm: 'stock.voir',
  async render() {
    await chargerStock();
    const [tb, sit] = await Promise.all([api('GET', '/api/stock/tableau'), api('GET', '/api/stock/situation')]);
    const k = (lbl, val, sub, cls = '') => `<div class="kpi ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
    return `${tete('Situation du stock', `${esc(nomAgenceVue())} · valorisation au coût réel des lots (FIFO / FEFO)`,
      `<span class="actions"><button class="btn primary" data-perm="stock.saisir" data-action="stk-reception">+ Réception</button><button class="btn" data-perm="stock.saisir" data-action="stk-sortie">Sortie</button><button class="btn" data-perm="stock.transferer" data-action="stk-transfert">Transfert</button><button class="btn" data-perm="stock.pertes" data-action="stk-perte">Déclarer une perte</button></span>`)}
    <div class="kpis">
      ${k('Valeur du stock', money(tb.valeur), 'Lots disponibles, bloqués et en quarantaine', 'main')}
      ${k('Valeur à risque (30 jours)', money(tb.valeurRisque30), tb.tranches.map((t) => `${t.tranche} j : ${nb(t.valeur)}`).join(' · '), tb.valeurRisque30 ? 'alerte' : '')}
      ${k('Perte sur péremption du jour', money(tb.perteJour), `${tb.lotsPerimesJour} lot(s) · mois : ${nb(tb.perteMois)} · année : ${nb(tb.perteAnnee)}`, tb.perteJour ? 'danger' : '')}
      ${k('Lots périmés encore en stock', money(tb.perimesEnStock), `${tb.nbPerimes} lot(s) à sortir`, tb.nbPerimes ? 'danger' : '')}
    </div>
    <div class="kpis">
      ${k('Ruptures (sous le minimum)', tb.ruptures, `${tb.aCommander} article(s) à commander`, tb.ruptures ? 'danger' : '')}
      ${k('Péremptions sous 30 jours', tb.peremptionsProches, 'lot(s) à écouler en priorité', tb.peremptionsProches ? 'alerte' : '')}
      ${k('Pertes à valider', tb.pertesAValider, '<a href="#/pertes">Voir les déclarations</a>', tb.pertesAValider ? 'alerte' : '')}
      ${k('Transferts', `${tb.transfertsARecevoir} à recevoir`, `${tb.transfertsEnvoyes} envoyé(s) en transit · ${nb(tb.valeurEnTransit)}`, tb.transfertsARecevoir ? 'alerte' : '')}
    </div>
    <div class="card"><div class="card-head"><h2>Stock par article</h2></div><div class="table-wrap"><table class="data">
      <thead><tr>${thAgence()}<th>Article</th><th>Catégorie</th><th class="num">Disponible</th><th class="num">Bloqué / quar.</th><th class="num">Périmé</th><th class="num">Valeur</th><th class="num">Min / Max</th><th class="num">Conso / jour</th><th class="num">Couverture</th><th>Prochaine péremption</th><th>Alerte</th><th></th></tr></thead>
      <tbody>${sit.map((l) => `<tr class="${l.alerte === 'rupture' ? 'rupture-ligne' : l.alerte || l.peremptionProche ? 'alerte-ligne' : ''}">${colAgence(l)}
        <td><b>${esc(l.designation)}</b><br><small class="muted">${esc(l.code)} · ${esc(l.unite)}</small></td><td>${esc(l.categorie)}</td>
        <td class="num"><b>${nq(l.disponible)}</b></td><td class="num">${l.bloque ? nq(l.bloque) : ''}</td><td class="num">${l.perime ? `<span class="neg">${nq(l.perime)}</span>` : ''}</td>
        <td class="num">${nb(l.valeur)}</td><td class="num">${nq(l.min)} / ${nq(l.max)}</td><td class="num">${l.consoJour ? nq(l.consoJour) : '—'}</td>
        <td class="num">${l.couvertureJours == null ? '—' : `${l.couvertureJours} j`}</td>
        <td>${l.prochainePeremption ? badgePeremption(l.prochainePeremption) : '<span class="muted">—</span>'}</td>
        <td class="keep">${l.alerte === 'rupture' ? '<span class="badge out">Rupture</span>' : l.alerte === 'commander' ? '<span class="badge warn">À commander</span>' : ''}${l.aCommander ? `<br><small>Commander ${nq(l.aCommander)} ${esc(l.unite)}</small>` : ''}</td>
        <td class="nowrap">${!consolide() && peut('stock.articles', 'stock.valider') ? `<button class="btn sm" data-action="stk-seuils" data-id="${l.articleId}" data-min="${l.min}" data-max="${l.max}">Seuils</button>` : ''}</td></tr>`).join('') || vide(13, SK.articles.length ? 'Aucun stock.' : 'Aucun article : créez d\'abord vos articles (menu Articles et catégories).')}</tbody>
    </table></div></div>`;
  },
};

/* ------------------------------------------------------------ Réception */
ACTIONS['stk-reception'] = async () => {
  if (!agenceSaisie()) return;
  await chargerStock();
  if (!SK.articles.some((a) => a.actif !== false)) { toast("Aucun article : créez d'abord vos articles (menu Articles et catégories).", 'err'); return; }
  ouvrirModale(`Réception de marchandises – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date de réception<input type="date" name="date" value="${today()}" required></label>
    <label>Article<select name="articleId" required>${optArticles()}</select></label>
    <label>Quantité reçue (poids net)<input type="number" name="quantite" min="0" step="any" required></label>
    <label>Prix d'achat unitaire (${esc(S.params.devise)})<input type="number" name="prixUnitaire" min="0" step="any" value="0" required></label>
    <label>Frais accessoires (total : transport, collecte, douane…)<input type="number" name="fraisAccessoires" min="0" step="any" value="0"></label>
    <label>Coût unitaire de revient<input id="cout" readonly></label>
    <label>Date de péremption (DLC / DLUO)<input type="date" name="datePeremption"><span class="help" id="per-help">Vide : calculée selon la durée de vie de l'article.</span></label>
    <label>N° de lot (facultatif)<input name="numeroLot" placeholder="Généré automatiquement"></label>
    <label>Fournisseur / coopérative<input name="fournisseur" list="dl-fourn"></label>
    <label>Origine (producteur, parcelle, pays)<input name="origine"></label>
    <label>Campagne agricole<input name="campagne" placeholder="ex. 2026A"></label>
    <label>Bon de livraison / pièce<input name="document"></label>
    <label>Humidité (%)<input type="number" name="humidite" step="any" min="0" max="100"></label>
    <label>Impuretés (%)<input type="number" name="impuretes" step="any" min="0" max="100"></label>
    <label class="full">Observations qualité<input name="observationsQualite"></label>
    <label>Statut à l'entrée<select name="statut"><option value="disponible">Disponible</option><option value="quarantaine">Quarantaine (en attente d'analyse)</option></select></label>
  </div><datalist id="dl-fourn">${S.fournisseurs.map((f) => `<option value="${esc(f.nom)}">`).join('')}</datalist>${piedForm('Enregistrer et imprimer le bon')}</form>`, (b) => {
    const maj = () => {
      const q = Number($('[name=quantite]', b).value) || 0; const p = Number($('[name=prixUnitaire]', b).value) || 0; const f = Number($('[name=fraisAccessoires]', b).value) || 0;
      $('#cout', b).value = q ? `${nb(p + f / q)} ${S.params.devise}` : '';
      const a = SK.articles.find((x) => x._id === $('[name=articleId]', b).value);
      $('#per-help', b).textContent = a && a.dureeVieJours ? `Vide : réception + ${a.dureeVieJours} jours (durée de vie de l'article).` : "Vide : pas de date de péremption pour ce lot.";
    };
    $('#f', b).addEventListener('input', maj); $('#f', b).addEventListener('change', maj); maj();
    lierFormulaire($('#f', b), async (d) => {
      const r = await api('POST', '/api/stock/receptions', d);
      fermerModale(); toast(`Réception enregistrée : lot ${r.lot.numero}.`, 'ok'); afficherPage(); docMouvementStock({ ...r.mouvement, agence: nomAgenceVue() });
    });
  });
};

/* --------------------------------------------------------------- Sortie */
ACTIONS['stk-sortie'] = async () => {
  if (!agenceSaisie()) return;
  await chargerStock();
  ouvrirModale(`Sortie de stock – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Nature<select name="nature">${Object.entries(SK.ref.natures).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
    <label>Article<select name="articleId" required>${optArticles()}</select></label>
    <label>Quantité<input type="number" name="quantite" min="0" step="any" required></label>
    <label class="full">Lot<select name="lotId"><option value="">Automatique : lots les plus proches de la péremption d'abord (FEFO)</option></select><span class="help" id="dispo-help"></span></label>
    <label class="full" id="hors-fefo" hidden>Motif du choix d'un autre lot que celui qui périme le plus tôt<input name="motifHorsFefo"></label>
    <label>Client / destinataire<input name="tiers"></label>
    <label>Bon de livraison / facture<input name="document"></label>
    <label>Prix de vente unitaire (facultatif)<input type="number" name="prixVente" min="0" step="any"></label>
    <label class="full">Libellé<input name="libelle" placeholder="Facultatif"></label>
  </div>${piedForm('Enregistrer et imprimer le bon')}</form>`, (b) => {
    let lots = [];
    const chargerLots = async () => {
      lots = await api('GET', `/api/stock/lots?${qs({ articleId: $('[name=articleId]', b).value, statut: 'disponible' })}`);
      const a = SK.articles.find((x) => x._id === $('[name=articleId]', b).value) || {};
      $('[name=lotId]', b).innerHTML = '<option value="">Automatique : lots les plus proches de la péremption d\'abord (FEFO)</option>'
        + lots.map((l) => `<option value="${l._id}">${esc(l.numero)} – ${nq(l.quantite)} ${esc(l.unite)} – péremption ${l.datePeremption ? fd(l.datePeremption) : 'aucune'}</option>`).join('');
      $('#dispo-help', b).textContent = `Disponible : ${nq(lots.reduce((s, l) => s + l.quantite, 0))} ${a.unite || ''} en ${lots.length} lot(s).`;
      $('#hors-fefo', b).hidden = true;
    };
    $('[name=articleId]', b).addEventListener('change', chargerLots);
    $('[name=lotId]', b).addEventListener('change', (e) => { $('#hors-fefo', b).hidden = !e.target.value || (lots[0] && lots[0]._id === e.target.value); });
    chargerLots();
    lierFormulaire($('#f', b), async (d) => {
      const m = await api('POST', '/api/stock/sorties', d);
      fermerModale(); toast(`Sortie ${m.numero} enregistrée.`, 'ok'); afficherPage(); docMouvementStock({ ...m, agence: nomAgenceVue() });
    });
  });
};

/* -------------------------------------------------------------- Seuils */
ACTIONS['stk-seuils'] = (ds) => {
  const a = SK.articles.find((x) => x._id === ds.id) || {};
  ouvrirModale(`Seuils de ${a.designation} – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Stock minimum (${esc(a.unite)})<input type="number" name="min" min="0" step="any" value="${ds.min}"></label>
    <label>Stock maximum (${esc(a.unite)})<input type="number" name="max" min="0" step="any" value="${ds.max}"></label>
  </div><p class="muted" style="font-size:12.5px">Sous le minimum, l'article passe en « rupture ». La proposition de commande ramène le stock au maximum.</p>${piedForm()}</form>`,
  (b) => lierFormulaire($('#f', b), async (d) => { await api('PUT', `/api/stock/articles/${ds.id}/seuils`, d); fermerModale(); toast('Seuils enregistrés.', 'ok'); afficherPage(); }));
};

/* ---------------------------------------------------------- Transfert */
ACTIONS['stk-transfert'] = async () => {
  if (!agenceSaisie()) return;
  await chargerStock();
  const dest = autresAgences();
  if (!dest.length) { toast('Aucune autre agence active : créez d\'abord les agences (menu Agences).', 'err'); return; }
  const ligne = () => `<div class="form-grid tr-ligne" style="margin-bottom:6px"><label>Article<select name="a">${optArticles()}</select></label><label>Quantité<input type="number" name="q" min="0" step="any"></label></div>`;
  ouvrirModale(`Transfert de stock depuis ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date d'expédition<input type="date" name="date" value="${today()}" required></label>
    <label>Agence destinataire<select name="destinationId" required>${dest.map((g) => `<option value="${g._id}">${esc(g.nom)}</option>`).join('')}</select></label>
    <label>Transporteur / véhicule<input name="transporteur"></label>
    <label>Observations<input name="observations"></label>
  </div>
  <div class="doc-h" style="margin:14px 0 6px;font-weight:600">Articles à transférer (lots choisis automatiquement : FEFO)</div>
  <div id="lignes">${ligne()}</div><button type="button" class="btn sm" id="plus">+ Ajouter un article</button>
  <p class="muted" style="font-size:12.5px">Le stock quitte votre agence dès l'expédition (statut « en transit ») et entre dans l'agence destinataire quand elle confirme la réception.</p>
  ${piedForm('Expédier et imprimer le bon de transfert')}</form>`, (b) => {
    $('#plus', b).addEventListener('click', () => $('#lignes', b).insertAdjacentHTML('beforeend', ligne()));
    lierFormulaire($('#f', b), async (d) => {
      d.lignes = $$('.tr-ligne', b).map((x) => ({ articleId: $('[name=a]', x).value, quantite: Number($('[name=q]', x).value) || 0 })).filter((l) => l.quantite > 0);
      const t = await api('POST', '/api/stock/transferts', d);
      fermerModale(); toast(`Transfert ${t.numero} expédié vers ${t.destinationNom}.`, 'ok'); afficherPage(); docTransfert(t);
    });
  });
};

/* -------------------------------------------------------------- Perte */
ACTIONS['stk-perte'] = async () => {
  if (!agenceSaisie()) return;
  await chargerStock();
  ouvrirModale(`Déclaration de perte – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date du constat<input type="date" name="date" value="${today()}" required></label>
    <label>Motif<select name="motif" required>${Object.entries(SK.ref.motifs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
    <label>Article<select name="articleId" required>${optArticles()}</select></label>
    <label>Quantité perdue<input type="number" name="quantite" min="0" step="any" required></label>
    <label class="full">Lot concerné<select name="lotId"><option value="">Non précisé (lots les plus proches de la péremption)</option></select></label>
    <label class="full">Pièce justificative (PV de constat, déclaration de vol…)<input name="justificatif" required></label>
    <label class="full">Observations<textarea name="observations"></textarea></label>
  </div><p class="muted" style="font-size:12.5px">${peut('stock.valider') ? 'Vous avez le droit de valider : la perte est appliquée immédiatement.' : 'La perte sera appliquée au stock après validation par un responsable (sa valeur lui est affichée).'}</p>${piedForm('Déclarer la perte')}</form>`, (b) => {
    const chargerLots = async () => {
      const lots = await api('GET', `/api/stock/lots?${qs({ articleId: $('[name=articleId]', b).value, statut: 'en_stock' })}`);
      $('[name=lotId]', b).innerHTML = '<option value="">Non précisé (lots les plus proches de la péremption)</option>'
        + lots.map((l) => `<option value="${l._id}">${esc(l.numero)} – ${nq(l.quantite)} ${esc(l.unite)} – ${esc(SK.ref.statuts[l.statut])}</option>`).join('');
    };
    $('[name=articleId]', b).addEventListener('change', chargerLots); chargerLots();
    lierFormulaire($('#f', b), async (d) => {
      const p = await api('POST', '/api/stock/pertes', d);
      fermerModale(); toast(p.statut === 'validee' ? `Perte ${p.numero} appliquée (valeur ${nb(p.valeur)}).` : `Perte ${p.numero} déclarée (valeur ${nb(p.valeur)}) : en attente de validation.`, 'ok'); afficherPage();
    });
  });
};

/* =============================================================== Lots */
PAGES.lots = {
  perm: 'stock.voir',
  async render() {
    await chargerStock();
    const f = S.filtres;
    const lots = await api('GET', `/api/stock/lots?${qs({ statut: f.lotStatut || 'en_stock', categorieId: f.lotCat, articleId: f.lotArt })}`);
    const tot = lots.reduce((s, l) => s + (['disponible', 'quarantaine', 'bloque'].includes(l.statut) ? l.valeur : 0), 0);
    return `${tete('Lots et péremptions', `${esc(nomAgenceVue())} · traçabilité par lot, du fournisseur au client`,
      '<span class="actions"><button class="btn primary" data-perm="stock.saisir" data-action="stk-reception">+ Réception</button></span>')}
    <div class="filters">
      <label>Statut<select data-f="lotStatut">${[['en_stock', 'En stock (disponible, quarantaine, bloqué)'], ['disponible', 'Disponibles'], ['quarantaine', 'Quarantaine'], ['bloque', 'Bloqués'], ['perime', 'Périmés'], ['epuise', 'Épuisés'], ['sorti', 'Périmés sortis'], ['tous', 'Tous']].map(([k, v]) => `<option value="${k}" ${(f.lotStatut || 'en_stock') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Catégorie<select data-f="lotCat">${optCategories(f.lotCat, true)}</select></label>
      <label>Article<select data-f="lotArt"><option value="">Tous</option>${optArticles(f.lotArt, false)}</select></label>
      <span class="periode-lbl">${lots.length} lot(s) · valeur en stock ${money(tot)}</span>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Lot</th>${thAgence()}<th>Article</th><th>Réception</th><th>Péremption</th><th class="num">Quantité</th><th class="num">Coût unit.</th><th class="num">Valeur</th><th>Fournisseur · campagne</th><th>Qualité</th><th>Statut</th><th></th></tr></thead>
      <tbody>${lots.map((l) => `<tr><td class="nowrap"><b>${esc(l.numero)}</b>${l.provenance ? `<br><small class="muted">transféré de ${esc(l.provenance)}</small>` : ''}</td>${colAgence(l)}
        <td>${esc(l.designation)}<br><small class="muted">${esc(nomCat(l.categorieId))}</small></td><td class="nowrap">${fd(l.dateReception)}</td>
        <td class="nowrap">${['disponible', 'quarantaine', 'bloque'].includes(l.statut) ? badgePeremption(l.datePeremption) : fd(l.datePeremption)}</td>
        <td class="num">${nq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.coutUnitaire)}</td><td class="num">${nb(l.valeur)}</td>
        <td>${esc(l.fournisseur || '')}${l.campagne ? `<br><small class="muted">Campagne ${esc(l.campagne)}</small>` : ''}</td>
        <td class="nowrap"><small>${l.qualite && l.qualite.humidite != null ? `H ${nq(l.qualite.humidite)} %` : ''}${l.qualite && l.qualite.impuretes != null ? `<br>Imp. ${nq(l.qualite.impuretes)} %` : ''}</small></td>
        <td>${badgeStatut(l.statut)}</td>
        <td class="nowrap"><button class="btn sm" data-action="stk-fiche" data-id="${l._id}">Fiche</button>
          ${peut('stock.valider') && ['disponible', 'quarantaine', 'bloque'].includes(l.statut) ? ` <button class="btn sm" data-action="stk-statut" data-id="${l._id}" data-num="${esc(l.numero)}" data-st="${l.statut}">Statut</button>` : ''}
          ${peut('stock.valider') && l.statut === 'perime' && l.quantite > 0 ? ` <button class="btn sm danger" data-action="stk-sortir-perime" data-id="${l._id}" data-num="${esc(l.numero)}" data-val="${l.valeur}">Sortir</button>` : ''}</td></tr>`).join('') || vide(12, 'Aucun lot.')}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierFiltres(root); },
};
ACTIONS['stk-fiche'] = async (ds) => docFicheLot(await api('GET', `/api/stock/lots/${ds.id}`));
ACTIONS['stk-statut'] = (ds) => {
  ouvrirModale(`Statut du lot ${ds.num}`, `<form id="f"><div class="form-grid">
    <label>Nouveau statut<select name="statut">${['disponible', 'quarantaine', 'bloque'].filter((x) => x !== ds.st).map((x) => `<option value="${x}">${esc(SK.ref.statuts[x])}</option>`).join('')}</select></label>
    <label class="full">Motif (analyse, contrôle qualité, traitement, fumigation…)<input name="motif" required></label>
  </div><p class="muted" style="font-size:12.5px">Un lot bloqué ou en quarantaine n'est plus servi en sortie ni en transfert.</p>${piedForm()}</form>`,
  (b) => lierFormulaire($('#f', b), async (d) => { await api('POST', `/api/stock/lots/${ds.id}/statut`, d); fermerModale(); toast('Statut modifié.', 'ok'); afficherPage(); }));
};
ACTIONS['stk-sortir-perime'] = (ds) => {
  ouvrirModale(`Sortir le lot périmé ${ds.num}`, `<form id="f"><p style="margin-top:0">Valeur comptable du lot : <b>${money(ds.val)}</b>. La perte a déjà été constatée le jour de la péremption ; cette sortie la rend « réalisée » et enregistre l'éventuelle valeur récupérée.</p><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Mode de sortie<select name="mode">${Object.entries(SK.ref.modes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
    <label>Valeur de récupération (${esc(S.params.devise)})<input type="number" name="recuperation" min="0" step="any" value="0"></label>
    <label>Pièce (PV de destruction, reçu…)<input name="document"></label>
  </div>${piedForm('Sortir le lot')}</form>`,
  (b) => lierFormulaire($('#f', b), async (d) => { const m = await api('POST', `/api/stock/lots/${ds.id}/sortie-perime`, d); fermerModale(); toast(`Lot sorti (${m.numero}).`, 'ok'); afficherPage(); }));
};

/* =================================================== Mouvements de stock */
PAGES['mouvements-stock'] = {
  perm: 'stock.voir',
  async render() {
    await chargerStock();
    const f = S.filtres;
    const ms = await api('GET', `/api/stock/mouvements?${qs({ ...per(), type: f.mvtType, articleId: f.mvtArt })}`);
    return `${tete('Mouvements de stock', `${esc(nomAgenceVue())} · chaque mouvement est valorisé et tracé`,
      '<span class="actions"><button class="btn primary" data-perm="stock.saisir" data-action="stk-reception">+ Réception</button><button class="btn" data-perm="stock.saisir" data-action="stk-sortie">Sortie</button></span>')}
    ${barrePeriode(`<label>Type<select data-f="mvtType"><option value="">Tous</option>${Object.entries(TYPES_MVT).map(([k, [v]]) => `<option value="${k}" ${f.mvtType === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Article<select data-f="mvtArt"><option value="">Tous</option>${optArticles(f.mvtArt, false)}</select></label>`)}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Date</th><th>N°</th>${thAgence()}<th>Type</th><th>Libellé</th><th>Articles et lots</th><th class="num">Valeur</th><th>Saisi par</th><th></th></tr></thead>
      <tbody>${ms.map((m) => `<tr><td class="nowrap">${fd(m.date)}</td><td class="nowrap">${esc(m.numero)}</td>${colAgence(m)}
        <td class="keep"><span class="badge ${(TYPES_MVT[m.type] || [])[1] || ''}">${(TYPES_MVT[m.type] || [m.type])[0]}</span>${m.horsFefo ? ' <span class="badge warn" title="' + esc(m.horsFefo.motif) + '">hors FEFO</span>' : ''}</td>
        <td>${esc(m.libelle)}${m.tiers ? `<br><small class="muted">${esc(m.tiers)}</small>` : ''}</td>
        <td><small>${m.lignes.map((l) => `${esc(l.designation)} · ${esc(l.lotNumero)} : <b>${l.quantite > 0 ? '+' : ''}${nq(l.quantite)}</b> ${esc(l.unite)}`).join('<br>')}</small></td>
        <td class="num ${m.valeur < 0 ? 'neg' : 'pos'}">${nb(m.valeur)}</td><td><small>${esc(m.nomCreateur || '')}</small></td>
        <td><button class="btn sm" data-action="stk-voir-mvt" data-id="${m._id}">Bon</button></td></tr>`).join('') || vide(9)}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); lierFiltres(root); },
};
ACTIONS['stk-voir-mvt'] = async (ds) => docMouvementStock(await api('GET', `/api/stock/mouvements/${ds.id}`));

/* ================================================= Transferts */
PAGES.transferts = {
  perm: 'stock.voir',
  async render() {
    const ts = await api('GET', '/api/stock/transferts');
    const moi = S.me.agenceId || S.agence;
    const st = { en_transit: ['En transit', 'warn'], recu: ['Reçu', 'in'], annule: ['Annulé', ''] };
    return `${tete('Transferts entre agences', `${esc(nomAgenceVue())} · envois et réceptions`, '<span class="actions"><button class="btn primary" data-perm="stock.transferer" data-action="stk-transfert">+ Nouveau transfert</button></span>')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>N°</th><th>Expédié le</th><th>De</th><th>Vers</th><th>Articles</th><th class="num">Valeur</th><th>Statut</th><th></th></tr></thead>
      <tbody>${ts.map((t) => `<tr><td class="nowrap"><b>${esc(t.numero)}</b></td><td>${fd(t.date)}</td>
        <td>${esc(t.agenceNom)}${moi === t.agenceId ? ' <span class="badge int">vous</span>' : ''}</td><td>${esc(t.destinationNom)}${moi === t.destinationId ? ' <span class="badge int">vous</span>' : ''}</td>
        <td><small>${t.lignes.map((l) => `${esc(l.designation)} (${esc(l.lotNumero)}) : ${nq(l.quantite)} ${esc(l.unite)}`).join('<br>')}</small></td>
        <td class="num">${nb(t.valeur)}</td>
        <td><span class="badge ${st[t.statut][1]}">${st[t.statut][0]}</span>${t.dateReception ? `<br><small class="muted">reçu le ${fd(t.dateReception)}</small>` : ''}</td>
        <td class="nowrap"><button class="btn sm" data-action="stk-voir-tr" data-id="${t._id}">Bon</button>
          ${t.statut === 'en_transit' && peut('stock.transferer') && (!moi || moi === t.destinationId) ? ` <button class="btn sm primary" data-action="stk-recevoir" data-id="${t._id}" data-num="${esc(t.numero)}">Réceptionner</button>` : ''}
          ${t.statut === 'en_transit' && peut('stock.transferer') && (!moi || moi === t.agenceId) ? ` <button class="btn sm danger" data-action="stk-annuler-tr" data-id="${t._id}" data-num="${esc(t.numero)}">Annuler</button>` : ''}</td></tr>`).join('') || vide(8, 'Aucun transfert.')}</tbody>
    </table></div></div>`;
  },
};
ACTIONS['stk-voir-tr'] = async (ds) => docTransfert(await api('GET', `/api/stock/transferts/${ds.id}`));
ACTIONS['stk-recevoir'] = (ds) => ouvrirModale(`Réceptionner le transfert ${ds.num}`, `<form id="f"><div class="form-grid"><label>Date de réception<input type="date" name="date" value="${today()}" required></label></div>
  <p class="muted" style="font-size:12.5px">Les lots entrent dans le stock de l'agence destinataire avec leur numéro, leur coût et leur date de péremption d'origine.</p>${piedForm('Confirmer la réception')}</form>`,
(b) => lierFormulaire($('#f', b), async (d) => { await api('POST', `/api/stock/transferts/${ds.id}/recevoir`, d); fermerModale(); toast('Transfert réceptionné.', 'ok'); afficherPage(); }));
ACTIONS['stk-annuler-tr'] = (ds) => demanderMotif(`Annuler le transfert ${ds.num}`, 'Les quantités retournent dans les lots d\'origine de votre agence.', `/api/stock/transferts/${ds.id}/annuler`);

/* =============================================================== Pertes */
PAGES.pertes = {
  perm: 'stock.voir,stock.pertes',
  async render() {
    await chargerStock();
    const { declarations, peremptions } = await api('GET', '/api/stock/pertes');
    const attente = declarations.filter((p) => p.statut === 'proposee');
    const st = { proposee: ['À valider', 'warn'], validee: ['Validée', 'in'], rejetee: ['Rejetée', 'out'] };
    const ligneDecl = (p) => `<tr><td class="nowrap">${esc(p.numero)}</td><td>${fd(p.date)}</td>${colAgence(p)}<td>${esc(p.designation)}<br><small class="muted">${esc(p.lots || '')}</small></td>
      <td>${esc(p.motifLibelle)}</td><td class="num">${nq(p.quantite)} ${esc(p.unite)}</td><td class="num"><b>${nb(p.valeur)}</b></td><td>${esc(p.justificatif)}<br><small class="muted">${esc(p.nomPropose || '')}</small></td>
      <td><span class="badge ${st[p.statut][1]}">${st[p.statut][0]}</span>${p.motifRejet ? `<br><small>${esc(p.motifRejet)}</small>` : ''}</td>
      <td class="nowrap">${p.statut === 'proposee' && peut('stock.valider') ? `<button class="btn sm primary" data-action="stk-perte-ok" data-id="${p._id}" data-num="${esc(p.numero)}" data-val="${p.valeur}">Valider</button> <button class="btn sm danger" data-action="stk-perte-non" data-id="${p._id}" data-num="${esc(p.numero)}">Rejeter</button>` : ''}</td></tr>`;
    return `${tete('Pertes et produits périmés', `${esc(nomAgenceVue())} · sorties exceptionnelles soumises à validation, pertes sur péremption valorisées chaque jour`,
      '<span class="actions"><button class="btn primary" data-perm="stock.pertes" data-action="stk-perte">Déclarer une perte</button></span>')}
    ${attente.length ? `<div class="card" style="border-color:#f0a43a"><div class="card-head"><h2>À valider (${attente.length})</h2></div><div class="table-wrap"><table class="data">
      <thead><tr><th>N°</th><th>Date</th>${thAgence()}<th>Article</th><th>Motif</th><th class="num">Quantité</th><th class="num">Valeur</th><th>Justificatif</th><th>Statut</th><th></th></tr></thead>
      <tbody>${attente.map(ligneDecl).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><div class="card-head"><h2>Lots périmés (détectés automatiquement)</h2></div><div class="table-wrap"><table class="data">
      <thead><tr><th>Périmé le</th>${thAgence()}<th>Lot</th><th>Article</th><th class="num">Quantité</th><th class="num">Valeur brute</th><th class="num">Récupération</th><th class="num">Perte nette</th><th>Situation</th></tr></thead>
      <tbody>${peremptions.map((p) => `<tr><td class="nowrap">${fd(p.date)}</td>${colAgence(p)}<td class="nowrap">${esc(p.lotNumero)}</td><td>${esc(p.designation)}<br><small class="muted">${esc(nomCat(p.categorieId))}</small></td>
        <td class="num">${nq(p.quantite)} ${esc(p.unite)}</td><td class="num">${nb(p.valeurBrute)}</td><td class="num">${p.recuperation ? nb(p.recuperation) : ''}</td><td class="num neg">${nb(p.perteNette)}</td>
        <td>${p.realisee ? `<span class="badge">Sorti (${esc(SK.ref.modes[p.mode] || '')})</span>` : `<span class="badge out">Encore en stock</span>${peut('stock.valider') ? ` <button class="btn sm danger" data-action="stk-sortir-perime" data-id="${p.lotId}" data-num="${esc(p.lotNumero)}" data-val="${p.valeurBrute}">Sortir</button>` : ''}`}</td></tr>`).join('') || vide(9, 'Aucun lot périmé.')}</tbody>
    </table></div></div>
    <div class="card"><div class="card-head"><h2>Historique des déclarations</h2></div><div class="table-wrap"><table class="data">
      <thead><tr><th>N°</th><th>Date</th>${thAgence()}<th>Article</th><th>Motif</th><th class="num">Quantité</th><th class="num">Valeur</th><th>Justificatif</th><th>Statut</th><th></th></tr></thead>
      <tbody>${declarations.filter((p) => p.statut !== 'proposee').map(ligneDecl).join('') || vide(10, 'Aucune déclaration traitée.')}</tbody></table></div></div>`;
  },
};
ACTIONS['stk-perte-ok'] = async (ds) => {
  if (!window.confirm(`Valider la perte ${ds.num} d'une valeur de ${money(ds.val)} ?\n\nLe stock sera diminué en conséquence.`)) return;
  try { await api('POST', `/api/stock/pertes/${ds.id}/decision`, { decision: 'valider' }); toast('Perte validée et appliquée au stock.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  afficherPage();
};
ACTIONS['stk-perte-non'] = (ds) => ouvrirModale(`Rejeter la perte ${ds.num}`, `<form id="f"><div class="form-grid"><label class="full">Motif du rejet<textarea name="motif" required></textarea></label></div>${piedForm('Rejeter')}</form>`,
  (b) => lierFormulaire($('#f', b), async (d) => { await api('POST', `/api/stock/pertes/${ds.id}/decision`, { decision: 'rejeter', motif: d.motif }); fermerModale(); toast('Déclaration rejetée.', 'ok'); afficherPage(); }));

/* =========================================================== Inventaires */
PAGES.inventaires = {
  perm: 'stock.voir,stock.inventaire',
  async render() {
    await chargerStock();
    const invs = await api('GET', '/api/stock/inventaires');
    const st = { en_cours: ['En cours', 'warn'], valide: ['Validé', 'in'], abandonne: ['Abandonné', ''] };
    return `${tete('Inventaires', `${esc(nomAgenceVue())} · comptage (à l'aveugle possible), écarts valorisés, ajustement validé par un responsable`,
      '<span class="actions"><button class="btn primary" data-perm="stock.inventaire" data-action="stk-inv-nouveau">+ Nouvel inventaire</button></span>')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>N°</th><th>Date</th><th>Périmètre</th><th class="num">Lots</th><th class="num">Exactitude</th><th class="num">Écart net</th><th>Statut</th><th></th></tr></thead>
      <tbody>${invs.map((i) => `<tr><td class="nowrap"><b>${esc(i.numero)}</b></td><td>${fd(i.date)}</td><td>${i.categorieId ? esc(nomCat(i.categorieId)) : 'Tout le stock'}${i.aveugle ? ' <span class="badge int">à l\'aveugle</span>' : ''}</td>
        <td class="num">${i.lignes.length}</td><td class="num">${i.synthese ? `${nb(i.synthese.exactitude)} %` : `${i.lignes.filter((l) => l.compte != null).length} compté(s)`}</td>
        <td class="num">${i.synthese ? nb(i.synthese.ecartPositif + i.synthese.ecartNegatif) : ''}</td>
        <td><span class="badge ${st[i.statut][1]}">${st[i.statut][0]}</span></td>
        <td class="nowrap">${i.statut === 'en_cours' ? `<button class="btn sm primary" data-action="stk-inv-compter" data-id="${i._id}">Saisir les comptages</button>` : `<button class="btn sm" data-action="stk-inv-pv" data-id="${i._id}">PV d'inventaire</button>`}</td></tr>`).join('') || vide(8, 'Aucun inventaire.')}</tbody>
    </table></div></div>`;
  },
};
ACTIONS['stk-inv-nouveau'] = async () => {
  if (!agenceSaisie()) return;
  await chargerStock();
  ouvrirModale(`Nouvel inventaire – ${nomAgenceVue()}`, `<form id="f"><div class="form-grid">
    <label>Date de l'inventaire<input type="date" name="date" value="${today()}" required></label>
    <label>Périmètre<select name="categorieId"><option value="">Tout le stock</option>${optCategories('')}</select></label>
    <label class="full check"><input type="checkbox" name="aveugle" checked> Comptage à l'aveugle : les quantités théoriques sont masquées aux compteurs</label>
    <label class="full">Observations<input name="observations"></label>
  </div>${piedForm("Ouvrir l'inventaire")}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    d.aveugle = !!$('[name=aveugle]', b).checked;
    const inv = await api('POST', '/api/stock/inventaires', d);
    fermerModale(); afficherPage(); ACTIONS['stk-inv-compter']({ id: inv._id });
  }));
};
ACTIONS['stk-inv-compter'] = async (ds) => {
  const inv = await api('GET', `/api/stock/inventaires/${ds.id}`);
  const montrer = inv.lignes.some((l) => l.theorique !== undefined);
  ouvrirModale(`Inventaire ${inv.numero} du ${fd(inv.date)}`, `<form id="f">
    <p style="margin-top:0" class="muted">${inv.aveugle && !montrer ? 'Comptage à l\'aveugle : saisissez les quantités physiquement comptées.' : 'Saisissez les quantités physiquement comptées. Les écarts sont calculés à la validation.'}</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Article</th><th>Lot</th><th>Péremption</th>${montrer ? '<th class="num">Théorique</th>' : ''}<th class="num">Compté</th></tr></thead>
    <tbody>${inv.lignes.map((l) => `<tr><td>${esc(l.designation)}</td><td class="nowrap">${esc(l.lotNumero)}${l.statutLot === 'perime' ? ' <span class="badge out">périmé</span>' : ''}</td><td>${fd(l.datePeremption)}</td>${montrer ? `<td class="num">${nq(l.theorique)} ${esc(l.unite)}</td>` : ''}
      <td class="num"><input class="compte-input" type="number" min="0" step="any" data-lot="${l.lotId}" value="${l.compte == null ? '' : l.compte}"> ${esc(l.unite)}</td></tr>`).join('')}</tbody></table></div>
    <p class="form-error" hidden></p>
    <div class="form-foot"><button type="button" class="btn" data-action="close-modal">Fermer</button>
      <span data-perm="stock.valider"><button type="button" class="btn danger" id="inv-abandon">Abandonner</button></span>
      <button type="submit" class="btn">Enregistrer les comptages</button>
      <span data-perm="stock.valider"><button type="button" class="btn primary" id="inv-valider">Valider l'inventaire</button></span></div></form>`, (b) => {
    const comptes = () => Object.fromEntries($$('[data-lot]', b).map((x) => [x.dataset.lot, x.value]));
    const err = (e) => { const p = $('.form-error', b); p.textContent = e.message; p.hidden = false; };
    lierFormulaire($('#f', b), async () => { const r = await api('PUT', `/api/stock/inventaires/${inv._id}/comptages`, { comptes: comptes() }); toast(`Comptages enregistrés (${r.comptes}/${r.total}).`, 'ok'); afficherPage(); });
    const v = $('#inv-valider', b);
    if (v) v.addEventListener('click', async () => {
      try {
        await api('PUT', `/api/stock/inventaires/${inv._id}/comptages`, { comptes: comptes() });
        if (!window.confirm('Valider l\'inventaire ? Les écarts seront appliqués au stock (ajustement valorisé) et l\'inventaire sera clos.')) return;
        await api('POST', `/api/stock/inventaires/${inv._id}/valider`);
        fermerModale(); toast('Inventaire validé : stock ajusté.', 'ok'); afficherPage();
        docInventaire(await api('GET', `/api/stock/inventaires/${inv._id}`));
      } catch (e) { err(e); }
    });
    const a = $('#inv-abandon', b);
    if (a) a.addEventListener('click', async () => {
      if (!window.confirm('Abandonner cet inventaire ? Aucun ajustement ne sera fait.')) return;
      try { await api('POST', `/api/stock/inventaires/${inv._id}/abandonner`); fermerModale(); afficherPage(); } catch (e) { err(e); }
    });
  });
};
ACTIONS['stk-inv-pv'] = async (ds) => docInventaire(await api('GET', `/api/stock/inventaires/${ds.id}`));

/* ================================================ Articles et catégories */
PAGES.articles = {
  perm: 'stock.voir,stock.articles',
  async render() {
    await chargerStock();
    const g = peut('stock.articles') && !S.me.agenceId;
    return `${tete('Articles et catégories', 'Référentiel commun à toutes les agences (seuils minimum et maximum ajustables par agence)',
      g ? '<span class="actions"><button class="btn primary" data-action="stk-article">+ Nouvel article</button><button class="btn" data-action="stk-categorie">+ Catégorie</button></span>' : '')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Code</th><th>Désignation</th><th>Catégorie</th><th>Unité</th><th class="num">Durée de vie</th><th class="num">Alerte</th><th class="num">Min / Max</th><th class="num">Délai appro.</th><th>Statut</th><th></th></tr></thead>
      <tbody>${SK.articles.map((a) => `<tr class="${a.actif === false ? 'muted' : ''}"><td class="nowrap"><b>${esc(a.code)}</b></td><td>${esc(a.designation)}${a.variete ? `<br><small class="muted">${esc(a.variete)}</small>` : ''}${a.conditions ? `<br><small class="muted">${esc(a.conditions)}</small>` : ''}</td>
        <td>${esc(nomCat(a.categorieId))}</td><td>${esc(a.unite)}</td><td class="num">${a.dureeVieJours ? `${a.dureeVieJours} j` : '—'}</td><td class="num">${a.alerteJours} j</td>
        <td class="num">${nq(a.stockMin)} / ${nq(a.stockMax)}</td><td class="num">${a.delaiAppro} j</td><td>${a.actif === false ? '<span class="badge">Inactif</span>' : '<span class="badge in">Actif</span>'}</td>
        <td>${g ? `<button class="btn sm" data-action="stk-article" data-id="${a._id}">Modifier</button>` : ''}</td></tr>`).join('') || vide(10, 'Aucun article.')}</tbody>
    </table></div></div>
    <div class="card"><div class="card-head"><h2>Catégories</h2></div><div class="table-wrap"><table class="data"><thead><tr><th>Catégorie</th><th class="num">Articles</th><th></th></tr></thead>
      <tbody>${SK.categories.map((c) => `<tr><td>${esc(c.nom)}</td><td class="num">${SK.articles.filter((a) => a.categorieId === c._id).length}</td><td>${g ? `<button class="btn sm" data-action="stk-categorie" data-id="${c._id}">Renommer</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  },
};
ACTIONS['stk-article'] = (ds) => {
  const a = SK.articles.find((x) => x._id === ds.id) || { alerteJours: 30, delaiAppro: 7, unite: 'kg' };
  ouvrirModale(ds.id ? `Article ${a.code}` : 'Nouvel article', `<form id="f"><div class="form-grid">
    <label>Code<input name="code" value="${esc(a.code)}" required maxlength="30" style="text-transform:uppercase"></label>
    <label>Désignation<input name="designation" value="${esc(a.designation)}" required></label>
    <label>Catégorie<select name="categorieId" required>${optCategories(a.categorieId)}</select></label>
    <label>Unité de stock<input name="unite" value="${esc(a.unite)}" list="dl-unites" required></label>
    <label>Variété / calibre<input name="variete" value="${esc(a.variete)}"></label>
    <label>GTIN (code-barres)<input name="gtin" value="${esc(a.gtin)}"></label>
    <label>Durée de vie (jours, 0 = sans péremption)<input type="number" name="dureeVieJours" min="0" value="${a.dureeVieJours || 0}"></label>
    <label>Alerte avant péremption (jours)<input type="number" name="alerteJours" min="0" value="${a.alerteJours}"></label>
    <label>Stock minimum<input type="number" name="stockMin" min="0" step="any" value="${a.stockMin || 0}"></label>
    <label>Stock maximum<input type="number" name="stockMax" min="0" step="any" value="${a.stockMax || 0}"></label>
    <label>Délai d'approvisionnement (jours)<input type="number" name="delaiAppro" min="0" value="${a.delaiAppro}"></label>
    <label>Conditions de stockage<input name="conditions" value="${esc(a.conditions)}" placeholder="ex. sec, < 14 % d'humidité, à l'abri des ravageurs"></label>
    ${ds.id ? `<label>Statut<select name="actif"><option value="1">Actif</option><option value="0" ${a.actif === false ? 'selected' : ''}>Inactif</option></select></label>` : ''}
  </div><datalist id="dl-unites">${UNITES.map((u) => `<option value="${u}">`).join('')}</datalist>${piedForm()}</form>`,
  (b) => lierFormulaire($('#f', b), async (d) => {
    if (d.actif !== undefined) d.actif = d.actif === '1';
    await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/stock/articles/${ds.id}` : '/api/stock/articles', d);
    fermerModale(); toast('Article enregistré.', 'ok'); afficherPage();
  }));
};
ACTIONS['stk-categorie'] = (ds) => {
  const c = SK.categories.find((x) => x._id === ds.id) || {};
  ouvrirModale(ds.id ? 'Renommer la catégorie' : 'Nouvelle catégorie', `<form id="f"><div class="form-grid"><label class="full">Nom<input name="nom" value="${esc(c.nom)}" required></label></div>${piedForm()}</form>`,
    (b) => lierFormulaire($('#f', b), async (d) => { await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/stock/categories/${ds.id}` : '/api/stock/categories', d); fermerModale(); toast('Catégorie enregistrée.', 'ok'); afficherPage(); }));
};

/* ===================================================== Rapports de stock */
PAGES['etats-stock'] = {
  perm: 'stock.etats',
  async render() {
    const f = S.filtres;
    const d = f.dateStock || today();
    const carte = (nom, titre, texte, opts = '') => `<div class="etat"><h2>${titre}</h2><p>${texte}</p>${opts ? `<div class="opts">${opts}</div>` : ''}<button class="btn primary" data-action="stk-etat" data-nom="${nom}">Afficher · Imprimer · PDF</button></div>`;
    return `${tete('Rapports de stock', `${esc(nomAgenceVue())} · chaque rapport reprend l'entête de vos documents et respecte le périmètre de l'utilisateur`)}
    <div class="filters"><label>Date d'arrêté (rapports quotidiens)<input type="date" id="date-stock" value="${d}"></label></div>
    <div class="etats">
      ${carte('valeur', 'Valeur du stock par agence et catégorie', 'Valeur monétaire à la date d\'arrêté, comparaison avec la veille, totaux par agence et par catégorie, lots sans coût signalés.')}
      ${carte('pertes-peremption', 'Pertes sur péremption (quotidien)', 'Lots périmés du jour : quantité, valeur brute, récupération, perte nette ; cumul du mois et de l\'année ; comparaison avec la veille.')}
      ${carte('peremptions', 'Péremptions à venir et stock dormant', 'Valeur à risque à 7, 15 et 30 jours, lots à écouler en priorité, lots périmés encore en stock, stock sans mouvement depuis 90 jours.')}
      ${carte('situation', 'État des stocks et réapprovisionnement', 'Quantités disponibles, bloquées et périmées, valeur, seuils, consommation moyenne, couverture en jours et propositions de commande.')}
    </div>
    <h2 style="margin:22px 0 10px;font-size:15px">Rapports sur une période</h2>
    ${barrePeriode()}
    <div class="etats">
      ${carte('pertes', 'Pertes et freintes', 'Pertes par motif (casse, vol, infestation, péremption…), par catégorie et par agence, en valeur.')}
      ${carte('mouvements', 'Journal des mouvements de stock', 'Réceptions, sorties, transferts, pertes et ajustements de la période avec leur valeur.')}
      ${carte('historique', 'Évolution quotidienne de la valeur', 'Instantanés quotidiens non modifiables : valeur du stock et perte sur péremption, jour par jour.')}
    </div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); $('#date-stock', root).addEventListener('change', (e) => { S.filtres.dateStock = e.target.value; }); },
};
ACTIONS['stk-etat'] = async (ds) => {
  const d = S.filtres.dateStock || today(); const p = { ...S.periode };
  try {
    await chargerStock();
    if (ds.nom === 'valeur') docValeurStock(await api('GET', `/api/stock/etats/valeur?date=${d}`));
    else if (ds.nom === 'pertes-peremption') docPertesPeremption(await api('GET', `/api/stock/etats/pertes-peremption?date=${d}`));
    else if (ds.nom === 'peremptions') docPeremptions(await api('GET', `/api/stock/etats/peremptions?date=${d}`));
    else if (ds.nom === 'situation') docSituationStock(await api('GET', '/api/stock/etats/situation'));
    else if (ds.nom === 'pertes') docPertesStock(await api('GET', `/api/stock/etats/pertes?${qs(per())}`), p);
    else if (ds.nom === 'mouvements') docJournalStock(await api('GET', `/api/stock/mouvements?${qs(per())}`), p);
    else if (ds.nom === 'historique') docHistoriqueStock(await api('GET', `/api/stock/etats/historique?${qs(per())}`), p);
  } catch (e) { toast(e.message, 'err'); }
};

/* ========================================================== Documents */
const tq = (x) => `${x > 0 ? '+' : ''}${nq(x)}`;
const variation = (a, b) => { const v = a - b; return `<span class="${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}">${v > 0 ? '+' : ''}${nb(v)}</span>`; };
const TITRES_MVT = { reception: 'Bon de réception', sortie: 'Bon de sortie de stock', transfert_sortie: 'Bon de sortie (transfert)', transfert_entree: 'Bon de réception (transfert)', transfert_annule: 'Annulation de transfert', perte: 'Bon de perte', ajustement: "Bon d'ajustement d'inventaire" };

function docMouvementStock(m) {
  const html = `${entete(TITRES_MVT[m.type] || 'Mouvement de stock', { numero: m.numero, date: m.date, meta: m.agence ? [`Agence : <b>${esc(m.agence)}</b>`] : [] })}
  <div class="kv" style="margin-top:10px">
    <div>Objet</div><div>${esc(m.libelle)}</div>
    ${m.tiers ? `<div>${m.type === 'reception' ? 'Fournisseur' : m.type.startsWith('transfert') ? 'Agence' : 'Client / destinataire'}</div><div>${esc(m.tiers)}</div>` : ''}
    ${m.document ? `<div>Pièce</div><div>${esc(m.document)}</div>` : ''}
    ${m.horsFefo ? `<div>Hors FEFO</div><div>Lot attendu ${esc(m.horsFefo.lotAttendu)} – motif : ${esc(m.horsFefo.motif)}</div>` : ''}
  </div>
  <table class="dt" style="margin-top:12px"><thead><tr><th>Article</th><th>Lot</th><th class="num">Quantité</th><th>Unité</th><th class="num">Coût unitaire</th><th class="num">Valeur</th></tr></thead>
  <tbody>${m.lignes.map((l) => `<tr><td>${esc(l.designation)}</td><td>${esc(l.lotNumero)}</td><td class="num">${tq(l.quantite)}</td><td>${esc(l.unite)}</td><td class="num">${nb(l.coutUnitaire)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('')}</tbody>
  <tfoot><tr class="tot"><td colspan="5">Valeur totale du mouvement</td><td class="num">${nb(m.valeur)}</td></tr>${m.montantVente != null ? `<tr><td colspan="5">Montant de la vente</td><td class="num">${nb(m.montantVente)}</td></tr>` : ''}</tfoot></table>
  <p class="note">Saisi par ${esc(m.nomCreateur || '')} le ${fdt(m.creeLe)}.</p>
  ${signatures([{ titre: 'Le Magasinier' }, { titre: m.type === 'reception' ? 'Le Livreur' : 'Le Réceptionnaire' }, { titre: "Le Responsable d'agence" }])}`;
  ouvrirDocument(`${TITRES_MVT[m.type] || 'Mouvement'} ${m.numero}`, feuille(html), { fichier: `Stock_${m.numero}` });
}

function docTransfert(t) {
  const html = `${entete('Bon de transfert de stock', { numero: t.numero, date: t.date })}
  <div class="kv" style="margin-top:10px">
    <div>Agence expéditrice</div><div><b>${esc(t.agenceNom)}</b></div>
    <div>Agence destinataire</div><div><b>${esc(t.destinationNom)}</b></div>
    ${t.transporteur ? `<div>Transporteur</div><div>${esc(t.transporteur)}</div>` : ''}
    <div>Statut</div><div>${t.statut === 'recu' ? `Reçu le ${fd(t.dateReception)} par ${esc(t.nomRecu || '')}` : t.statut === 'annule' ? `Annulé : ${esc(t.motifAnnulation || '')}` : 'En transit'}</div>
    ${t.observations ? `<div>Observations</div><div>${esc(t.observations)}</div>` : ''}
  </div>
  <table class="dt" style="margin-top:12px"><thead><tr><th>Article</th><th>Lot</th><th>Péremption</th><th>Campagne</th><th class="num">Quantité</th><th>Unité</th><th class="num">Coût unit.</th><th class="num">Valeur</th></tr></thead>
  <tbody>${t.lignes.map((l) => `<tr><td>${esc(l.designation)}</td><td>${esc(l.lotNumero)}</td><td>${fd(l.datePeremption)}</td><td>${esc(l.campagne || '')}</td><td class="num">${nq(l.quantite)}</td><td>${esc(l.unite)}</td><td class="num">${nb(l.coutUnitaire)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('')}</tbody>
  <tfoot><tr class="tot"><td colspan="7">Valeur transférée</td><td class="num">${nb(t.valeur)}</td></tr></tfoot></table>
  ${signatures([{ titre: "L'Expéditeur" }, { titre: 'Le Transporteur' }, { titre: 'Le Réceptionnaire' }])}`;
  ouvrirDocument(`Transfert ${t.numero}`, feuille(html), { fichier: `Transfert_${t.numero}` });
}

function docFicheLot(f) {
  const l = f.lot;
  const html = `${entete('Fiche de traçabilité du lot', { numero: l.numero, meta: [`Agence : <b>${esc(l.agence)}</b>`] })}
  <div class="doc-h">Identification</div>
  <div class="kv">
    <div>Article</div><div><b>${esc(l.designation)}</b> (${esc(l.code)}) – ${esc(nomCat(l.categorieId))}</div>
    <div>Statut</div><div>${esc(SK.ref.statuts[l.statut] || l.statut)} – ${nq(l.quantite)} ${esc(l.unite)} en stock sur ${nq(l.quantiteInitiale)} reçu(s)</div>
    <div>Réception</div><div>${fd(l.dateReception)}${l.document ? ` – pièce ${esc(l.document)}` : ''}</div>
    <div>Péremption</div><div>${l.datePeremption ? fd(l.datePeremption) : 'aucune'}</div>
    <div>Coût unitaire</div><div>${nb(l.coutUnitaire)} (prix ${nb(l.prixUnitaire)} + frais ${nb(l.fraisAccessoires)})</div>
  </div>
  <div class="doc-h">Amont (origine)</div>
  <div class="kv">
    <div>Fournisseur / coopérative</div><div>${esc(l.fournisseur || '—')}</div>
    <div>Origine</div><div>${esc(l.origine || '—')}</div>
    <div>Campagne</div><div>${esc(l.campagne || '—')}</div>
    ${l.provenance ? `<div>Transféré de</div><div>${esc(l.provenance)} (transfert ${esc(l.document)})</div>` : ''}
    <div>Qualité à l'entrée</div><div>${l.qualite && l.qualite.humidite != null ? `humidité ${nq(l.qualite.humidite)} % · ` : ''}${l.qualite && l.qualite.impuretes != null ? `impuretés ${nq(l.qualite.impuretes)} % · ` : ''}${esc((l.qualite && l.qualite.observations) || '')}</div>
  </div>
  ${(l.historiqueStatuts || []).length ? `<div class="doc-h">Changements de statut</div><table class="dt"><tbody>${l.historiqueStatuts.map((h) => `<tr><td>${fdt(h.le)}</td><td>${esc(SK.ref.statuts[h.de])} → ${esc(SK.ref.statuts[h.a])}</td><td>${esc(h.motif)}</td><td>${esc(h.par)}</td></tr>`).join('')}</tbody></table>` : ''}
  <div class="doc-h">Mouvements (aval : sorties, clients, transferts)</div>
  <table class="dt"><thead><tr><th>Date</th><th>N°</th><th>Type</th><th>Tiers / libellé</th><th class="num">Quantité</th><th class="num">Valeur</th></tr></thead>
  <tbody>${f.mouvements.map((m) => `<tr><td>${fd(m.date)}</td><td>${esc(m.numero)}</td><td>${(TYPES_MVT[m.type] || [m.type])[0]}</td><td>${esc(m.tiers || m.libelle)}</td><td class="num">${tq(m.quantite)}</td><td class="num">${nb(m.valeur)}</td></tr>`).join('')}</tbody></table>
  ${f.peremption ? `<p class="note">Périmé le ${fd(f.peremption.date)} : valeur brute ${nb(f.peremption.valeurBrute)}, récupération ${nb(f.peremption.recuperation)}, perte nette ${nb(f.peremption.perteNette)} (${f.peremption.realisee ? 'réalisée' : 'constatée, lot encore en stock'}).</p>` : ''}`;
  ouvrirDocument(`Lot ${l.numero}`, feuille(html), { fichier: `Lot_${l.numero}` });
}

function docInventaire(inv) {
  const s = inv.synthese || {};
  const html = `${entete("Procès-verbal d'inventaire", { numero: inv.numero, date: inv.date })}
  <p style="margin:12px 0">Le ${dLong(inv.date)}, il a été procédé à l'inventaire physique ${inv.categorieId ? `de la catégorie « ${esc(nomCat(inv.categorieId))} »` : 'de l\'ensemble du stock'}${inv.aveugle ? ', par comptage à l\'aveugle' : ''}.</p>
  <table class="dt"><thead><tr><th>Article</th><th>Lot</th><th class="num">Théorique</th><th class="num">Compté</th><th class="num">Écart</th><th>Unité</th><th class="num">Coût unit.</th><th class="num">Valeur de l'écart</th></tr></thead>
  <tbody>${inv.lignes.map((l) => `<tr><td>${esc(l.designation)}</td><td>${esc(l.lotNumero)}</td><td class="num">${l.theorique === undefined ? '' : nq(l.theorique)}</td><td class="num">${l.compte == null ? '' : nq(l.compte)}</td><td class="num">${l.ecart == null ? '' : tq(l.ecart)}</td><td>${esc(l.unite)}</td><td class="num">${nb(l.coutUnitaire)}</td><td class="num">${l.valeurEcart == null ? '' : nb(l.valeurEcart)}</td></tr>`).join('')}</tbody></table>
  ${inv.synthese ? `<div class="doc-h">Synthèse</div><table class="dt" style="width:70%">
    <tr><td>Lots comptés / sans écart</td><td class="num">${s.lots} / ${s.sansEcart}</td></tr>
    <tr><td>Exactitude des stocks</td><td class="num">${nb(s.exactitude)} %</td></tr>
    <tr><td>Valeur théorique</td><td class="num">${nb(s.valeurTheorique)}</td></tr>
    <tr><td>Valeur comptée</td><td class="num">${nb(s.valeurComptee)}</td></tr>
    <tr><td>Écarts positifs (excédents)</td><td class="num">${nb(s.ecartPositif)}</td></tr>
    <tr><td>Écarts négatifs (manquants)</td><td class="num">${nb(s.ecartNegatif)}</td></tr>
    <tr class="tot"><td>Écart net</td><td class="num">${nb(s.ecartPositif + s.ecartNegatif)}</td></tr></table>
    <p class="note">Validé par ${esc(inv.nomValide || '')} le ${fdt(inv.valideLe)}${inv.mouvementNumero ? ` – ajustement ${esc(inv.mouvementNumero)}` : ''}.</p>` : '<p class="note">Inventaire en cours : non validé.</p>'}
  ${inv.observations ? `<div class="doc-h">Observations</div><div class="obs">${esc(inv.observations)}</div>` : ''}
  ${signatures([{ titre: 'Le(s) Compteur(s)' }, { titre: 'Le Magasinier' }, { titre: "Le Responsable d'agence" }])}`;
  ouvrirDocument(`Inventaire ${inv.numero}`, feuille(html), { paysage: true, fichier: `Inventaire_${inv.numero}` });
}

/** Lignes regroupées par agence, avec sous-totaux et total général. */
function tableauGroupe(lignes, cols, tot, colsTot) {
  const agences = [...new Set(lignes.map((l) => l.agence))];
  const multi = agences.length > 1 || consolide();
  return agences.map((a) => {
    const ls = lignes.filter((l) => l.agence === a);
    return `${ls.map((l) => `<tr>${multi ? `<td>${esc(a)}</td>` : ''}${cols(l)}</tr>`).join('')}${multi ? `<tr class="sub"><td colspan="2">Total ${esc(a)}</td>${colsTot(tot(ls))}</tr>` : ''}`;
  }).join('');
}
function docValeurStock(d) {
  const multi = consolide() || new Set(d.lignes.map((l) => l.agence)).size > 1;
  const somme = (ls) => ({ lots: ls.reduce((s, l) => s + l.lots, 0), valeur: ls.reduce((s, l) => s + l.valeur, 0), veille: ls.reduce((s, l) => s + l.veille, 0) });
  const parCat = [...new Set(d.lignes.map((l) => l.categorie))].map((c) => ({ categorie: c, ...somme(d.lignes.filter((l) => l.categorie === c)) }));
  const sansCout = d.lignes.reduce((s, l) => s + l.sansCout, 0);
  const html = `${entete('Valeur du stock par agence et par catégorie', { date: d.date })}
  <table class="dt" style="margin-top:10px"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Catégorie</th><th class="num">Lots</th><th class="num">Valeur au ${fd(d.date)}</th><th class="num">Valeur au ${fd(d.veille)}</th><th class="num">Variation</th></tr></thead>
  <tbody>${tableauGroupe(d.lignes, (l) => `<td>${esc(l.categorie)}</td><td class="num">${l.lots}</td><td class="num">${nb(l.valeur)}</td><td class="num">${nb(l.veille)}</td><td class="num">${variation(l.valeur, l.veille)}</td>`, somme,
    (t) => `<td class="num">${t.lots}</td><td class="num">${nb(t.valeur)}</td><td class="num">${nb(t.veille)}</td><td class="num">${variation(t.valeur, t.veille)}</td>`)
    || `<tr><td colspan="6" style="text-align:center;color:#777">Aucun stock à cette date</td></tr>`}</tbody>
  <tfoot><tr class="tot"><td colspan="${multi ? 3 : 2}">TOTAL ${multi ? 'GÉNÉRAL' : ''}</td><td class="num">${nb(d.total)}</td><td class="num">${nb(d.totalVeille)}</td><td class="num">${variation(d.total, d.totalVeille)}</td></tr></tfoot></table>
  ${multi && parCat.length ? `<div class="doc-h">Totaux par catégorie</div><table class="dt" style="width:70%"><thead><tr><th>Catégorie</th><th class="num">Valeur</th><th class="num">Veille</th><th class="num">Variation</th></tr></thead><tbody>${parCat.map((c) => `<tr><td>${esc(c.categorie)}</td><td class="num">${nb(c.valeur)}</td><td class="num">${nb(c.veille)}</td><td class="num">${variation(c.valeur, c.veille)}</td></tr>`).join('')}</tbody></table>` : ''}
  <p class="note">Valorisation au coût réel des lots (prix d'achat + frais accessoires), méthode FIFO / FEFO conforme à IAS 2. Les lots périmés sont exclus de la valeur${d.perimesEnStock ? ` (lots périmés encore physiquement en stock : ${nb(d.perimesEnStock)})` : ''}.${sansCout ? ` <b>Anomalie : ${sansCout} lot(s) sans coût unitaire.</b>` : ''} ${d.instantane ? 'Instantané quotidien enregistré pour cette date.' : ''}</p>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument('Valeur du stock', feuille(html), { fichier: `Valeur_stock_${d.date}` });
}
function docPertesPeremption(d) {
  const multi = consolide() || new Set(d.lignes.map((l) => l.agence)).size > 1;
  const somme = (ls) => Object.fromEntries(['quantite', 'valeurBrute', 'recuperation', 'perteNette', 'cumulMois', 'cumulAnnee'].map((k) => [k, ls.reduce((s, l) => s + l[k], 0)]));
  const cols = (l) => `<td class="num">${nb(l.valeurBrute)}</td><td class="num">${nb(l.recuperation)}</td><td class="num"><b>${nb(l.perteNette)}</b></td><td class="num">${nb(l.cumulMois)}</td><td class="num">${nb(l.cumulAnnee)}</td>`;
  const html = `${entete('Rapport quotidien des pertes sur péremption', { date: d.date })}
  <table class="dt" style="margin-top:10px"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Catégorie</th><th class="num">Valeur brute</th><th class="num">Récupération</th><th class="num">Perte nette du jour</th><th class="num">Cumul du mois</th><th class="num">Cumul de l'année</th></tr></thead>
  <tbody>${tableauGroupe(d.lignes, (l) => `<td>${esc(l.categorie)}</td>${cols(l)}`, somme, (t) => cols(t)) || `<tr><td colspan="7" style="text-align:center;color:#777">Aucune perte sur péremption depuis le début de l'année</td></tr>`}</tbody>
  <tfoot><tr class="tot"><td colspan="${multi ? 2 : 1}">TOTAL ${multi ? 'GLOBAL' : ''}</td>${cols(d.totaux)}</tr></tfoot></table>
  <table class="dt" style="width:70%;margin-top:10px">
    <tr><td>Perte nette du jour</td><td class="num"><b>${nb(d.totaux.perteNette)}</b></td></tr>
    <tr><td>Perte nette de la veille</td><td class="num">${nb(d.totaux.veille)} (${variation(d.totaux.perteNette, d.totaux.veille)})</td></tr>
    <tr><td>Moyenne journalière du mois</td><td class="num">${nb(d.moyenneJourMois)}</td></tr></table>
  <div class="doc-h">Lots arrivés à péremption le ${fd(d.date)}</div>
  <table class="dt"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Lot</th><th>Article</th><th>Catégorie</th><th class="num">Quantité</th><th class="num">Valeur brute</th><th class="num">Récupération</th><th class="num">Perte nette</th><th>Situation</th></tr></thead>
  <tbody>${d.lots.map((p) => `<tr>${multi ? `<td>${esc(p.agence)}</td>` : ''}<td>${esc(p.lotNumero)}</td><td>${esc(p.designation)}</td><td>${esc(p.categorie)}</td><td class="num">${nq(p.quantite)} ${esc(p.unite)}</td><td class="num">${nb(p.valeurBrute)}</td><td class="num">${nb(p.recuperation)}</td><td class="num">${nb(p.perteNette)}</td><td>${p.realisee ? 'Réalisée (sortie)' : 'Constatée (en stock)'}</td></tr>`).join('') || `<tr><td colspan="9" style="text-align:center;color:#777">Aucun lot périmé ce jour</td></tr>`}</tbody></table>
  <p class="note">Perte brute = valeur comptable du lot ; perte nette = perte brute − valeur de récupération (vente déclassée, don valorisé, transformation). Une perte est comptée une seule fois, le jour de la péremption, qu'elle soit encore « constatée » ou déjà « réalisée ».</p>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument('Pertes sur péremption', feuille(html), { paysage: true, fichier: `Pertes_peremption_${d.date}` });
}
function docPeremptions(d) {
  const multi = consolide();
  const html = `${entete('Péremptions à venir et stock dormant', { date: d.date })}
  <div class="doc-h">Valeur à risque de péremption</div>
  <table class="dt" style="width:70%"><thead><tr><th>Échéance</th><th class="num">Valeur</th></tr></thead><tbody>${d.tranches.map((t) => `<tr><td>Péremption ${esc(t.libelle)}</td><td class="num">${nb(t.valeur)}</td></tr>`).join('')}</tbody>
  <tfoot><tr class="tot"><td>Total à risque sous 30 jours</td><td class="num">${nb(d.tranches.reduce((s, t) => s + t.valeur, 0))}</td></tr></tfoot></table>
  ${d.groupes.length ? `<table class="dt" style="margin-top:8px"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Catégorie</th><th class="num">≤ 7 jours</th><th class="num">8 à 15 jours</th><th class="num">16 à 30 jours</th></tr></thead><tbody>${d.groupes.map((g) => `<tr>${multi ? `<td>${esc(g.agence)}</td>` : ''}<td>${esc(g.categorie)}</td><td class="num">${nb(g[7])}</td><td class="num">${nb(g[15])}</td><td class="num">${nb(g[30])}</td></tr>`).join('')}</tbody></table>` : ''}
  <div class="doc-h">Lots à écouler en priorité (FEFO)</div>
  <table class="dt"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Lot</th><th>Article</th><th>Péremption</th><th class="num">Jours restants</th><th class="num">Quantité</th><th class="num">Valeur</th><th>Action proposée</th></tr></thead>
  <tbody>${d.lots.map((l) => `<tr>${multi ? `<td>${esc(l.agence)}</td>` : ''}<td>${esc(l.numero)}</td><td>${esc(l.designation)}</td><td>${fd(l.datePeremption)}</td><td class="num">${l.joursRestants}</td><td class="num">${nq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.valeur)}</td><td>${l.joursRestants <= 7 ? 'Déstockage immédiat, promotion ou don' : l.joursRestants <= 15 ? 'Sortie prioritaire ou transfert' : 'Servir en priorité'}</td></tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:#777">Aucun lot ne périme dans les 30 jours</td></tr>`}</tbody></table>
  <div class="doc-h">Lots périmés encore en stock (à sortir)</div>
  <table class="dt"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Lot</th><th>Article</th><th>Péremption</th><th class="num">Quantité</th><th class="num">Valeur</th></tr></thead>
  <tbody>${d.perimes.map((l) => `<tr>${multi ? `<td>${esc(l.agence)}</td>` : ''}<td>${esc(l.numero)}</td><td>${esc(l.designation)}</td><td>${fd(l.datePeremption)}</td><td class="num">${nq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#777">Aucun</td></tr>'}</tbody></table>
  <div class="doc-h">Stock dormant (aucun mouvement depuis ${d.joursDormant} jours)</div>
  <table class="dt"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Lot</th><th>Article</th><th>Reçu le</th><th class="num">Ancienneté</th><th class="num">Quantité</th><th class="num">Valeur</th></tr></thead>
  <tbody>${d.dormants.map((l) => `<tr>${multi ? `<td>${esc(l.agence)}</td>` : ''}<td>${esc(l.numero)}</td><td>${esc(l.designation)}</td><td>${fd(l.dateReception)}</td><td class="num">${l.ancienneteJours} j</td><td class="num">${nq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:#777">Aucun</td></tr>'}</tbody></table>`;
  ouvrirDocument('Péremptions et stock dormant', feuille(html), { paysage: true, fichier: `Peremptions_${d.date}` });
}
function docSituationStock(lignes) {
  const multi = consolide();
  const html = `${entete('État des stocks et réapprovisionnement', { date: today() })}
  <table class="dt" style="margin-top:10px"><thead><tr>${multi ? '<th>Agence</th>' : ''}<th>Article</th><th>Catégorie</th><th class="num">Disponible</th><th class="num">Bloqué</th><th class="num">Périmé</th><th>Unité</th><th class="num">Coût moyen</th><th class="num">Valeur</th><th class="num">Min / Max</th><th class="num">Conso / jour</th><th class="num">Couverture</th><th class="num">À commander</th></tr></thead>
  <tbody>${lignes.map((l) => `<tr>${multi ? `<td>${esc(l.agence)}</td>` : ''}<td>${esc(l.designation)}</td><td>${esc(l.categorie)}</td><td class="num">${nq(l.disponible)}</td><td class="num">${nq(l.bloque)}</td><td class="num">${nq(l.perime)}</td><td>${esc(l.unite)}</td><td class="num">${nb(l.coutMoyen)}</td><td class="num">${nb(l.valeur)}</td><td class="num">${nq(l.min)} / ${nq(l.max)}</td><td class="num">${nq(l.consoJour)}</td><td class="num">${l.couvertureJours == null ? '—' : `${l.couvertureJours} j`}</td><td class="num">${l.aCommander ? `<b>${nq(l.aCommander)}</b>` : ''}</td></tr>`).join('') || '<tr><td colspan="13" style="text-align:center;color:#777">Aucun article</td></tr>'}</tbody>
  <tfoot><tr class="tot"><td colspan="${multi ? 8 : 7}">Valeur totale</td><td class="num">${nb(lignes.reduce((s, l) => s + l.valeur, 0))}</td><td colspan="4"></td></tr></tfoot></table>
  <p class="note">Consommation moyenne calculée sur les 90 derniers jours (sorties et transferts). Point de commande = consommation journalière × délai d'approvisionnement + stock minimum ; la proposition ramène le stock au maximum.</p>`;
  ouvrirDocument('État des stocks', feuille(html), { paysage: true, fichier: `Etat_stocks_${today()}` });
}
function docPertesStock(d, periode) {
  const bloc = (titre, arr) => `<div><div class="doc-h">${titre}</div><table class="dt"><tbody>${arr.map((x) => `<tr><td>${esc(x.nom)}</td><td class="num">${nb(x.valeur)}</td></tr>`).join('') || '<tr><td>—</td><td></td></tr>'}</tbody></table></div>`;
  const multi = consolide();
  const html = `${entete('Pertes et freintes', { periode })}
  <div style="display:grid;grid-template-columns:repeat(${multi ? 3 : 2},1fr);gap:12px">${bloc('Par motif', d.parMotif)}${bloc('Par catégorie', d.parCategorie)}${multi ? bloc('Par agence', d.parAgence) : ''}</div>
  <div class="doc-h">Détail</div>
  <table class="dt"><thead><tr><th>Date</th><th>Référence</th>${multi ? '<th>Agence</th>' : ''}<th>Motif</th><th>Article</th><th>Lot</th><th class="num">Quantité</th><th class="num">Valeur perdue</th></tr></thead>
  <tbody>${d.lignes.map((l) => `<tr><td>${fd(l.date)}</td><td>${esc(l.numero)}</td>${multi ? `<td>${esc(l.agence)}</td>` : ''}<td>${esc(l.motif)}</td><td>${esc(l.designation)}</td><td>${esc(l.lotNumero)}</td><td class="num">${nq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:#777">Aucune perte sur la période</td></tr>'}</tbody>
  <tfoot><tr class="tot"><td colspan="${multi ? 7 : 6}">Total des pertes</td><td class="num">${nb(d.total)}</td></tr></tfoot></table>
  <p class="note">Les pertes sur péremption sont comptées à leur valeur nette (après récupération), une seule fois.</p>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument('Pertes et freintes', feuille(html), { paysage: true, fichier: `Pertes_stock_${d.debut}_${d.fin}` });
}
function docJournalStock(ms, periode) {
  const multi = consolide();
  const html = `${entete('Journal des mouvements de stock', { periode })}
  <table class="dt" style="margin-top:10px"><thead><tr><th>Date</th><th>N°</th>${multi ? '<th>Agence</th>' : ''}<th>Type</th><th>Libellé / tiers</th><th>Article</th><th>Lot</th><th class="num">Quantité</th><th class="num">Valeur</th></tr></thead>
  <tbody>${[...ms].reverse().map((m) => m.lignes.map((l, i) => `<tr><td>${i ? '' : fd(m.date)}</td><td>${i ? '' : esc(m.numero)}</td>${multi ? `<td>${i ? '' : esc(m.agence)}</td>` : ''}<td>${i ? '' : (TYPES_MVT[m.type] || [m.type])[0]}</td><td>${i ? '' : esc(m.tiers || m.libelle)}</td><td>${esc(l.designation)}</td><td>${esc(l.lotNumero)}</td><td class="num">${tq(l.quantite)} ${esc(l.unite)}</td><td class="num">${nb(l.valeur)}</td></tr>`).join('')).join('') || '<tr><td colspan="9" style="text-align:center;color:#777">Aucun mouvement sur la période</td></tr>'}</tbody>
  <tfoot><tr class="tot"><td colspan="${multi ? 8 : 7}">Variation nette de la valeur du stock</td><td class="num">${nb(ms.reduce((s, m) => s + m.valeur, 0))}</td></tr></tfoot></table>`;
  ouvrirDocument('Mouvements de stock', feuille(html), { paysage: true, fichier: `Mouvements_stock_${periode.debut}_${periode.fin}` });
}
function docHistoriqueStock(xs, periode) {
  const multi = consolide();
  const parJour = [...new Set(xs.map((x) => x.date))].map((d) => ({ date: d, valeur: xs.filter((x) => x.date === d).reduce((s, x) => s + x.valeur, 0), perte: xs.filter((x) => x.date === d).reduce((s, x) => s + x.perteJour, 0) }));
  const html = `${entete('Évolution quotidienne de la valeur du stock', { periode })}
  <table class="dt" style="margin-top:10px"><thead><tr><th>Date</th>${multi ? '<th>Agence</th>' : ''}<th class="num">Valeur du stock</th><th class="num">Perte sur péremption du jour</th></tr></thead>
  <tbody>${xs.map((x) => `<tr><td>${fd(x.date)}</td>${multi ? `<td>${esc(x.agence)}</td>` : ''}<td class="num">${nb(x.valeur)}</td><td class="num">${x.perteJour ? nb(x.perteJour) : ''}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#777">Aucun instantané sur la période (ils sont enregistrés automatiquement chaque jour pour la veille)</td></tr>'}</tbody></table>
  ${multi && parJour.length ? `<div class="doc-h">Total toutes agences</div><table class="dt" style="width:70%"><tbody>${parJour.map((j) => `<tr><td>${fd(j.date)}</td><td class="num">${nb(j.valeur)}</td><td class="num">${j.perte ? nb(j.perte) : ''}</td></tr>`).join('')}</tbody></table>` : ''}
  <p class="note">Instantanés enregistrés automatiquement en fin de journée ; ils ne sont jamais modifiés.</p>`;
  ouvrirDocument('Évolution de la valeur du stock', feuille(html), { fichier: `Historique_stock_${periode.debut}_${periode.fin}` });
}
