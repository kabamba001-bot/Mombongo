/* =========================================================================
   MOTEUR DE PALIERS — MOMBONGO SIMPLE / BUSINESS / PRO
   =========================================================================
   Fichier central : TOUTE décision liée aux limites d'un palier doit passer
   par les fonctions ci-dessous. Objectif : un seul endroit à modifier quand
   on ajoute un palier ou qu'on change une limite, au lieu de chasser des
   "if(isVip)" éparpillés dans 15 fichiers (l'ancien système isVip/vipUntil,
   y compris son badge de compte, a depuis été entièrement retiré — voir
   PALIERS.md §6).

   Un compte a :
     - plan       : 'simple' | 'business' | 'pro'
     - planStatus : 'free' | 'trial' | 'active' | 'expired'
     - planTrialEndsAt  : timestamp ms (fin d'essai Business) ou null
     - planExpiresAt    : timestamp ms (fin d'abonnement payé) ou null

   Ces 4 champs sont stockés en local (cache offline-first, voir
   savePlanToCache()/loadPlanFromCache()) + Firestore (voir applyDocData()
   dans stores-devices.js).
   ========================================================================= */

/* ---------- État courant (chargé/synchronisé ailleurs) ---------- */
let userPlan = 'simple';          // 'simple' | 'business' | 'pro'
let userPlanStatus = 'free';      // 'free' | 'trial' | 'active' | 'expired'
let userPlanTrialEndsAt = null;   // ms epoch ou null
let userPlanExpiresAt = null;     // ms epoch ou null
/* Une fois à true, reste à true POUR TOUJOURS (même après un retour à Simple) — sans
   ça, un commerçant pourrait faire simple→business→simple→business... et relancer
   14 jours gratuits à chaque fois. Un seul essai gratuit par compte, point final. */
let userHasUsedBusinessTrial = false;

/* GARDE-FOU — planDataLoaded ne passe à true qu'une fois la vraie valeur du compte
   connue (cache local via loadPlanFromCache(), ou compte Google via applyDocData()) —
   voir les deux fonctions plus bas. Tant qu'il est à false (le tout premier instant du
   démarrage, avant que loadData() n'ait tourné), computeFrozenProductIds() ne gèle
   RIEN, pour ne jamais griser un catalogue par erreur sur la base d'un état par défaut
   pas encore chargé. */
let planDataLoaded = false;

const BUSINESS_TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 jours

/* ---------- Définition des paliers ----------
   `limits` : valeurs numériques pures (Infinity = illimité) — utilisées à la
   fois pour bloquer une action ET pour afficher "200/200 produits" dans l'UI.
   `features` : interrupteurs on/off pour les fonctionnalités qui ne sont pas
   une histoire de quantité (scan, vocal, export, multi-devises, etc.).
   Chaque palier hérite explicitement des acquis du palier du dessous — pas
   de magie, pour que ce soit lisible dans 6 mois. */
const PLAN_DEFS = {
  simple: {
    label: 'Mombongo Simple',
    // Le palier "simple" a lui-même deux niveaux : gratuit et payant
    // (2 000 FC/mois). On les distingue via planStatus ('free' vs 'active').
    tiers: {
      free: {
        maxProducts: 50,
        historyDays: 1,          // fenêtre glissante 24h
        currencies: ['cdf'],
        features: { barcode: false, quickAdd: false }
      },
      active: {                  // 2 000 FC / mois
        maxProducts: 200,
        historyDays: 32,
        currencies: ['cdf'],
        features: { barcode: true, quickAdd: true }
      }
    }
  },
  business: {
    label: 'Mombongo Business',
    trialDurationMs: BUSINESS_TRIAL_DURATION_MS,
    limits: {
      maxProducts: Infinity,
      historyDays: Infinity,
      currencies: ['cdf', 'usd']
    },
    // "Toutes ses fonctionnalités gratuites pendant 14 jours" (spec) : il n'existe
    // PAS d'état "Business limité". Tant que userPlan==='business' sans être expiré
    // (trial en cours OU abonnement payé), TOUT est débloqué — l'unique alternative
    // est la relégation complète vers Simple (voir getEffectivePlan). Le découpage
    // base/payant ci-dessous ne sert donc qu'à documenter/afficher "ce qui est mis en
    // avant comme payant" sur l'écran d'onboarding — pas à restreindre l'essai.
    baseFeatures: {
      barcode: true,             // scan de base — dispo dès Simple payant, donc a fortiori ici
      profitTracking: true
      // customerDebts n'est plus listé ici : cette fonctionnalité est désormais
      // universelle (gratuite et illimitée pour tous les paliers) — voir le cas
      // spécial tout en haut de isFeatureUnlocked() ci-dessous.
    },
    paidFeatures: {               // mis en avant comme "Version Payante" dans la pub/l'onboarding
      voiceSales: true,
      quickBarcode: true,
      expenseTracking: true,
      lowStockAlerts: true,
      exportPdf: true,
      multiCurrency: true,
      pushNotifications: true
    }
  },
  pro: {
    label: 'Mombongo Pro',
    payFromStart: true,           // pas de version gratuite, pas d'essai
    limits: {
      maxProducts: Infinity,
      historyDays: Infinity,
      currencies: ['cdf', 'usd']
    },
    features: Object.assign({}, /* placeholder, rempli plus bas pour éviter la duplication */ {}, {
      multiDevice: true,
      multiStore: true,
      supplierManagement: true
    })
  }
};
// Pro hérite de tout ce que Business payant offre, plus ses propres extras.
PLAN_DEFS.pro.features = Object.assign(
  {}, PLAN_DEFS.business.baseFeatures, PLAN_DEFS.business.paidFeatures, PLAN_DEFS.pro.features
);

