# Mombongo — Système de paliers (Simple / Business / Pro)

Document de référence du découpage de Mombongo en 3 catégories dans une seule
application. Écrit pour que quelqu'un (toi dans 3 mois, ou un autre dev) puisse
comprendre les règles et l'architecture sans avoir à relire tout l'historique
des décisions.

## 1. Les 3 paliers, en résumé

| Palier | Coût | Produits actifs | Historique | Devises | Fonctionnalités |
|---|---|---|---|---|---|
| **Simple gratuit** | 0 FC | 50 max | Jour même | FC uniquement | Dettes/crédits illimités ; dépenses (3 actives max) |
| **Simple payant** | 2 000 FC/mois | 300 max | 32 jours | FC uniquement | + Scan code-barres, saisie rapide, dépenses illimitées |
| **Business (essai)** | 0 FC pendant 14 jours | Illimité | Illimité | FC + USD | TOUT (voir liste Business ci-dessous) |
| **Business (payant)** | 2 000 FC/semaine ou 5 000 FC/mois | Illimité | Illimité | FC + USD | Bénéfices/dettes/dépenses, vente vocale, scan rapide, alertes stock bas, export PDF, multi-devises, notifications push |
| **Pro** | 5 000 FC/semaine ou 12 000 FC/mois — payant dès l'inscription, pas d'essai | Illimité | Illimité | FC + USD | Tout Business + multi-appareils, multi-boutiques, gestion fournisseurs |

**Dettes/crédits clients : gratuits et illimités sur TOUS les paliers**, y
compris Simple gratuit — ce n'est plus une fonctionnalité à débloquer (voir
le cas spécial tout en haut de `isFeatureUnlocked()` dans `plans.js`).

**Dépenses : accessibles à tous, mais plafonnées à 3 actives sur Simple
gratuit** (en supprimer une libère une place, comme pour les produits) ;
illimitées dès qu'un palier payant est actif, quel qu'il soit — voir
`getMaxExpenses()` dans `plans.js`.

**Règle clé de l'essai Business** : pendant les 14 jours, TOUT est débloqué
(pas de version "Business limitée" — cette distinction n'existe pas). Une
fois l'essai fini, deux issues seulement : payer, ou être relégué
entièrement vers Simple gratuit.

**Un seul essai Business gratuit par compte, pour toujours.** Repasser sur
Simple puis re-choisir Business ne relance pas un nouvel essai — voir
`userHasUsedBusinessTrial` en §4.

## 2. La règle de gel des produits

Quand le nombre de produits dépasse la limite du palier (50 ou 300) :
- Les produits les **plus anciens** (par `createdAt`) restent **actifs**.
- Les produits ajoutés **après** avoir dépassé la limite sont **gelés**
  (grisés, verrouillés — aucune vente/édition/suppression/duplication
  possible) jusqu'à upgrade.
- **Rien n'est jamais supprimé.** Le gel est purement un état d'affichage
  recalculé à chaque `render()` (voir `computeFrozenProductIds()` dans
  `plans.js`) — pas un flag stocké sur le produit. Conséquence pratique :
  supprimer un vieux produit actif peut automatiquement "dégeler" le plus
  ancien produit gelé, sans rien coder de spécial pour ça.

Les **dépenses** suivent une logique proche mais plus simple (pas de gel
visuel, juste un blocage à la création) : sur Simple gratuit, dès que 3
dépenses actives existent, `openExpenseSheet()`/`confirmExpense()`
(`debts-expenses-alerts.js`) refusent d'en ajouter une 4e tant qu'une
ancienne n'a pas été supprimée depuis l'historique. Voir `getMaxExpenses()`
dans `plans.js`.

## 3. Décision produit : aucune migration des utilisateurs existants

Décision explicite prise en cours de chantier : le système traite chaque
nouveau compte / reconnexion comme si l'app n'avait jamais eu d'utilisateurs
avant les paliers. Aucun ancien utilisateur `isVip` n'est automatiquement
requalifié en Business ou Pro — tout le monde repart sur Simple gratuit par
défaut. C'est un choix produit assumé (les utilisateurs avaient déjà été
informés avant ce chantier), pas un oubli.

