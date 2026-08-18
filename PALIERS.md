# Mombongo — Système de paliers (Simple / Business / Pro)

Document de référence du découpage de Mombongo en 3 catégories dans une seule
application. Écrit pour que quelqu'un (toi dans 3 mois, ou un autre dev) puisse
comprendre les règles et l'architecture sans avoir à relire tout l'historique
des décisions.

## 1. Les 3 paliers, en résumé

| Palier | Coût | Produits actifs | Historique | Devises | Fonctionnalités |
|---|---|---|---|---|---|
| **Simple gratuit** | 0 FC | 30 max | Jour même | FC uniquement | — |
| **Simple payant** | 2 000 FC/mois | 200 max | 32 jours | FC uniquement | Scan code-barres, saisie rapide |
| **Business (essai)** | 0 FC pendant 14 jours | Illimité | Illimité | FC + USD | TOUT (voir liste Business ci-dessous) |
| **Business (payant)** | 2 000 FC/semaine ou 5 000 FC/mois | Illimité | Illimité | FC + USD | Bénéfices/dettes/dépenses, vente vocale, scan rapide, alertes stock bas, export PDF, multi-devises, notifications push |
| **Pro** | 5 000 FC/semaine ou 12 000 FC/mois — payant dès l'inscription, pas d'essai | Illimité | Illimité | FC + USD | Tout Business + multi-appareils, multi-boutiques, gestion fournisseurs |

**Règle clé de l'essai Business** : pendant les 14 jours, TOUT est débloqué
(pas de version "Business limitée" — cette distinction n'existe pas). Une
fois l'essai fini, deux issues seulement : payer, ou être relégué
entièrement vers Simple gratuit.

**Un seul essai Business gratuit par compte, pour toujours.** Repasser sur
Simple puis re-choisir Business ne relance pas un nouvel essai — voir
`userHasUsedBusinessTrial` en §4.

## 2. La règle de gel des produits

Quand le nombre de produits dépasse la limite du palier (30 ou 200) :
- Les produits les **plus anciens** (par `createdAt`) restent **actifs**.
- Les produits ajoutés **après** avoir dépassé la limite sont **gelés**
  (grisés, verrouillés — aucune vente/édition/suppression/duplication
  possible) jusqu'à upgrade.
- **Rien n'est jamais supprimé.** Le gel est purement un état d'affichage
  recalculé à chaque `render()` (voir `computeFrozenProductIds()` dans
  `plans.js`) — pas un flag stocké sur le produit. Conséquence pratique :
  supprimer un vieux produit actif peut automatiquement "dégeler" le plus
  ancien produit gelé, sans rien coder de spécial pour ça.

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
| `history`, `barcode` | Simple payant |
| `voice`, `export`, `notif`, `currency`, `debts`, `expense`, `stock` | Business |
| `stores`, `devices`, `suppliers` | Pro |

`openLimitSheet(reason)` (dans `products.js`) construit le message à partir
de cette table + du gabarit `limitDescTemplate` ("X est une fonctionnalité
de Y. Veux-tu y passer ?") — jamais un "c'est VIP" générique.

## 5. Activation d'un palier payant (manuel, pas de passerelle de paiement)

Aucun paiement en ligne intégré. Le parcours est le même que l'ancien
`isVip` : le commerçant clique sur un CTA de paiement → WhatsApp s'ouvre avec
un message pré-rempli vers `DEV_WHATSAPP` (`243980979141`) → une fois payé
(mobile money, en dehors de l'app), **toi** tu actives manuellement dans la
console Firebase, sur le document `mombongo_users/{uid}` :

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
  (déjà en place, voir §7) couvre déjà tout ce que faisait ce système côté
  paliers — rien n'a été perdu, seul le doublon a disparu.
- **Mécanisme promo "50 premiers utilisateurs"** : entièrement réécrit pour
  accorder un vrai palier plutôt que l'ancien `isVip` legacy — voir §8
  ci-dessous.
- **Onglet Découvrir** : nouvelle première section ("Les 3 catégories
  Mombongo") expliquant Simple/Business/Pro et comment changer de palier
  (bouton qui ouvre directement le sélecteur) — remplace l'ancienne section
  "Devenir VIP" à palier unique.

## 8. Promo "50 places par palier" (Business et Pro séparément)

Voir `tryClaimPlanPromo()` dans `debts-expenses-alerts.js`. Remplace
l'ancienne promo "50 premiers utilisateurs d'août", qui accordait l'ancien
`isVip`/`vipUntil` legacy à la création du compte, indépendamment de tout
palier.

**Règles :**
- Fenêtre de 3 mois : du 1er août 2026 au 1er novembre 2026 (fin exclusive) —
  `PROMO_START`/`PROMO_END`.
- **50 places par catégorie, séparément** : un compteur Firestore dédié par
  palier (`mombongo_meta/promo_business_2026` et `mombongo_meta/promo_pro_2026`).
  Être dans les 50 premiers Business n'a aucun effet sur les places Pro, et
  inversement.
- **Le cadeau se joue au choix du palier, pas à la création du compte** :
  la réclamation est tentée dans `choosePlanOnboarding()`
  (`plan-onboarding.js`) au moment précis où le patron choisit Business ou
  Pro — jamais à l'inscription (`handlePostLogin()` ne s'en occupe plus).
- Gagnée, la promo accorde **2 mois du palier choisi directement actifs**
  (`userPlanStatus:'active'`, `userPlanExpiresAt` = maintenant + 2 mois),
  à la place de l'essai de 14 jours habituel (Business) ou du paiement
  manuel via WhatsApp (Pro).
- **Un seul cadeau par compte, à vie, tous paliers confondus** : le verrou
  est un unique document `mombongo_promo_claims/{uid}` (indexé par uid seul,
  pas par uid+palier). Un patron qui a déjà eu ses 2 mois Business offerts
  et qui tente ensuite de passer à Pro NE bénéficie PAS d'une deuxième
  place, même s'il reste des places Pro disponibles — le document existe
  déjà, donc la transaction échoue avant même de vérifier le compteur Pro.
- Anti-fraude : comme pour l'ancienne version, tout passe par une
  transaction Firestore (jamais une déclaration du client), et les règles
  Firestore (`firestore.rules`, collections `mombongo_meta` et
  `mombongo_promo_claims`) revérifient indépendamment côté serveur que le
  rang réclamé correspond bien au compteur de la bonne catégorie et ne
  dépasse jamais 50.

## 7. Alerte de fin d'essai/abonnement (J-5)

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
