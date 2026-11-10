'use strict';
/* =====================================================================
   Pages de l'application et formulaires.
   ===================================================================== */
const per = () => ({ debut: S.periode.debut, fin: S.periode.fin });
const tete = (titre, sous, actions = '') => `<div class="page-head"><div><h1>${titre}</h1>${sous ? `<p>${sous}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
const vide = (n, txt = 'Aucune donnée sur la période sélectionnée.') => `<tr><td colspan="${n}" class="empty">${txt}</td></tr>`;
const NATURES = {
  encaissement: ['Entrée', 'in'], versement_caisse: ['Versement caisse → banque', 'int'],
  virement_fournisseur: ['Virement fournisseur', 'out'], transfert_caisse: ['Transfert en caisse', 'int'],
};
const piedForm = (lbl = 'Enregistrer') => `<p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">${lbl}</button></div>`;
function exigerComptes() {
  if (S.comptes.some((c) => c.actif !== false)) return true;
  toast(peut('comptes.gerer') ? "Créez d'abord un compte bancaire (menu Comptes bancaires)." : "Aucun compte bancaire n'est configuré. Contactez l'administrateur.", 'err');
  return false;
}

/* ======================================================= Tableau de bord */
PAGES.tableau = {
  async render() {
    const d = await api('GET', '/api/tableau-de-bord');
    return `${tete('Tableau de bord', `Situation au ${new Date().toLocaleDateString('fr-FR', { dateStyle: 'full' })}`,
      `<span class="actions"><button class="btn primary" data-perm="banque.saisir" data-action="op-entree">+ Entrée d'argent</button><button class="btn" data-perm="banque.saisir" data-action="op-virement">Virement fournisseur</button><button class="btn" data-perm="banque.saisir" data-action="op-transfert">Transfert en caisse</button><button class="btn" data-perm="caisse.saisir" data-action="bon-nouveau" data-type="sortie">Bon de sortie caisse</button></span>`)}
    <div class="kpis">
      <div class="kpi main"><div class="lbl">Trésorerie totale</div><div class="val">${money(d.total)}</div><div class="sub">Banques + caisse</div></div>
      ${d.soldes.map((s) => `<div class="kpi"><div class="lbl">${esc(s.banque)}</div><div class="val ${s.solde < 0 ? 'neg' : ''}">${money(s.solde)}</div><div class="sub">${esc(s.numero)}${s.intitule ? ` · ${esc(s.intitule)}` : ''}</div></div>`).join('')}
      <div class="kpi"><div class="lbl">Caisse</div><div class="val">${money(d.caisse)}</div><div class="sub">Dernière clôture : ${d.derniereCloture ? fd(d.derniereCloture.date) : 'aucune'}</div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="lbl">Encaissements du mois</div><div class="val pos">${money(d.mois.encaissements)}</div><div class="sub">Hors mouvements internes</div></div>
      <div class="kpi"><div class="lbl">Décaissements du mois</div><div class="val neg">${money(d.mois.decaissements)}</div><div class="sub">Hors mouvements internes</div></div>
      <div class="kpi"><div class="lbl">Flux net du mois</div><div class="val">${money(d.mois.encaissements - d.mois.decaissements)}</div><div class="sub">&nbsp;</div></div>
      <div class="kpi"><div class="lbl">Dernier contrôle de caisse</div><div class="val">${d.dernierPV ? (d.dernierPV.ecart === 0 ? 'Conforme' : money(d.dernierPV.ecart)) : '—'}</div><div class="sub">${d.dernierPV ? `${esc(d.dernierPV.numero)} du ${fd(d.dernierPV.date)}` : 'Aucun PV'}</div></div>
    </div>
    ${S.stockage && S.stockage.serveurEnLigne && S.stockage.serveurEnLigne.aJour === false && peut('stockage.gerer') ? `<div class="card" style="border-color:#b42318;background:#fdecea;margin-bottom:16px"><b>⚠ Le serveur en ligne n'est pas à jour</b> (version ${esc(S.stockage.serveurEnLigne.version)}, ce PC : ${esc(S.stockage.version)}). Les autres ordinateurs et les téléphones utilisent encore l'ancienne version. Envoyez le contenu du dossier <b>gestion-fonds</b> du Bureau sur GitHub (Add file → Upload files → Commit changes) ; Render se met à jour en 3 à 5 minutes.</div>` : ''}
    ${S.stockage && S.stockage.mode === 'local' && !S.stockage.relaisPossible && peut('stockage.gerer') ? `<div class="card" style="border-color:#f0a43a;background:#fff8ec;margin-bottom:16px"><b>⚠ Connexion cloud inactive sur cet ordinateur.</b> Les comptes et opérations saisis ici ne sont pas visibles sur les autres ordinateurs ni sur les mobiles. <a href="#/stockage">Activer la connexion cloud</a></div>` : ''}
    ${S.stockage && S.stockage.cloud === 'refuse' ? `<div class="card" style="border-color:#b42318;background:#fdecea;margin-bottom:16px"><b>⚠ Liaison de cet ordinateur au cloud refusée</b> (compte suspendu ou mot de passe changé). Déconnectez-vous puis reconnectez-vous : l'ordinateur se relie à nouveau automatiquement. Vos saisies sont conservées ici en attendant.</div>` : ''}
    ${S.comptes.length ? '' : `<div class="card"><b>Pour commencer :</b> ${peut('comptes.gerer') ? 'renseignez l\'<a href="#/parametres">entête de vos documents</a>, puis créez vos <a href="#/comptes">comptes bancaires</a> et vos <a href="#/fournisseurs">fournisseurs</a>.' : 'l\'administrateur doit créer les comptes bancaires.'}</div>`}
    <div class="card"><div class="card-head"><h2>Derniers mouvements saisis</h2></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>N°</th><th>Lieu</th><th>Libellé</th><th class="num">Montant</th></tr></thead><tbody>
      ${d.derniers.map((m) => `<tr class="${m.annulee ? 'strike' : ''}"><td class="nowrap">${fd(m.date)}</td><td class="nowrap">${esc(m.numero)}</td><td>${m.lieu}</td><td>${esc(m.libelle)}</td><td class="num ${m.sens === 'entree' ? 'pos' : 'neg'}">${m.sens === 'entree' ? '+' : '−'} ${money(m.montant)}</td></tr>`).join('') || vide(5, 'Aucun mouvement enregistré.')}
      </tbody></table></div></div>`;
  },
};

/* ================================================ Opérations bancaires */
PAGES.banque = {
  async render() {
    const f = S.filtres;
    const ops = await api('GET', `/api/operations?${qs({ ...per(), compteId: f.compte, nature: f.nature })}`);
    const actives = ops.filter((o) => !o.annulee);
    const tD = actives.filter((o) => o.sens === 'entree').reduce((a, o) => a + o.montant, 0);
    const tC = actives.filter((o) => o.sens === 'sortie').reduce((a, o) => a + o.montant, 0);
    return `${tete('Opérations bancaires', 'Entrée d\'argent = débit du compte banque · Sortie d\'argent = crédit du compte banque',
      `<span class="actions" data-perm="banque.saisir"><button class="btn primary" data-action="op-entree">+ Entrée d'argent</button><button class="btn" data-action="op-virement">Virement fournisseur</button><button class="btn" data-action="op-transfert">Transfert en caisse</button><button class="btn" data-action="op-versement">Versement caisse → banque</button></span>`)}
    ${barrePeriode(`<label>Compte<select data-f="compte">${optionsComptes(f.compte, true)}</select></label>
      <label>Nature<select data-f="nature"><option value="">Toutes</option>${Object.entries(NATURES).map(([k, [l]]) => `<option value="${k}" ${f.nature === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`)}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Date</th><th>N° / Nature</th><th>Libellé</th><th>Provenance des fonds</th><th>Banque destinataire</th><th class="num">Débit</th><th class="num">Crédit</th><th>Document</th><th></th></tr></thead>
      <tbody>${ops.map((o) => `<tr class="${o.annulee ? 'strike' : ''}">
        <td class="nowrap">${fd(o.date)}</td>
        <td class="keep nowrap">${esc(o.numero)}<br><span class="badge ${NATURES[o.nature][1]}">${NATURES[o.nature][0]}</span>${o.annulee ? ` <span class="badge warn" title="${esc(o.motifAnnulation)}">Annulée</span>` : ''}</td>
        <td>${esc(o.libelle)}${o.fournisseurNom ? `<br><small class="muted">${esc(o.fournisseurNom)}</small>` : ''}${o.reference ? `<br><small class="muted">Réf. ${esc(o.reference)}</small>` : ''}</td>
        <td>${esc(o.provenance)}</td><td>${esc(o.banqueDestinataire)}</td>
        <td class="num">${o.sens === 'entree' ? nb(o.montant) : ''}</td><td class="num">${o.sens === 'sortie' ? nb(o.montant) : ''}</td>
        <td class="keep nowrap">${o.ordreId ? `<button class="btn sm" data-action="voir-ordre" data-id="${o.ordreId}">${esc(o.ordreNumero)}</button>` : ''}${o.bonId ? `<button class="btn sm" data-action="voir-bon" data-id="${o.bonId}">${esc(o.bonNumero)}</button>` : ''}</td>
        <td class="keep">${!o.annulee && peut('banque.annuler') ? `<button class="btn sm danger" data-action="op-annuler" data-id="${o._id}" data-num="${esc(o.numero)}">Annuler</button>` : ''}</td>
      </tr>`).join('') || vide(10)}</tbody>
      <tfoot><tr><td colspan="6">Totaux de la sélection (hors opérations annulées)</td><td class="num">${nb(tD)}</td><td class="num">${nb(tC)}</td><td colspan="2"></td></tr></tfoot>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); lierFiltres(root); },
};

function lierFiltres(root) {
  $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { S.filtres[el.dataset.f] = el.value; afficherPage(); }));
}

/* Formulaire : entrée d'argent */
ACTIONS['op-entree'] = () => {
  if (!exigerComptes()) return;
  const c0 = S.comptes.find((c) => c.actif !== false);
  ouvrirModale("Entrée d'argent en banque", `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Montant (${esc(S.params.devise)})<input type="number" name="montant" min="0" step="any" required></label>
    <label>Compte bancaire crédité des fonds<select name="compteId" required>${optionsComptes(c0._id)}</select></label>
    <label>Catégorie<select name="categorie" required>${optionsListe(S.params.categoriesEncaissement)}</select></label>
    <label class="full">Provenance des fonds<input name="provenance" required placeholder="Ex. : Client SOTRA – règlement facture F-2026-045, Subvention ministère…"></label>
    <label class="full">Banque destinataire<input name="banqueDestinataire" value="${esc(`${c0.banque} – ${c0.numero}`)}" required></label>
    <label class="full">Libellé de l'opération<input name="libelle" required></label>
    <label class="full">Référence (n° chèque, avis de crédit…)<input name="reference"></label>
  </div>${piedForm()}</form>`, (b) => {
    const sel = $('[name=compteId]', b); const dest = $('[name=banqueDestinataire]', b);
    sel.addEventListener('change', () => { const c = S.comptes.find((x) => x._id === sel.value); dest.value = `${c.banque} – ${c.numero}`; });
    lierFormulaire($('#f', b), async (d) => {
      await api('POST', '/api/operations/entree', d);
      fermerModale(); toast('Entrée bancaire enregistrée.', 'ok'); afficherPage();
    });
  });
};

/* Formulaire : virement fournisseur */
ACTIONS['op-virement'] = () => {
  if (!exigerComptes()) return;
  const fs = S.fournisseurs.filter((f) => f.actif !== false);
  if (!fs.length) { toast("Ajoutez d'abord un fournisseur (menu Fournisseurs).", 'err'); return; }
  ouvrirModale('Virement à un fournisseur', `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Montant (${esc(S.params.devise)})<input type="number" name="montant" min="0" step="any" required></label>
    <label class="full">Compte bancaire à débiter (provenance des fonds)<select name="compteId" required>${optionsComptes(S.comptes.find((c) => c.actif !== false)._id)}</select></label>
    <label class="full">Fournisseur bénéficiaire<select name="fournisseurId" required>${fs.map((f) => `<option value="${f._id}">${esc(f.nom)}</option>`).join('')}</select></label>
    <label>Banque destinataire (banque du fournisseur)<input name="banqueDestinataire" required></label>
    <label>N° de compte du bénéficiaire<input name="compteBeneficiaire" required></label>
    <label>Catégorie<select name="categorie">${optionsListe(S.params.categoriesDecaissement, 'Achats fournisseurs')}</select></label>
    <label>Référence (facture, bon de commande…)<input name="reference"></label>
    <label class="full">Motif du virement<input name="libelle" required placeholder="Ex. : Règlement facture n° 1254 du 12/10/2026"></label>
  </div><p class="muted" style="margin:10px 0 0;font-size:12.5px">L'ordre de virement officiel sera généré automatiquement et numéroté.</p>${piedForm('Enregistrer et générer l\'ordre')}</form>`, (b) => {
    const fsel = $('[name=fournisseurId]', b);
    const remplir = () => { const f = S.fournisseurs.find((x) => x._id === fsel.value); $('[name=banqueDestinataire]', b).value = f.banque || ''; $('[name=compteBeneficiaire]', b).value = f.numeroCompte || ''; };
    fsel.addEventListener('change', remplir); remplir();
    lierFormulaire($('#f', b), async (d) => {
      const r = await api('POST', '/api/operations/virement', d);
      fermerModale(); toast(`Virement enregistré – ordre ${r.ordre.numero} généré.`, 'ok'); afficherPage();
      docOrdre(r.ordre);
    });
  });
};

/* Formulaire : transfert banque → caisse */
ACTIONS['op-transfert'] = () => {
  if (!exigerComptes()) return;
  ouvrirModale('Transfert de la banque vers la caisse', `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Montant (${esc(S.params.devise)})<input type="number" name="montant" min="0" step="any" required></label>
    <label class="full">Compte bancaire à débiter (provenance des fonds)<select name="compteId" required>${optionsComptes(S.comptes.find((c) => c.actif !== false)._id)}</select></label>
    <label>Porteur des fonds (personne ayant retiré)<input name="porteur"></label>
    <label>Référence (n° chèque de retrait…)<input name="reference"></label>
    <label class="full">Libellé<input name="libelle" required value="Approvisionnement de la caisse"></label>
  </div><p class="muted" style="margin:10px 0 0;font-size:12.5px">Un bon d'entrée caisse sera généré automatiquement. Banque destinataire : Caisse.</p>${piedForm('Enregistrer et générer le bon')}</form>`, (b) => {
    lierFormulaire($('#f', b), async (d) => {
      const r = await api('POST', '/api/operations/transfert-caisse', d);
      fermerModale(); toast(`Transfert enregistré – bon d'entrée ${r.bon.numero} généré.`, 'ok'); afficherPage();
      docBon(r.bon);
    });
  });
};