/* ---------- Résolution de l'état courant en limites concrètes ---------- */

// Renvoie true si l'essai Business (14j) est dépassé sans paiement.
function isBusinessTrialExpired(){
  if(userPlan !== 'business' || userPlanStatus !== 'trial') return false;
  return !!userPlanTrialEndsAt && Date.now() > userPlanTrialEndsAt;
}

// Renvoie true si un abonnement payé (business actif ou pro) est arrivé à expiration.
function isPlanExpired(){
  if(userPlanStatus !== 'active') return false;
  return !!userPlanExpiresAt && Date.now() > userPlanExpiresAt;
}

/* Calcule le palier "effectif" à utiliser pour les limites — c'est ici
   qu'on applique la relégation : Business non payé après 14j, ou abonnement
   expiré (Business/Pro), retombe automatiquement sur Simple gratuit.
   Le compte garde en mémoire son plan/planStatus d'origine (pour l'écran
   d'upgrade et l'historique), seule la RÉSOLUTION change. */
function getEffectivePlan(){
  if(userPlan === 'simple'){
    const tier = (userPlanStatus === 'active' && !isPlanExpired()) ? 'active' : 'free';
    return { plan: 'simple', tier };
  }
  if(userPlan === 'business'){
    if(isBusinessTrialExpired() || isPlanExpired()){
      return { plan: 'simple', tier: 'free', downgradedFrom: 'business' };
    }
    return { plan: 'business', tier: userPlanStatus }; // 'trial' | 'active'
  }
  if(userPlan === 'pro'){
    if(isPlanExpired()){
      return { plan: 'simple', tier: 'free', downgradedFrom: 'pro' };
    }
    return { plan: 'pro', tier: 'active' };
  }
  return { plan: 'simple', tier: 'free' };
}

// Limite de produits ACTIFS (non gelés) pour le palier effectif courant.
function getMaxActiveProducts(){
  const eff = getEffectivePlan();
  if(eff.plan === 'simple') return PLAN_DEFS.simple.tiers[eff.tier].maxProducts;
  return Infinity; // business & pro : illimité
}

// Nombre maximum de DÉPENSES actives (non supprimées) : 3 sur Simple gratuit, illimité
// dès qu'un palier est payant (Simple payant, Business, Pro — "VIP" au sens large,
// n'importe quel abonnement payé). Contrairement aux dettes/crédits (universellement
// gratuits, voir isFeatureUnlocked() plus bas), les dépenses restent un vrai levier
// d'upgrade sur Simple gratuit — mais accessibles dès le premier jour, pas bloquées en
// bloc comme avant. Une dépense supprimée depuis l'historique libère sa place (comme les
// produits), pas de compteur qui grimpe pour toujours.
const SIMPLE_FREE_MAX_EXPENSES = 3;
function getMaxExpenses(){
  const eff = getEffectivePlan();
  if(eff.plan === 'simple' && eff.tier === 'free') return SIMPLE_FREE_MAX_EXPENSES;
  return Infinity;
}

// Profondeur d'historique (en jours) autorisée pour le palier effectif.
function getMaxHistoryDays(){
  const eff = getEffectivePlan();
  if(eff.plan === 'simple') return PLAN_DEFS.simple.tiers[eff.tier].historyDays;
  return Infinity;
}

