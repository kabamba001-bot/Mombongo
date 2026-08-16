/* =========================================================================
   MOTEUR DE PALIERS — MOMBONGO SIMPLE / BUSINESS / PRO
   =========================================================================
   Fichier central : TOUTE décision liée aux limites d'un palier doit passer
   par les fonctions ci-dessous. Objectif : un seul endroit à modifier quand
   on ajoute un palier ou qu'on change une limite, au lieu de chasser des
   "if(isVip)" éparpillés dans 15 fichiers.

   Un compte a :
     - plan       : 'simple' | 'business' | 'pro'
     - planStatus : 'free' | 'trial' | 'active' | 'expired'
     - planTrialEndsAt  : timestamp ms (fin d'essai Business) ou null
     - planExpiresAt    : timestamp ms (fin d'abonnement payé) ou null

   Ces 4 champs vivent à côté de isVip/vipUntil (conservés tels quels pour
   l'instant) et sont stockés en local (cache offline-first, voir
   savePlanToCache()/loadPlanFromCache()) + Firestore (voir applyDocData()
   dans stores-devices.js), exactement comme isVip/vipUntil.
   ========================================================================= */

/* ---------- État courant (chargé/synchronisé ailleurs, comme isVip) ---------- */
let userPlan = 'simple';          // 'simple' | 'business' | 'pro'
let userPlanStatus = 'free';      // 'free' | 'trial' | 'active' | 'expired'
let userPlanTrialEndsAt = null;   // ms epoch ou null
let userPlanExpiresAt = null;     // ms epoch ou null

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
        maxProducts: 30,
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
      profitTracking: true,
      customerDebts: true
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
    return { plan: 'simple', tier: (userPlanStatus === 'active' ? 'active' : 'free') };
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

/* Vérifie si UNE fonctionnalité précise est débloquée pour le compte
   courant. Clés reconnues : 'barcode', 'quickAdd' (Simple payant) ;
   'voiceSales', 'quickBarcode', 'expenseTracking', 'lowStockAlerts',
   'exportPdf', 'multiCurrency', 'pushNotifications' (Business payant) ;
   'multiDevice', 'multiStore', 'supplierManagement' (Pro). */
function isFeatureUnlocked(featureKey){
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
  expiresAt: 'mombongo:userPlanExpiresAt'
};

function savePlanToCache(){
  localSet(PLAN_CACHE_KEYS.plan, userPlan);
  localSet(PLAN_CACHE_KEYS.status, userPlanStatus);
  localSet(PLAN_CACHE_KEYS.trialEndsAt, userPlanTrialEndsAt === null ? '' : String(userPlanTrialEndsAt));
  localSet(PLAN_CACHE_KEYS.expiresAt, userPlanExpiresAt === null ? '' : String(userPlanExpiresAt));
}

function loadPlanFromCache(){
  const p = localGet(PLAN_CACHE_KEYS.plan);
  const s = localGet(PLAN_CACHE_KEYS.status);
  const te = localGet(PLAN_CACHE_KEYS.trialEndsAt);
  const ee = localGet(PLAN_CACHE_KEYS.expiresAt);
  if(p && p.value) userPlan = p.value;
  if(s && s.value) userPlanStatus = s.value;
  userPlanTrialEndsAt = (te && te.value) ? parseInt(te.value, 10) : null;
  userPlanExpiresAt = (ee && ee.value) ? parseInt(ee.value, 10) : null;
  planDataLoaded = true;
}

/* Détecte, pendant que l'app reste ouverte, le moment précis où le palier effectif
   change (fin d'essai Business, abonnement qui expire) — sans ça, comme pour
   checkVipExpiryLive(), le gel ne serait recalculé qu'au prochain rechargement.
   Ne redéclenche un render() que si le palier effectif a réellement changé, pour ne
   pas re-rendre inutilement toutes les 60s. */
let lastKnownEffectivePlanSignature = null;
function checkPlanExpiryLive(){
  if(!planDataLoaded) return;
  const eff = getEffectivePlan();
  const signature = eff.plan + ':' + eff.tier;
  if(signature === lastKnownEffectivePlanSignature) return;
  const isFirstCheck = lastKnownEffectivePlanSignature === null;
  lastKnownEffectivePlanSignature = signature;
  if(isFirstCheck) return; // pas de re-rendu au tout premier calcul, seulement sur un vrai changement
  enforceAllowedCurrencyForPlan();
  if(typeof render === 'function') render();
  if(eff.downgradedFrom){
    showToast(dict[currentLang].planJustDowngradedMsg, 6000);
  }
}
