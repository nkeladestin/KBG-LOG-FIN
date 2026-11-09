'use strict';
/** Calcul des états de sortie : journal banque, livre de caisse, plan de trésorerie, rapport financier. */

const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const arrondi = (x) => Math.round(x * 100) / 100;
const somme = (arr, f = (x) => x.montant) => arrondi(arr.reduce((a, x) => a + f(x), 0));
const lendemain = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
const tri = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.numero < b.numero ? -1 : a.numero > b.numero ? 1 : 0));

function grouper(items, cle) {
  const m = new Map();
  for (const it of items) {
    const k = cle(it) || '—';
    m.set(k, arrondi((m.get(k) || 0) + it.montant));
  }
  return [...m.entries()].map(([libelle, montant]) => ({ libelle, montant })).sort((a, b) => b.montant - a.montant);
}

function createReports(store, svc) {
  const actifs = { annulee: { $ne: true } };
  const periode = (debut, fin) => ({ ...actifs, date: { $gte: debut, $lte: fin } });

  async function journalBanque(debut, fin, compteId) {
    const filtre = periode(debut, fin);
    let compte = null;
    if (compteId) {
      compte = await store.col('comptes').findOne({ _id: compteId });
      if (!compte) throw new svc.ErreurMetier('Compte introuvable.', 404);
      filtre.compteId = compteId;
    }
    const ops = (await store.col('operations').find(filtre)).sort(tri);
    const soldeOuverture = await svc.soldeBanque(store, compteId || null, debut);
    let s = soldeOuverture;
    const lignes = ops.map((o) => {
      const debit = o.sens === 'entree' ? o.montant : 0;   // entrée d'argent → débit du compte banque
      const credit = o.sens === 'sortie' ? o.montant : 0;  // sortie d'argent → crédit du compte banque
      s = arrondi(s + debit - credit);
      return {
        _id: o._id, date: o.date, numero: o.numero, libelle: o.libelle, provenance: o.provenance,
        banqueDestinataire: o.banqueDestinataire, tiers: o.fournisseurNom || '', reference: o.reference || '',
        piece: o.ordreNumero || o.bonNumero || '', compte: o.compte, nature: o.nature, debit, credit, solde: s,
      };
    });
    const totalDebit = somme(lignes, (l) => l.debit);
    const totalCredit = somme(lignes, (l) => l.credit);
    return { debut, fin, compte, soldeOuverture, lignes, totalDebit, totalCredit, soldeCloture: arrondi(soldeOuverture + totalDebit - totalCredit) };
  }

  async function livreCaisse(debut, fin) {
    const bons = (await store.col('bons').find(periode(debut, fin))).sort(tri);
    const soldeOuverture = await svc.soldeCaisse(store, debut);
    const clotures = await store.col('clotures').find({ date: { $gte: debut, $lte: fin } });
    const parJour = new Map();
    let s = soldeOuverture;
    for (const b of bons) {
      if (!parJour.has(b.date)) parJour.set(b.date, { date: b.date, soldeDebut: s, lignes: [], entrees: 0, sorties: 0 });
      const j = parJour.get(b.date);
      const entree = b.type === 'entree' ? b.montant : 0;
      const sortie = b.type === 'sortie' ? b.montant : 0;
      s = arrondi(s + entree - sortie);
      j.entrees = arrondi(j.entrees + entree);
      j.sorties = arrondi(j.sorties + sortie);
      j.soldeFin = s;
      j.lignes.push({ _id: b._id, numero: b.numero, type: b.type, libelle: b.libelle, tiers: b.tiers, categorie: b.categorie, piece: b.piece, entree, sortie, solde: s });
    }
    const jours = [...parJour.values()].map((j) => ({ ...j, cloture: clotures.find((c) => c.date === j.date) || null }));
    const totalEntrees = somme(bons.filter((b) => b.type === 'entree'));
    const totalSorties = somme(bons.filter((b) => b.type === 'sortie'));
    const derniere = (await store.col('clotures').find({}, { sort: { date: -1 }, limit: 1 }))[0] || null;
    return { debut, fin, soldeOuverture, jours, totalEntrees, totalSorties, soldeCloture: arrondi(soldeOuverture + totalEntrees - totalSorties), derniereCloture: derniere };
  }

  function listeMois(debut, fin) {
    const res = [];
    let [a, m] = debut.split('-').map(Number);
    const [af, mf] = fin.split('-').map(Number);
    while (a < af || (a === af && m <= mf)) {
      const cle = `${a}-${String(m).padStart(2, '0')}`;
      const dernierJour = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
      res.push({ cle, annee: a, index: m - 1, libelle: `${MOIS[m - 1]} ${a}`, court: `${MOIS[m - 1].slice(0, 4)}. ${String(a).slice(2)}`,
        debut: `${cle}-01` < debut ? debut : `${cle}-01`, fin: dernierJour > fin ? fin : dernierJour });
      m += 1; if (m > 12) { m = 1; a += 1; }
      if (res.length > 36) throw new svc.ErreurMetier('Période trop longue pour le plan de trésorerie (36 mois maximum).');
    }
    return res;
  }

  async function mouvementsExternes(debut, fin) {
    const ops = (await store.col('operations').find(periode(debut, fin))).filter((o) => !o.interne);
    const bons = (await store.col('bons').find(periode(debut, fin))).filter((b) => !b.interne);
    const enc = [...ops.filter((o) => o.sens === 'entree'), ...bons.filter((b) => b.type === 'entree')];
    const dec = [...ops.filter((o) => o.sens === 'sortie'), ...bons.filter((b) => b.type === 'sortie')];
    return { ops, bons, enc, dec };
  }

  async function tresorerie(debut, fin) {
    const p = await svc.getParametres();
    const mois = listeMois(debut, fin);
    const { enc, dec } = await mouvementsExternes(debut, fin);
    const prev = {};
    for (const an of new Set(mois.map((m) => m.annee))) prev[an] = await svc.getPrevisions(an);

    const construire = (mouvements, catsParam, cleePrev) => {
      const cats = [...catsParam];
      for (const x of mouvements) if (x.categorie && !cats.includes(x.categorie)) cats.push(x.categorie);
      for (const an of Object.keys(prev)) for (const c of Object.keys(prev[an][cleePrev] || {})) if (!cats.includes(c)) cats.push(c);
      return cats.map((categorie) => {
        const realise = mois.map((m) => somme(mouvements.filter((x) => x.categorie === categorie && x.date >= m.debut && x.date <= m.fin)));
        const prevu = mois.map((m) => arrondi(((prev[m.annee][cleePrev] || {})[categorie] || [])[m.index] || 0));
        return { categorie, realise, prevu, totalRealise: somme(realise, (x) => x), totalPrevu: somme(prevu, (x) => x) };
      }).filter((l) => l.totalRealise !== 0 || l.totalPrevu !== 0 || catsParam.includes(l.categorie));
    };
    const encaissements = construire(enc, p.categoriesEncaissement, 'encaissements');
    const decaissements = construire(dec, p.categoriesDecaissement, 'decaissements');
    const col = (lignes, k) => mois.map((_, i) => somme(lignes, (l) => l[k][i]));
    const encR = col(encaissements, 'realise'); const encP = col(encaissements, 'prevu');
    const decR = col(decaissements, 'realise'); const decP = col(decaissements, 'prevu');
    const soldeInitial = arrondi((await svc.soldeBanque(store, null, debut)) + (await svc.soldeCaisse(store, debut)));
    const chaine = (e, d) => {
      const deb = []; const fins = []; let s = soldeInitial;
      mois.forEach((_, i) => { deb.push(s); s = arrondi(s + e[i] - d[i]); fins.push(s); });
      return { debut: deb, fin: fins };
    };
    return {
      debut, fin, mois, encaissements, decaissements, soldeInitial,
      realise: { enc: encR, dec: decR, solde: mois.map((_, i) => arrondi(encR[i] - decR[i])), ...chaine(encR, decR) },
      prevu: { enc: encP, dec: decP, solde: mois.map((_, i) => arrondi(encP[i] - decP[i])), ...chaine(encP, decP) },
    };
  }

  async function rapport(debut, fin) {
    const comptes = await store.col('comptes').find({}, { sort: { banque: 1 } });
    const apres = lendemain(fin);
    const soldes = [];
    for (const c of comptes) {
      const ouverture = await svc.soldeBanque(store, c._id, debut);
      const cloture = await svc.soldeBanque(store, c._id, apres);
      if (c.actif === false && ouverture === 0 && cloture === 0) continue;
      soldes.push({ libelle: `${c.banque} – ${c.numero}`, ouverture, cloture, variation: arrondi(cloture - ouverture) });
    }
    const cO = await svc.soldeCaisse(store, debut);
    const cC = await svc.soldeCaisse(store, apres);
    soldes.push({ libelle: 'Caisse', ouverture: cO, cloture: cC, variation: arrondi(cC - cO) });
    const totalOuverture = somme(soldes, (s) => s.ouverture);
    const totalCloture = somme(soldes, (s) => s.cloture);

    const { ops, bons, enc, dec } = await mouvementsExternes(debut, fin);
    const tousOps = await store.col('operations').find(periode(debut, fin));
    const internes = tousOps.filter((o) => o.interne);
    const pvs = (await store.col('pv').find({ date: { $gte: debut, $lte: fin } })).sort(tri);
    const ordres = await store.col('ordres').countDocuments(periode(debut, fin));
    const tousBons = await store.col('bons').find(periode(debut, fin));
    const totalEnc = somme(enc); const totalDec = somme(dec);
    return {
      debut, fin, soldes, totalOuverture, totalCloture,
      encaissements: { total: totalEnc, parCategorie: grouper(enc, (x) => x.categorie), parProvenance: grouper(ops.filter((o) => o.sens === 'entree'), (o) => o.provenance), parCaisse: somme(bons.filter((b) => b.type === 'entree')) },
      decaissements: { total: totalDec, parCategorie: grouper(dec, (x) => x.categorie), parFournisseur: grouper(ops.filter((o) => o.nature === 'virement_fournisseur'), (o) => o.fournisseurNom), parCaisse: somme(bons.filter((b) => b.type === 'sortie')) },
      fluxNet: arrondi(totalEnc - totalDec),
      internes: {
        banqueVersCaisse: somme(internes.filter((o) => o.nature === 'transfert_caisse')),
        caisseVersBanque: somme(internes.filter((o) => o.nature === 'versement_caisse')),
      },
      controles: pvs.map((p) => ({ numero: p.numero, date: p.date, soldeTheorique: p.soldeTheorique, soldePhysique: p.soldePhysique, ecart: p.ecart })),
      indicateurs: {
        operationsBancaires: tousOps.length, ordresVirement: ordres,
        bonsEntree: tousBons.filter((b) => b.type === 'entree').length, bonsSortie: tousBons.filter((b) => b.type === 'sortie').length,
        controles: pvs.length,
      },
      coherence: arrondi(totalOuverture + totalEnc - totalDec - totalCloture),
    };
  }

  async function tableauDeBord() {
    const today = new Date().toISOString().slice(0, 10);
    const comptes = await store.col('comptes').find({}, { sort: { banque: 1 } });
    const soldes = [];
    for (const c of comptes) if (c.actif !== false) soldes.push({ _id: c._id, banque: c.banque, intitule: c.intitule, numero: c.numero, solde: await svc.soldeBanque(store, c._id, null) });
    const caisse = await svc.soldeCaisse(store, null);
    const debutMois = `${today.slice(0, 7)}-01`;
    const { enc, dec } = await mouvementsExternes(debutMois, `${today.slice(0, 7)}-31`);
    const ops = await store.col('operations').find({}, { sort: { creeLe: -1 }, limit: 8 });
    const bons = await store.col('bons').find({}, { sort: { creeLe: -1 }, limit: 8 });
    const derniers = [
      ...ops.map((o) => ({ quand: o.creeLe, date: o.date, numero: o.numero, libelle: o.libelle, montant: o.montant, sens: o.sens, lieu: 'Banque', annulee: o.annulee })),
      ...bons.map((b) => ({ quand: b.creeLe, date: b.date, numero: b.numero, libelle: b.libelle, montant: b.montant, sens: b.type, lieu: 'Caisse', annulee: b.annulee })),
    ].sort((a, b) => (a.quand < b.quand ? 1 : -1)).slice(0, 10);
    const derniereCloture = (await store.col('clotures').find({}, { sort: { date: -1 }, limit: 1 }))[0] || null;
    const dernierPV = (await store.col('pv').find({}, { sort: { creeLe: -1 }, limit: 1 }))[0] || null;
    return {
      soldes, caisse, total: arrondi(soldes.reduce((a, s) => a + s.solde, 0) + caisse),
      mois: { encaissements: somme(enc), decaissements: somme(dec) }, derniers, derniereCloture,
      dernierPV: dernierPV && { numero: dernierPV.numero, date: dernierPV.date, ecart: dernierPV.ecart },
    };
  }

  return { journalBanque, livreCaisse, tresorerie, rapport, tableauDeBord };
}

module.exports = { createReports };