// Devises autorisées pour le palier effectif.
function getAllowedCurrencies(){
  const eff = getEffectivePlan();
  if(eff.plan === 'simple') return PLAN_DEFS.simple.tiers[eff.tier].currencies;
  return PLAN_DEFS[eff.plan].limits.currencies;
}

/* Repli automatique si la devise affichée n'est plus autorisée par le palier effectif
   (ex. abonnement Business qui expire alors que l'affichage était en USD → repasse en
   FC, seule devise de Simple). Appelée après chaque chargement/changement de palier —
   jamais depuis un clic utilisateur (voir le garde-fou dans setCurrency(), qui lui
   bloque un choix explicite de devise non autorisée). Ne fait rien tant que l'app n'a
   pas fini de démarrer (DOM des boutons devise pas forcément prêt). */
function enforceAllowedCurrencyForPlan(){
  if(typeof currentCurrency === 'undefined') return;
  if(getAllowedCurrencies().includes(currentCurrency)) return;
  currentCurrency = getAllowedCurrencies()[0];
  if(typeof localSet === 'function') localSet('mombongo:currency', currentCurrency);
  const usdBtn = document.getElementById('btn-usd');
  const cdfBtn = document.getElementById('btn-cdf');
  const rateWrap = document.getElementById('rate-fields-wrap');
  if(usdBtn) usdBtn.classList.toggle('active', currentCurrency==='usd');
  if(cdfBtn) cdfBtn.classList.toggle('active', currentCurrency==='cdf');
  if(rateWrap) rateWrap.style.display = (currentCurrency==='cdf') ? 'block' : 'none';
  if(typeof updateAddFieldLabels === 'function') updateAddFieldLabels();
}

/* Repli automatique pour la Gestion fournisseurs (Pro uniquement) — même logique que
   enforceAllowedCurrencyForPlan() juste au-dessus, mêmes points d'appel. Sans ça,
   suppliersFeatureEnabled (persisté en local + Firestore) restait à true pour toujours
   après un essai/abonnement Pro expiré : le switch "🚚 Gestion fournisseurs" du menu
   Compte réaffichait ON à chaque réouverture (juste parce que openAccountSheet() lisait
   le flag brut sans revérifier le palier), et le bouton 🚚 restait visible dans l'en-tête
   — la fonctionnalité restait donc accessible bien après la fin du Pro. Appelée après
   chaque chargement/changement de palier, jamais depuis le clic utilisateur sur le
   switch lui-même (toggleSuppliersFeature(), data-catalog.js, garde déjà son propre
   contrôle à l'activation). */
function enforceSupplierFeatureForPlan(){
  if(typeof suppliersFeatureEnabled === 'undefined' || !suppliersFeatureEnabled) return;
  if(isFeatureUnlocked('supplierManagement')) return;
  suppliersFeatureEnabled = false;
  if(typeof saveSuppliersFeatureEnabled === 'function') saveSuppliersFeatureEnabled();
  if(typeof updateHeaderSuppliersButtonVisibility === 'function') updateHeaderSuppliersButtonVisibility();
  const cb = document.getElementById('in-suppliers-toggle');
  if(cb) cb.checked = false;
}

/* Vérifie si UNE fonctionnalité précise est débloquée pour le compte
   courant. Clés reconnues : 'barcode', 'quickAdd' (Simple payant) ;
   'voiceSales', 'quickBarcode', 'expenseTracking', 'lowStockAlerts',
   'exportPdf', 'multiCurrency', 'pushNotifications' (Business payant) ;
   'multiDevice', 'multiStore', 'supplierManagement' (Pro). */