## 4. Architecture technique

### Fichiers centraux
- **`plans.js`** — le moteur. Tout ce qui touche aux limites/fonctionnalités
  passe par ses fonctions (`isFeatureUnlocked()`, `getMaxActiveProducts()`,
  `getMaxHistoryDays()`, `getAllowedCurrencies()`, `computeFrozenProductIds()`,
  `getEffectivePlan()`...). Aucun autre fichier ne doit recalculer une limite
  lui-même.
- **`plan-onboarding.js`** — l'écran de choix/changement de palier (3 cartes)
  et toute la logique de transition (démarrer l'essai, rétrograder, demander
  un upgrade payant).

### Les 4 + 1 champs d'un compte
Stockés en local (cache offline-first) **et** Firestore, comme
`isVip`/`vipUntil` avant eux :
- `userPlan` : `'simple' | 'business' | 'pro'`
- `userPlanStatus` : `'free' | 'trial' | 'active' | 'expired'`
- `userPlanTrialEndsAt` : timestamp ms, fin d'essai Business, ou `null`
- `userPlanExpiresAt` : timestamp ms, fin d'abonnement payé, ou `null`
- `userHasUsedBusinessTrial` : booléen, **ne se remet jamais à zéro**, même
  après un retour à Simple — anti-abus contre le cycle
  Simple→Business→Simple→Business pour relancer l'essai indéfiniment.

### `getEffectivePlan()` — le cœur du système
Calcule le palier *réellement applicable en ce moment*, en tenant compte des
expirations. Un compte `userPlan='business'` dont l'essai a expiré sans
paiement n'est PAS "Business limité" — `getEffectivePlan()` renvoie
directement `{ plan:'simple', tier:'free', downgradedFrom:'business' }`.
Toute la logique de gating (`isFeatureUnlocked`, `getMaxActiveProducts`...)
raisonne uniquement sur ce palier *effectif*, jamais sur `userPlan` brut.

Le raw `userPlan`/`userPlanStatus` restent inchangés après une expiration —
c'est un historique, pas un état vivant. C'est pour ça que "Mon palier"
peut afficher un message "ton essai a expiré" tant que l'utilisateur n'a
pas explicitement choisi Simple ou payé (voir `getPlanStatusSummary()`).

### `planDataLoaded` — le garde-fou anti-catastrophe
Tant que ce flag est à `false` (le tout premier instant du démarrage, avant
que le palier réel du compte soit connu), `computeFrozenProductIds()` ne
gèle **rien**, quel que soit le nombre de produits. Passe à `true` via
`loadPlanFromCache()` (cache local, très tôt dans `loadData()`) ou
`applyDocData()` (compte Firestore, une fois synchronisé). Sans ce garde-fou,
un compte avec beaucoup de produits verrait la majorité de son catalogue
gelée par erreur au tout premier chargement.

### Quel palier débloque quoi (pour les messages de blocage)
Table `LIMIT_REASON_TARGET_PLAN` dans `plans.js` — toujours le palier le
**moins cher** qui débloque la fonctionnalité :

| Raison | Palier cible |
|---|---|
| `history`, `barcode`, `expense` | Simple payant |
| `voice`, `export`, `notif`, `currency`, `stock` | Business |
| `stores`, `devices`, `suppliers` | Pro |

(`debts` n'existe plus dans cette table : dettes/crédits sont universellement
gratuits, voir §1.)