/* Formulaire : versement caisse → banque */
ACTIONS['op-versement'] = () => {
  if (!exigerComptes()) return;
  ouvrirModale('Versement de la caisse en banque', `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Montant (${esc(S.params.devise)})<input type="number" name="montant" min="0" step="any" required></label>
    <label class="full">Compte bancaire crédité des fonds (banque destinataire)<select name="compteId" required>${optionsComptes(S.comptes.find((c) => c.actif !== false)._id)}</select></label>
    <label>Référence (bordereau de versement)<input name="reference"></label>
    <label>Libellé<input name="libelle" required value="Versement des espèces en banque"></label>
  </div><p class="muted" style="margin:10px 0 0;font-size:12.5px">Un bon de sortie caisse sera généré automatiquement. Provenance des fonds : Caisse.</p>${piedForm()}</form>`, (b) => {
    lierFormulaire($('#f', b), async (d) => {
      const r = await api('POST', '/api/operations/versement-caisse', d);
      fermerModale(); toast(`Versement enregistré – bon de sortie ${r.bon.numero} généré.`, 'ok'); afficherPage();
      docBon(r.bon);
    });
  });
};

function demanderMotif(titre, texte, url) {
  ouvrirModale(titre, `<form id="f"><p style="margin-top:0">${texte}</p><div class="form-grid">
    <label class="full">Motif de l'annulation (obligatoire, conservé dans le journal d'audit)<textarea name="motif" required></textarea></label>
  </div>${piedForm("Confirmer l'annulation")}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    await api('POST', url, d); fermerModale(); toast('Annulation enregistrée.', 'ok'); afficherPage();
  }));
}
ACTIONS['op-annuler'] = (ds) => demanderMotif(`Annuler l'opération ${ds.num}`, "L'opération restera visible (barrée) mais ne sera plus prise en compte dans les soldes et les états. Les documents liés (ordre de virement, bon de caisse) seront également annulés.", `/api/operations/${ds.id}/annuler`);
ACTIONS['voir-ordre'] = async (ds) => docOrdre(await api('GET', `/api/ordres/${ds.id}`));
ACTIONS['voir-bon'] = async (ds) => docBon(await api('GET', `/api/bons/${ds.id}`));
ACTIONS['voir-pv'] = async (ds) => docPV(await api('GET', `/api/pv/${ds.id}`));

/* =================================================== Ordres de virement */
PAGES.ordres = {
  async render() {
    const ordres = await api('GET', `/api/ordres?${qs(per())}`);
    return `${tete('Ordres de virement', 'Générés automatiquement à chaque paiement fournisseur', '<span data-perm="banque.saisir"><button class="btn primary" data-action="op-virement">Nouveau virement fournisseur</button></span>')}
    ${barrePeriode()}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>N° ordre</th><th>Date</th><th>Bénéficiaire</th><th>Banque destinataire</th><th>Compte débité</th><th>Motif</th><th class="num">Montant</th><th></th></tr></thead>
      <tbody>${ordres.map((o) => `<tr class="${o.annulee ? 'strike' : ''}"><td class="nowrap">${esc(o.numero)}</td><td>${fd(o.date)}</td><td>${esc(o.beneficiaire.nom)}</td><td>${esc(o.beneficiaire.banque)}<br><small class="muted">${esc(o.beneficiaire.numeroCompte)}</small></td><td>${esc(o.donneurOrdre.banque)}<br><small class="muted">${esc(o.donneurOrdre.numero)}</small></td><td>${esc(o.motif)}</td><td class="num">${nb(o.montant)}</td><td class="keep"><button class="btn sm" data-action="voir-ordre" data-id="${o._id}">Imprimer / PDF</button></td></tr>`).join('') || vide(8)}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); },
};

/* ========================================================= Fournisseurs */
PAGES.fournisseurs = {
  async render() {
    return `${tete('Fournisseurs', 'Le nom, la banque et le compte du fournisseur sont repris sur chaque ordre de virement', '<span data-perm="fournisseurs.gerer"><button class="btn primary" data-action="fournisseur-edit">+ Nouveau fournisseur</button></span>')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Nom</th><th>Banque</th><th>N° de compte</th><th>Contact</th><th>NIF</th><th>Statut</th><th></th></tr></thead>
      <tbody>${S.fournisseurs.map((f) => `<tr><td><b>${esc(f.nom)}</b>${f.adresse ? `<br><small class="muted">${esc(f.adresse)}</small>` : ''}</td><td>${esc(f.banque)}</td><td>${esc(f.numeroCompte)}</td><td>${esc([f.telephone, f.email].filter(Boolean).join(' · '))}</td><td>${esc(f.nif)}</td><td>${f.actif === false ? '<span class="badge">Inactif</span>' : '<span class="badge in">Actif</span>'}</td><td><span data-perm="fournisseurs.gerer"><button class="btn sm" data-action="fournisseur-edit" data-id="${f._id}">Modifier</button></span></td></tr>`).join('') || vide(7, 'Aucun fournisseur enregistré.')}</tbody>
    </table></div></div>`;
  },
};
ACTIONS['fournisseur-edit'] = (ds) => {
  const f = S.fournisseurs.find((x) => x._id === ds.id) || {};
  ouvrirModale(ds.id ? 'Modifier le fournisseur' : 'Nouveau fournisseur', `<form id="f"><div class="form-grid">
    <label class="full">Nom / Raison sociale<input name="nom" value="${esc(f.nom)}" required></label>
    <label>Banque<input name="banque" value="${esc(f.banque)}"></label>
    <label>N° de compte / RIB / IBAN<input name="numeroCompte" value="${esc(f.numeroCompte)}"></label>
    <label class="full">Adresse<input name="adresse" value="${esc(f.adresse)}"></label>
    <label>Téléphone<input name="telephone" value="${esc(f.telephone)}"></label>
    <label>E-mail<input name="email" type="email" value="${esc(f.email)}"></label>
    <label>NIF / IFU<input name="nif" value="${esc(f.nif)}"></label>
    <label>Statut<select name="actif"><option value="1">Actif</option><option value="0" ${f.actif === false ? 'selected' : ''}>Inactif</option></select></label>
  </div>${piedForm()}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    d.actif = d.actif === '1';
    await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/fournisseurs/${ds.id}` : '/api/fournisseurs', d);
    await chargerReference(); fermerModale(); toast('Fournisseur enregistré.', 'ok'); afficherPage();
  }));
};

/* ===================================================== Comptes bancaires */
PAGES.comptes = {
  async render() {
    const d = await api('GET', '/api/tableau-de-bord');
    const solde = (id) => (d.soldes.find((s) => s._id === id) || {}).solde;
    return `${tete('Comptes bancaires', 'Comptes de l\'entreprise sur lesquels sont enregistrées les opérations', peut('comptes.gerer') ? '<button class="btn primary" data-action="compte-edit">+ Nouveau compte</button>' : '')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Banque</th><th>Intitulé</th><th>N° de compte</th><th>IBAN / SWIFT</th><th class="num">Solde initial</th><th class="num">Solde actuel</th><th>Statut</th><th></th></tr></thead>
      <tbody>${S.comptes.map((c) => `<tr><td><b>${esc(c.banque)}</b>${c.agence ? `<br><small class="muted">${esc(c.agence)}</small>` : ''}</td><td>${esc(c.intitule)}</td><td>${esc(c.numero)}</td><td>${esc([c.iban, c.swift].filter(Boolean).join(' / '))}</td><td class="num">${nb(c.soldeInitial)}</td><td class="num">${solde(c._id) === undefined ? '—' : nb(solde(c._id))}</td><td>${c.actif === false ? '<span class="badge">Inactif</span>' : '<span class="badge in">Actif</span>'}</td><td>${peut('comptes.gerer') ? `<button class="btn sm" data-action="compte-edit" data-id="${c._id}">Modifier</button>` : ''}</td></tr>`).join('') || vide(8, 'Aucun compte bancaire.')}</tbody>
    </table></div></div>`;
  },
};
ACTIONS['compte-edit'] = (ds) => {
  const c = S.comptes.find((x) => x._id === ds.id) || {};
  ouvrirModale(ds.id ? 'Modifier le compte bancaire' : 'Nouveau compte bancaire', `<form id="f"><div class="form-grid">
    <label>Banque<input name="banque" value="${esc(c.banque)}" required></label>
    <label>Agence bancaire (guichet)<input name="agence" value="${esc(c.agence)}"></label>
    <label>Intitulé du compte<input name="intitule" value="${esc(c.intitule)}" placeholder="Compte courant, compte projet…"></label>
    <label>N° de compte<input name="numero" value="${esc(c.numero)}" required></label>
    <label>IBAN / RIB<input name="iban" value="${esc(c.iban)}"></label>
    <label>Code SWIFT / BIC<input name="swift" value="${esc(c.swift)}"></label>
    <label>Solde initial (${esc(S.params.devise)})<input type="number" step="any" name="soldeInitial" value="${c.soldeInitial || 0}" ${ds.id ? 'title="Non modifiable dès que des opérations existent"' : ''}><span class="help">Non modifiable une fois des opérations saisies.</span></label>
    <label>Statut<select name="actif"><option value="1">Actif</option><option value="0" ${c.actif === false ? 'selected' : ''}>Inactif</option></select></label>
  </div>${piedForm()}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    d.actif = d.actif === '1';
    await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/comptes/${ds.id}` : '/api/comptes', d);
    await chargerReference(); fermerModale(); toast('Compte enregistré.', 'ok'); afficherPage();
  }));
};

/* ======================================================= Bons de caisse */
PAGES.caisse = {
  async render() {
    const f = S.filtres;
    const [bons, solde, clotures] = await Promise.all([
      api('GET', `/api/bons?${qs({ ...per(), type: f.typeBon })}`), api('GET', '/api/caisse/solde'), api('GET', '/api/clotures'),
    ]);
    const derniere = clotures[0];
    return `${tete('Bons de caisse', `Solde de caisse actuel : <b>${money(solde.solde)}</b> · Dernière clôture : ${derniere ? `${fd(derniere.date)} (${money(derniere.soldeCloture)})` : 'aucune'}`,
      `<span class="actions"><button class="btn primary" data-perm="caisse.saisir" data-action="bon-nouveau" data-type="entree">+ Bon d'entrée</button><button class="btn primary" data-perm="caisse.saisir" data-action="bon-nouveau" data-type="sortie">+ Bon de sortie</button><button class="btn" data-perm="caisse.cloturer" data-action="cloturer">Clôturer une journée</button></span>`)}
    ${barrePeriode(`<label>Type<select data-f="typeBon"><option value="">Tous</option><option value="entree" ${f.typeBon === 'entree' ? 'selected' : ''}>Entrées</option><option value="sortie" ${f.typeBon === 'sortie' ? 'selected' : ''}>Sorties</option></select></label>`)}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>N° bon</th><th>Date</th><th>Type</th><th>Libellé</th><th>Remettant / Bénéficiaire</th><th>Imputation</th><th class="num">Montant</th><th></th></tr></thead>
      <tbody>${bons.map((b) => `<tr class="${b.annulee ? 'strike' : ''}"><td class="nowrap">${esc(b.numero)}</td><td>${fd(b.date)}</td>
        <td class="keep"><span class="badge ${b.type === 'entree' ? 'in' : 'out'}">${b.type === 'entree' ? 'Entrée' : 'Sortie'}</span>${b.interne ? ' <span class="badge int">Banque</span>' : ''}${b.annulee ? ' <span class="badge warn">Annulé</span>' : ''}</td>
        <td>${esc(b.libelle)}</td><td>${esc(b.tiers)}</td><td>${esc(b.categorie)}</td><td class="num">${nb(b.montant)}</td>
        <td class="keep nowrap"><button class="btn sm" data-action="voir-bon" data-id="${b._id}">Imprimer / PDF</button>${!b.annulee && !b.operationId && peut('caisse.annuler') && !(derniere && b.date <= derniere.date) ? ` <button class="btn sm danger" data-action="bon-annuler" data-id="${b._id}" data-num="${esc(b.numero)}">Annuler</button>` : ''}</td></tr>`).join('') || vide(8)}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); lierFiltres(root); },
};
ACTIONS['bon-nouveau'] = (ds) => {
  const entree = ds.type === 'entree';
  ouvrirModale(entree ? "Bon d'entrée caisse" : 'Bon de sortie caisse', `<form id="f"><div class="form-grid">
    <label>Date<input type="date" name="date" value="${today()}" required></label>
    <label>Montant (${esc(S.params.devise)})<input type="number" name="montant" min="0" step="any" required></label>
    <label>${entree ? 'Reçu de (remettant)' : 'Payé à (bénéficiaire)'}<input name="tiers" required></label>
    <label>Imputation<select name="categorie">${optionsListe(entree ? S.params.categoriesEncaissement : S.params.categoriesDecaissement)}</select></label>
    <label class="full">Motif<input name="libelle" required></label>
    <label class="full">Pièce justificative (facture, reçu…)<input name="piece"></label>
  </div><p class="muted" style="margin:10px 0 0;font-size:12.5px">Pour approvisionner la caisse depuis la banque, utilisez « Transfert en caisse » : le bon d'entrée est alors généré automatiquement.</p>${piedForm('Enregistrer et imprimer')}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    d.type = ds.type;
    const bon = await api('POST', '/api/bons', d);
    fermerModale(); toast(`Bon ${bon.numero} enregistré.`, 'ok'); afficherPage(); docBon(bon);
  }));
};
ACTIONS['bon-annuler'] = (ds) => demanderMotif(`Annuler le bon ${ds.num}`, 'Le bon restera visible (barré) mais ne sera plus pris en compte dans le livre de caisse.', `/api/bons/${ds.id}/annuler`);
ACTIONS.cloturer = async () => {
  const cl = await api('GET', '/api/clotures');
  ouvrirModale('Clôture journalière de la caisse', `<form id="f">
    <p style="margin-top:0">La clôture fige le livre de caisse : plus aucun bon ne pourra être saisi ou annulé à cette date ni avant. Clôtures récentes : ${cl.slice(0, 5).map((c) => fd(c.date)).join(', ') || 'aucune'}.</p>
    <div class="form-grid"><label>Journée à clôturer<input type="date" name="date" value="${today()}" required></label><label>Solde de caisse à cette date<input id="sc" readonly></label></div>
    ${piedForm('Clôturer la journée')}</form>`, (b) => {
    const maj = async () => { try { $('#sc', b).value = money((await api('GET', `/api/caisse/solde?date=${$('[name=date]', b).value}`)).solde); } catch { $('#sc', b).value = ''; } };
    $('[name=date]', b).addEventListener('change', maj); maj();
    lierFormulaire($('#f', b), async (d) => { await api('POST', '/api/clotures', d); fermerModale(); toast(`Journée du ${fd(d.date)} clôturée.`, 'ok'); afficherPage(); });
  });
};

/* ======================================================= Livre de caisse */
PAGES.livre = {
  async render() {
    const d = await api('GET', `/api/etats/livre-caisse?${qs(per())}`);
    this.data = d;
    return `${tete('Livre de caisse', 'Mis à jour en temps réel à chaque bon d\'entrée ou de sortie', '<button class="btn primary" data-action="etat" data-nom="livre">Imprimer / PDF</button>')}
    ${barrePeriode()}
    <div class="kpis">
      <div class="kpi"><div class="lbl">Solde d'ouverture</div><div class="val">${money(d.soldeOuverture)}</div></div>
      <div class="kpi"><div class="lbl">Total entrées</div><div class="val pos">${money(d.totalEntrees)}</div></div>
      <div class="kpi"><div class="lbl">Total sorties</div><div class="val neg">${money(d.totalSorties)}</div></div>
      <div class="kpi main"><div class="lbl">Solde de clôture</div><div class="val">${money(d.soldeCloture)}</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Date</th><th>N° bon</th><th>Libellé</th><th>Remettant / Bénéficiaire</th><th class="num">Entrées</th><th class="num">Sorties</th><th class="num">Solde</th></tr></thead>
      <tbody>${d.jours.map((j) => `<tr><td colspan="7" style="background:#f4f6fa"><b>${dLong(j.date)}</b> <span class="muted">· solde de début ${nb(j.soldeDebut)}</span>${j.cloture ? ' <span class="badge in">Clôturée</span>' : ''}</td></tr>
        ${j.lignes.map((l) => `<tr><td>${fd(j.date)}</td><td class="nowrap"><button class="link" data-action="voir-bon" data-id="${l._id}">${esc(l.numero)}</button></td><td>${esc(l.libelle)}</td><td>${esc(l.tiers)}</td><td class="num">${l.entree ? nb(l.entree) : ''}</td><td class="num">${l.sortie ? nb(l.sortie) : ''}</td><td class="num">${nb(l.solde)}</td></tr>`).join('')}
        <tr><td colspan="4" class="muted">Total de la journée</td><td class="num"><b>${nb(j.entrees)}</b></td><td class="num"><b>${nb(j.sorties)}</b></td><td class="num"><b>${nb(j.soldeFin)}</b></td></tr>`).join('') || vide(7)}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); },
};

/* ================================================ Contrôle de caisse (PV) */
PAGES.controle = {
  async render() {
    const pvs = await api('GET', `/api/pv?${qs(per())}`);
    return `${tete('Contrôle de caisse', 'Procès-verbaux de contrôle avec billetage et rapprochement', '<span data-perm="pv.saisir"><button class="btn primary" data-action="pv-nouveau">+ Nouveau contrôle de caisse</button></span>')}
    ${barrePeriode()}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>N° PV</th><th>Date</th><th>Caissier</th><th>Contrôleur</th><th class="num">Solde théorique</th><th class="num">Encaisse physique</th><th class="num">Écart</th><th></th></tr></thead>
      <tbody>${pvs.map((p) => `<tr><td>${esc(p.numero)}</td><td>${fd(p.date)}${p.heure ? ` ${esc(p.heure)}` : ''}</td><td>${esc(p.caissier)}</td><td>${esc(p.controleur)}</td><td class="num">${nb(p.soldeTheorique)}</td><td class="num">${nb(p.soldePhysique)}</td><td class="num ${p.ecart < 0 ? 'neg' : p.ecart > 0 ? 'pos' : ''}">${p.ecart === 0 ? '<span class="badge in">Conforme</span>' : nb(p.ecart)}</td><td><button class="btn sm" data-action="voir-pv" data-id="${p._id}">Imprimer / PDF</button></td></tr>`).join('') || vide(8, 'Aucun contrôle sur la période.')}</tbody>
    </table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); },
};

function coupuresParDefaut() {
  const dv = (S.params.devise || '').toUpperCase();
  if (/USD|US\$|\$/.test(dv)) return { billet: [100, 50, 20, 10, 5, 2, 1], piece: [1, 0.5, 0.25, 0.1, 0.05, 0.01] };
  if (/EUR|€/.test(dv)) return { billet: [500, 200, 100, 50, 20, 10, 5], piece: [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01] };
  if (/CFA|XOF|XAF/.test(dv)) return { billet: [10000, 5000, 2000, 1000, 500], piece: [500, 250, 200, 100, 50, 25, 10, 5, 1] };
  return { billet: [10000, 5000, 2000, 1000, 500], piece: [500, 200, 100, 50, 25, 10, 5, 1] };
}

ACTIONS['pv-nouveau'] = () => {
  const c = coupuresParDefaut();
  const lignes = [...c.billet.map((v) => ['billet', v]), ...c.piece.map((v) => ['piece', v])];
  const sg = S.params.signataires;
  ouvrirModale('Contrôle de caisse – procès-verbal', `<form id="f">
    <div class="form-grid">
      <label>Date du contrôle<input type="date" name="date" value="${today()}" required></label>
      <label>Heure<input type="time" name="heure" value="${new Date().toTimeString().slice(0, 5)}"></label>
      <label>Caissier(ère)<input name="caissier" value="${esc(sg.caissier)}" required></label>
      <label>Contrôleur<input name="controleur" value="${esc(sg.controleur)}" required></label>
      <label>Témoin (facultatif)<input name="temoin"></label>
    </div>
    <h3 style="margin:16px 0 8px">Billetage</h3>
    <table class="data billetage"><thead><tr><th>Nature</th><th class="num">Valeur</th><th class="num">Nombre</th><th class="num">Montant</th></tr></thead><tbody>
      ${lignes.map(([t, v], i) => `<tr data-i="${i}"><td>${t === 'billet' ? 'Billet' : 'Pièce'}<input type="hidden" data-k="type" value="${t}"></td><td class="num"><input type="number" step="any" min="0" data-k="valeur" value="${v}"></td><td class="num"><input type="number" min="0" step="1" data-k="quantite" value="0"></td><td class="num" data-tot>0</td></tr>`).join('')}
      <tr><td colspan="2"><input name="libelleAutresValeurs" placeholder="Autres valeurs (chèques, bons…)"></td><td></td><td class="num"><input type="number" step="any" min="0" name="autresValeurs" value="0" style="width:110px;text-align:right"></td></tr>
    </tbody></table>
    <div class="recap"><div>Solde théorique<b id="r-theo">…</b></div><div>Encaisse physique<b id="r-phys">0</b></div><div>Écart<b id="r-ecart">…</b></div></div>
    <div class="form-grid" style="margin-top:12px"><label class="full">Observations<textarea name="observations"></textarea></label></div>
    ${piedForm('Enregistrer le PV')}</form>`, (b) => {
    let theo = 0;
    const calc = () => {
      let t = 0;
      $$('tr[data-i]', b).forEach((tr) => {
        const v = Number($('[data-k=valeur]', tr).value) || 0; const q = Number($('[data-k=quantite]', tr).value) || 0;
        $('[data-tot]', tr).textContent = nb(v * q); t += v * q;
      });
      t += Number($('[name=autresValeurs]', b).value) || 0;
      $('#r-phys', b).textContent = nb(t);
      const e = Math.round((t - theo) * 100) / 100;
      $('#r-ecart', b).textContent = e === 0 ? 'Conforme' : nb(e);
      $('#r-ecart', b).className = e < 0 ? 'neg' : e > 0 ? 'pos' : '';
    };
    const chargerTheo = async () => {
      try { theo = (await api('GET', `/api/caisse/solde?date=${$('[name=date]', b).value}`)).solde; $('#r-theo', b).textContent = nb(theo); } catch { $('#r-theo', b).textContent = '—'; }
      calc();
    };
    $('#f', b).addEventListener('input', calc);
    $('[name=date]', b).addEventListener('change', chargerTheo);
    chargerTheo();
    lierFormulaire($('#f', b), async (d) => {
      d.billetage = $$('tr[data-i]', b).map((tr) => ({ type: $('[data-k=type]', tr).value, valeur: Number($('[data-k=valeur]', tr).value), quantite: Number($('[data-k=quantite]', tr).value) })).filter((l) => l.quantite > 0);
      const pv = await api('POST', '/api/pv', d);
      fermerModale(); toast(`PV ${pv.numero} enregistré.`, 'ok'); afficherPage(); docPV(pv);
    });
  });
};

/* ======================================================= États de sortie */
PAGES.etats = {
  async render() {
    const pvs = await api('GET', `/api/pv?${qs(per())}`);
    const f = S.filtres;
    return `${tete('États de sortie', 'Chaque état reprend automatiquement l\'entête défini dans « Entête & paramètres »')}
    ${barrePeriode()}
    <div class="etats">
      <div class="etat"><h2>Journal banque</h2><p>Opérations bancaires chronologiques avec provenance des fonds, banque destinataire, débits, crédits et solde progressif.</p>
        <div class="opts"><label>Compte<select data-f="etatCompte">${optionsComptes(f.etatCompte, true)}</select></label></div>
        <button class="btn primary" data-action="etat" data-nom="journal">Afficher · Imprimer · PDF</button></div>
      <div class="etat"><h2>PV de contrôle de caisse</h2><p>Procès-verbal avec billetage, solde théorique, encaisse physique et écart.</p>
        <div class="opts"><label>Procès-verbal<select id="pv-sel">${pvs.map((p) => `<option value="${p._id}">${esc(p.numero)} – ${fd(p.date)}</option>`).join('') || '<option value="">Aucun PV sur la période</option>'}</select></label></div>
        <div class="actions"><button class="btn primary" data-action="etat" data-nom="pv" ${pvs.length ? '' : 'disabled'}>Afficher · Imprimer · PDF</button><span data-perm="pv.saisir"><button class="btn" data-action="pv-nouveau">Nouveau contrôle</button></span></div></div>
      <div class="etat"><h2>Plan de trésorerie</h2><p>Encaissements et décaissements mensuels par rubrique, soldes de début et de fin de mois (banques + caisse).</p>
        <div class="opts"><label>Version<select data-f="modeTreso"><option value="realise">Réalisé</option><option value="prevu" ${f.modeTreso === 'prevu' ? 'selected' : ''}>Prévisionnel</option><option value="comparatif" ${f.modeTreso === 'comparatif' ? 'selected' : ''}>Comparatif prévu / réalisé</option></select></label></div>
        <button class="btn primary" data-action="etat" data-nom="tresorerie">Afficher · Imprimer · PDF</button></div>
      <div class="etat"><h2>Rapport financier</h2><p>Schéma de présentation : situation de trésorerie, ressources, emplois, synthèse des flux, contrôles de caisse, indicateurs et observations.</p>
        <button class="btn primary" data-action="etat" data-nom="rapport">Afficher · Imprimer · PDF</button></div>
      <div class="etat"><h2>Livre de caisse</h2><p>Mouvements de caisse journée par journée avec soldes de début et de fin de journée.</p>
        <button class="btn primary" data-action="etat" data-nom="livre">Afficher · Imprimer · PDF</button></div>
    </div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); $$('[data-f]', root).forEach((el) => el.addEventListener('change', () => { S.filtres[el.dataset.f] = el.value; })); },
};
ACTIONS.etat = async (ds) => {
  const p = { ...S.periode };
  try {
    if (ds.nom === 'journal') docJournal(await api('GET', `/api/etats/journal-banque?${qs({ ...per(), compteId: S.filtres.etatCompte })}`), p);
    else if (ds.nom === 'livre') docLivre(await api('GET', `/api/etats/livre-caisse?${qs(per())}`), p);
    else if (ds.nom === 'tresorerie') docTresorerie(await api('GET', `/api/etats/tresorerie?${qs(per())}`), p, S.filtres.modeTreso || 'realise');
    else if (ds.nom === 'rapport') docRapport(await api('GET', `/api/etats/rapport?${qs(per())}`), p);
    else if (ds.nom === 'pv') { const id = $('#pv-sel').value; if (id) docPV(await api('GET', `/api/pv/${id}`)); }
  } catch (e) { toast(e.message, 'err'); }
};

/* ============================================== Prévisions de trésorerie */
PAGES.previsions = {
  dirty: false,
  async render() {
    this.dirty = false;
    const an = S.filtres.anneePrev || new Date().getFullYear();
    const pv = await api('GET', `/api/previsions/${an}`);
    const ro = pv.consolide || !peut('previsions.modifier');
    const mois = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
    const bloc = (titre, cle, cats) => `<tr><td colspan="14" style="background:#f4f6fa"><b>${titre}</b></td></tr>
      ${cats.map((c) => `<tr data-cle="${cle}" data-cat="${esc(c)}"><td>${esc(c)}</td>${mois.map((_, i) => `<td><input type="number" step="any" value="${((pv[cle] || {})[c] || [])[i] || ''}" ${ro ? 'readonly' : ''}></td>`).join('')}<td class="num" data-t></td></tr>`).join('')}`;
    return `${tete('Prévisions de trésorerie', 'Montants prévus par mois et par rubrique, utilisés par le plan de trésorerie (versions prévisionnelle et comparative)',
      `<label style="min-width:120px">Année<input type="number" id="an" value="${an}" min="2000" max="2100"></label>${pv.consolide ? '' : '<span data-perm="previsions.modifier"><button class="btn primary" id="save-prev">Enregistrer</button></span>'}`)}
    ${pv.consolide ? '<div class="card" style="background:#eef2ff;border-color:#c5cae9;margin-bottom:12px">Vue consolidée de toutes les agences (lecture seule). Choisissez une agence en haut du menu pour saisir ses prévisions.</div>' : ''}
    <div class="card"><div class="table-wrap"><table class="data prev"><thead><tr><th>Rubrique</th>${mois.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${bloc('Encaissements prévus', 'encaissements', S.params.categoriesEncaissement)}${bloc('Décaissements prévus', 'decaissements', S.params.categoriesDecaissement)}</tbody></table></div></div>`;
  },
  mount(root) {
    const totaux = () => $$('tr[data-cle]', root).forEach((tr) => { $('[data-t]', tr).textContent = nb($$('input', tr).reduce((a, i) => a + (Number(i.value) || 0), 0)); });
    totaux();
    root.addEventListener('input', (e) => { if (e.target.closest('tr[data-cle]')) { this.dirty = true; totaux(); } });
    $('#an', root).addEventListener('change', (e) => { S.filtres.anneePrev = e.target.value; afficherPage(); });
    const btn = $('#save-prev', root);
    if (btn) btn.addEventListener('click', async () => {
      const body = { encaissements: {}, decaissements: {} };
      $$('tr[data-cle]', root).forEach((tr) => { body[tr.dataset.cle][tr.dataset.cat] = $$('input', tr).map((i) => Number(i.value) || 0); });
      try { await api('PUT', `/api/previsions/${$('#an', root).value}`, body); this.dirty = false; toast('Prévisions enregistrées.', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
  },
};

/* ================================================= Entête & paramètres */
PAGES.parametres = {
  dirty: false,
  async render() {
    this.dirty = false;
    const p = S.params; const e = p.entreprise; const s = p.signataires;
    const ch = (n, l, v, full = false, ph = '') => `<label class="${full ? 'full' : ''}">${l}<input name="${n}" value="${esc(v)}" placeholder="${esc(ph)}"></label>`;
    return `${tete('Entête & paramètres', 'Ces informations apparaissent automatiquement en entête de tous les états et documents imprimés')}
    <form id="fp" class="entete-layout">
      <div>
        <fieldset class="fieldset"><legend>Entête des documents</legend><div class="form-grid">
          ${ch('e.nom', "Nom de l'entreprise / structure", e.nom, true)}
          ${ch('e.sigle', 'Sigle', e.sigle)}${ch('e.formeJuridique', 'Forme juridique / capital', e.formeJuridique, false, 'SARL au capital de …')}
          ${ch('e.adresse', 'Adresse', e.adresse, true, 'Rue, quartier, BP…')}
          ${ch('e.ville', 'Ville', e.ville)}${ch('e.pays', 'Pays', e.pays)}
          ${ch('e.telephone', 'Téléphone(s)', e.telephone)}${ch('e.email', 'E-mail', e.email)}
          ${ch('e.siteWeb', 'Site web', e.siteWeb)}${ch('e.rccm', 'RCCM', e.rccm)}
          ${ch('e.nif', 'NIF / IFU / N° contribuable', e.nif)}
          ${ch('e.ligneComplementaire', 'Ligne complémentaire', e.ligneComplementaire, true, 'Ex. : Projet XYZ – Financement ABC, exercice 2026')}
          ${ch('e.piedDePage', 'Pied de page', e.piedDePage, true, 'Ex. : Document interne – confidentiel')}
          <div class="full"><label>Logo (PNG, JPEG, SVG – redimensionné automatiquement)</label>
            <div class="logo-zone" style="margin-top:6px"><img id="logo-img" ${e.logo ? `src="${esc(e.logo)}"` : 'hidden'} alt="Logo"><input type="file" id="logo-file" accept="image/*" style="width:auto"><button type="button" class="btn sm" id="logo-del" ${e.logo ? '' : 'hidden'}>Retirer</button></div></div>
        </div></fieldset>
        <fieldset class="fieldset"><legend>Signataires</legend><div class="form-grid">
          ${['caissier', 'comptable', 'directeur', 'controleur'].map((k) => {
    const t = `titre${k[0].toUpperCase()}${k.slice(1)}`;
    return `<label>Titre<input name="s.${t}" value="${esc(s[t])}"></label><label>Nom<input name="s.${k}" value="${esc(s[k])}"></label>`;
  }).join('')}
        </div></fieldset>
        <fieldset class="fieldset"><legend>Monnaie et caisse</legend><div class="form-grid">
          ${ch('devise', 'Devise (abréviation)', p.devise)}${ch('deviseLettres', 'Devise en lettres (pluriel)', p.deviseLettres, false, 'dollars américains, euros…')}${ch('subdivisionLettres', 'Subdivision en lettres (pluriel)', p.subdivisionLettres, false, 'cents, centimes…')}
          <label>Décimales<select name="decimales"><option value="2">2 (ex. USD, EUR)</option><option value="0" ${p.decimales === 0 ? 'selected' : ''}>0 (ex. FCFA)</option></select></label>
          <p class="full muted" style="margin:0;font-size:12.5px">Le solde initial de la caisse se définit pour chaque agence (menu Administration → Agences).</p>
          <label class="full check"><input type="checkbox" name="autoriserDecouvert" ${p.autoriserDecouvert ? 'checked' : ''}> Autoriser le découvert bancaire (solde négatif d'un compte)</label>
        </div></fieldset>
        <fieldset class="fieldset"><legend>Rubriques (une par ligne)</legend><div class="form-grid">
          <label>Encaissements<textarea name="categoriesEncaissement" rows="7">${esc(p.categoriesEncaissement.join('\n'))}</textarea></label>
          <label>Décaissements<textarea name="categoriesDecaissement" rows="7">${esc(p.categoriesDecaissement.join('\n'))}</textarea></label>
        </div></fieldset>
        <p class="form-error" hidden></p>
        <div class="form-foot"><button class="btn primary" type="submit">Enregistrer les paramètres</button></div>
      </div>
      <div class="apercu"><h3>Aperçu de l'entête</h3><div class="feuille-mini" id="apercu"></div></div>
    </form>`;
  },
  mount(root) {
    const form = $('#fp', root);
    let logo = S.params.entreprise.logo || '';
    const lire = () => {
      const fd2 = new FormData(form); const o = { entreprise: { logo }, signataires: {} };
      for (const [k, v] of fd2.entries()) {
        if (k.startsWith('e.')) o.entreprise[k.slice(2)] = v;
        else if (k.startsWith('s.')) o.signataires[k.slice(2)] = v;
        else o[k] = v;
      }
      o.autoriserDecouvert = !!form.autoriserDecouvert.checked;
      o.categoriesEncaissement = String(o.categoriesEncaissement || '').split('\n').map((x) => x.trim()).filter(Boolean);
      o.categoriesDecaissement = String(o.categoriesDecaissement || '').split('\n').map((x) => x.trim()).filter(Boolean);
      o.decimales = Number(o.decimales);
      return o;
    };
    const apercu = () => {
      const old = S.params; const o = lire();
      S.params = { ...old, ...o, entreprise: { ...old.entreprise, ...o.entreprise } };
      $('#apercu', root).innerHTML = `<div class="feuille" style="width:auto;min-height:0;box-shadow:none;margin:0;padding:0">${entete('Journal banque', { periode: S.periode })}<p class="note">… contenu de l'état …</p>${pied()}</div>`;
      S.params = old;
    };
    apercu();
    form.addEventListener('input', () => { this.dirty = true; apercu(); });
    $('#logo-file', root).addEventListener('change', (ev) => {
      const file = ev.target.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 600 / img.width, 240 / img.height);
          const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k) || 1; cv.height = Math.round(img.height * k) || 1;
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          logo = cv.toDataURL('image/png');
          $('#logo-img', root).src = logo; $('#logo-img', root).hidden = false; $('#logo-del', root).hidden = false;
          this.dirty = true; apercu();
        };
        img.onerror = () => toast('Image illisible.', 'err');
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
    $('#logo-del', root).addEventListener('click', () => { logo = ''; $('#logo-img', root).hidden = true; $('#logo-del', root).hidden = true; $('#logo-file', root).value = ''; this.dirty = true; apercu(); });
    lierFormulaire(form, async () => {
      S.params = await api('PUT', '/api/parametres', lire());
      this.dirty = false;
      $('#brand-nom').textContent = S.params.entreprise.sigle || S.params.entreprise.nom;
      toast('Paramètres enregistrés : les états utiliseront ce nouvel entête.', 'ok');
    });
  },
};

/* ================================================= Utilisateurs & rôles */
/* ============================================================ Utilisateurs
   Deux sortes de comptes : l'administrateur (toutes agences, tous droits) et le responsable d'agence
   (une agence, avec les permissions cochées ici). */
const MODELES_DROITS = {
  complet: { nom: "Gestion complète de l'agence", perms: null },
  banque: { nom: 'Banque', perms: ['banque.voir', 'banque.saisir', 'fournisseurs.gerer', 'comptes.gerer', 'etats.voir'] },
  caisse: { nom: 'Caisse', perms: ['caisse.voir', 'caisse.saisir', 'caisse.cloturer', 'pv.voir', 'pv.saisir', 'etats.voir'] },
  stock: { nom: 'Stock', perms: ['stock.voir', 'stock.saisir', 'stock.transferer', 'stock.pertes', 'stock.inventaire', 'stock.valider', 'stock.etats'] },
  lecture: { nom: 'Consultation seule', perms: ['banque.voir', 'caisse.voir', 'pv.voir', 'etats.voir', 'previsions.voir', 'stock.voir', 'stock.etats'] },
};
const nomAgenceId = (id) => ((S.me.agences || []).find((g) => g._id === id) || {}).nom || '';

PAGES.utilisateurs = {
  perm: 'utilisateurs.gerer',
  async render() {
    const [us, perms, inst] = await Promise.all([api('GET', '/api/utilisateurs'), api('GET', '/api/permissions/responsable'), fetch('/api/installation').then((r) => r.json()).catch(() => ({}))]);
    Object.assign(this, { us, perms, adresse: (inst.defaut && inst.defaut.serveurEnLigne) || location.origin });
    const f = S.filtres;
    const recherche = (f.userQ || '').toLowerCase();
    const liste = us.filter((u) => (!f.userAg || (f.userAg === 'admin' ? u.type === 'admin' : u.agenceId === f.userAg))
      && (!f.userSt || (f.userSt === 'actifs' ? u.actif !== false : u.actif === false))
      && (!recherche || `${u.nom} ${u.identifiant} ${u.fonction || ''}`.toLowerCase().includes(recherche)));
    const groupes = [...new Set(perms.map((p) => p.groupe))];
    const resume = (u) => (u.type === 'admin' ? '<span class="badge int">Tous les droits</span>'
      : groupes.map((g) => { const t = perms.filter((p) => p.groupe === g); const n = t.filter((p) => u.permissionsEffectives.includes(p.cle)).length; return n ? `<span class="badge ${n === t.length ? 'in' : ''}">${g} ${n}/${t.length}</span>` : ''; }).join(' ') || '<span class="badge out">Aucun droit</span>');
    const nResp = us.filter((u) => u.type !== 'admin').length;
    return `${tete('Utilisateurs', "Chaque responsable d'agence ne voit que son agence et ne fait que ce que vous avez coché. L'administrateur voit toutes les agences.",
      '<span class="actions"><button class="btn primary" data-action="user-edit">+ Nouveau responsable d\'agence</button></span>')}
    <div class="kpis">
      <div class="kpi"><div class="lbl">Responsables d'agence</div><div class="val">${nResp}</div><div class="sub">${us.filter((u) => u.type !== 'admin' && u.actif !== false).length} actif(s)</div></div>
      <div class="kpi"><div class="lbl">Administrateurs</div><div class="val">${us.length - nResp}</div><div class="sub">Toutes agences, tous droits</div></div>
      <div class="kpi"><div class="lbl">Accès suspendus</div><div class="val">${us.filter((u) => u.actif === false).length}</div><div class="sub">Connexion impossible</div></div>
    </div>
    <div class="filters">
      <label>Agence<select data-f="userAg"><option value="">Toutes</option><option value="admin" ${f.userAg === 'admin' ? 'selected' : ''}>Administrateurs</option>${(S.me.agences || []).map((g) => `<option value="${g._id}" ${f.userAg === g._id ? 'selected' : ''}>${esc(g.nom)}</option>`).join('')}</select></label>
      <label>Statut<select data-f="userSt"><option value="">Tous</option><option value="actifs" ${f.userSt === 'actifs' ? 'selected' : ''}>Actifs</option><option value="suspendus" ${f.userSt === 'suspendus' ? 'selected' : ''}>Suspendus</option></select></label>
      <label>Rechercher<input id="user-q" value="${esc(f.userQ || '')}" placeholder="Nom, identifiant…"></label>
      <span class="periode-lbl">${liste.length} compte(s)</span>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Utilisateur</th><th>Identifiant</th><th>Mot de passe</th><th>Accès</th><th>Permissions</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead>
      <tbody>${liste.map((u) => `<tr class="${u.actif === false ? 'muted' : ''}">
        <td><b>${esc(u.nom)}</b>${u.fonction ? `<br><small class="muted">${esc(u.fonction)}</small>` : ''}${u.telephone ? `<br><small class="muted">${esc(u.telephone)}</small>` : ''}</td>
        <td class="nowrap">${esc(u.identifiant)}${u._id === S.me._id ? ' <span class="badge int">vous</span>' : ''}</td>
        <td class="nowrap"><span class="mdp" data-mdp="${u._id}">••••••••</span> <button class="btn sm" data-action="mdp-voir" data-id="${u._id}">Afficher</button></td>
        <td>${u.type === 'admin' ? '<span class="badge int">Administrateur</span><br><small class="muted">toutes les agences</small>' : `<span class="badge agence">${esc(nomAgenceId(u.agenceId) || 'Agence ?')}</span><br><small class="muted">Responsable d'agence</small>`}</td>
        <td class="droits-badges">${resume(u)}</td>
        <td>${u.actif === false ? '<span class="badge out">Suspendu</span>' : '<span class="badge in">Actif</span>'}${u.doitChanger ? '<br><span class="badge warn">changera son mot de passe</span>' : ''}</td>
        <td class="nowrap">${u.derniereConnexion ? fdt(u.derniereConnexion) : '<span class="muted">jamais</span>'}</td>
        <td class="nowrap"><button class="btn sm" data-action="user-edit" data-id="${u._id}">Modifier</button>${u._id === S.me._id ? '' : ` <button class="btn sm" data-action="user-actif" data-id="${u._id}">${u.actif === false ? 'Réactiver' : 'Suspendre'}</button> <button class="btn sm danger" data-action="user-suppr" data-id="${u._id}">Supprimer</button>`}</td></tr>`).join('') || vide(8, 'Aucun compte ne correspond.')}</tbody>
    </table></div></div>`;
  },
  mount(root) {
    lierFiltres(root);
    const q = $('#user-q', root);
    let t = null;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { S.filtres.userQ = q.value; await afficherPage(); const n = $('#user-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 250); });
  },
};

function motDePasseProvisoire() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  return [...a].map((x) => c[x % c.length]).join('');
}

ACTIONS['user-edit'] = (ds) => {
  const pg = PAGES.utilisateurs;
  const u = (pg.us || []).find((x) => x._id === ds.id) || { type: 'responsable', permissionsEffectives: [] };
  const moi = u._id === S.me._id;
  const groupes = [...new Set(pg.perms.map((p) => p.groupe))];
  const agences = (S.me.agences || []).filter((g) => g.actif || g._id === u.agenceId);
  const agDefaut = u.agenceId || (S.filtres.userAg && S.filtres.userAg !== 'admin' ? S.filtres.userAg : '') || (agences.length === 1 ? agences[0]._id : '');
  ouvrirModale(ds.id ? `Accès de ${u.nom}` : "Nouveau responsable d'agence", `<form id="f">
    <fieldset class="fieldset"><legend>Identité</legend><div class="form-grid">
      <label>Nom complet<input name="nom" value="${esc(u.nom)}" required></label>
      <label>Fonction<input name="fonction" value="${esc(u.fonction)}" placeholder="Chef d'agence, gérant…"></label>
      <label>Téléphone<input name="telephone" value="${esc(u.telephone)}"></label>
      ${ds.id ? `<label>Identifiant<input value="${esc(u.identifiant)}" disabled></label>` : '<label>Identifiant de connexion<input name="identifiant" autocapitalize="none" autocorrect="off" spellcheck="false" required pattern="[a-zA-Z0-9._\\-]{3,40}" placeholder="ex. jean.kindu"><span class="help">Lettres sans accent, chiffres, point ou tiret.</span></label>'}
    </div></fieldset>
    <fieldset class="fieldset"><legend>Accès</legend><div class="form-grid">
      <label>Type de compte<select name="type" ${moi ? 'disabled' : ''}>
        <option value="responsable" ${u.type !== 'admin' ? 'selected' : ''}>Responsable d'agence</option>
        <option value="admin" ${u.type === 'admin' ? 'selected' : ''}>Administrateur (toutes agences)</option></select><span class="help">Le responsable ne voit que son agence et ne fait que ce qui est coché.</span></label>
      <label id="champ-agence">Agence<select name="agenceId" ${moi ? 'disabled' : ''}><option value="">— Choisir l'agence —</option>${agences.map((g) => `<option value="${g._id}" ${g._id === agDefaut ? 'selected' : ''}>${esc(g.nom)}</option>`).join('')}</select></label>
      ${ds.id && !moi ? `<label>Statut<select name="actif"><option value="1">Actif</option><option value="0" ${u.actif === false ? 'selected' : ''}>Suspendu (connexion impossible)</option></select></label>` : ''}
    </div>${moi ? '<p class="muted" style="font-size:12.5px;margin:6px 0 0">Vous ne pouvez pas modifier votre propre accès.</p>' : ''}</fieldset>
    <fieldset class="fieldset"><legend>${ds.id ? 'Mot de passe (laisser vide pour le conserver)' : 'Mot de passe'}</legend><div class="form-grid">
      <label>Mot de passe (8 caractères minimum)<input name="motDePasse" id="mdp-prov" ${ds.id ? '' : 'required minlength="8"'} autocomplete="new-password" spellcheck="false" autocapitalize="none"></label>
      <label>&nbsp;<button type="button" class="btn" id="gen-mdp">Générer un mot de passe</button></label>
      <label class="full check"><input type="checkbox" name="doitChanger"> Facultatif : lui demander de choisir son propre mot de passe à la première connexion</label>
    </div></fieldset>
    <fieldset class="fieldset" id="bloc-perms"><legend>Ce que ce responsable peut faire dans son agence</legend>
      <div class="modeles"><span class="muted" style="font-size:12.5px;align-self:center">Modèles :</span>${Object.entries(MODELES_DROITS).map(([k, m]) => `<button type="button" class="btn sm" data-modele="${k}">${esc(m.nom)}</button>`).join('')}<button type="button" class="btn sm" data-modele="aucun">Tout décocher</button></div>
      <div class="perm-grille">${groupes.map((g) => `<fieldset class="fieldset"><legend>${g} <button type="button" class="link" data-tout="${g}" style="font-size:12px;margin-left:6px">tout</button></legend>
        ${pg.perms.filter((p) => p.groupe === g).map((p) => `<label class="check"><input type="checkbox" name="perm" value="${p.cle}" data-groupe="${g}" ${u.permissionsEffectives.includes(p.cle) ? 'checked' : ''}> ${esc(p.libelle)}</label>`).join('')}
      </fieldset>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Les droits prennent effet immédiatement, sur tous ses appareils. Les données des autres agences lui restent toujours invisibles.</p>
    </fieldset>
    ${piedForm(ds.id ? 'Enregistrer' : "Créer l'accès")}</form>`, (b) => {
    const cases = () => $$('input[name=perm]', b);
    const appliquer = (liste) => cases().forEach((c) => { c.checked = liste === null || liste.includes(c.value); });
    if (!ds.id) appliquer(null); // nouveau responsable : gestion complète proposée, à ajuster
    $$('[data-modele]', b).forEach((x) => x.addEventListener('click', () => appliquer(x.dataset.modele === 'aucun' ? [] : MODELES_DROITS[x.dataset.modele].perms)));
    $$('[data-tout]', b).forEach((x) => x.addEventListener('click', () => {
      const cs = $$(`input[data-groupe="${x.dataset.tout}"]`, b); const tous = cs.every((c) => c.checked); cs.forEach((c) => { c.checked = !tous; });
    }));
    const majType = () => { const adm = $('[name=type]', b).value === 'admin'; $('#bloc-perms', b).hidden = adm; $('#champ-agence', b).hidden = adm; };
    $('[name=type]', b).addEventListener('change', majType); majType();
    $('#gen-mdp', b).addEventListener('click', () => { $('#mdp-prov', b).value = motDePasseProvisoire(); });
    lierFormulaire($('#f', b), async (d) => {
      const corps = { nom: d.nom, fonction: d.fonction, telephone: d.telephone, doitChanger: !!$('[name=doitChanger]', b).checked };
      if (!ds.id) corps.identifiant = d.identifiant;
      if (d.motDePasse) corps.motDePasse = d.motDePasse;
      if (!moi) {
        corps.type = d.type;
        if (d.type !== 'admin') {
          if (!d.agenceId) throw new Error("Choisissez l'agence du responsable.");
          corps.agenceId = d.agenceId;
          corps.permissions = cases().filter((c) => c.checked).map((c) => c.value);
          if (!corps.permissions.length) throw new Error('Cochez au moins une permission.');
        }
        if (d.actif !== undefined) corps.actif = d.actif === '1';
      }
      if (d.type === 'admin' && u.type !== 'admin' && !window.confirm(`${d.nom} deviendra administrateur : il verra TOUTES les agences et aura TOUS les droits. Confirmer ?`)) return;
      const r = await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/utilisateurs/${ds.id}` : '/api/utilisateurs', corps);
      fermerModale(); afficherPage();
      if (!ds.id || d.motDePasse) recapAcces({ nom: d.nom, identifiant: ds.id ? u.identifiant : r.identifiant, motDePasse: d.motDePasse, agence: d.type === 'admin' ? 'toutes les agences' : nomAgenceId(d.agenceId) });
      else toast('Accès mis à jour : les droits s\'appliquent immédiatement.', 'ok');
    });
  });
};
/** Récapitulatif à transmettre à la personne (copiable). */
function recapAcces(x) {
  const texte = `Gestion des fonds – vos accès\nAgence : ${x.agence}\nAdresse (téléphone ou ordinateur) : ${PAGES.utilisateurs.adresse}\nIdentifiant : ${x.identifiant}\nMot de passe : ${x.motDePasse}`;
  ouvrirModale(`Accès de ${x.nom}`, `<p style="margin-top:0">Transmettez ces informations à la personne de façon confidentielle. Sur un ordinateur où l'application est installée, elle se connecte avec le même identifiant.</p>
    <div class="recap-acces" id="recap">${esc(texte)}</div>
    <div class="form-foot"><button type="button" class="btn" id="copier">Copier</button><button type="button" class="btn primary" data-action="close-modal">Terminé</button></div>`, (b) => {
    $('#copier', b).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(texte); toast('Copié.', 'ok'); } catch { const r = document.createRange(); r.selectNodeContents($('#recap', b)); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Texte sélectionné : faites Ctrl+C.', 'ok'); }
    });
  });
}