function isFeatureUnlocked(featureKey){
  // Dettes/crédits clients : gratuits et illimités pour TOUS les paliers, y compris
  // Simple gratuit — ce n'est plus une fonctionnalité à débloquer. Traité ici, au même
  // endroit pour tous les appelants existants (sales.js, render.js,
  // debts-expenses-alerts.js...), plutôt que de retirer chaque vérification une par une
  // dans chaque fichier — un seul endroit à retenir si la règle change encore.
  if(featureKey === 'customerDebts') return true;
  // Dépenses : désormais accessibles à TOUS les paliers (avant : Business+ uniquement),
  // mais plafonnées en quantité sur Simple gratuit — voir getMaxExpenses() ci-dessous,
  // vérifié séparément (quantité, pas un simple on/off) dans openExpenseSheet() /
  // confirmExpense() (debts-expenses-alerts.js).
  if(featureKey === 'expenseTracking') return true;
  const eff = getEffectivePlan();
  if(eff.plan === 'simple'){
    return !!(PLAN_DEFS.simple.tiers[eff.tier].features || {})[featureKey];
  }
  if(eff.plan === 'business'){
    // plan==='business' ici veut dire : trial en cours (non expiré) OU payé — dans les
    // deux cas tout est débloqué (voir commentaire sur PLAN_DEFS.business ci-dessus).
    return !!(PLAN_DEFS.business.baseFeatures[featureKey] || PLAN_DEFS.business.paidFeatures[featureKey]);
  }
  if(eff.plan === 'pro'){
    return !!PLAN_DEFS.pro.features[featureKey];
  }
  return false;
}

/* ---------- Gel des produits au-delà de la limite ----------
   Règle retenue : les produits les PLUS ANCIENS restent actifs (ce sont eux
   qui construisent le fonds de commerce historique du vendeur) ; les
   produits ajoutés APRÈS avoir dépassé la limite sont gelés (grisés,
   invendables, non modifiables) jusqu'à upgrade. Le tri se fait sur
   `createdAt`, qui existe déjà sur chaque produit (voir products.js). */
function computeFrozenProductIds(allProducts){
  if(!planDataLoaded) return new Set(); // voir garde-fou plus haut
  const maxActive = getMaxActiveProducts();
  if(maxActive === Infinity) return new Set();
  const sorted = allProducts.slice().sort((a, b) => (a.createdAt||0) - (b.createdAt||0));
  const frozenIds = new Set();
  sorted.forEach((p, idx) => { if(idx >= maxActive) frozenIds.add(p.id); });
  return frozenIds;
}

// Un produit est gelé si son id apparaît dans le set retourné ci-dessus.
// À appeler depuis render.js pour griser la ligne, et depuis sales.js /
// products.js pour bloquer vente/édition sur un produit gelé.
function isProductFrozen(productId, allProducts){
  return computeFrozenProductIds(allProducts).has(productId);
}

/* À appeler juste après avoir créé un ou plusieurs produits (products.push() + save),
   en passant leur(s) id(s). Remplace le toast "Enregistré" habituel par le toast de gel
   quand au moins un des produits vient de naître gelé (limite déjà atteinte) — pour que
   le commerçant comprenne tout de suite pourquoi il ne le voit pas comme les autres,
   au lieu de croire à un bug. Renvoie true si un toast de gel a été affiché (pour que
   l'appelant sache s'il doit encore afficher son propre toast "Enregistré" ou non). */
function notifyIfNewProductsFrozen(newProductIds){
  const ids = Array.isArray(newProductIds) ? newProductIds : [newProductIds];
  const frozen = computeFrozenProductIds(products);
  const anyFrozen = ids.some(id => frozen.has(id));
  if(anyFrozen && typeof showToast === 'function'){
    showToast(dict[currentLang].productFrozenMsg, 5500);
  }
  return anyFrozen;
}

/* Compteur visible "X/Y produits" affiché au-dessus de la liste (voir products-counter
   dans index.html) — masqué pour Business/Pro (illimité). Appelé à chaque render(),
   donc toujours à jour en direct pendant l'usage (ajout, suppression, upgrade...),
   sans qu'aucun code appelant n'ait besoin d'y penser explicitement. */
function updateProductsCounter(){
  const el = document.getElementById('products-counter');
  if(!el) return;
  const max = getMaxActiveProducts();
  if(max === Infinity || typeof products === 'undefined'){
    el.style.display = 'none';
    return;
  }
  const total = products.length;
  const frozenCount = computeFrozenProductIds(products).size;
  const activeCount = total - frozenCount;
  const pct = Math.min(100, Math.round((activeCount / max) * 100));
  const atLimit = frozenCount > 0;
  const nearLimit = !atLimit && pct >= 80;
  el.className = 'products-counter' + (atLimit ? ' at-limit' : (nearLimit ? ' near-limit' : ''));
  const t = (typeof dict !== 'undefined' && typeof currentLang !== 'undefined') ? dict[currentLang] : null;
  const label = t ? t.productsCounterLabel : 'produits';
  const frozenNote = frozenCount > 0 && t ? ` · 🔒 ${frozenCount} ${t.productsCounterFrozenSuffix}` : '';
  el.innerHTML = `<span>${activeCount}/${max} ${label}${frozenNote}</span>` +
    `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>`;
  el.style.display = 'flex';
}
/* Peut-on ajouter un NOUVEAU produit actif tout de suite (hors zone gelée) ?
   Différent du calcul de gel ci-dessus : ici on veut juste savoir, avant
   même de créer le produit, si l'ajout sera immédiatement utilisable ou
   s'il naîtra gelé — utile pour avertir l'utilisateur AVANT qu'il ne saisisse
   tout le formulaire. */
