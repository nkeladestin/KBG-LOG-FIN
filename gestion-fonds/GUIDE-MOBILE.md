# Gestion des fonds sur téléphone et tablette (iPhone, iPad, Android)

L'application mobile est une **application web installable (PWA)**. Le même code sert pour iPhone, iPad, Android et les navigateurs. Elle s'installe sur l'écran d'accueil comme une vraie application : icône, plein écran, sans barre d'adresse. Elle travaille **directement sur votre base MongoDB Atlas**, donc sur les mêmes données que le PC, en temps réel.

```
 Téléphones / tablettes ──HTTPS──►  Serveur cloud (Render)  ──►  MongoDB Atlas « Destin »
                                                                   ▲
 PC (application de bureau, stockage local + cloud) ───────────────┘
```

Les téléphones ont besoin d'une adresse Internet sécurisée (https://…). Le serveur de l'application est donc mis en ligne une fois, sur Render.com.

---

## Étape 1 – Mettre le code sur GitHub (10 min, une seule fois)

1. Créez un compte gratuit sur <https://github.com> (si vous n'en avez pas).
2. Cliquez sur **+** (en haut à droite) → **New repository**.
   - Nom : `gestion-fonds`
   - Cochez **Private** (votre code reste privé).
   - Cliquez sur **Create repository**.
3. Sur la page du dépôt vide, cliquez sur **uploading an existing file**.
4. Décompressez `GestionFonds-Mobile-Cloud.zip`, ouvrez le dossier `gestion-fonds`, **sélectionnez tout son contenu** (Ctrl + A) et glissez-le dans la page GitHub.
   Vérifiez que `Dockerfile`, `render.yaml`, `package.json`, et les dossiers `server` et `public` apparaissent.
5. Cliquez sur **Commit changes**.

## Étape 2 – Autoriser le serveur cloud dans Atlas (1 min)

Le serveur Render n'a pas d'adresse IP fixe. Dans Atlas :
**Network Access → + Add IP Address → Allow Access from Anywhere (0.0.0.0/0) → Confirm.**

La base reste protégée par l'utilisateur `nkeladestin_db_user` et son mot de passe.

## Étape 3 – Mettre en ligne sur Render (10 min, une seule fois)

1. Créez un compte sur <https://render.com> avec **Sign in with GitHub**.
2. Cliquez sur **New +** → **Blueprint**, puis choisissez le dépôt `gestion-fonds` (autorisez Render à y accéder si demandé).
3. Render lit le fichier `render.yaml` et vous demande la valeur de **MONGODB_URI**. Collez la chaîne complète **avec votre mot de passe** :
   `mongodb+srv://nkeladestin_db_user:VOTRE_MOT_DE_PASSE@destin.v0nltkd.mongodb.net/?retryWrites=true&w=majority`
4. Cliquez sur **Apply**. Après 3 à 5 minutes, le service est **Live** et Render affiche son adresse, par exemple `https://gestion-fonds-xxxx.onrender.com`.
5. Ouvrez cette adresse sur votre PC : l'écran de connexion s'affiche. Connectez-vous avec **le même identifiant et mot de passe que sur le PC** (les comptes sont partagés par le cloud).

**Coût :** le fichier prévoit l'offre **Starter (7 $/mois)**, toujours active. Avec l'offre **Free**, gratuite, le serveur se met en veille après 15 minutes sans utilisation : la première ouverture suivante prend environ une minute. Le choix se fait à l'étape 3, et peut être changé plus tard dans Render.

## Étape 4 – Installer l'application sur chaque téléphone ou tablette (1 min)

**iPhone / iPad (Safari obligatoirement) :**
1. Ouvrez l'adresse Render dans **Safari**.
2. Touchez le bouton **Partager** (carré avec une flèche vers le haut).
3. Choisissez **Sur l'écran d'accueil**, puis **Ajouter**.
4. Lancez « Gestion fonds » depuis l'icône de l'écran d'accueil.

**Android (Chrome) :**
1. Ouvrez l'adresse Render dans **Chrome**.
2. Touchez **Installer l'application** dans le bandeau proposé, ou le menu **⋮** → **Installer l'application** (ou **Ajouter à l'écran d'accueil**).
3. Lancez « Gestion fonds » depuis l'icône.

Pour envoyer l'adresse aux collaborateurs, il suffit de la partager par WhatsApp ou par e-mail. Créez-leur un compte dans **Administration → Utilisateurs**, avec le rôle adapté.

---

## Utilisation sur mobile

- **Menu** : bouton ☰ en haut à gauche.
- **Point de couleur en haut à droite** : état du stockage (vert = cloud synchronisé).
- **États et documents (PDF)** : bouton **Exporter en PDF**.
  - iPhone : **Imprimer** → écartez deux doigts sur l'aperçu → **Partager** → **Enregistrer dans Fichiers**.
  - Android : choisissez l'imprimante **Enregistrer au format PDF**.
- **Connexion Internet nécessaire** sur mobile : les données sont lues et écrites directement dans Atlas. Sans réseau, un bandeau orange l'indique. Le **PC**, lui, continue de fonctionner hors ligne grâce au stockage local, et se resynchronise ensuite.

## Mettre à jour l'application mobile

Remplacez les fichiers sur GitHub (**Add file → Upload files**). Render redéploie automatiquement en quelques minutes, et les téléphones reçoivent la nouvelle version à leur prochaine ouverture.

## Et les boutiques App Store / Google Play ?

L'application PWA n'a pas besoin des boutiques. Pour une publication dans les boutiques plus tard :
- **Google Play** : <https://www.pwabuilder.com> génère le paquet Android à partir de l'adresse Render. Il faut un compte développeur Google Play (paiement unique).
- **App Store** : il faut un compte Apple Developer (abonnement annuel) et un Mac avec Xcode. PWABuilder peut aussi générer le projet iOS.

L'application, les données et le fonctionnement restent les mêmes.