ACTIONS['user-actif'] = async (ds) => {
  const u = (PAGES.utilisateurs.us || []).find((x) => x._id === ds.id);
  if (!u) return;
  const suspendre = u.actif !== false;
  if (suspendre && !window.confirm(`Suspendre l'accès de ${u.nom} ? Il est déconnecté immédiatement sur tous ses appareils.`)) return;
  try { await api('PUT', `/api/utilisateurs/${ds.id}`, { actif: !suspendre }); toast(suspendre ? 'Accès suspendu.' : 'Accès rétabli.', 'ok'); } catch (x) { toast(x.message, 'err'); }
  afficherPage();
};

ACTIONS['mdp-voir'] = async (ds, el) => {
  const span = $(`[data-mdp="${ds.id}"]`);
  if (el.dataset.visible) { span.textContent = '••••••••'; el.textContent = 'Afficher'; delete el.dataset.visible; return; }
  try {
    const r = await api('GET', `/api/utilisateurs/${ds.id}/mot-de-passe`);
    span.textContent = r.motDePasse; span.style.fontFamily = 'ui-monospace, Consolas, monospace'; el.textContent = 'Masquer'; el.dataset.visible = '1';
  } catch (x) { toast(x.message, 'err'); }
};

ACTIONS['user-suppr'] = async (ds) => {
  const u = (PAGES.utilisateurs.us || []).find((x) => x._id === ds.id);
  if (!u) return;
  if (!window.confirm(`Supprimer définitivement le compte de ${u.nom} (${u.identifiant}) ?\n\nLa personne ne pourra plus se connecter, sur aucun ordinateur ni mobile. L'historique de ses opérations est conservé.`)) return;
  try { await api('POST', `/api/utilisateurs/${ds.id}/supprimer`); toast(`Compte ${u.identifiant} supprimé.`, 'ok'); } catch (x) { toast(x.message, 'err'); }
  afficherPage();
};