function canAddActiveProduct(currentProductCount){
  return currentProductCount < getMaxActiveProducts();
}

/* ---------- Essai Business : démarrage & jours restants ---------- */

function startBusinessTrial(){
  userPlan = 'business';
  userPlanStatus = 'trial';
  userPlanTrialEndsAt = Date.now() + BUSINESS_TRIAL_DURATION_MS;
  userPlanExpiresAt = null;
  userHasUsedBusinessTrial = true;
}

// Un compte n'a droit qu'à un seul essai Business gratuit, jamais (même après être
// repassé sur Simple entretemps) — voir userHasUsedBusinessTrial ci-dessus.
function canStartBusinessTrial(){
  return !userHasUsedBusinessTrial;
}

// Jours restants avant fin d'essai (arrondi au jour supérieur), ou null si
// non applicable. Sert à l'affichage "Essai : 6 jours restants".
function businessTrialDaysLeft(){
  if(userPlan !== 'business' || userPlanStatus !== 'trial' || !userPlanTrialEndsAt) return null;
  const msLeft = userPlanTrialEndsAt - Date.now();
  return Math.max(0, Math.ceil(msLeft / (24*60*60*1000)));
}

/* ---------- Activation après paiement (branché plus tard sur le vrai
   moyen de paiement — mobile money etc. Pour l'instant, ces fonctions
   posent juste le nouvel état ; l'appel réel se fera depuis l'écran VIP.) */

function activatePaidPlan(plan, durationMs){
  userPlan = plan;
  userPlanStatus = 'active';
  userPlanExpiresAt = Date.now() + durationMs;
  userPlanTrialEndsAt = null;
}

function setSimplePaidTier(durationMs){
  userPlan = 'simple';
  userPlanStatus = 'active';
  userPlanExpiresAt = Date.now() + durationMs;
}

/* ---------- Quel palier débloque quoi (pour le message d'écran de blocage) ----------
   Toujours le palier le MOINS cher qui débloque la fonctionnalité — ex. le scan de
   code-barres existe dès Simple payant, inutile de pousser vers Business pour ça. */
const LIMIT_REASON_TARGET_PLAN = {
  history: 'simple_paid', barcode: 'simple_paid', expense: 'simple_paid',
  voice: 'business', export: 'business', notif: 'business', currency: 'business',
  stock: 'business',
  stores: 'pro', devices: 'pro', suppliers: 'pro'
};
function getLimitReasonTargetPlan(reason){
  return LIMIT_REASON_TARGET_PLAN[reason] || 'business';
}
// Nom affichable du palier cible — 'simple_paid' n'est pas un vrai palier séparé (c'est
// Simple avec l'abonnement payant), donc on ajoute juste un mot pour le distinguer du
// Simple gratuit dans les messages.
function getTargetPlanLabel(targetPlan){
  const t = (typeof dict !== 'undefined' && typeof currentLang !== 'undefined') ? dict[currentLang] : {};
  if(targetPlan === 'simple_paid') return PLAN_DEFS.simple.label + (t.simplePaidSuffix || '');
  if(targetPlan === 'pro') return PLAN_DEFS.pro.label;
  return PLAN_DEFS.business.label;
}

/* ---------- Résumé du palier courant (pour l'écran "Mon palier" dans le compte) ---------- */
function getPlanStatusSummary(){
  const t = (typeof dict !== 'undefined' && typeof currentLang !== 'undefined') ? dict[currentLang] : {};
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('fr-FR');
  const eff = getEffectivePlan();
  if(eff.downgradedFrom){
    return {
      label: PLAN_DEFS.simple.label,
      status: (t.planStatusDowngraded || '').replace('{from}', PLAN_DEFS[eff.downgradedFrom].label)
    };
  }
  if(eff.plan === 'business'){
    return {
      label: PLAN_DEFS.business.label,
      status: eff.tier === 'trial'
        ? (t.planStatusTrial || '').replace('{days}', businessTrialDaysLeft())
        : (t.planStatusPaid || '').replace('{date}', userPlanExpiresAt ? fmtDate(userPlanExpiresAt) : '')
    };
  }
  if(eff.plan === 'pro'){
    return { label: PLAN_DEFS.pro.label, status: (t.planStatusPaid || '').replace('{date}', userPlanExpiresAt ? fmtDate(userPlanExpiresAt) : '') };
  }
  return {
    label: PLAN_DEFS.simple.label,
    status: eff.tier === 'active'
      ? (t.planStatusSimplePaid || '').replace('{date}', userPlanExpiresAt ? fmtDate(userPlanExpiresAt) : '')
      : (t.planStatusSimpleFree || '')
  };
}