`openLimitSheet(reason)` (dans `products.js`) construit le message à partir
de cette table + du gabarit `limitDescTemplate` ("X est une fonctionnalité
de Y. Veux-tu y passer ?") — jamais un "c'est VIP" générique.

## 5. Activation d'un palier payant (manuel, pas de passerelle de paiement)

Aucun paiement en ligne intégré. Le parcours est le même que l'ancien
`isVip` : le commerçant clique sur un CTA de paiement → WhatsApp s'ouvre avec
un message pré-rempli vers `DEV_WHATSAPP` (`243980979141`) → une fois payé
(mobile money, en dehors de l'app), **toi** tu actives manuellement.

**Méthode rapide (recommandée) : `admin.html`.** Page autonome, à part de
l'app cliente — ouvre-la, connecte-toi avec ton propre compte Google
(`kabambavincent120@gmail.com`, le seul autorisé — voir la règle dédiée
dans `firestore.rules`, `/mombongo_users/{ownerUid}`), tape l'email du
client, cherche son compte, choisis le palier et la durée payée, et clique
sur Activer. Quelques secondes, pas besoin d'ouvrir la console Firebase ni
de calculer un timestamp à la main. Mets-la en raccourci sur l'écran
d'accueil de ton téléphone pour l'ouvrir aussi vite qu'une app. L'écriture
Firestore qu'elle déclenche est strictement limitée à 4 champs (voir plus
bas) — impossible, même par erreur, de toucher aux données de la boutique
du client.

**Méthode de secours : console Firebase**, si `admin.html` est
inaccessible pour une raison quelconque (pas de compte Google sous la main,
page cassée...). Sur le document `mombongo_users/{uid}` du client :

```
userPlan: "business"          // ou "simple" / "pro"
userPlanStatus: "active"
userPlanExpiresAt: <timestamp ms de fin d'abonnement>
userPlanTrialEndsAt: null
```

Pour Simple payant, mêmes champs mais `userPlan: "simple"`. Le champ
`userHasUsedBusinessTrial` ne doit **jamais** être touché manuellement — il
ne concerne que l'essai gratuit, pas les abonnements payés.

## 6. Écarts connus / pas encore traités

- **Export Excel** : bouton visible mais désactivé pour tous les paliers
  actuellement (la spec dit "PDF et non Excel" pour Business ; aucun palier
  ne l'inclut pour l'instant — décision à prendre si/quand un palier futur
  doit l'obtenir).
- Aucun test de bout en bout réel n'a encore été fait sur l'app qui tourne
  (uniquement relecture/vérification de code à chaque étape).
- **Alerte J-5 uniquement côté client** (toast + bannière dans "Mon palier",
  une fois par jour tant qu'on est dans la fenêtre). Le vrai système de push
  serveur existe déjà (`send-daily-recap.js`/`send-new-alerts.js` via cron
  GitHub Actions + Firebase Admin) et serait l'endroit naturel pour aussi
  envoyer une notification push J-5 — pas fait ici car ce chantier tourne
  hors du bac à sable où ce travail a été mené (déploiement/service account
  non testables depuis là).

### Traité depuis la première version de ce document

- **Badge "⭐ VIP"** (compte) : supprimé — `isVip`/`vipUntil` et tout leur
  système d'expiration en direct (`checkVipExpiryLive`, l'écran de blocage
  employé dédié) ont été retirés de `config.js`, `stores-devices.js`,
  `render.js`, `account-cloud.js` et `index.html`. `checkPlanExpiryLive()`
  (déjà en place, voir §8) couvre déjà tout ce que faisait ce système côté
  paliers — rien n'a été perdu, seul le doublon a disparu.
- **Mécanisme promo "50 premiers utilisateurs"** : entièrement réécrit pour
  accorder un vrai palier plutôt que l'ancien `isVip` legacy — voir §7
  ci-dessous.
- **Onglet Découvrir** : nouvelle première section ("Les 3 catégories
  Mombongo") expliquant Simple/Business/Pro et comment changer de palier
  (bouton qui ouvre directement le sélecteur) — remplace l'ancienne section
  "Devenir VIP" à palier unique.
- **Écran vide de quelques secondes au chargement** : l'app se révélait
  seulement une fois Firebase Auth résolu, alors que les données en cache
  étaient déjà chargées et affichées derrière l'écran de chargement plein
  écran — voir la fin de `loadData()` (`data-catalog.js`), qui révèle
  désormais l'app dès que les données locales sont prêtes, sans attendre
  Auth. Réglait au passage le même symptôme sur le bandeau "connecte-toi
  avec Google", qui pouvait flasher pour un compte déjà connecté sur une
  connexion lente.
- **État figé après un retour arrière en vente multiple** : le bouton retour
  (Android/navigateur) ne nettoyait jamais l'état propre à l'écran de vente
  (`multiCart`), contrairement à un clic sur "Fermer"/"Annuler" — voir
  `navigation.js`, qui appelle maintenant `closeSellSheet()` (ou
  `pauseCurrentCartIfAny()`, §11) au lieu de retirer juste la classe CSS.

## 7. Promos "places offertes par palier" — système généralisé

Voir `PROMO_CAMPAIGNS` dans `debts-expenses-alerts.js`. Généralise la
première version (une seule promo, tout codé en dur : fenêtre, plafonds ET
comptage, tout dans le JS) en une **liste de campagnes** : lancer une promo
ponctuelle ne demande plus de toucher à la logique de réclamation, juste
d'ajouter une entrée à ce tableau — voir le modèle donné en commentaire dans
le fichier.

**⚠️ Migration à faire manuellement AVANT de déployer ce changement.** La
promo de lancement (1er août → 1er novembre 2026) est **déjà en cours** au
moment où ce système a été généralisé (nous sommes le 19 août 2026) — elle
utilisait encore l'ancien schéma à deux documents séparés
(`mombongo_meta/promo_business_2026` et `mombongo_meta/promo_pro_2026`,
champ `claimed` seul). Le nouveau schéma fusionne tout dans un seul document
par campagne. Avant de déployer :
1. Sur la console Firebase, relève les valeurs `claimed` actuelles de
   `mombongo_meta/promo_business_2026` et `mombongo_meta/promo_pro_2026`.
2. Crée un nouveau document `mombongo_meta/promo_2026_launch` avec :
   `{ claimedBusiness: <valeur relevée>, maxSlotsBusiness: 50,
   claimedPro: <valeur relevée>, maxSlotsPro: 50 }`.
3. Déploie le code (JS + `firestore.rules`).
Sans cette étape, `tryClaimPlanPromo()` verra que le document
`promo_2026_launch` n'existe pas encore et refusera toute réclamation en
silence (échec sûr, pas de triche possible — mais la promo serait en pause
sans que personne ne le sache) jusqu'à ce que le document soit créé.

**Comment lancer une NOUVELLE promo ponctuelle (ex. "X places Business et Y
Pro, pendant 1 semaine, 1 mois offert") — deux étapes, jamais de logique à
réécrire :**
1. Ajoute un objet à `PROMO_CAMPAIGNS` (`debts-expenses-alerts.js`) :
   `{ id, start, end, giftMonths }` — un identifiant unique, la fenêtre de
   dates, et la durée du cadeau. Déploie.
2. Sur la console Firebase, crée `mombongo_meta/{id}` (le même id que
   choisi ci-dessus) avec `{ claimedBusiness: 0, maxSlotsBusiness: X,
   claimedPro: 0, maxSlotsPro: Y }` — ne mets `X` ou `Y` que pour les
   paliers réellement offerts par cette promo (0 ou champ absent = personne
   ne peut rien gagner sur ce palier-là pour cette campagne).

Ajuster le nombre de places d'une promo déjà lancée (ou simplement suivre en
direct combien ont déjà été prises) se fait **uniquement** sur ce document
Firestore, à la main — jamais besoin de redéployer pour ça. Seules la
fenêtre de dates et la durée du cadeau restent dans le code (elles doivent
être connues par tous les appareils dès l'ouverture de l'app, avant toute
connexion réseau).

**Règles inchangées d'une campagne à l'autre :**
- **Places comptées séparément par palier** : être dans les places Business
  d'une campagne n'a aucun effet sur ses places Pro, et inversement.
- **Le cadeau se joue au choix du palier, pas à la création du compte** :
  la réclamation est tentée dans `choosePlanOnboarding()`
  (`plan-onboarding.js`) au moment précis où le patron choisit Business ou
  Pro — jamais à l'inscription (`handlePostLogin()` ne s'en occupe pas).
- Gagnée, la promo accorde **`giftMonths` mois du palier choisi directement
  actifs** (`userPlanStatus:'active'`), à la place de l'essai de 14 jours
  habituel (Business) ou du paiement manuel via WhatsApp (Pro).
- **Un seul cadeau par compte, à vie, tous paliers ET toutes campagnes
  confondus** : le verrou est un unique document
  `mombongo_promo_claims/{uid}` (indexé par uid seul). Un patron qui a déjà
  gagné une promo passée (Business ou Pro, peu importe laquelle) NE
  bénéficie PAS d'une deuxième place lors d'une promo suivante, même sur un
  palier différent — le document existe déjà, donc la transaction échoue
  avant même de vérifier le compteur de la nouvelle campagne.
- Anti-fraude : tout passe par une transaction Firestore (jamais une
  déclaration du client), et les règles Firestore (`firestore.rules`,
  collections `mombongo_meta` et `mombongo_promo_claims`) revérifient
  indépendamment côté serveur que le rang réclamé correspond bien au
  compteur de la bonne campagne+catégorie et ne dépasse jamais le plafond
  fixé manuellement pour elle — voir la note #5 en bas de `firestore.rules`.

## 8. Alerte de fin d'essai/abonnement (J-5)

Voir `getPlanExpiryAlertInfo()` dans `plans.js` — se déclenche à J-5 ou moins
avant :
- la fin de l'essai Business (`userPlanTrialEndsAt`), ou
- la fin de tout abonnement payé actif — Simple payant, Business payant, Pro
  (`userPlanExpiresAt`).

Raisonne sur le palier **brut** (`userPlan`/`userPlanStatus`), pas sur le
palier effectif — le but est de prévenir *avant* la relégation automatique
de `getEffectivePlan()`, pas après coup.

Deux affichages, une seule source :
- **Toast**, une fois par jour maximum tant qu'on reste dans la fenêtre J-5
  (`maybeShowPlanExpiryWarningToast()`, throttlé via
  `mombongo:lastPlanExpiryAlertDate` en local) — déclenché à l'ouverture de
  l'app et à chaque vérification périodique (`checkPlanExpiryLive()`, toutes
  les 60s + retour au premier plan).
- **Bannière permanente** dans "Mon palier" (`updatePlanSummary()`), sans
  throttle — visible à chaque fois que le compte est ouvert pendant la
  fenêtre.

## 9. Type de commerce universel (myStoreType)

Avant ce chantier, le catalogue partagé proposé dans "Ajout rapide depuis le
catalogue" dépendait de `store.type` (boutique/pharmacie/quincaillerie),
réglable **uniquement** via la création d'une boutique — une fonctionnalité
Pro. Résultat : Simple et Business ne pouvaient jamais obtenir le bon
catalogue (toujours "autre" par défaut), et un compte purement hors ligne
(jamais connecté à Google) avait `stores` vide en permanence, donc aucun
moyen d'y répondre du tout.

Décorrélé : `myStoreType` (voir `config.js`) est un réglage universel,
stocké en local (`mombongo:storeType`), qui répond à "quel est ton métier ?"
indépendamment du multi-boutique. `activeStoreCategory()`
(`community-catalog.js`) le priorise ; `store.type` par-boutique ne reste
utile que pour un compte Pro qui gère plusieurs métiers différents à la
fois. Demandé automatiquement au premier usage de "Ajout rapide depuis le
catalogue" (`openBulkCatalogSheet()`, `products.js`), modifiable ensuite
via le petit lien 🏪 dans cette même fenêtre.

## 10. Favoris (loi de Pareto, 30 jours glissants)

Nouvel onglet à droite de "Mes produits" (`setProductsView()`, `render.js`)
— pas un remplacement, les deux coexistent. Un produit est "favori" s'il
fait partie du sous-ensemble, classé par chiffre d'affaires décroissant, qui
cumule ~80% des ventes des **30 derniers jours glissants** (pas "aujourd'hui",
trop instable ; pas "à vie", un produit qui ne se vend plus resterait
favori pour toujours). Recalculé à chaque appel de `getFavoriteProductIds()`
— aucun cache, aucune tâche de fond.

## 11. Panier en pause (heldCarts)

Cas d'usage : un client en train de payer (vente multiple) se rend compte
qu'il a oublié un article, retourne dans les rayons pendant que la file
s'allonge. Voir la doc complète en tête de `heldCarts` (`config.js`) et
`pauseCurrentCartIfAny()`/`resumeHeldCart()` (`sales.js`).

- Le bouton retour (Android/navigateur), pendant une "vente plusieurs" non
  vide, met le panier de côté au lieu de le perdre — jusqu'à
  `MAX_HELD_CARTS` (3) simultanés. Au-delà, le retour arrière reste bloqué
  sur l'écran de vente (toast d'explication) plutôt que d'écraser
  silencieusement un panier existant.
