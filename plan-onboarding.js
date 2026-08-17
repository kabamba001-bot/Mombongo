/* =========================================================================
   SÉLECTEUR DE PALIER — voir plans.js pour le moteur.
   Deux points d'entrée pour le même écran (#plan-onboarding-overlay) :
     - maybeShowPlanOnboarding() : automatique, une seule fois par appareil,
       au tout premier lancement (voir hideBootLoading() dans stores-devices.js).
     - openPlanPicker() : manuel, depuis "Mon palier" dans le compte — permet
       de changer de palier à tout moment après coup, ce qui manquait avant.
   choosePlanOnboarding() gère les deux cas indifféremment : elle regarde le
   palier effectif ACTUEL pour décider quoi faire (déjà dessus → ferme juste ;
   descendre vers Simple → rétrogradation immédiate et gratuite ; monter vers
   Business/Pro → essai ou paiement selon le cas).
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
  // Tout premier lancement : personne n'a encore rien choisi, donc pas de
  // refreshPlanPickerCards() ici — Simple est le défaut technique en interne, mais ce
  // n'est PAS encore un choix ; les 3 cartes doivent rester telles quelles (voir
  // index.html), sans quoi Simple s'afficherait à tort comme "déjà ton palier".
  document.getElementById('plan-onboarding-overlay').classList.add('open');
}

// Point d'entrée manuel — "Changer de palier" dans le compte (voir index.html,
// account-plan-section). Même écran que l'onboarding, mais cette fois un choix a
// forcément déjà été fait avant (implicitement Simple, ou explicitement) — donc on
// met en évidence le palier réellement actif.
function openPlanPicker(){
  if(typeof isEmployeeMode !== 'undefined' && isEmployeeMode) return;
  refreshPlanPickerCards();
  document.getElementById('plan-onboarding-overlay').classList.add('open');
}

/* Au tout premier lancement, les 3 cartes montrent toujours le même texte figé (voir
   index.html) — logique, personne n'a encore de palier. Mais rouvert depuis "Changer
   de palier" en cours de route, il faut que la carte du palier déjà actif se distingue
   clairement des deux autres, sinon on pourrait croire qu'on peut "démarrer l'essai"
   une deuxième fois alors qu'on est déjà dessus. */
function refreshPlanPickerCards(){
  const t = dict[currentLang];
  const eff = getEffectivePlan();
  const cards = { simple:'plan-card-simple', business:'plan-card-business', pro:'plan-card-pro' };
  const btns = { simple:'t-plan-onb-simple-btn', business:'t-plan-onb-business-btn', pro:'t-plan-onb-pro-btn' };
  Object.keys(cards).forEach(key=>{
    const card = document.getElementById(cards[key]);
    const btn = document.getElementById(btns[key]);
    if(!card || !btn) return;
    const isCurrent = (eff.plan === key);
    card.classList.toggle('current-plan', isCurrent);
    if(isCurrent){
      btn.textContent = t.planOnbCurrentBtn || '';
    } else if(key === 'business' && !canStartBusinessTrial()){
      // Essai déjà consommé : ne plus jamais afficher "Démarrer l'essai gratuit"
      // ailleurs qu'au tout premier lancement — direction abonnement payant seulement.
      btn.textContent = (t.limitCtaSwitchTo || '').replace('{plan}', PLAN_DEFS.business.label);
    } else {
      btn.textContent = t['planOnb' + key.charAt(0).toUpperCase() + key.slice(1) + 'Btn'];
    }
  });
}

function closePlanOnboardingOverlay(){
  document.getElementById('plan-onboarding-overlay').classList.remove('open');
}

/* "Plus tard" (uniquement au premier lancement) : équivalent à rester sur Simple —
   c'est déjà le palier par défaut, donc rien à changer côté plan, seulement à ne
   plus jamais reproposer l'écran automatiquement sur cet appareil. */
function dismissPlanOnboarding(){
  markPlanOnboardingSeen();
  closePlanOnboardingOverlay();
}

async function choosePlanOnboarding(plan){
  const t = dict[currentLang];
  const eff = getEffectivePlan();

  if(plan === 'simple'){
    if(userPlan === 'simple'){
      markPlanOnboardingSeen();
      closePlanOnboardingOverlay();
      return;
    }
    // Rétrogradation volontaire depuis Business/Pro — gratuite et immédiate (aucun
    // paiement en jeu côté Simple), mais peut geler des produits au-delà de la
    // limite Simple : on prévient avant d'agir.
    if(!window.confirm(t.confirmDowngradeToSimple)) return;
    userPlan = 'simple'; userPlanStatus = 'free'; userPlanExpiresAt = null;
    // userPlanTrialEndsAt et userHasUsedBusinessTrial NE sont PAS remis à zéro : un
    // essai Business déjà consommé reste consommé, même après ce retour à Simple.
    if(typeof savePlanToCache === 'function') savePlanToCache();
    if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
    markPlanOnboardingSeen();
    closePlanOnboardingOverlay();
    if(typeof pushToCloud === 'function') await pushToCloud();
    if(typeof render === 'function') render();
    showToast(t.planChosenSimpleMsg, 4000);
    return;
  }

  if(plan === 'business'){
    if(eff.plan === 'business'){
      markPlanOnboardingSeen();
      closePlanOnboardingOverlay();
      return;
    }
    if(!canStartBusinessTrial()){
      // Essai déjà consommé une fois par ce compte (même si terminé depuis) — pas de
      // second essai gratuit, direction l'abonnement payant.
      closePlanOnboardingOverlay();
      requestPlanUpgradeViaWhatsapp('business');
      return;
    }
    startBusinessTrial();
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
    if(eff.plan === 'pro'){
      markPlanOnboardingSeen();
      closePlanOnboardingOverlay();
      return;
    }
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
  markPlanOnboardingSeen();
  closeProConfirm();
  closePlanOnboardingOverlay();
  requestPlanUpgradeViaWhatsapp('pro');
}

/* Point commun à tout passage payant (Simple payant / Business après essai / Pro) —
   ouvre WhatsApp avec un message pré-rempli qui nomme précisément le palier demandé,
   pour que le développeur sache directement quoi activer côté Firestore. */
function requestPlanUpgradeViaWhatsapp(targetPlan){
  const t = dict[currentLang];
  const msgKey = { simple_paid: 'simplePaidWhatsappMsg', business: 'businessOnboardingWhatsappMsg', pro: 'proOnboardingWhatsappMsg' }[targetPlan] || 'proOnboardingWhatsappMsg';
  window.open('https://wa.me/' + DEV_WHATSAPP + '?text=' + encodeURIComponent(t[msgKey] || ''), '_blank');
}