/* ---------- Alerte de fin d'essai/abonnement proche (J-5) ----------
   Raisonne sur le palier BRUT (userPlan/userPlanStatus), pas sur le palier effectif —
   on veut prévenir AVANT la relégation automatique de getEffectivePlan(), pas après.
   Couvre les 3 cas payants : essai Business (userPlanTrialEndsAt), et tout abonnement
   payé actif — Simple payant, Business payant, Pro (userPlanExpiresAt). */
const PLAN_EXPIRY_WARNING_DAYS = 5;
function getPlanExpiryAlertInfo(){
  const now = Date.now();
  if(userPlan === 'business' && userPlanStatus === 'trial' && userPlanTrialEndsAt){
    const daysLeft = Math.ceil((userPlanTrialEndsAt - now) / 86400000);
    if(daysLeft >= 0 && daysLeft <= PLAN_EXPIRY_WARNING_DAYS){
      return { kind:'trial', daysLeft, planLabel: PLAN_DEFS.business.label };
    }
    return null;
  }
  if(userPlanStatus === 'active' && userPlanExpiresAt){
    const daysLeft = Math.ceil((userPlanExpiresAt - now) / 86400000);
    if(daysLeft >= 0 && daysLeft <= PLAN_EXPIRY_WARNING_DAYS){
      const label = (userPlan === 'simple') ? getTargetPlanLabel('simple_paid') : PLAN_DEFS[userPlan].label;
      return { kind:'subscription', daysLeft, planLabel: label };
    }
  }
  return null;
}

// Toast une seule fois par jour (pas à chaque vérification toutes les 60s, ni à
// chaque re-render) tant qu'on reste dans la fenêtre J-5 — voir PLAN_EXPIRY_ALERT_KEY.
const PLAN_EXPIRY_ALERT_KEY = 'mombongo:lastPlanExpiryAlertDate';
function maybeShowPlanExpiryWarningToast(){
  if(typeof localGet !== 'function' || typeof showToast !== 'function') return;
  const info = getPlanExpiryAlertInfo();
  if(!info) return;
  const todayStr = new Date().toISOString().slice(0,10);
  const last = localGet(PLAN_EXPIRY_ALERT_KEY);
  if(last && last.value === todayStr) return; // déjà montré aujourd'hui
  localSet(PLAN_EXPIRY_ALERT_KEY, todayStr);
  const t = dict[currentLang];
  const key = info.kind === 'trial'
    ? (info.daysLeft === 0 ? 'planExpiryWarningTrialToday' : 'planExpiryWarningTrial')
    : (info.daysLeft === 0 ? 'planExpiryWarningSubscriptionToday' : 'planExpiryWarningSubscription');
  const msg = (t[key] || '').replace('{plan}', info.planLabel).replace('{days}', info.daysLeft);
  showToast(msg, 6500);
}

// Pousse le résumé ci-dessus dans la carte "Mon palier" du compte (voir index.html,
// account-plan-section) — appelée depuis renderAccountUI() à chaque render().
function updatePlanSummary(){
  const nameEl = document.getElementById('plan-current-name');
  const statusEl = document.getElementById('plan-current-status');
  const warnEl = document.getElementById('plan-current-warning');
  if(!nameEl || !statusEl) return;
  const summary = getPlanStatusSummary();
  nameEl.textContent = summary.label;
  statusEl.textContent = summary.status;
  if(!warnEl) return;
  const info = getPlanExpiryAlertInfo();
  if(!info){
    warnEl.style.display = 'none';
    return;
  }
  const t = dict[currentLang];
  const key = info.kind === 'trial'
    ? (info.daysLeft === 0 ? 'planExpiryWarningTrialToday' : 'planExpiryWarningTrial')
    : (info.daysLeft === 0 ? 'planExpiryWarningSubscriptionToday' : 'planExpiryWarningSubscription');
  warnEl.textContent = (t[key] || '').replace('{plan}', info.planLabel).replace('{days}', info.daysLeft);
  warnEl.style.display = 'block';
}