- Bouton 🧺 (miroir du bouton scan, à gauche du micro) : visible uniquement
  s'il y a au moins un panier en attente, badge numéroté. Ouvre la liste
  "Vente 1 / Vente 2..." (`renderHeldCartsList()`) — chaque ligne peut être
  reprise (`resumeHeldCart()`) ou abandonnée (`dropHeldCart()`, pour un
  client qui a finalement renoncé).
- L'ancien bouton flottant ✅ (`multi-confirm-fab`) a été retiré — il était
  redondant avec le "Confirmer la vente" déjà présent dans la fiche, et
  c'était la source du bug historique (état figé après un retour arrière).
  "🗑️ Tout supprimer" (sous "Confirmer la vente") et un 🗑️ par ligne déjà
  sélectionnée le remplacent pour la gestion du panier en cours.
- Persisté en local (`mombongo:heldCarts`) pour survivre à un rechargement,
  mais jamais synchronisé sur Firestore : c'est une file d'attente de
  caisse propre à un appareil et un instant précis.

## 12. Import en masse depuis Excel/CSV

Voir `handleExcelImportFile()` (`products.js`) — réutilise la librairie
XLSX déjà chargée pour l'export (`export.js`), donc aucune nouvelle
dépendance. En-têtes de colonnes reconnus de façon souple (accents/casse
ignorés, plusieurs libellés par colonne acceptés — voir
`EXCEL_IMPORT_HEADER_ALIASES`) ; seuls "Nom" et "Prix de vente" sont
obligatoires. Un modèle `.xlsx` téléchargeable (`downloadExcelImportTemplate()`)
évite d'avoir à deviner le format. Ouvert à tous les paliers (comme "Ajout
rapide depuis le catalogue"), bien que pensé surtout pour Business/Pro qui
démarrent avec un catalogue de 500-1000 produits déjà existant ailleurs.

