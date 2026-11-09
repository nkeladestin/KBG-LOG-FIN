# Gestion des fonds – Banque · Virements · Caisse · États

Application web de gestion des fonds avec stockage cloud **MongoDB Atlas**, synchronisation en temps réel et états de sortie imprimables / exportables en PDF avec **entête personnalisé**.

---

## 1. Fonctionnalités

| Domaine | Ce que fait l'application |
|---|---|
| **Devise** | Dollar américain (USD) par défaut, montants à 2 décimales, montants en lettres « … dollars américains et … cents », billetage en coupures américaines. Modifiable dans *Entête & paramètres*. |
| **Compte bancaire** | Entrée d'argent → **débit** du compte banque ; sortie d'argent → **crédit** du compte banque. Chaque opération enregistre la **provenance des fonds** et la **banque destinataire**. Plusieurs comptes bancaires possibles. |
| **Virements fournisseurs** | Le nom du fournisseur, sa banque et son compte sont enregistrés à chaque virement. Un **ordre de virement officiel** numéroté (OV-AAAA-00001) est généré automatiquement, avec le montant en lettres. |
| **Transferts en caisse** | Chaque transfert banque → caisse génère automatiquement un **bon d'entrée caisse** (BEC-AAAA-00001). |
| **Caisse** | Bon d'entrée pour chaque entrée, **bon de sortie** (BSC-AAAA-00001) pour chaque sortie, imprimés en double exemplaire (original + souche). Le versement caisse → banque génère le bon de sortie. |
| **Livre de caisse** | Mis à jour en temps réel, présenté jour par jour (solde de début, mouvements, total et solde de fin de journée). **Clôture journalière** : une journée clôturée ne peut plus être modifiée. |
| **Contrôle de caisse** | PV avec billetage (billets et pièces), solde théorique, encaisse physique, écart (excédent / déficit), observations, signatures. |
| **États de sortie** | Journal banque · PV de contrôle de caisse · Plan de trésorerie (réalisé, prévisionnel, comparatif) · Rapport financier (schéma de présentation) · Livre de caisse. |
| **Entête personnalisé** | Menu *Entête & paramètres* : nom, sigle, forme juridique, adresse, contacts, RCCM, NIF, logo, ligne complémentaire, pied de page, signataires. Tous les états le reprennent automatiquement. |
| **Filtres de période** | Journalière, hebdomadaire, mensuelle, trimestrielle, semestrielle, annuelle ou personnalisée (du … au …). |
| **Traçabilité** | Numérotation séquentielle automatique, aucune suppression possible (annulation avec motif obligatoire, l'opération reste visible barrée), **journal d'audit** (qui, quoi, quand), contrôle des soldes (caisse jamais négative ; découvert bancaire paramétrable), transactions ACID. |
| **Accès** | Connexion par identifiant / mot de passe, 3 rôles : Administrateur, Agent de saisie, Consultation. |
| **Double stockage** | Chaque opération est d'abord écrite sur le disque du PC (journal sécurisé + base locale + sauvegarde quotidienne), puis recopiée automatiquement dans MongoDB Atlas. Sans Internet, l'application continue de fonctionner ; la file d'attente part au retour du réseau. Écran *Stockage & synchronisation* : état, synchronisation manuelle, sauvegarde téléchargeable, reconstruction du cloud. |
| **Temps réel** | Toute saisie apparaît instantanément sur les autres postes connectés (flux de changements MongoDB + Server-Sent Events). |

---

## 2. Créer la base MongoDB Atlas (10 minutes)

1. Créez un compte sur <https://www.mongodb.com/cloud/atlas/register>.
2. **Create a cluster** : l'offre gratuite *M0* suffit pour démarrer ; pour la production, une offre *Flex* ou *M10* (sauvegardes automatiques) est recommandée. Choisissez la région la plus proche de vos utilisateurs.
3. **Database Access** → *Add New Database User* : créez un utilisateur (ex. `gestion_fonds_app`) avec un mot de passe fort et le rôle *Read and write to any database*.
4. **Network Access** → *Add IP Address* : ajoutez l'adresse IP de votre serveur (ou `0.0.0.0/0` le temps des tests uniquement).
5. **Database** → *Connect* → *Drivers* → copiez la chaîne de connexion `mongodb+srv://…` et remplacez `<password>` par le mot de passe de l'étape 3.

Les collections et index sont créés automatiquement au premier démarrage.

---

## 3. Installation et lancement

Prérequis : **Node.js 18 ou plus récent** (<https://nodejs.org>).

```bash
cd gestion-fonds
npm install                 # installe le pilote officiel MongoDB (seule dépendance)
cp .env.example .env        # puis éditez .env
```

Renseignez dans `.env` :

```ini
MONGODB_URI=mongodb+srv://gestion_fonds_app:VOTRE_MOT_DE_PASSE@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=gestion_fonds
SESSION_SECRET=<résultat de : node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
ADMIN_USER=admin
ADMIN_PASSWORD=<mot de passe du premier administrateur>
```

Démarrez :

```bash
npm start
```

Ouvrez <http://localhost:3000> et connectez-vous avec `ADMIN_USER` / `ADMIN_PASSWORD`.

> **Essai sans Atlas** : `npm run demo` démarre l'application avec un stockage en mémoire (données perdues à l'arrêt). À réserver aux démonstrations.

### Premiers pas

1. **Entête & paramètres** : saisissez les informations de l'entête, chargez le logo, indiquez les signataires, la devise et le solde initial de la caisse.
2. **Comptes bancaires** : créez vos comptes avec leur solde initial.
3. **Fournisseurs** : enregistrez vos fournisseurs avec leur banque et leur numéro de compte.
4. **Utilisateurs** : créez les comptes de vos collaborateurs.
5. Commencez la saisie : *Opérations bancaires*, *Bons de caisse*, *Contrôle de caisse*.
6. *Prévisions de trésorerie* (facultatif) : saisissez les montants prévus pour obtenir le plan prévisionnel et le comparatif.

---

## 3 bis. Installation sous Windows avec l'installateur

1. Installez **Node.js LTS** depuis <https://nodejs.org> (options par défaut).
2. Décompressez `Installateur-GestionFonds.zip` (clic droit → *Extraire tout…*).
3. Double-cliquez sur **`INSTALLER.bat`**. L'installateur, qui ne demande pas de droits administrateur :
   - vérifie Node.js ;
   - copie l'application dans `%LOCALAPPDATA%\GestionFonds` ;
   - télécharge le pilote MongoDB ;
   - demande la chaîne de connexion Atlas et le compte administrateur ;
   - crée les raccourcis **Gestion des fonds** sur le Bureau et dans le menu Démarrer ;
   - inscrit l'application dans *Paramètres → Applications* pour la désinstallation.
4. Lancez l'application depuis l'icône du Bureau : le navigateur s'ouvre sur <http://localhost:3000>. Gardez la fenêtre noire ouverte pendant l'utilisation.

**Mise à jour :** relancez `INSTALLER.bat` d'une version plus récente ; la configuration est conservée.
**Désinstallation :** menu Démarrer → *Désinstaller Gestion des fonds* (les données dans Atlas ne sont pas touchées).

## 3 ter. Double stockage local + cloud

| Élément | Emplacement / comportement |
|---|---|
| Base locale | `donnees\base.json` + `donnees\journal.ndjson` (chaque transaction est écrite et forcée sur disque avant d'être confirmée ; rejouée au démarrage après une coupure) |
| Sauvegardes locales | `donnees\sauvegardes\base-AAAA-MM-JJ.json`, une par jour, 30 jours conservés |
| Cloud | MongoDB Atlas (si `MONGODB_URI` est renseigné) : envoi automatique en continu, réception en temps réel des autres postes |
| Hors ligne | Saisie normale ; numéros au format `BQ-2026-P1-0001` (code du poste) ; envoi automatique au retour du réseau |
| Nouveau PC | Au premier lancement, toutes les données sont téléchargées depuis Atlas |
| Cloud perdu | *Stockage & synchronisation → Renvoyer toutes les données vers le cloud* |
| Conflits | Une modification locale non envoyée n'est jamais écrasée ; ensuite la dernière écriture l'emporte ; les doublons refusés par le cloud sont listés |

**Par défaut, l'application fonctionne en stockage local.** Pour activer le cloud : menu *Stockage & synchronisation* → *Paramétrage de la connexion cloud* (administrateur). Collez la chaîne de connexion Atlas, cliquez sur *Tester la connexion* puis *Enregistrer et activer* ; aucun redémarrage n'est nécessaire. Les données déjà saisies sont alors envoyées automatiquement vers Atlas. Le bouton *Désactiver le cloud* revient au stockage local seul.

## 4. Impression et export PDF

Chaque document s'ouvre dans une visionneuse au format A4 (portrait ou paysage selon l'état) :

- **Imprimer** : envoie le document à l'imprimante ;
- **Exporter en PDF** : ouvre la même boîte de dialogue avec le nom de fichier déjà proposé ; choisissez la destination **« Enregistrer au format PDF »**.

Les en-têtes de tableaux se répètent sur chaque page, chaque page est numérotée (« Page x / y ») et porte le pied de page défini dans les paramètres. Dans le rapport financier, la rubrique *Observations et commentaires* est modifiable directement avant l'impression. Le rendu est optimisé pour Chrome et Edge.

---

## 5. Mise en ligne (accès en tout lieu)

L'application est un unique processus Node.js sans étape de compilation. Options courantes :

- **Render, Railway, Fly.io, Heroku…** : déployez le dossier, commande de démarrage `npm start`, ajoutez les variables du fichier `.env` dans le tableau de bord de l'hébergeur et `COOKIE_SECURE=true`. Autorisez l'adresse IP sortante de l'hébergeur dans *Network Access* d'Atlas.
- **Serveur VPS** : `npm start` sous un gestionnaire de processus (`pm2 start server/index.js --name gestion-fonds`) derrière Nginx avec certificat HTTPS (Let's Encrypt). Pour Nginx, désactivez la mise en tampon sur `/api/evenements` (`proxy_buffering off;`) afin que le temps réel fonctionne.

**Toujours utiliser HTTPS en production** et mettre `COOKIE_SECURE=true`.

---

## 4 bis. Agences et gestion de stock

**Agences**
- Menu Administration → **Agences** : créez vos agences (code, nom, ville, responsable, solde initial de caisse).
- Chaque opération (banque, caisse, PV, prévisions, stock, journal d'audit) appartient à une agence.
- Un utilisateur **rattaché à une agence** (ex. rôle « Responsable d'agence ») ne voit et ne saisit que les données de son agence, avec les seuls droits que l'administrateur a donnés à son rôle. Le serveur l'impose : même en forçant l'adresse, aucune donnée d'une autre agence n'est accessible.
- L'administrateur (ou un compte « toutes agences ») choisit l'agence dans le sélecteur en haut du menu, ou la vue consolidée.
- Avec une seule agence, rien ne change : elle s'applique d'office. Les données existantes sont rattachées automatiquement à l'agence « Siège ».

**Stock (produits vivriers)**, d'après le cahier des charges KBG v2 :
- Articles et catégories (céréales, farines, tubercules, légumineuses, huiles, sucre, fruits et légumes…), seuils min / max par agence.
- Réceptions par lot : coût unitaire = prix + frais accessoires, péremption, fournisseur, origine, campagne, humidité, impuretés, quarantaine.
- Sorties en FEFO (le lot qui périme le plus tôt part en premier ; tout écart doit être motivé), transferts inter-agences (en transit puis réception), pertes soumises à validation, inventaires (à l'aveugle) avec écarts valorisés.
- Chaque jour, automatiquement : lots périmés détectés, bloqués et valorisés en perte ; instantané non modifiable de la valeur du stock.
- Rapports imprimables / PDF : valeur du stock par agence et catégorie, pertes quotidiennes sur péremption (brute, récupération, nette, cumuls), péremptions à 7 / 15 / 30 jours et stock dormant, état des stocks et réapprovisionnement, pertes par motif, journal des mouvements, évolution quotidienne, PV d'inventaire, bons de réception / sortie / transfert, fiche de traçabilité d'un lot.

## 4 ter. Utilisateurs

- Deux sortes de comptes : **Administrateur** (toutes les agences, tous les droits) et **Responsable d'agence** (une seule agence).
- Pour chaque responsable, l'administrateur coche ce qu'il peut faire (banque, caisse, contrôles, états, prévisions, stock…), avec des modèles prêts à l'emploi (gestion complète, banque, caisse, stock, consultation seule). Les droits s'appliquent immédiatement sur tous ses appareils.
- Après la création, un récapitulatif (adresse, identifiant, mot de passe) est prêt à être copié et transmis.
- Suspendre / réactiver en un clic ; mot de passe consultable par l'administrateur ; suppression avec conservation de l'historique.
- **Connexion depuis un autre ordinateur** : si l'ordinateur n'est pas relié au cloud (ou si le compte vient d'être créé ailleurs), l'identifiant et le mot de passe sont vérifiés par le serveur en ligne et la session s'ouvre directement sur la version en ligne (jeton à usage unique, valable 2 minutes).

## 5 bis. Mises à jour et droits en temps réel

- **Mise à jour de tous les appareils** : il suffit de publier la nouvelle version sur GitHub (Render la déploie).
  - Téléphones, tablettes et navigateurs : la page se recharge seule avec la nouvelle version.
  - Ordinateurs installés : toutes les 10 minutes, chaque PC compare sa version avec celle du serveur en ligne ;
    si elle est plus récente, il télécharge le code, vérifie chaque fichier (empreinte SHA-256 et syntaxe),
    garde l'ancienne version dans `maj-precedente`, remplace les fichiers et redémarre.
  - Une saisie en cours n'est jamais interrompue : la mise à jour attend la fermeture du formulaire.
  - Les données (`donnees`) et la configuration (`.env`) ne sont jamais touchées.
- **Droits en temps réel** : quand l'administrateur retire un accès, désactive un compte ou change un rôle,
  les fonctions concernées s'estompent puis disparaissent immédiatement chez l'utilisateur, sur tous ses appareils ;
  un compte désactivé est déconnecté partout.

## 6. Règles de gestion appliquées

- **Sens des écritures** (journal banque) : entrée d'argent = colonne *Débit* ; sortie d'argent = colonne *Crédit* ; solde progressif.
- **Sorties bancaires** : uniquement par virement fournisseur (ordre de virement généré) ou par transfert en caisse (bon d'entrée caisse généré).
- **Mouvements internes** (banque ↔ caisse) : neutralisés dans le plan de trésorerie et le rapport financier pour ne pas gonfler les encaissements et décaissements.
- **Contrôle des soldes** : la caisse ne peut jamais devenir négative, à aucune date ; le découvert bancaire est refusé sauf si vous l'autorisez dans les paramètres.
- **Annulation** (administrateur) : motif obligatoire ; l'opération et ses documents liés (ordre, bon) sont marqués annulés et exclus des soldes, mais restent consultables.
- **Clôture journalière** : bloque toute saisie ou annulation de caisse à la date clôturée et avant.
- **Solde initial d'un compte** : non modifiable dès qu'une opération existe.
- **Numérotation** : séquentielle par type et par année ; en ligne, attribuée par Atlas (unique entre tous les postes) ; hors ligne, suffixée du code du poste.

---

## 7. Structure du projet

```
gestion-fonds/
├── package.json          dépendance unique : mongodb
├── .env.example          modèle de configuration
├── server/
│   ├── index.js          serveur HTTP, routes API, sécurité, temps réel (SSE)
│   ├── db.js             accès MongoDB Atlas (transactions, flux de changements) + stockage mémoire de démo
│   ├── services.js       règles de gestion : opérations, ordres, bons, clôtures, PV, prévisions, audit
│   ├── reports.js        calcul des états : journal banque, livre de caisse, trésorerie, rapport
│   ├── auth.js           mots de passe (scrypt), sessions signées, rôles
│   └── lettres.js        montant en toutes lettres (français)
└── public/
    ├── index.html
    ├── css/app.css       interface + mise en page A4 des documents
    └── js/
        ├── core.js       API, période, routeur, temps réel
        ├── docs.js       documents : ordre de virement, bons, journal, livre, PV, trésorerie, rapport
        └── pages.js      écrans et formulaires
```

## 8. Sécurité et sauvegarde

- Mots de passe hachés (scrypt), sessions signées HMAC de 12 h, révoquées au changement de mot de passe ou à la désactivation du compte.
- Limitation des tentatives de connexion, protection CSRF, en-têtes de sécurité (CSP, X-Frame-Options…).
- Sauvegardes : activez les **sauvegardes continues** d'Atlas (offres payantes) ou planifiez un `mongodump` régulier.