/* ======================================================= Journal d'audit */
PAGES.audit = {
  async render() {
    const lignes = await api('GET', `/api/audit?${qs(per())}`);
    return `${tete("Journal d'audit", 'Traçabilité complète : qui a fait quoi et quand (non modifiable)')}
    ${barrePeriode()}
    <div class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Date et heure</th><th>Utilisateur</th><th>Action</th><th>Référence</th><th>Détails</th></tr></thead>
    <tbody>${lignes.map((l) => `<tr><td class="nowrap">${fdt(l.quand)}</td><td>${esc(l.nomUtilisateur || l.utilisateur)}<br><small class="muted">${esc(l.utilisateur)}</small></td><td>${esc(l.action)}</td><td class="nowrap">${esc(l.cible)}</td><td>${esc(l.details)}</td></tr>`).join('') || vide(5)}</tbody></table></div></div>`;
  },
  mount(root) { lierPeriode(root, afficherPage); },
};

/* ============================================ Stockage & synchronisation */
PAGES.stockage = {
  async render() {
    const e = await api('GET', '/api/stockage');
    this.dirty = false;
    const cfg = peut('stockage.gerer') && ['double', 'local'].includes(e.mode) ? await api('GET', '/api/stockage/config') : null;
    this.cfg = cfg;
    S.stockage = e;
    const [cls, txt] = libelleStockage(e);
    const pCloud = e.cloud === 'desactive' ? '' : e.enLigne ? (e.enAttente ? 'warn' : 'ok') : 'err';
    const quand = (x) => (x ? fdt(x) : '—');
    return `${tete('Stockage & synchronisation', e.cloud === 'desactive' ? 'Cet ordinateur n\'est pas encore relié au cloud : il se relie automatiquement à la prochaine connexion d\'un utilisateur.' : 'Cloud prioritaire : chaque enregistrement part aussitôt dans le cloud et arrive en temps réel sur les autres appareils. Sans connexion, il attend sur ce PC et part dès le retour du réseau.',
      `${e.cloud !== 'desactive' ? '<span data-perm="stockage.gerer"><button class="btn primary" data-action="sync-maintenant">Synchroniser maintenant</button></span>' : ''}${peut('stockage.gerer') ? '<a class="btn" href="/api/stockage/sauvegarde">Télécharger une sauvegarde</a>' : ''}`)}
    <div class="etat-grille">
      <div class="card"><h2><span class="pastille ${e.local && e.local.ok ? 'ok' : ''}"></span>Stockage local (ce PC)</h2>
        <dl class="kv2" style="margin-top:10px">
          <dt>État</dt><dd>${e.local && e.local.ok ? 'Actif – chaque opération est écrite sur le disque avant d\'être confirmée' : 'Non utilisé'}</dd>
          ${e.local && e.local.dossier ? `<dt>Dossier</dt><dd>${esc(e.local.dossier)}</dd><dt>Documents</dt><dd>${e.local.documents}</dd><dt>Sauvegardes</dt><dd>Copie automatique quotidienne (30 jours) dans « sauvegardes »</dd>` : ''}
          ${e.poste ? `<dt>Code du poste</dt><dd>${esc(e.poste)}</dd>` : ''}
        </dl></div>
      <div class="card"><h2><span class="pastille ${pCloud}"></span>Cloud (MongoDB Atlas) – prioritaire</h2>
        <dl class="kv2" style="margin-top:10px">
          <dt>État</dt><dd>${esc(txt)}</dd>
          <dt>Liaison</dt><dd>${e.liaison === 'serveur' ? `Par le serveur en ligne${e.relais && e.relais.utilisateur ? ` (relié par le compte ${esc(e.relais.utilisateur)})` : ''}` : e.liaison === 'atlas' ? 'Directe (MongoDB Atlas)' : e.mode === 'cloud' ? 'Serveur en ligne' : 'Aucune pour l\'instant'}</dd>
          ${e.cloud !== 'desactive' ? `<dt>En attente d'envoi</dt><dd>${e.enAttente} document(s)</dd>
          <dt>Dernier envoi</dt><dd>${quand(e.dernierEnvoi)}</dd><dt>Dernière réception</dt><dd>${quand(e.derniereReception)}</dd>
          ${e.erreur && !e.enLigne ? `<dt>Dernière erreur</dt><dd class="neg">${esc(e.erreur)}</dd>` : ''}` : `<dt>Activer</dt><dd>${peut('stockage.gerer') ? 'Utilisez le paramétrage de la connexion cloud ci-dessous.' : 'Demandez à l\'administrateur de paramétrer la connexion cloud.'}</dd>`}
        </dl></div>
    </div>
    ${cfg ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Liaison directe à MongoDB Atlas (facultatif)</h2>${cfg.active ? '<span class="badge in">Activée</span>' : '<span class="badge">Non activée – stockage local uniquement</span>'}</div>
      <form id="f-cloud" autocomplete="off"><div class="form-grid">
        <label class="full">Adresse du cluster<input name="hote" value="${esc(cfg.hote)}" placeholder="cluster0.xxxxx.mongodb.net" spellcheck="false" autocomplete="off" required>
          <span class="help">Dans Atlas : Database → Connect → Drivers ; c'est la partie après « @ » (vous pouvez aussi coller la chaîne complète).</span></label>
        <label>Utilisateur de base de données<input name="utilisateur" value="${esc(cfg.utilisateur)}" spellcheck="false" autocomplete="off" required></label>
        <label>Mot de passe<input type="password" name="motDePasse" autocomplete="new-password" placeholder="${cfg.motDePasseEnregistre ? '•••••••• (enregistré – laisser vide pour le conserver)' : 'Mot de passe défini dans Atlas › Database Access'}"></label>
        <label>Nom de la base<input name="base" value="${esc(cfg.base)}"></label>
        <label>Code de ce poste<input name="poste" value="${esc(cfg.poste)}" maxlength="6"><span class="help">Utilisé dans les numéros attribués hors ligne (ex. BQ-2026-${esc(cfg.poste)}-0001).</span></label>
      </div>
      <p class="form-error" hidden></p><p class="muted" id="cloud-msg" style="margin:10px 0 0" hidden></p>
      <div class="form-foot">
        ${cfg.active ? '<button type="button" class="btn danger" data-action="cloud-desactiver">Désactiver le cloud</button>' : ''}
        <button type="button" class="btn" data-action="cloud-tester">Tester la connexion</button>
        <button type="submit" class="btn primary">${cfg.active ? 'Enregistrer' : 'Enregistrer et activer'}</button>
      </div></form>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Inutile en temps normal : chaque ordinateur se relie au cloud par le serveur en ligne dès qu'un utilisateur s'y connecte. Les réglages sont enregistrés dans ${esc(cfg.fichier)}. À l'activation, les données déjà saisies sur ce PC sont envoyées automatiquement vers le cloud, et celles du cloud sont récupérées.</p>
    </div>` : ''}
    <div class="card"><h3>Fonctionnement</h3>
      <ul style="margin:0;padding-left:18px;line-height:1.7;color:var(--muted)">
        <li>Le cloud est prioritaire : chaque enregistrement est envoyé immédiatement et n'est confirmé qu'une fois arrivé dans le cloud.</li>
        <li>Sans Internet, l'application continue de fonctionner sur la copie locale ; les enregistrements attendent sur ce PC (message à l'écran) et partent automatiquement au retour de la connexion.</li>
        <li>Les enregistrements des autres ordinateurs et des téléphones arrivent en temps réel (une à deux secondes).</li>
        <li>En ligne, les numéros (BQ, OV, BEC, BSC, PV) sont attribués par le cloud et sont uniques pour tous les postes. Hors ligne, ils contiennent le code du poste (ex. BQ-2026-${esc(e.poste || 'P1')}-0001) pour rester uniques.</li>
        <li>Nouveau PC ou PC réinstallé : au premier lancement, toutes les données sont récupérées depuis le cloud.</li>
        <li>Cloud perdu ou nouveau cluster : « Renvoyer toutes les données vers le cloud » le reconstruit à partir de ce PC.</li>
      </ul>
      ${peut('stockage.gerer') && e.mode === 'double' && e.cloud !== 'desactive' ? '<div class="actions" style="margin-top:12px"><button class="btn" data-action="sync-renvoyer">Renvoyer toutes les données vers le cloud</button></div>' : ''}
    </div>
    ${e.conflits && e.conflits.length ? `<div class="card"><h3>Conflits signalés</h3><table class="data"><thead><tr><th>Date</th><th>Collection</th><th>Document</th><th>Motif</th></tr></thead><tbody>${e.conflits.map((c) => `<tr><td>${fdt(c.quand)}</td><td>${esc(c.collection)}</td><td>${esc(c.id)}</td><td>${esc(c.motif)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  },
};
PAGES.stockage.mount = function mount(root) {
  const f = $('#f-cloud', root);
  if (!f) return;
  f.addEventListener('input', () => { this.dirty = true; });
  lierFormulaire(f, async (d) => {
    const r = await api('PUT', '/api/stockage/config', { ...d, active: true });
    this.dirty = false;
    toast(r.message || 'Connexion cloud enregistrée.', 'ok');
    majStockage(); afficherPage();
  });
};
ACTIONS['cloud-tester'] = async (ds, el) => {
  const f = $('#f-cloud'); const msg = $('#cloud-msg'); const err = f.querySelector('.form-error');
  err.hidden = true; msg.hidden = false; msg.className = 'muted'; msg.textContent = 'Test de la connexion en cours…';
  el.disabled = true;
  try {
    const r = await api('POST', '/api/stockage/tester', Object.fromEntries(new FormData(f).entries()));
    msg.className = r.ok ? 'pos' : 'neg'; msg.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
  } catch (x) { msg.hidden = true; err.textContent = x.message; err.hidden = false; } finally { el.disabled = false; }
};
ACTIONS['cloud-desactiver'] = async () => {
  if (!window.confirm('Désactiver la connexion cloud ? Les données restent sur ce PC et dans Atlas ; la synchronisation s\'arrête.')) return;
  try { await api('PUT', '/api/stockage/config', { active: false, poste: $('#f-cloud [name=poste]').value }); PAGES.stockage.dirty = false; toast('Cloud désactivé : stockage local uniquement.', 'ok'); } catch (x) { toast(x.message, 'err'); }
  majStockage(); afficherPage();
};
ACTIONS['sync-maintenant'] = async (ds, el) => {
  el.disabled = true;
  try { const e = await api('POST', '/api/stockage/synchroniser'); toast(e.enLigne ? 'Synchronisation effectuée.' : `Cloud injoignable : ${e.erreur || 'hors ligne'}`, e.enLigne ? 'ok' : 'err'); } catch (x) { toast(x.message, 'err'); }
  majStockage(); afficherPage();
};
ACTIONS['sync-renvoyer'] = async () => {
  if (!window.confirm('Remettre toutes les données de ce PC dans la file d\'envoi vers le cloud ?')) return;
  try { const r = await api('POST', '/api/stockage/renvoyer'); toast(`${r.renvoyes} documents mis en file d'envoi.`, 'ok'); } catch (x) { toast(x.message, 'err'); }
  majStockage(); afficherPage();
};