/* ---------- Persistance locale (hors ligne / avant résolution du compte) ----------
   Appelée depuis loadData() (data-catalog.js), tout au début du démarrage de l'app —
   donc avant le tout premier render() — pour que planDataLoaded passe à true dès que
   possible, y compris pour quelqu'un qui n'est pas connecté à un compte Google (le
   palier Simple gratuit ne nécessite pas de compte). Une fois Firebase Auth résolu,
   applyDocData() (stores-devices.js) écrase ces valeurs avec la version faisant foi
   côté serveur si un compte existe. */
const PLAN_CACHE_KEYS = {
  plan: 'mombongo:userPlan',
  status: 'mombongo:userPlanStatus',
  trialEndsAt: 'mombongo:userPlanTrialEndsAt',
  expiresAt: 'mombongo:userPlanExpiresAt',
  trialUsed: 'mombongo:userHasUsedBusinessTrial'
};

function savePlanToCache(){
  localSet(PLAN_CACHE_KEYS.plan, userPlan);
  localSet(PLAN_CACHE_KEYS.status, userPlanStatus);
  localSet(PLAN_CACHE_KEYS.trialEndsAt, userPlanTrialEndsAt === null ? '' : String(userPlanTrialEndsAt));
  localSet(PLAN_CACHE_KEYS.expiresAt, userPlanExpiresAt === null ? '' : String(userPlanExpiresAt));
  localSet(PLAN_CACHE_KEYS.trialUsed, userHasUsedBusinessTrial ? '1' : '');
}

function loadPlanFromCache(){
  const p = localGet(PLAN_CACHE_KEYS.plan);
  const s = localGet(PLAN_CACHE_KEYS.status);
  const te = localGet(PLAN_CACHE_KEYS.trialEndsAt);
  const ee = localGet(PLAN_CACHE_KEYS.expiresAt);
  const tu = localGet(PLAN_CACHE_KEYS.trialUsed);
  if(p && p.value) userPlan = p.value;
  if(s && s.value) userPlanStatus = s.value;
  userPlanTrialEndsAt = (te && te.value) ? parseInt(te.value, 10) : null;
  userPlanExpiresAt = (ee && ee.value) ? parseInt(ee.value, 10) : null;
  userHasUsedBusinessTrial = !!(tu && tu.value === '1');
  planDataLoaded = true;
}

/* Détecte, pendant que l'app reste ouverte, le moment précis où le palier effectif
   change (fin d'essai Business, abonnement qui expire) — sans ça, le gel ne serait
   recalculé qu'au prochain rechargement.
   Ne redéclenche un render() que si le palier effectif a réellement changé, pour ne
   pas re-rendre inutilement toutes les 60s.
   SEUL point d'entrée pour cette vérification en direct — voir l'unique
   setInterval(checkPlanExpiryLive, 60000) + le seul listener 'visibilitychange' tout en
   bas de stores-devices.js. Ne jamais ajouter un second minuteur ailleurs : tout ce qui
   doit réagir à un changement de palier (toast J-5, fermeture des actions VIP en cours,
   blocage/déblocage de l'appareil employé...) passe par CETTE fonction. */
let lastKnownEffectivePlanSignature = null;
function checkPlanExpiryLive(){
  if(!planDataLoaded) return;
  // Indépendant du reste de la fonction (qui ne réagit qu'à un CHANGEMENT de palier
  // effectif) : la fenêtre J-5 doit être revérifiée à chaque passage, pas seulement au
  // moment de la relégation — l'auto-limitation "une fois par jour" est gérée à
  // l'intérieur de maybeShowPlanExpiryWarningToast() elle-même.
  maybeShowPlanExpiryWarningToast();
  // L'appareil employé doit refléter la réalité du palier du patron à CHAQUE passage
  // (y compris le tout premier, avant même qu'un "changement" soit détecté) — un employé
  // qui ouvre l'app alors que le Pro du patron est déjà expiré doit être bloqué
  // immédiatement, pas seulement à la prochaine bascule en direct.
  if(typeof updateEmployeeDowngradeBlock === 'function') updateEmployeeDowngradeBlock();
  const eff = getEffectivePlan();
  const signature = eff.plan + ':' + eff.tier;
  if(signature === lastKnownEffectivePlanSignature) return;
  const isFirstCheck = lastKnownEffectivePlanSignature === null;
  lastKnownEffectivePlanSignature = signature;
  if(isFirstCheck) return; // pas de re-rendu au tout premier calcul, seulement sur un vrai changement
  enforceAllowedCurrencyForPlan();
  if(typeof updatePlanSummary === 'function') updatePlanSummary();
  if(typeof render === 'function') render();
  // Une fenêtre liée à une fonctionnalité payante restée ouverte au moment précis où le
  // palier effectif la reperd (essai fini, abonnement expiré) est fermée immédiatement —
  // jamais laissée utilisable jusqu'à la prochaine action de l'utilisateur. Sans effet si
  // le changement est une amélioration (rien à fermer pour une fonctionnalité qui vient
  // au contraire d'être débloquée) — voir closeDowngradedActionSheets() ci-dessous.
  if(typeof closeDowngradedActionSheets === 'function') closeDowngradedActionSheets();
  if(eff.downgradedFrom){
    showToast(dict[currentLang].planJustDowngradedMsg, 6000);
  }
}

