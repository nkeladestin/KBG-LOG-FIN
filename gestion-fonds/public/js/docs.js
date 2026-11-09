'use strict';
/* =====================================================================
   Documents imprimables / exportables en PDF, avec entête personnalisé.
   ===================================================================== */

let docFichier = 'document';

function ouvrirDocument(titre, html, { paysage = false, fichier = 'document' } = {}) {
  docFichier = fichier.replace(/[^\w.-]+/g, '_');
  $('#doc-titre').textContent = titre;
  $('#doc-pages').innerHTML = html;
  $$('#doc-pages .feuille').forEach((f) => f.classList.toggle('paysage', paysage));
  const piedTxt = String(S.params.entreprise.piedDePage || '').replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  $('#page-style').textContent = `@page { size: A4 ${paysage ? 'landscape' : 'portrait'}; ${piedTxt ? `@bottom-left { content: "${piedTxt}"; font-size: 7.5pt; color: #555; font-family: Arial, sans-serif; }` : ''} }`;
  $('#doc').hidden = false;
  $('#doc').scrollTop = 0;
  ajusterDocument();
}
/** Sur téléphone, réduit l'aperçu A4 à la largeur de l'écran (l'impression reste en taille réelle). */
function ajusterDocument() {
  const f = $('#doc-pages .feuille');
  if (!f) return;
  $('#doc-pages').style.zoom = '';
  const k = Math.min(1, (window.innerWidth - 16) / f.offsetWidth);
  if (k < 1) $('#doc-pages').style.zoom = String(Math.round(k * 1000) / 1000);
}
window.addEventListener('resize', () => { if (!$('#doc').hidden) ajusterDocument(); });
function fermerDocument() { $('#doc').hidden = true; $('#doc-pages').innerHTML = ''; }
function imprimerDocument(pdf) {
  const ancien = document.title;
  if (pdf) document.title = docFichier; // nom proposé par « Enregistrer au format PDF »
  window.addEventListener('afterprint', () => { document.title = ancien; }, { once: true });
  window.print();
}

/* ----------------------------------------------------- Entête & pied */
function entete(titre, { periode, numero, date, meta = [], extraSous = '' } = {}) {
  const e = S.params.entreprise;
  const lignes = [
    e.formeJuridique,
    [e.adresse, e.ville, e.pays].filter(Boolean).join(' – '),
    [e.telephone && `Tél. : ${e.telephone}`, e.email && `E-mail : ${e.email}`].filter(Boolean).join('  ·  '),
    e.siteWeb,
    [e.rccm && `RCCM : ${e.rccm}`, e.nif && `NIF / IFU : ${e.nif}`].filter(Boolean).join('  ·  '),
    e.ligneComplementaire,
  ].filter(Boolean);
  const m = [
    numero && `N° : <b>${esc(numero)}</b>`,
    date && `Date : <b>${fd(date)}</b>`,
    periode && `Période : <b>${esc(libellePeriode(periode))}</b>`,
    ...meta,
    `Édité le ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
  ].filter(Boolean);
  return `<div class="ent">
    <div class="ent-logo">${e.logo ? `<img src="${esc(e.logo)}" alt="">` : ''}</div>
    <div class="ent-id">
      <div class="nom">${esc(e.nom)}</div>
      ${e.sigle ? `<div class="sigle">${esc(e.sigle)}</div>` : ''}
      ${lignes.map((l) => `<div class="lig">${esc(l)}</div>`).join('')}
    </div>
    <div class="ent-doc"><div class="titre">${esc(titre)}</div><div class="meta">${m.map((x) => `<div>${x}</div>`).join('')}</div></div>
  </div>
  <div class="ent-sous"><span>Montants exprimés en ${esc(S.params.devise)}</span><span>${extraSous || ''}</span><span>Édité par : ${esc(S.me.nom)}</span></div>`;
}

function pied() {
  const t = S.params.entreprise.piedDePage;
  return t ? `<div class="pied">${esc(t)}</div>` : '';
}

function signatures(liste) {
  return `<div class="signatures" style="--n:${liste.length}">${liste.map((s) => `<div><div class="t">${esc(s.titre)}</div><div class="zone"></div><div>${esc(s.nom || '')}</div></div>`).join('')}</div>`;
}
const sig = (k) => ({ titre: S.params.signataires[`titre${k[0].toUpperCase()}${k.slice(1)}`] || k, nom: S.params.signataires[k] });
const tampon = (x) => (x.annulee ? `<div class="annule-tampon">Annulé – ${esc(x.motifAnnulation || '')}</div>` : '');
const feuille = (html) => `<section class="feuille">${html}${pied()}</section>`;

/* ------------------------------------------------- Ordre de virement */
function docOrdre(o) {
  const e = S.params.entreprise;
  const html = `${entete('Ordre de virement', { numero: o.numero, date: o.date })}
  ${tampon(o)}
  <p style="margin:14px 0 4px">À l'attention de Monsieur le Directeur<br><b>${esc(o.donneurOrdre.banque)}</b>${o.donneurOrdre.agence ? `<br>Agence : ${esc(o.donneurOrdre.agence)}` : ''}</p>
  <p style="margin:10px 0"><b>Objet :</b> Ordre de virement n° ${esc(o.numero)}</p>
  <p>Monsieur le Directeur,</p>
  <p>Par la présente, nous vous prions de bien vouloir débiter notre compte ci-dessous référencé et de virer au profit du bénéficiaire désigné la somme indiquée.</p>
  <div class="doc-h">Donneur d'ordre</div>
  <div class="kv">
    <div>Raison sociale</div><div>${esc(e.nom)}${e.sigle ? ` (${esc(e.sigle)})` : ''}</div>
    <div>Banque</div><div>${esc(o.donneurOrdre.banque)}${o.donneurOrdre.agence ? ` – ${esc(o.donneurOrdre.agence)}` : ''}</div>
    <div>N° de compte à débiter</div><div><b>${esc(o.donneurOrdre.numero)}</b>${o.donneurOrdre.intitule ? ` – ${esc(o.donneurOrdre.intitule)}` : ''}</div>
    ${o.donneurOrdre.iban ? `<div>IBAN / RIB</div><div>${esc(o.donneurOrdre.iban)}</div>` : ''}
    ${o.donneurOrdre.swift ? `<div>Code SWIFT / BIC</div><div>${esc(o.donneurOrdre.swift)}</div>` : ''}
  </div>
  <div class="doc-h">Bénéficiaire</div>
  <div class="kv">
    <div>Nom / Raison sociale</div><div><b>${esc(o.beneficiaire.nom)}</b></div>
    ${o.beneficiaire.adresse ? `<div>Adresse</div><div>${esc(o.beneficiaire.adresse)}</div>` : ''}
    <div>Banque destinataire</div><div>${esc(o.beneficiaire.banque)}</div>
    <div>N° de compte / RIB</div><div><b>${esc(o.beneficiaire.numeroCompte)}</b></div>
  </div>
  <div class="doc-h">Montant et motif</div>
  <div class="kv">
    <div>Montant en chiffres</div><div><span class="montant-box">${money(o.montant)}</span></div>
    <div>Montant en lettres</div><div class="lettres">${esc(o.montantLettres)}</div>
    <div>Motif du virement</div><div>${esc(o.motif)}</div>
    ${o.reference ? `<div>Référence</div><div>${esc(o.reference)}</div>` : ''}
    <div>Réf. comptable</div><div>${esc(o.operationNumero || '')}</div>
  </div>
  <p style="margin-top:14px">Nous vous prions d'agréer, Monsieur le Directeur, l'expression de nos salutations distinguées.</p>
  <p style="text-align:right">Fait à ${esc(e.ville || '………………')}, le ${dLong(o.date)}</p>
  ${signatures([sig('comptable'), sig('directeur')])}
  <p class="note" style="text-align:center">Signature(s) autorisée(s) et cachet de l'entreprise</p>`;
  ouvrirDocument(`Ordre de virement ${o.numero}`, feuille(html), { fichier: `Ordre_virement_${o.numero}` });
}

/* ---------------------------------------------------- Bons de caisse */
function corpsBon(b, exemplaire) {
  const entree = b.type === 'entree';
  return `${entete(entree ? "Bon d'entrée caisse" : 'Bon de sortie caisse', { numero: b.numero, date: b.date, extraSous: `<span class="exemplaire">${exemplaire}</span>` })}
  ${tampon(b)}
  <div class="bon-grid">
    <div><div class="l">${entree ? 'Reçu de (remettant)' : 'Payé à (bénéficiaire)'}</div><div class="v"><b>${esc(b.tiers)}</b></div></div>
    <div><div class="l">Montant</div><div class="v"><span class="montant-box" style="font-size:12pt;padding:3px 8px">${money(b.montant)}</span></div></div>
    <div style="grid-column:1/-1"><div class="l">Montant en lettres</div><div class="v lettres">${esc(b.montantLettres)}</div></div>
    <div style="grid-column:1/-1"><div class="l">Motif</div><div class="v">${esc(b.libelle)}</div></div>
    <div><div class="l">Imputation</div><div class="v">${esc(b.categorie)}</div></div>
    <div><div class="l">Pièce justificative / Référence</div><div class="v">${esc(b.piece || '—')}</div></div>
  </div>
  ${signatures(entree
    ? [sig('caissier'), { titre: 'Le Remettant', nom: '' }, sig('comptable')]
    : [sig('caissier'), { titre: 'Le Bénéficiaire', nom: '' }, sig('directeur')])}`;
}
function docBon(b) {
  const html = `<section class="feuille bon">${corpsBon(b, 'Original')}<div class="decoupe"></div>${corpsBon(b, 'Souche / Copie')}</section>`;
  ouvrirDocument(`${b.type === 'entree' ? "Bon d'entrée" : 'Bon de sortie'} ${b.numero}`, html, { fichier: `Bon_caisse_${b.numero}` });
}

/* ----------------------------------------------------- Journal banque */
function docJournal(d, periode) {
  const c = d.compte;
  const html = `${entete('Journal banque', { periode, meta: [`Compte : <b>${c ? `${esc(c.banque)} – ${esc(c.numero)}` : 'Tous les comptes'}</b>`] })}
  <table class="dt">
    <thead><tr><th style="width:17mm">Date</th><th style="width:25mm">N° pièce</th><th>Libellé</th><th>Provenance des fonds</th><th>Banque destinataire</th><th style="width:24mm">Doc. lié / Réf.</th>${c ? '' : '<th>Compte</th>'}<th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th></tr></thead>
    <tbody>
      <tr class="sub"><td>${fd(d.debut)}</td><td></td><td colspan="${c ? 4 : 5}">Solde d'ouverture (report à nouveau)</td><td></td><td></td><td class="num">${nb(d.soldeOuverture)}</td></tr>
      ${d.lignes.map((l) => `<tr><td>${fd(l.date)}</td><td>${esc(l.numero)}</td><td>${esc(l.libelle)}${l.tiers ? `<br><small>${esc(l.tiers)}</small>` : ''}</td><td>${esc(l.provenance)}</td><td>${esc(l.banqueDestinataire)}</td><td>${esc([l.piece, l.reference].filter(Boolean).join(' / '))}</td>${c ? '' : `<td>${esc(l.compte.banque)}</td>`}<td class="num">${l.debit ? nb(l.debit) : ''}</td><td class="num">${l.credit ? nb(l.credit) : ''}</td><td class="num">${nb(l.solde)}</td></tr>`).join('')
        || `<tr><td colspan="${c ? 9 : 10}" style="text-align:center;color:#777">Aucune opération sur la période</td></tr>`}
    </tbody>
    <tfoot>
      <tr class="tot"><td colspan="${c ? 6 : 7}">Totaux des mouvements de la période</td><td class="num">${nb(d.totalDebit)}</td><td class="num">${nb(d.totalCredit)}</td><td></td></tr>
      <tr class="tot"><td colspan="${c ? 6 : 7}">Solde de clôture au ${fd(d.fin)}</td><td></td><td></td><td class="num">${nb(d.soldeCloture)}</td></tr>
    </tfoot>
  </table>
  <p class="note">Convention : le compte banque est débité des entrées d'argent et crédité des sorties d'argent. Nombre d'opérations : ${d.lignes.length}.</p>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument('Journal banque', feuille(html), { paysage: true, fichier: `Journal_banque_${d.debut}_${d.fin}` });
}

/* ----------------------------------------------------- Livre de caisse */
function docLivre(d, periode) {
  const lignes = d.jours.map((j) => `
    <tr class="jour"><td colspan="5">${dLong(j.date)} — Solde en début de journée</td><td></td><td></td><td class="num">${nb(j.soldeDebut)}</td></tr>
    ${j.lignes.map((l) => `<tr><td>${fd(j.date)}</td><td>${esc(l.numero)}</td><td>${esc(l.libelle)}</td><td>${esc(l.tiers)}</td><td>${esc(l.piece || '')}</td><td class="num">${l.entree ? nb(l.entree) : ''}</td><td class="num">${l.sortie ? nb(l.sortie) : ''}</td><td class="num">${nb(l.solde)}</td></tr>`).join('')}
    <tr class="sub"><td colspan="5">Total de la journée — solde en fin de journée${j.cloture ? ` · clôturée par ${esc(j.cloture.nomCloture || j.cloture.cloturePar)}` : ''}</td><td class="num">${nb(j.entrees)}</td><td class="num">${nb(j.sorties)}</td><td class="num">${nb(j.soldeFin)}</td></tr>`).join('');
  const html = `${entete('Livre de caisse', { periode })}
  <table class="dt">
    <thead><tr><th style="width:17mm">Date</th><th style="width:26mm">N° bon</th><th>Libellé</th><th>Remettant / Bénéficiaire</th><th>Pièce</th><th class="num">Entrées</th><th class="num">Sorties</th><th class="num">Solde</th></tr></thead>
    <tbody>
      <tr class="sub"><td>${fd(d.debut)}</td><td></td><td colspan="5">Solde d'ouverture de la période</td><td class="num">${nb(d.soldeOuverture)}</td></tr>
      ${lignes || '<tr><td colspan="8" style="text-align:center;color:#777">Aucun mouvement de caisse sur la période</td></tr>'}
    </tbody>
    <tfoot><tr class="tot"><td colspan="5">Totaux de la période — solde de clôture au ${fd(d.fin)}</td><td class="num">${nb(d.totalEntrees)}</td><td class="num">${nb(d.totalSorties)}</td><td class="num">${nb(d.soldeCloture)}</td></tr></tfoot>
  </table>
  <p class="note">Dernière clôture journalière : ${d.derniereCloture ? `${fd(d.derniereCloture.date)} (solde ${nb(d.derniereCloture.soldeCloture)})` : 'aucune'}.</p>
  ${signatures([sig('caissier'), sig('comptable')])}`;
  ouvrirDocument('Livre de caisse', feuille(html), { paysage: true, fichier: `Livre_caisse_${d.debut}_${d.fin}` });
}

/* ------------------------------------- PV de contrôle de caisse */
function docPV(pv) {
  const e = S.params.entreprise;
  const billets = pv.billetage.filter((l) => l.type === 'billet');
  const pieces = pv.billetage.filter((l) => l.type === 'piece');
  const st = (arr) => arr.reduce((a, l) => a + l.total, 0);
  const lig = (arr) => arr.map((l) => `<tr><td>${l.type === 'billet' ? 'Billet' : 'Pièce'}</td><td class="num">${nb(l.valeur)}</td><td class="num">${l.quantite}</td><td class="num">${nb(l.total)}</td></tr>`).join('');
  const constat = pv.ecart === 0 ? 'La caisse est <b>conforme</b> : aucun écart constaté.'
    : pv.ecart > 0 ? `Il est constaté un <b>excédent de caisse de ${money(pv.ecart)}</b>.`
      : `Il est constaté un <b>déficit (manquant) de caisse de ${money(-pv.ecart)}</b>.`;
  const html = `${entete('PV de contrôle de caisse', { numero: pv.numero, date: pv.date })}
  <div class="pv-texte">
    <p>Le ${dLong(pv.date)}${pv.heure ? ` à ${esc(pv.heure.replace(':', 'h'))}` : ''}, il a été procédé au contrôle inopiné de la caisse de <b>${esc(e.nom)}</b>${e.ville ? `, à ${esc(e.ville)}` : ''}, en présence de :</p>
    <p>– Caissier(ère) : <b>${esc(pv.caissier || '……………………')}</b><br>– Contrôleur : <b>${esc(pv.controleur || '……………………')}</b>${pv.temoin ? `<br>– Témoin : <b>${esc(pv.temoin)}</b>` : ''}</p>
  </div>
  <div class="doc-h">I. Solde théorique</div>
  <p>Solde de caisse selon le livre de caisse à la date du contrôle : <b>${money(pv.soldeTheorique)}</b></p>
  <div class="doc-h">II. Inventaire physique (billetage)</div>
  <table class="dt" style="width:70%">
    <thead><tr><th>Nature</th><th class="num">Valeur faciale</th><th class="num">Nombre</th><th class="num">Montant</th></tr></thead>
    <tbody>
      ${lig(billets)}<tr class="sub"><td colspan="3">Sous-total billets</td><td class="num">${nb(st(billets))}</td></tr>
      ${lig(pieces)}<tr class="sub"><td colspan="3">Sous-total pièces</td><td class="num">${nb(st(pieces))}</td></tr>
      ${pv.autresValeurs ? `<tr><td colspan="3">Autres valeurs${pv.libelleAutresValeurs ? ` (${esc(pv.libelleAutresValeurs)})` : ''}</td><td class="num">${nb(pv.autresValeurs)}</td></tr>` : ''}
    </tbody>
    <tfoot><tr class="tot"><td colspan="3">Total encaisse physique</td><td class="num">${nb(pv.soldePhysique)}</td></tr></tfoot>
  </table>
  <div class="doc-h">III. Rapprochement</div>
  <table class="dt" style="width:70%">
    <tr><td>Solde théorique (livre de caisse)</td><td class="num">${nb(pv.soldeTheorique)}</td></tr>
    <tr><td>Encaisse physique constatée</td><td class="num">${nb(pv.soldePhysique)}</td></tr>
    <tr class="tot"><td>Écart (physique − théorique)</td><td class="num">${nb(pv.ecart)}</td></tr>
  </table>
  <p style="margin-top:8px">${constat}</p>
  <div class="doc-h">IV. Observations</div>
  <div class="obs">${esc(pv.observations || 'Néant.')}</div>
  <p style="margin-top:12px">En foi de quoi, le présent procès-verbal est établi et signé par les parties pour servir et valoir ce que de droit.</p>
  ${signatures([{ titre: 'Le Caissier', nom: pv.caissier }, { titre: 'Le Contrôleur', nom: pv.controleur }, ...(pv.temoin ? [{ titre: 'Le Témoin', nom: pv.temoin }] : []), sig('directeur')])}`;
  ouvrirDocument(`PV ${pv.numero}`, feuille(html), { fichier: `PV_controle_caisse_${pv.numero}` });
}

/* ------------------------------------------------ Plan de trésorerie */
function docTresorerie(d, periode, mode) {
  const titres = { realise: 'Réalisé', prevu: 'Prévisionnel', comparatif: 'Prévu / Réalisé' };
  let corps;
  if (mode === 'comparatif') {
    const lig = (l) => {
      const ec = l.totalRealise - l.totalPrevu;
      const taux = l.totalPrevu ? `${Math.round((l.totalRealise / l.totalPrevu) * 100)} %` : '—';
      return `<tr><td>${esc(l.categorie)}</td><td class="num">${nb(l.totalPrevu)}</td><td class="num">${nb(l.totalRealise)}</td><td class="num">${nb(ec)}</td><td class="num">${taux}</td></tr>`;
    };
    const tot = (arr, lbl) => {
      const p = arr.reduce((a, l) => a + l.totalPrevu, 0); const r = arr.reduce((a, l) => a + l.totalRealise, 0);
      return `<tr class="sub"><td>${lbl}</td><td class="num">${nb(p)}</td><td class="num">${nb(r)}</td><td class="num">${nb(r - p)}</td><td class="num">${p ? `${Math.round((r / p) * 100)} %` : '—'}</td></tr>`;
    };
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const fluxP = sum(d.prevu.enc) - sum(d.prevu.dec); const fluxR = sum(d.realise.enc) - sum(d.realise.dec);
    corps = `<table class="dt">
      <thead><tr><th>Rubriques</th><th class="num">Prévu</th><th class="num">Réalisé</th><th class="num">Écart</th><th class="num">Taux de réalisation</th></tr></thead>
      <tbody>
        <tr class="sub"><td>Trésorerie en début de période</td><td class="num">${nb(d.soldeInitial)}</td><td class="num">${nb(d.soldeInitial)}</td><td></td><td></td></tr>
        <tr class="grp"><td colspan="5">Encaissements</td></tr>${d.encaissements.map(lig).join('')}${tot(d.encaissements, 'Total encaissements')}
        <tr class="grp"><td colspan="5">Décaissements</td></tr>${d.decaissements.map(lig).join('')}${tot(d.decaissements, 'Total décaissements')}
        <tr class="sub"><td>Flux net de trésorerie</td><td class="num">${nb(fluxP)}</td><td class="num">${nb(fluxR)}</td><td class="num">${nb(fluxR - fluxP)}</td><td></td></tr>
      </tbody>
      <tfoot><tr class="tot"><td>Trésorerie en fin de période</td><td class="num">${nb(d.soldeInitial + fluxP)}</td><td class="num">${nb(d.soldeInitial + fluxR)}</td><td class="num">${nb(fluxR - fluxP)}</td><td></td></tr></tfoot>
    </table>`;
  } else {
    const k = mode === 'prevu' ? 'prevu' : 'realise';
    const v = d[k];
    const n = d.mois.length;
    const total = (arr) => arr.reduce((a, x) => a + x, 0);
    const ligne = (lbl, arr, cls = '', tot = total(arr)) => `<tr class="${cls}"><td>${lbl}</td>${arr.map((x) => `<td class="num">${x ? nb(x) : (cls ? nb(0) : '')}</td>`).join('')}<td class="num">${tot === null ? '' : nb(tot)}</td></tr>`;
    corps = `<table class="dt ${n > 6 ? 'compact' : ''}">
      <thead><tr><th>Rubriques</th>${d.mois.map((m) => `<th class="num">${esc(n > 6 ? m.court : m.libelle)}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>
        ${ligne('Trésorerie en début de mois', v.debut, 'sub', v.debut[0])}
        <tr class="grp"><td colspan="${n + 2}">Encaissements</td></tr>
        ${d.encaissements.map((l) => ligne(esc(l.categorie), l[k])).join('')}
        ${ligne('Total encaissements (A)', v.enc, 'sub')}
        <tr class="grp"><td colspan="${n + 2}">Décaissements</td></tr>
        ${d.decaissements.map((l) => ligne(esc(l.categorie), l[k])).join('')}
        ${ligne('Total décaissements (B)', v.dec, 'sub')}
        ${ligne('Flux net du mois (A − B)', v.solde, 'sub')}
      </tbody>
      <tfoot>${ligne('Trésorerie en fin de mois', v.fin, 'tot', v.fin[n - 1])}</tfoot>
    </table>`;
  }
  const html = `${entete('Plan de trésorerie', { periode, meta: [`Version : <b>${titres[mode]}</b>`] })}
  ${corps}
  <p class="note">Trésorerie consolidée (comptes bancaires + caisse). Les transferts internes banque ↔ caisse sont neutralisés.${mode !== 'realise' ? ' Les montants prévisionnels sont saisis dans « Prévisions de trésorerie ».' : ''}</p>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument(`Plan de trésorerie (${titres[mode]})`, feuille(html), { paysage: true, fichier: `Plan_tresorerie_${mode}_${d.debut}_${d.fin}` });
}

/* ------------------------------------- Rapport financier (schéma) */
function docRapport(d, periode) {
  const e = S.params.entreprise;
  const pct = (x, t) => (t ? `${((x / t) * 100).toFixed(1).replace('.', ',')} %` : '—');
  const tabRep = (liste, total, lbl) => `<table class="dt"><thead><tr><th>${lbl}</th><th class="num" style="width:35mm">Montant</th><th class="num" style="width:22mm">Part</th></tr></thead><tbody>
    ${liste.map((x) => `<tr><td>${esc(x.libelle)}</td><td class="num">${nb(x.montant)}</td><td class="num">${pct(x.montant, total)}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#777">Néant</td></tr>'}
    </tbody><tfoot><tr class="tot"><td>Total</td><td class="num">${nb(total)}</td><td class="num">${total ? '100 %' : ''}</td></tr></tfoot></table>`;
  const html = `${entete('Rapport financier', { periode })}
  <div class="doc-h">I. Présentation générale</div>
  <div class="kv">
    <div>Entité</div><div>${esc(e.nom)}${e.sigle ? ` (${esc(e.sigle)})` : ''}</div>
    <div>Période couverte</div><div>${esc(libellePeriode(periode))}</div>
    <div>Monnaie de présentation</div><div>${esc(S.params.devise)}</div>
    <div>Périmètre</div><div>${d.soldes.length - 1} compte(s) bancaire(s) et la caisse</div>
  </div>

  <div class="doc-h">II. Situation de la trésorerie</div>
  <table class="dt"><thead><tr><th>Compte</th><th class="num">Solde d'ouverture</th><th class="num">Solde de clôture</th><th class="num">Variation</th></tr></thead><tbody>
    ${d.soldes.map((s) => `<tr><td>${esc(s.libelle)}</td><td class="num">${nb(s.ouverture)}</td><td class="num">${nb(s.cloture)}</td><td class="num">${nb(s.variation)}</td></tr>`).join('')}
  </tbody><tfoot><tr class="tot"><td>Trésorerie totale</td><td class="num">${nb(d.totalOuverture)}</td><td class="num">${nb(d.totalCloture)}</td><td class="num">${nb(d.totalCloture - d.totalOuverture)}</td></tr></tfoot></table>

  <div class="doc-h">III. Ressources (encaissements)</div>
  ${tabRep(d.encaissements.parCategorie, d.encaissements.total, 'Nature des ressources')}
  <p class="note">Dont encaissements directs en caisse : ${nb(d.encaissements.parCaisse)}.</p>
  ${d.encaissements.parProvenance.length ? `<h3 style="font-size:9pt;margin:8px 0 4px">Provenance des fonds reçus en banque</h3>${tabRep(d.encaissements.parProvenance.slice(0, 10), d.encaissements.parProvenance.reduce((a, x) => a + x.montant, 0), 'Provenance')}` : ''}

  <div class="doc-h">IV. Emplois (décaissements)</div>
  ${tabRep(d.decaissements.parCategorie, d.decaissements.total, 'Nature des emplois')}
  <p class="note">Dont décaissements en espèces (caisse) : ${nb(d.decaissements.parCaisse)}.</p>
  ${d.decaissements.parFournisseur.length ? `<h3 style="font-size:9pt;margin:8px 0 4px">Paiements par virement aux fournisseurs</h3>${tabRep(d.decaissements.parFournisseur.slice(0, 10), d.decaissements.parFournisseur.reduce((a, x) => a + x.montant, 0), 'Fournisseur')}` : ''}

  <div class="doc-h">V. Synthèse des flux</div>
  <table class="dt" style="width:75%"><tbody>
    <tr><td>Trésorerie d'ouverture</td><td class="num">${nb(d.totalOuverture)}</td></tr>
    <tr><td>+ Total des ressources encaissées</td><td class="num">${nb(d.encaissements.total)}</td></tr>
    <tr><td>− Total des emplois décaissés</td><td class="num">${nb(d.decaissements.total)}</td></tr>
    <tr class="sub"><td>= Flux net de la période</td><td class="num">${nb(d.fluxNet)}</td></tr>
    <tr class="tot"><td>Trésorerie de clôture</td><td class="num">${nb(d.totalCloture)}</td></tr>
  </tbody></table>
  <p class="note">Mouvements internes neutralisés : banque → caisse ${nb(d.internes.banqueVersCaisse)} ; caisse → banque ${nb(d.internes.caisseVersBanque)}. Contrôle de cohérence : ${d.coherence === 0 ? 'équilibré ✓' : `écart de ${nb(d.coherence)}`}.</p>

  <div class="doc-h">VI. Contrôles de caisse de la période</div>
  <table class="dt"><thead><tr><th>N° PV</th><th>Date</th><th class="num">Solde théorique</th><th class="num">Encaisse physique</th><th class="num">Écart</th></tr></thead><tbody>
    ${d.controles.map((c) => `<tr><td>${esc(c.numero)}</td><td>${fd(c.date)}</td><td class="num">${nb(c.soldeTheorique)}</td><td class="num">${nb(c.soldePhysique)}</td><td class="num">${nb(c.ecart)}</td></tr>`).join('') || '<tr><td colspan="5" style="color:#777">Aucun contrôle de caisse réalisé sur la période.</td></tr>'}
  </tbody></table>

  <div class="doc-h">VII. Indicateurs d'activité</div>
  <table class="dt" style="width:75%"><tbody>
    <tr><td>Opérations bancaires enregistrées</td><td class="num">${d.indicateurs.operationsBancaires}</td></tr>
    <tr><td>Ordres de virement émis</td><td class="num">${d.indicateurs.ordresVirement}</td></tr>
    <tr><td>Bons d'entrée caisse / bons de sortie caisse</td><td class="num">${d.indicateurs.bonsEntree} / ${d.indicateurs.bonsSortie}</td></tr>
    <tr><td>Procès-verbaux de contrôle de caisse</td><td class="num">${d.indicateurs.controles}</td></tr>
  </tbody></table>

  <div class="doc-h">VIII. Observations et commentaires</div>
  <div class="obs" contenteditable="true" data-placeholder="Cliquez ici pour saisir vos commentaires avant d'imprimer (faits marquants, explication des écarts, perspectives…)"></div>
  ${signatures([sig('comptable'), sig('directeur')])}`;
  ouvrirDocument('Rapport financier', feuille(html), { fichier: `Rapport_financier_${d.debut}_${d.fin}` });
}
