'use strict';
/* =====================================================================
   Pouvoirs de l'administrateur : « Modifier » et « Supprimer » sur toutes les saisies,
   avec les pièces liées, un motif obligatoire, la corbeille et le journal d'audit.
   ===================================================================== */
const estAdmin = () => !!(S.me && S.me.role === 'admin');

/** Boutons réservés à l'administrateur, à placer dans la cellule d'actions d'une ligne. */
function btnAdmin(type, id, { modif = true, num = '' } = {}) {
  if (!estAdmin() || !id) return '';
  return `<span class="admin-actions">${modif ? `<button class="btn sm admin" data-action="adm-modif" data-type="${type}" data-id="${id}" title="Modifier (administrateur)">Modifier</button>` : ''}`
    + `<button class="btn sm admin danger" data-action="adm-suppr" data-type="${type}" data-id="${id}" data-num="${esc(num)}" title="Supprimer (administrateur)">Supprimer</button></span>`;
}

ACTIONS['adm-suppr'] = async (ds) => {
  const a = await api('GET', `/api/admin/apercu/${ds.type}/${ds.id}`);
  ouvrirModale(`Supprimer : ${a.nom}`, `<form id="f">
    <p style="margin-top:0"><b>${esc(a.libelle)}</b></p>
    ${a.liees.length ? `<p>Seront supprimés avec : </p><ul class="liste-liees">${a.liees.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${a.avertissements.map((x) => `<p class="avert-admin">⚠ ${esc(x)}</p>`).join('')}
    <p class="muted">Tout part dans la <b>corbeille</b> (menu Administration) d'où vous pouvez le restaurer. L'opération est inscrite au journal d'audit.</p>
    <div class="form-grid"><label class="full">Motif (obligatoire)<textarea name="motif" required placeholder="ex. saisie en double, erreur de montant…"></textarea></label></div>
    <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn danger" type="submit">Supprimer${a.liees.length ? ` (${a.liees.length + 1} éléments)` : ''}</button></div></form>`,
  (m) => lierFormulaire($('#f', m), async (d) => {
    await api('POST', `/api/admin/supprimer/${ds.type}/${ds.id}`, d);
    fermerModale(); toast(`${a.nom} supprimé(e) – récupérable dans la corbeille.`, 'ok');
    if (S.route === 'bon-commande' && ds.type === 'stock-bon') location.hash = '#/bons-commande'; else afficherPage();
    if (typeof chargerReference === 'function') chargerReference().catch(() => {});
    if (typeof majBadgeStock === 'function') majBadgeStock();
  }));
};

ACTIONS['adm-modif'] = async (ds) => {
  const a = await api('GET', `/api/admin/apercu/${ds.type}/${ds.id}`);
  if (!a.modifiable) { toast("Cet élément se modifie depuis son propre bouton « Modifier ».", 'err'); return; }
  const champ = (c) => {
    const lbl = `<span>${esc(c.label)}</span>`;
    if (c.genre === 'date') return `<label>${lbl}<input type="date" name="${c.nom}" value="${esc(c.valeur)}" required></label>`;
    if (c.genre === 'montant') return `<label>${lbl}<input type="number" step="any" ${c.signe ? '' : 'min="0"'} inputmode="decimal" name="${c.nom}" value="${esc(c.valeur)}" ${c.zero ? '' : 'required'}></label>`;
    if (c.genre === 'liste') return `<label>${lbl}<select name="${c.nom}">${c.options.map(([v, t]) => `<option value="${esc(v)}" ${v === c.valeur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    return `<label class="${(c.max || 0) > 150 ? 'full' : ''}">${lbl}<input name="${c.nom}" value="${esc(c.valeur)}" maxlength="${c.max || 250}"></label>`;
  };
  ouvrirModale(`Modifier : ${a.nom}`, `<form id="f"><p style="margin-top:0"><b>${esc(a.libelle)}</b></p>
    ${a.liees.length ? `<p class="muted">Les pièces liées sont mises à jour en même temps : ${a.liees.map(esc).join(', ')}.</p>` : ''}
    ${a.avertissements.filter((x) => /clôturée/.test(x)).map((x) => `<p class="avert-admin">⚠ ${esc(x)}</p>`).join('')}
    <div class="form-grid">${a.champs.map(champ).join('')}</div>
    <p class="muted">La modification (avant → après) est inscrite au journal d'audit.</p>${piedForm('Enregistrer la modification')}</form>`,
  (m) => lierFormulaire($('#f', m), async (d) => {
    const r = await api('POST', `/api/admin/modifier/${ds.type}/${ds.id}`, { valeurs: d });
    fermerModale(); toast(r.changements.length ? `Modifié : ${r.changements.length} changement(s).` : 'Aucun changement.', 'ok'); afficherPage();
    if (typeof majBadgeStock === 'function') majBadgeStock();
  }));
};

/** Clôtures de caisse : liste et suppression (réouverture d'une journée). */
ACTIONS['adm-clotures'] = async () => {
  const cl = await api('GET', '/api/clotures');
  ouvrirModale('Clôtures de caisse', `<p style="margin-top:0">Supprimer une clôture rouvre la journée : les bons de cette date pourront à nouveau être saisis, modifiés ou annulés.</p>
    <div class="table-wrap"><table class="data"><thead><tr>${consolideAdmin() ? '<th>Agence</th>' : ''}<th>Journée</th><th class="num">Solde de clôture</th><th>Clôturée par</th><th></th></tr></thead>
    <tbody>${cl.map((c) => `<tr>${consolideAdmin() ? `<td>${esc(nomAgenceId(c.agenceId))}</td>` : ''}<td>${fd(c.date)}</td><td class="num">${money(c.soldeCloture)}</td><td>${esc(c.nomCloture || c.cloturePar || '')}<br><small class="muted">${fdt(c.clotureLe)}</small></td><td>${btnAdmin('cloture', c._id, { modif: false })}</td></tr>`).join('') || vide(5, 'Aucune clôture.')}</tbody></table></div>
    <div class="form-foot"><button type="button" class="btn" data-action="close-modal">Fermer</button></div>`);
};
const consolideAdmin = () => !S.me.agenceId && !S.agence && agencesActives().length > 1;

/* ------------------------------------------------------------ Corbeille */
const LIB_TYPES = {
  operation: 'Opération bancaire', bon: 'Bon de caisse', ordre: 'Ordre de virement', pv: 'PV de contrôle', cloture: 'Clôture de caisse', compte: 'Compte bancaire',
  fournisseur: 'Fournisseur', agence: 'Agence', 'stock-bon': 'Bon de commande', 'stock-livraison': 'Bon de livraison', 'stock-mouvement': 'Mouvement de stock',
  'stock-region': 'Région militaire', 'stock-unite': 'Unité',
};
PAGES.corbeille = {
  perm: null,
  async render() {
    if (!estAdmin()) return `${tete('Corbeille', '')}<div class="card"><p class="empty">Réservé à l'administrateur.</p></div>`;
    const liste = await api('GET', '/api/admin/corbeille');
    return `${tete('Corbeille', "Éléments supprimés par l'administrateur : restaurez-les à l'identique (même numéro) ou supprimez-les définitivement")}
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Supprimé le</th><th>Type</th><th>Élément</th><th>Avec</th><th>Motif</th><th>Par</th><th></th></tr></thead>
      <tbody>${liste.map((c) => `<tr><td class="nowrap">${fdt(c.supprimeLe)}</td><td>${esc(LIB_TYPES[c.type] || c.nom)}</td><td><b>${esc(c.libelle)}</b></td>
        <td><small>${c.contenu.slice(1).map(esc).join('<br>') || '—'}</small></td><td>${esc(c.motif)}</td><td>${esc(c.nomSuppression || c.supprimePar)}</td>
        <td class="nowrap"><button class="btn sm primary" data-action="adm-restaurer" data-id="${c._id}">Restaurer</button> <button class="btn sm danger" data-action="adm-purger" data-id="${c._id}" data-lib="${esc(c.libelle)}">Supprimer définitivement</button></td></tr>`).join('') || vide(7, 'La corbeille est vide.')}</tbody>
    </table></div></div>`;
  },
};
ACTIONS['adm-restaurer'] = async (ds) => {
  await api('POST', `/api/admin/corbeille/${ds.id}/restaurer`);
  toast('Élément restauré à sa place.', 'ok'); afficherPage();
  if (typeof chargerReference === 'function') chargerReference().catch(() => {});
};
ACTIONS['adm-purger'] = (ds) => {
  ouvrirModale('Supprimer définitivement', `<form id="f"><p style="margin-top:0"><b>${esc(ds.lib)}</b> sera effacé définitivement : il ne pourra plus être restauré. Le journal d'audit en garde la trace.</p>
    <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn danger" type="submit">Supprimer définitivement</button></div></form>`,
  (m) => lierFormulaire($('#f', m), async () => { await api('POST', `/api/admin/corbeille/${ds.id}/supprimer`); fermerModale(); toast('Supprimé définitivement.', 'ok'); afficherPage(); }));
};

/* ============================================ Sauvegarde et réinitialisation */
function telechargerJson(obj, nom) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nom;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const nomSauvegarde = () => `Sauvegarde_MIL-FIN_STOCK_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')}.json`;

PAGES.reinitialisation = {
  perm: null,
  agence: 'toutes',
  async render() {
    if (!estAdmin()) return `${tete('Sauvegarde et réinitialisation', '')}<div class="card"><p class="empty">Réservé à l'administrateur.</p></div>`;
    const info = await api('GET', `/api/admin/reinitialiser?agence=${encodeURIComponent(this.agence)}`);
    this.info = info;
    const ags = (S.me.agences || []).filter((g) => g.actif !== false);
    return `${tete('Sauvegarde et réinitialisation', "Télécharger une copie des données, les effacer pour repartir de zéro, ou remettre en place une sauvegarde")}
    <div class="card reinit-carte">
      <h2>Réinitialiser les données</h2>
      <p>Efface les données choisies, sur tous les appareils (cloud, ordinateurs, téléphones). Les <b>utilisateurs</b>, les <b>agences</b> et l'<b>entête / paramètres</b> sont toujours conservés.
      Une <b>sauvegarde est téléchargée automatiquement juste avant</b> : elle permet de tout remettre en place.</p>
      <div class="filters"><label>Étendue<select id="reinit-agence"><option value="toutes">Toutes les agences</option>${ags.map((g) => `<option value="${g._id}" ${g._id === this.agence ? 'selected' : ''}>Agence ${esc(g.nom)} uniquement</option>`).join('')}</select></label></div>
      <div class="reinit-choix">${info.categories.map((c) => `<label class="check ${c.commune && this.agence !== 'toutes' ? 'desactive' : ''}"><input type="checkbox" value="${c.cle}" ${c.defaut && !(c.commune && this.agence !== 'toutes') ? 'checked' : ''} ${c.commune && this.agence !== 'toutes' ? 'disabled' : ''}>
        <span><b>${esc(c.nom)}</b> <span class="badge">${nb(c.nombre).replace(/,00$/, '')}</span><br><small class="muted">${esc(c.detail)}${c.commune && this.agence !== 'toutes' ? ' — commun à toutes les agences : seulement avec « Toutes les agences »' : ''}</small></span></label>`).join('')}</div>
      <button class="btn danger gros" data-action="adm-reinit">Réinitialiser les données…</button>
    </div>
    <div class="card"><h2>Sauvegarder</h2><p>Télécharge un fichier contenant les données cochées ci-dessus (à garder en lieu sûr).</p>
      <button class="btn" data-action="adm-sauvegarder">Télécharger une sauvegarde</button></div>
    <div class="card"><h2>Restaurer une sauvegarde</h2><p>Remet en place les éléments d'un fichier de sauvegarde. Ceux qui existent déjà ne sont pas modifiés.</p>
      <label class="btn" style="display:inline-flex;width:auto">Choisir le fichier de sauvegarde…<input type="file" id="fichier-sauvegarde" accept=".json,application/json" hidden></label></div>`;
  },
  mount(root) {
    const sel = $('#reinit-agence', root);
    if (sel) sel.addEventListener('change', () => { this.agence = sel.value; afficherPage(); });
    const f = $('#fichier-sauvegarde', root);
    if (f) f.addEventListener('change', async () => {
      const fichier = f.files[0]; if (!fichier) return;
      let sv;
      try { sv = JSON.parse(await fichier.text()); } catch { toast("Ce fichier n'est pas une sauvegarde lisible.", 'err'); return; }
      const n = Object.values(sv.collections || {}).reduce((a, d) => a + (Array.isArray(d) ? d.length : 0), 0);
      ouvrirModale('Restaurer une sauvegarde', `<form id="f"><p style="margin-top:0">Sauvegarde du <b>${esc(fdt(sv.date || ''))}</b> (${esc(String(n))} élément(s)${sv.agence ? `, agence ${esc(nomAgenceId(sv.agence))}` : ''}).</p>
        <p>Les éléments absents seront remis en place à l'identique ; ceux qui existent déjà sont laissés tels quels.</p>
        <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">Restaurer</button></div></form>`,
      (m) => lierFormulaire($('#f', m), async () => {
        const r = await api('POST', '/api/admin/sauvegarde/restaurer', { sauvegarde: sv });
        fermerModale(); toast(`Sauvegarde restaurée : ${r.ajoutes} élément(s) remis en place${r.presents ? `, ${r.presents} déjà présent(s)` : ''}.${r.doublons ? ` Attention : ${r.doublons} numéro(s) de pièce en double (pièces saisies après la remise à 1 de la numérotation).` : ''}`, r.doublons ? 'err' : 'ok');
        f.value = ''; await chargerReference().catch(() => {}); afficherPage();
      }));
    });
  },
};
const choixReinit = () => $$('.reinit-choix input:checked').map((x) => x.value);

ACTIONS['adm-sauvegarder'] = async () => {
  const cats = choixReinit();
  if (!cats.length) { toast('Cochez au moins une catégorie.', 'err'); return; }
  const sv = await api('GET', `/api/admin/sauvegarde?categories=${cats.join(',')}&agence=${encodeURIComponent(PAGES.reinitialisation.agence)}`);
  telechargerJson(sv, nomSauvegarde());
  toast('Sauvegarde téléchargée (dossier Téléchargements).', 'ok');
};

ACTIONS['adm-reinit'] = async () => {
  const P = PAGES.reinitialisation; const cats = choixReinit();
  if (!cats.length) { toast('Cochez au moins une catégorie de données à effacer.', 'err'); return; }
  const choisies = P.info.categories.filter((c) => cats.includes(c.cle));
  const total = choisies.reduce((a, c) => a + c.nombre, 0);
  const etendue = P.agence === 'toutes' ? 'TOUTES LES AGENCES' : `l'agence ${nomAgenceId(P.agence)}`;
  ouvrirModale('Réinitialiser les données', `<form id="f">
    <p class="avert-admin" style="margin-top:0">⚠ <b>${total} élément(s)</b> vont être effacés pour <b>${esc(etendue)}</b>, sur tous les appareils :</p>
    <ul class="liste-liees">${choisies.map((c) => `<li><b>${esc(c.nom)}</b> (${c.nombre})</li>`).join('')}</ul>
    <p>Une sauvegarde est téléchargée automatiquement avant l'effacement.</p>
    <div class="form-grid">
      ${P.agence === 'toutes' && P.info.renumerotationPossible && cats.some((k) => ['tresorerie', 'stock'].includes(k)) ? '<label class="full check"><input type="checkbox" name="numerotation" value="1"> Remettre la numérotation à 1 (BQ, BEC, BSC, OV, PV, BC, BL, MV…)</label>' : ''}
      <label class="full">Motif<input name="motif" placeholder="ex. fin des essais, démarrage réel"></label>
      <label>Tapez <b>REINITIALISER</b> pour confirmer<input name="confirmation" required autocomplete="off"></label>
      <label>Votre mot de passe administrateur<input type="password" name="motDePasse" required autocomplete="current-password"></label>
    </div>
    <p class="form-error" hidden></p><div class="form-foot"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn danger" type="submit">Sauvegarder puis effacer</button></div></form>`,
  (m) => lierFormulaire($('#f', m), async (d) => {
    if (String(d.confirmation).trim().toUpperCase() !== 'REINITIALISER') throw new Error('Tapez exactement REINITIALISER.');
    const sv = await api('GET', `/api/admin/sauvegarde?categories=${cats.join(',')}&agence=${encodeURIComponent(P.agence)}`);
    telechargerJson(sv, nomSauvegarde());
    const r = await api('POST', '/api/admin/reinitialiser', { categories: cats, agenceId: P.agence, confirmation: d.confirmation, motDePasse: d.motDePasse, motif: d.motif, numerotation: !!d.numerotation });
    fermerModale();
    toast(`Réinitialisation faite : ${r.total} élément(s) effacé(s)${r.numerotation ? ', numérotation remise à 1' : ''}. La sauvegarde est dans vos Téléchargements.`, 'ok');
    await chargerReference().catch(() => {}); afficherPage();
    if (typeof majBadgeStock === 'function') majBadgeStock();
  }));
};
