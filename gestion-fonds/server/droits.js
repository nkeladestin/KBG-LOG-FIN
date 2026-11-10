'use strict';
/**
 * Droits d'accès : catalogue des permissions et rôles.
 * Les rôles sont définis par l'administrateur (écran Utilisateurs → Rôles) ; le rôle
 * « Administrateur » possède toujours toutes les permissions et ne peut être ni modifié ni supprimé.
 */

const PERMISSIONS = [
  { cle: 'banque.voir', groupe: 'Banque', libelle: 'Consulter les opérations bancaires et ordres de virement' },
  { cle: 'banque.saisir', groupe: 'Banque', libelle: 'Saisir entrées, virements fournisseurs et transferts' },
  { cle: 'banque.annuler', groupe: 'Banque', libelle: 'Annuler une opération bancaire' },
  { cle: 'fournisseurs.gerer', groupe: 'Banque', libelle: 'Créer et modifier les fournisseurs' },
  { cle: 'comptes.gerer', groupe: 'Banque', libelle: 'Créer et modifier les comptes bancaires' },
  { cle: 'caisse.voir', groupe: 'Caisse', libelle: 'Consulter les bons et le livre de caisse' },
  { cle: 'caisse.saisir', groupe: 'Caisse', libelle: "Établir des bons d'entrée et de sortie" },
  { cle: 'caisse.annuler', groupe: 'Caisse', libelle: 'Annuler un bon de caisse' },
  { cle: 'caisse.cloturer', groupe: 'Caisse', libelle: 'Clôturer une journée de caisse' },
  { cle: 'pv.voir', groupe: 'Caisse', libelle: 'Consulter les PV de contrôle de caisse' },
  { cle: 'pv.saisir', groupe: 'Caisse', libelle: 'Établir un PV de contrôle de caisse' },
  { cle: 'etats.voir', groupe: 'Pilotage', libelle: 'Afficher, imprimer et exporter les états de sortie' },
  { cle: 'previsions.voir', groupe: 'Pilotage', libelle: 'Consulter les prévisions de trésorerie' },
  { cle: 'previsions.modifier', groupe: 'Pilotage', libelle: 'Modifier les prévisions de trésorerie' },
  { cle: 'stock.voir', groupe: 'Stock', libelle: 'Consulter le stock, les lots, les mouvements et les transferts' },
  { cle: 'stock.saisir', groupe: 'Stock', libelle: 'Enregistrer les réceptions et les sorties de stock' },
  { cle: 'stock.transferer', groupe: 'Stock', libelle: 'Transférer du stock vers une autre agence et réceptionner les transferts' },
  { cle: 'stock.pertes', groupe: 'Stock', libelle: 'Déclarer des pertes (casse, vol, détérioration, don…)' },
  { cle: 'stock.inventaire', groupe: 'Stock', libelle: 'Réaliser les inventaires (comptage)' },
  { cle: 'stock.valider', groupe: 'Stock', libelle: 'Valider les pertes et les inventaires, bloquer / débloquer des lots, sortir les lots périmés' },
  { cle: 'stock.articles', groupe: 'Stock', libelle: 'Gérer les articles, les catégories et les seuils' },
  { cle: 'stock.etats', groupe: 'Stock', libelle: 'Rapports de stock : valeur, pertes sur péremption, péremptions à venir' },
  { cle: 'parametres.gerer', groupe: 'Administration', libelle: 'Modifier l\'entête et les paramètres' },
  { cle: 'agences.gerer', groupe: 'Administration', libelle: 'Créer et modifier les agences' },
  { cle: 'utilisateurs.gerer', groupe: 'Administration', libelle: 'Gérer les utilisateurs et les rôles' },
  { cle: 'audit.voir', groupe: 'Administration', libelle: "Consulter le journal d'audit" },
  { cle: 'stockage.gerer', groupe: 'Administration', libelle: 'Gérer le stockage et la connexion cloud' },
];
const CLES = PERMISSIONS.map((p) => p.cle);
/** Droits réservés à l'administration centrale (sans objet pour un responsable rattaché à une agence). */
const CENTRALES = ['parametres.gerer', 'utilisateurs.gerer', 'stockage.gerer', 'agences.gerer', 'stock.articles'];
const CLES_RESPONSABLE = CLES.filter((c) => !CENTRALES.includes(c));

const ROLES_DEFAUT = [
  { _id: 'admin', nom: 'Administrateur', description: 'Tous les droits (rôle protégé)', permissions: CLES, systeme: true },
  {
    _id: 'saisie', nom: 'Agent de saisie', description: 'Saisie bancaire et caisse, consultation des états',
    permissions: ['banque.voir', 'banque.saisir', 'fournisseurs.gerer', 'caisse.voir', 'caisse.saisir', 'caisse.cloturer', 'pv.voir', 'pv.saisir', 'etats.voir', 'previsions.voir', 'previsions.modifier'],
  },
  { _id: 'lecture', nom: 'Consultation', description: 'Lecture et impression uniquement', permissions: ['banque.voir', 'caisse.voir', 'pv.voir', 'etats.voir', 'previsions.voir'] },
  {
    _id: 'responsable-agence', nom: "Responsable d'agence", description: "Toutes les opérations de son agence (banque, caisse, stock), sans voir les autres agences",
    permissions: ['banque.voir', 'banque.saisir', 'banque.annuler', 'fournisseurs.gerer', 'comptes.gerer', 'caisse.voir', 'caisse.saisir', 'caisse.annuler', 'caisse.cloturer',
      'pv.voir', 'pv.saisir', 'etats.voir', 'previsions.voir', 'previsions.modifier', 'audit.voir',
      'stock.voir', 'stock.saisir', 'stock.transferer', 'stock.pertes', 'stock.inventaire', 'stock.valider', 'stock.etats'],
  },
  {
    _id: 'magasinier', nom: 'Magasinier', description: 'Réceptions, sorties, transferts, déclaration de pertes et comptages',
    permissions: ['stock.voir', 'stock.saisir', 'stock.transferer', 'stock.pertes', 'stock.inventaire'],
  },
];

function createDroits(store) {
  /** Crée les rôles par défaut s'ils n'existent pas (sans écraser les modifications). */
  async function initialiser() {
    for (const r of ROLES_DEFAUT) {
      const { _id, ...reste } = r;
      if (!(await store.col('roles').findOne({ _id }))) await store.col('roles').updateOne({ _id }, { $set: { ...reste, semence: true, creeLe: new Date().toISOString() } }, { upsert: true });
    }
  }

  /** Droits d'un utilisateur : tous pour l'administrateur, sinon ceux cochés sur son compte (ou ceux de son rôle). */
  async function permissionsUtilisateur(u) {
    if (!u || u.role === 'admin') return CLES.slice();
    if (Array.isArray(u.permissionsPerso || u.permissions)) {
      const liste = u.permissionsPerso || u.permissions;
      return CLES.filter((c) => liste.includes(c) && (!u.agenceId || !CENTRALES.includes(c)));
    }
    const r = await permissionsDe(u.role);
    return u.agenceId ? r.filter((c) => !CENTRALES.includes(c)) : r;
  }

  async function permissionsDe(roleId) {
    if (roleId === 'admin') return CLES.slice();
    const r = await store.col('roles').findOne({ _id: roleId });
    return r ? (r.permissions || []).filter((p) => CLES.includes(p)) : [];
  }

  return { initialiser, permissionsDe, permissionsUtilisateur };
}

module.exports = { PERMISSIONS, CLES, CLES_RESPONSABLE, CENTRALES, ROLES_DEFAUT, createDroits };