/* Permissions requises par écran (au moins une) */
Object.assign(PAGES.banque, { perm: 'banque.voir' });
Object.assign(PAGES.ordres, { perm: 'banque.voir' });
Object.assign(PAGES.fournisseurs, { perm: 'banque.voir,fournisseurs.gerer' });
Object.assign(PAGES.comptes, { perm: 'banque.voir,comptes.gerer' });
Object.assign(PAGES.caisse, { perm: 'caisse.voir' });
Object.assign(PAGES.livre, { perm: 'caisse.voir,etats.voir' });
Object.assign(PAGES.controle, { perm: 'pv.voir,pv.saisir' });
Object.assign(PAGES.etats, { perm: 'etats.voir' });
Object.assign(PAGES.previsions, { perm: 'previsions.voir' });
Object.assign(PAGES.parametres, { perm: 'parametres.gerer' });
Object.assign(PAGES.audit, { perm: 'audit.voir' });

/* ============================================================== Agences */
PAGES.agences = {
  perm: 'agences.gerer',
  async render() {
    const [ags, us] = await Promise.all([api('GET', '/api/agences'), peut('utilisateurs.gerer') ? api('GET', '/api/utilisateurs') : Promise.resolve([])]);
    this.ags = ags;
    return `${tete('Agences', "Chaque agence a sa propre caisse, ses comptes bancaires, son stock et ses états. Un responsable d'agence ne voit que les données de son agence.",
      '<button class="btn primary" data-action="agence-edit">+ Nouvelle agence</button>')}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Code</th><th>Agence</th><th>Ville / adresse</th><th>Responsable</th><th class="num">Solde initial caisse</th><th class="num">Utilisateurs</th><th>Statut</th><th></th></tr></thead>
      <tbody>${ags.map((g) => `<tr class="${g.actif === false ? 'muted' : ''}"><td class="nowrap"><b>${esc(g.code)}</b></td><td>${esc(g.nom)}</td><td>${esc([g.ville, g.adresse].filter(Boolean).join(' – '))}${g.telephone ? `<br><small class="muted">${esc(g.telephone)}</small>` : ''}</td>
        <td>${esc(g.responsable || '')}</td><td class="num">${nb(g.soldeInitialCaisse || 0)}</td><td class="num">${us.filter((u) => u.agenceId === g._id).length}</td>
        <td>${g.actif === false ? '<span class="badge">Inactive</span>' : '<span class="badge in">Active</span>'}</td>
        <td class="nowrap"><button class="btn sm" data-action="agence-edit" data-id="${g._id}">Modifier</button> <button class="btn sm" data-action="agence-voir" data-id="${g._id}">Ouvrir</button></td></tr>`).join('') || vide(8, 'Aucune agence.')}</tbody>
    </table></div></div>
    <p class="muted" style="font-size:12.5px">Pour donner un accès à un responsable d'agence : menu Utilisateurs → « Nouveau responsable d'agence » : choisissez l'agence et cochez ce qu'il peut faire.</p>`;
  },
};
ACTIONS['agence-voir'] = (ds) => { changerAgence(ds.id).then(() => { location.hash = '#/tableau'; }); majSelecteurAgence(); };
ACTIONS['agence-edit'] = (ds) => {
  const g = ((PAGES.agences.ags) || []).find((x) => x._id === ds.id) || {};
  ouvrirModale(ds.id ? `Agence ${g.nom}` : 'Nouvelle agence', `<form id="f"><div class="form-grid">
    <label>Code (court, unique)<input name="code" value="${esc(g.code)}" required maxlength="12" placeholder="KIN, LUB…" style="text-transform:uppercase"></label>
    <label>Nom de l'agence<input name="nom" value="${esc(g.nom)}" required></label>
    <label>Ville<input name="ville" value="${esc(g.ville)}"></label>
    <label>Téléphone<input name="telephone" value="${esc(g.telephone)}"></label>
    <label class="full">Adresse<input name="adresse" value="${esc(g.adresse)}"></label>
    <label>Responsable (nom)<input name="responsable" value="${esc(g.responsable)}"></label>
    <label>Solde initial de la caisse (${esc(S.params.devise)})<input type="number" step="any" name="soldeInitialCaisse" value="${g.soldeInitialCaisse || 0}"><span class="help">Figé dès que la caisse de l'agence a des mouvements.</span></label>
    ${ds.id ? `<label>Statut<select name="actif"><option value="1">Active</option><option value="0" ${g.actif === false ? 'selected' : ''}>Inactive</option></select></label>` : ''}
  </div>${piedForm()}</form>`, (b) => lierFormulaire($('#f', b), async (d) => {
    if (d.actif !== undefined) d.actif = d.actif === '1';
    d.soldeInitialCaisse = Number(d.soldeInitialCaisse) || 0;
    await api(ds.id ? 'PUT' : 'POST', ds.id ? `/api/agences/${ds.id}` : '/api/agences', d);
    S.me = await api('GET', '/api/me'); majSelecteurAgence();
    fermerModale(); toast('Agence enregistrée.', 'ok'); afficherPage();
  }));
};
