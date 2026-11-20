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
