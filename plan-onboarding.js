/* =========================================================================
   ÉCRAN DE CHOIX DU PALIER (ONBOARDING) — voir plans.js pour le moteur.
   Affiché une seule fois par appareil, dès que le chargement initial est
   terminé (voir maybeShowPlanOnboarding(), appelée depuis hideBootLoading()
   dans stores-devices.js). Le choix est mémorisé localement
   (mombongo:planOnboardingSeen) — jamais reproposé sur ce même appareil,
   qu'il ait été explicitement choisi ou juste passé ("Plus tard").
   ========================================================================= */

const PLAN_ONBOARDING_SEEN_KEY = 'mombongo:planOnboardingSeen';

function hasSeenPlanOnboarding(){
  const seen = localGet(PLAN_ONBOARDING_SEEN_KEY);
  return !!(seen && seen.value === '1');
}
function markPlanOnboardingSeen(){
  localSet(PLAN_ONBOARDING_SEEN_KEY, '1');
}

/* N'affiche l'écran que pour un vrai propriétaire de compte (jamais un appareil
   employé — patron/caissier/magasinier n'ont pas à choisir de palier, seul le
   patron le fait), et une seule fois par appareil. */
function maybeShowPlanOnboarding(){
  if(isEmployeeMode) return;
  if(hasSeenPlanOnboarding()) return;
  document.getElementById('plan-onboarding-overlay').classList.add('open');
}

function closePlanOnboardingOverlay(){
  document.getElementById('plan-onboarding-overlay').classList.remove('open');
}

/* "Plus tard" : équivalent à choisir Simple — c'est déjà le palier par défaut,
   donc rien à changer côté plan, seulement à ne plus jamais reproposer l'écran
   sur cet appareil. */
function dismissPlanOnboarding(){
  markPlanOnboardingSeen();
  closePlanOnboardingOverlay();
}

async function choosePlanOnboarding(plan){
  const t = dict[currentLang];
  if(plan === 'simple'){
    // Déjà le défaut : rien à activer, juste fermer et mémoriser le choix.
    markPlanOnboardingSeen();
    closePlanOnboardingOverlay();
    showToast(t.planChosenSimpleMsg, 4000);
    return;
  }
  if(plan === 'business'){
    startBusinessTrial();
    if(typeof planDataLoaded !== 'undefined') planDataLoaded = true;
    if(typeof savePlanToCache === 'function') savePlanToCache();
    if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
    markPlanOnboardingSeen();
    closePlanOnboardingOverlay();
    // Sans compte Google connecté, l'essai reste local à cet appareil (comme le
    // reste de l'app avant connexion) — pushToCloud() ne fait rien tant qu'aucun
    // compte n'est rattaché, il devient actif dès la prochaine connexion.
    if(typeof pushToCloud === 'function') await pushToCloud();
    if(typeof render === 'function') render();
    const daysLeft = businessTrialDaysLeft();
    showToast((t.planChosenBusinessMsg || '').replace('{days}', daysLeft), 5000);
    return;
  }
  if(plan === 'pro'){
    // Pro est payant dès l'inscription : on ne l'active jamais tout seul, on
    // demande d'abord une confirmation explicite (voir spec : éviter qu'un TPE
    // clique dessus par erreur en pensant que c'est gratuit ou à l'essai).
    document.getElementById('plan-pro-confirm-overlay').classList.add('open');
  }
}

function closeProConfirm(){
  document.getElementById('plan-pro-confirm-overlay').classList.remove('open');
}

/* Confirmé : comme pour "Devenir VIP" ailleurs dans l'app (discover.js,
   products.js), l'activation réelle passe par un message WhatsApp au
   développeur — Pro n'a pas d'auto-activation, exactement comme Business une
   fois l'essai terminé. Le compte reste sur Simple gratuit en attendant
   l'activation manuelle côté Firestore, une fois le paiement reçu. */
function confirmProOnboarding(){
  const t = dict[currentLang];
  markPlanOnboardingSeen();
  closeProConfirm();
  closePlanOnboardingOverlay();
  const msg = t.proOnboardingWhatsappMsg || '';
  window.open('https://wa.me/' + DEV_WHATSAPP + '?text=' + encodeURIComponent(msg), '_blank');
}