## 13. Bas de l'onglet Compte : politique de confidentialité + suppression

Réorganisé : "💬 Contacte-nous" et "📖 Bon à savoir" côte à côte (au lieu de
deux liens empilés verbeux), puis "🔒 Politique de confidentialité" — en
fenêtre in-app (`openPrivacySheet()`, `account-cloud.js`), pas une page
statique séparée, car la suppression de compte tout en bas a besoin du
contexte Firebase déjà chargé (utilisateur connecté, base de données).

Suppression de compte (`confirmDeleteAccountFinal()`) :
- Réservée au patron connecté (`currentUser`) — un appareil employé
  (`isEmployeeMode`) ou un compte non connecté sont explicitement bloqués
  avec un message clair, pas juste un bouton qui ne fait rien.
- Confirmation forte : il faut taper le mot "SUPPRIMER" (`deleteConfirmWord`)
  dans un champ dédié, pas juste cliquer un "OK" — geste irréversible.
- Supprime réellement toutes les sous-collections Firestore du compte
  (`products`, `sales`, `debts`, `expenses`, `suppliers`, `purchases`,
  `activityLog`, `fcmTokens`) par lots de 400 documents
  (`deleteAllDocsInCollection()`), puis le document racine
  `mombongo_users/{uid}`, puis le compte Firebase Auth lui-même.
- `mombongo_promo_claims/{uid}` n'est **volontairement pas supprimé** — ce
  n'est pas une donnée personnelle mais un registre anti-fraude de la promo
  (§7) : le garder empêche de supprimer son compte pour en recréer un autre
  et réclamer une deuxième fois le même cadeau à vie.
- Si Firebase répond `auth/requires-recent-login` (session trop ancienne
  pour un geste aussi sensible), l'app redemande une connexion Google
  (`reauthenticateWithPopup`) puis relance la suppression complète depuis le
  début — jamais de reprise à un stade intermédiaire incertain.
- Après succès : `localStorage.clear()` + rechargement complet de l'app,
  plus sûr que d'essayer de réinitialiser chaque variable JS une par une.