/* ---------- Fermeture des actions VIP en cours lors d'un downgrade en direct ----------
   Liste des fenêtres qui n'ont de sens QUE si la fonctionnalité correspondante est
   débloquée — fermées via leurs vraies fonctions de fermeture quand elles existent (pour
   couper micro/caméra proprement), sinon un simple retrait de la classe .open (même
   comportement que les fonctions closeXxxSheet() équivalentes ailleurs dans l'app). */
const DOWNGRADE_CLOSE_ACTIONS = [
  { feature:'voiceSales', run: function(){ if(typeof cancelVoiceSale === 'function') cancelVoiceSale(); } },
  { feature:'barcode', run: function(){
      if(typeof closeBarcodeScanner === 'function') closeBarcodeScanner();
      if(typeof cancelBarcodeSale === 'function') cancelBarcodeSale();
    } },
  { feature:'supplierManagement', ids: ['suppliers-overlay','supplier-form-overlay','record-purchase-overlay','purchase-history-overlay','pay-supplier-overlay'] },
  { feature:'multiDevice', run: function(){
      if(typeof closeDevicesSheet === 'function') closeDevicesSheet();
      if(typeof closeGeneratePinSheet === 'function') closeGeneratePinSheet();
      if(typeof closeJoinWithCodeSheet === 'function') closeJoinWithCodeSheet();
    } },
  { feature:'multiStore', run: function(){ if(typeof closeNewStoreSheet === 'function') closeNewStoreSheet(); } }
];
function closeDowngradedActionSheets(){
  DOWNGRADE_CLOSE_ACTIONS.forEach(function(entry){
    if(isFeatureUnlocked(entry.feature)) return; // toujours débloquée : rien à fermer
    if(entry.run){ entry.run(); return; }
    (entry.ids || []).forEach(function(id){
      const el = document.getElementById(id);
      if(el) el.classList.remove('open');
    });
  });
}

/* ---------- Blocage de l'appareil employé au moment précis d'un downgrade ----------
   Un appareil employé (caissier/magasinier) n'a de raison d'exister QUE parce que le
   compte patron a un palier qui débloque 'multiDevice' (Pro). Si ce palier expire pendant
   qu'un employé est en train de l'utiliser — grâce à attachRealtimeListener() qui
   synchronise déjà en direct le palier du PATRON sur l'appareil employé via
   applyDocData() — l'appareil doit être bloqué IMMÉDIATEMENT (écran plein écran, rien
   d'actionnable derrière), pas seulement au prochain redémarrage de l'app. Dès qu'un
   renouvellement est détecté (même mécanisme, en sens inverse), le blocage se lève tout
   seul — aucune action du patron ni de l'employé n'est nécessaire à part rouvrir/garder
   l'app ouverte, checkPlanExpiryLive() s'en charge. */
function updateEmployeeDowngradeBlock(){
  const overlay = document.getElementById('employee-plan-block-overlay');
  if(!overlay) return;
  // Un patron (même sur un appareil "secondaire" mais avec currentRole()==='patron')
  // n'est jamais bloqué par ce mécanisme : seuls les rôles caissier/magasinier le sont —
  // c'est le patron qui doit rester libre de renouveler ou de repasser à Simple/Business.
  const shouldBlock = !!isEmployeeMode && typeof currentRole === 'function' && currentRole() !== 'patron' && !isFeatureUnlocked('multiDevice');
  overlay.classList.toggle('open', shouldBlock);
}

