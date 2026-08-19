/* ---------- Crédits & Dettes ---------- */

/* =========================================================================
   INSTALLATION "EN UN TAP" (PWA) : quand le téléphone le permet, Chrome
   propose un vrai prompt d'installation natif — aucune permission "sources
   inconnues" à activer, aucun fichier à ouvrir manuellement, exactement
   comme une app du Play Store. On intercepte cet évènement tôt (avant même
   que l'utilisateur touche quoi que ce soit) pour pouvoir le déclencher
   nous-mêmes plus tard, au moment où NOTRE fenêtre "Installer Mombongo"
   s'affiche, plutôt que de laisser Chrome afficher sa propre mini-bannière
   à un moment qu'on ne contrôle pas.
   Le téléchargement APK reste le filet de sécurité : si ce prompt n'est
   jamais proposé (navigateur qui ne le supporte pas, critères pas encore
   remplis, etc.), acceptInstallApk() retombe automatiquement dessus —
   rien ne change pour ces cas-là.
   ========================================================================= */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  localStorage.setItem('mombongo:apkPromptSeen', '1');
  if(typeof fbq === 'function'){ fbq('trackCustom', 'InstallPWA'); }
  // Popup cadeau "50 premiers utilisateurs d'août" — installation confirmée (voie native).
  setTimeout(maybeShowPromoPopup, 600);
});

/* =========================================================================
   PROMO "50 PLACES PAR PALIER" (Business et Pro) : fenêtre de 3 mois, du
   1er août au 1er novembre 2026 (fin exclusive). Contrairement à la première
   version de cette promo, le cadeau n'est plus accordé automatiquement à la
   création du compte — il est accordé au moment où le patron CHOISIT
   explicitement Business ou Pro (voir choosePlanOnboarding() dans
   plan-onboarding.js), et porte directement sur CE palier :
     - 50 places pour Business, 50 places pour Pro — deux compteurs séparés
       (mombongo_meta/promo_business_2026 et mombongo_meta/promo_pro_2026).
       Être dans les 50 premiers Business n'a aucun effet sur les places Pro,
       et inversement.
     - Le cadeau accordé, c'est 2 mois du palier CHOISI directement actifs
       (userPlanStatus='active', pas un essai à surveiller) — pour Business,
       ça remplace l'essai de 14 jours habituel ; pour Pro (normalement
       payant dès l'inscription, sans essai), ça donne exactement le même
       traitement que Business le temps du cadeau.
     - Un seul cadeau par compte, à VIE, tous paliers confondus : le verrou
       est un unique document mombongo_promo_claims/{uid} (indépendant du
       palier). Un patron qui a déjà eu ses 2 mois Business offerts et qui
       tente ensuite de passer à Pro NE bénéficie PAS d'une deuxième place,
       même s'il reste des places Pro disponibles — voir tryClaimPlanPromo().

   Anti-fraude / anti-course : comme pour l'ancienne version, le comptage
   passe par une transaction Firestore (jamais une déclaration du client) :
   si deux patrons choisissent Business à la même seconde, Firestore ne
   laisse passer qu'une seule des deux écritures tant que le compteur de
   cette catégorie est encore sous 50.
   ========================================================================= */
const PROMO_SLOTS_PER_PLAN = 50;
const PROMO_GIFT_MONTHS = 2;
const PROMO_COUNTER_DOCS = { business: 'promo_business_2026', pro: 'promo_pro_2026' };
const PROMO_START = new Date(2026, 7, 1).getTime();   // 1er août 2026 00:00 (mois 0-indexé : 7 = août)
const PROMO_END = new Date(2026, 10, 1).getTime();    // 1er novembre 2026 00:00 (fin exclusive) — fenêtre de 3 mois : août, septembre, octobre
let promoPopupShown = false;

function isPromoWindowOpen(){
  const now = Date.now();
  return now >= PROMO_START && now < PROMO_END;
}

// Tente d'accorder la promo pour le palier CHOISI (plan = 'business' ou 'pro') au compte
// connecté uid. Renvoie true si gagné. Appelée uniquement depuis choosePlanOnboarding()
// (plan-onboarding.js), au moment précis où le patron choisit ce palier — jamais à la
// création du compte. Le verrou mombongo_promo_claims/{uid} est commun aux deux paliers :
// s'il existe déjà (quel que soit le palier gagné à l'époque), aucune nouvelle réclamation
// n'est possible, même dans l'autre catégorie — "un seul cadeau à vie, tous paliers
// confondus".
async function tryClaimPlanPromo(uid, plan){
  if(!cloudEnabled || !db || !isPromoWindowOpen()) return false;
  if(plan !== 'business' && plan !== 'pro') return false;
  const counterRef = db.collection('mombongo_meta').doc(PROMO_COUNTER_DOCS[plan]);
  const claimRef = db.collection('mombongo_promo_claims').doc(uid);
  try{
    const won = await db.runTransaction(async (tx)=>{
      const claimSnap = await tx.get(claimRef);
      if(claimSnap.exists) return false; // cadeau déjà utilisé une fois (business OU pro, peu importe lequel)
      const counterSnap = await tx.get(counterRef);
      const claimed = (counterSnap.exists && counterSnap.data().claimed) || 0;
      if(claimed >= PROMO_SLOTS_PER_PLAN) return false;
      tx.set(counterRef, { claimed: claimed + 1 }, { merge: true });
      tx.set(claimRef, { uid, plan, rank: claimed + 1, timestamp: Date.now() });
      return true;
    });
    if(won){
      const until = new Date();
      until.setMonth(until.getMonth() + PROMO_GIFT_MONTHS);
      userPlan = plan;
      userPlanStatus = 'active';
      userPlanExpiresAt = until.getTime();
      userPlanTrialEndsAt = null; // le cadeau remplace l'essai — pas d'essai Business à consommer en plus
      if(typeof savePlanToCache === 'function') savePlanToCache();
      if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
      await db.collection('mombongo_users').doc(uid).set({
        userPlan, userPlanStatus, userPlanExpiresAt, userPlanTrialEndsAt
      }, { merge: true });
    }
    return won;
  }catch(e){
    console.error('Erreur réclamation promo palier', e);
    return false;
  }
}

// Nombre de places restantes par catégorie, en direct sur les compteurs partagés — pour
// ne jamais promettre (popup, badge) un cadeau qui n'existe plus dans l'une des deux
// catégories. Renvoie les 50 places par défaut si la lecture échoue (hors ligne, etc.).
async function getPromoRemaining(){
  if(!cloudEnabled || !db){
    return { business: PROMO_SLOTS_PER_PLAN, pro: PROMO_SLOTS_PER_PLAN };
  }
  try{
    const [businessSnap, proSnap] = await Promise.all([
      db.collection('mombongo_meta').doc(PROMO_COUNTER_DOCS.business).get(),
      db.collection('mombongo_meta').doc(PROMO_COUNTER_DOCS.pro).get()
    ]);
    const businessClaimed = (businessSnap.exists && businessSnap.data().claimed) || 0;
    const proClaimed = (proSnap.exists && proSnap.data().claimed) || 0;
    return {
      business: Math.max(0, PROMO_SLOTS_PER_PLAN - businessClaimed),
      pro: Math.max(0, PROMO_SLOTS_PER_PLAN - proClaimed)
    };
  }catch(e){
    return { business: PROMO_SLOTS_PER_PLAN, pro: PROMO_SLOTS_PER_PLAN };
  }
}

// Fenêtre "🎁 places offertes" affichée au milieu du tableau de bord, juste après
// l'installation (native ou APK) — voir appinstalled et acceptInstallApk(). N'annonce pas
// encore quel palier sera gagné (ça se joue au choix du palier, après connexion) : décrit
// juste que la promo existe. Ne s'affiche que si : la personne n'est pas déjà connectée
// (son statut est déjà tranché sinon), la fenêtre de 3 mois n'est pas terminée, elle ne l'a
// pas déjà vue/refusée, et il reste vraiment des places dans AU MOINS une des deux
// catégories (vérifié en direct sur les compteurs partagés).
async function maybeShowPromoPopup(){
  if(promoPopupShown) return;
  if(currentUser) return;
  if(!isPromoWindowOpen()) return;
  if(localStorage.getItem('mombongo:promoAug2026Seen') === '1') return;
  if(!cloudEnabled || !db) return;
  const remaining = await getPromoRemaining();
  if(remaining.business <= 0 && remaining.pro <= 0) return;
  const bodyEl = document.getElementById('promo-gift-remaining');
  if(bodyEl){
    bodyEl.textContent = (dict[currentLang].promoRemainingText || '')
      .replace('{business}', remaining.business)
      .replace('{pro}', remaining.pro);
  }
  promoPopupShown = true;
  document.getElementById('promo-gift-overlay').classList.add('open');
}
function closePromoPopup(){
  localStorage.setItem('mombongo:promoAug2026Seen', '1');
  document.getElementById('promo-gift-overlay').classList.remove('open');
}
function acceptPromoPopup(){
  localStorage.setItem('mombongo:promoAug2026Seen', '1');
  document.getElementById('promo-gift-overlay').classList.remove('open');
  // Direction directe vers la connexion Google du téléphone (compte déjà présent sur
  // l'appareil dans la plupart des cas) — réutilise le flux de connexion existant. Le choix
  // du palier (et donc la tentative de réclamation) se fera juste après, sur l'écran
  // "Choisis ton profil" qui s'affiche automatiquement à la première connexion.
  signInWithGoogle();
}

// Petit badge discret dans le menu de compte, visible tant que la promo tourne et que des
// places restent dans au moins une des deux catégories.
async function initFirstUsersPromoBadge(){
  const badge = document.getElementById('promo-first-users-badge');
  if(!badge) return;
  if(!isPromoWindowOpen() || !cloudEnabled || !db){ badge.style.display = 'none'; return; }
  const remaining = await getPromoRemaining();
  if(remaining.business <= 0 && remaining.pro <= 0){ badge.style.display = 'none'; return; }
  badge.textContent = (dict[currentLang].promoBadgeText || '')
    .replace('{business}', remaining.business)
    .replace('{pro}', remaining.pro);
  badge.style.display = 'inline-block';
}

function openDebtsSheet(){
  if(currentRole()==='magasinier'){ showToast(dict[currentLang].restrictedFeature); return; }
  if(!isFeatureUnlocked('customerDebts')){ openLimitSheet('debts'); return; }
  try{ renderDebtsList(); }catch(e){ console.error('Erreur affichage dettes', e); }
  document.getElementById('debts-overlay').classList.add('open');
}
function closeDebtsSheet(){
  document.getElementById('debts-overlay').classList.remove('open');
}

let editingDebtId = null;
function openEditDebtSheet(debtId){
  if(!isPatron() && currentRole()!=='caissier'){ showToast(dict[currentLang].restrictedFeature); return; }
  const debt = debts.find(d=>d.id===debtId);
  if(!debt) return;
  editingDebtId = debtId;
  document.getElementById('in-edit-debt-name').value = debt.clientName || '';
  document.getElementById('in-edit-debt-phone').value = debt.phone || '';
  document.getElementById('in-edit-debt-due').value = debt.dueDate || '';
  const remaining = Math.max(0, debt.totalOwed - debt.amountPaid);
  document.getElementById('in-edit-debt-amount').value = currentCurrency==='cdf' ? Math.round(remaining*exchangeRate) : remaining.toFixed(2);
  document.getElementById('edit-debt-overlay').classList.add('open');
}
function closeEditDebtSheet(){
  document.getElementById('edit-debt-overlay').classList.remove('open');
  editingDebtId = null;
}
async function confirmEditDebt(){
  const t = dict[currentLang];
  const debt = debts.find(d=>d.id===editingDebtId);
  if(!debt) return;
  const newName = document.getElementById('in-edit-debt-name').value.trim();
  const newPhone = document.getElementById('in-edit-debt-phone').value.trim();
  const newDue = document.getElementById('in-edit-debt-due').value;
  const rawAmount = parseFloat(document.getElementById('in-edit-debt-amount').value);
  if(!newName || isNaN(rawAmount) || rawAmount < 0){
    showToast(currentLang==='fr' ? "Vérifie le nom et le montant" : (currentLang==='ln' ? "Talá nkombo na motángo" : "Angalia jina na kiasi"));
    return;
  }
  const newRemaining = toInternal(rawAmount);
  const changed = [];
  if(newName !== debt.clientName) changed.push(t.clientName);
  if(newPhone !== (debt.phone||'')) changed.push(t.clientPhone);
  if(newDue !== (debt.dueDate||'')) changed.push(t.dueLabel);
  const oldRemaining = Math.max(0, debt.totalOwed - debt.amountPaid);
  if(Math.abs(newRemaining - oldRemaining) > 0.001) changed.push(t.owedSuffix);
  debt.clientName = newName;
  debt.phone = newPhone;
  debt.dueDate = newDue;
  debt.totalOwed = debt.amountPaid + newRemaining;
  debt.status = (debt.totalOwed - debt.amountPaid <= 0.001) ? 'réglé' : 'ouvert';
  await saveDebts();
  if(currentRole()==='caissier' && changed.length){
    logActivity('debt_edit', t.logDebtEdited + ' : ' + newName + ' (' + changed.join(', ') + ')');
  }
  closeEditDebtSheet();
  renderDebtsList();
  render();
  showToast(t.debtUpdated);
}
async function deleteDebt(debtId){
  const t = dict[currentLang];
  if(!isPatron()){ showToast(t.restrictedFeature); return; }
  const debt = debts.find(d=>d.id===debtId);
  if(!debt) return;
  const ok = window.confirm(`${t.confirmDeleteDebt}\n"${debt.clientName}"`);
  if(!ok) return;
  debts = debts.filter(d=>d.id!==debtId);
  await saveDebts();
  renderDebtsList();
  render();
  showToast(t.debtDeleted);
}

let repayingDebtId = null;
function openRepaySheet(debtId){
  if(!canRepayDebt()){ showToast(dict[currentLang].restrictedFeature); return; }
  const debt = debts.find(d=>d.id===debtId);
  if(!debt) return;
  repayingDebtId = debtId;
  const remaining = Math.max(0, debt.totalOwed - debt.amountPaid);
  document.getElementById('repay-client-display').value = `${debt.clientName} — ${formatMoney(remaining)} ${dict[currentLang].owedSuffix}`;
  document.getElementById('in-repay-amount').value = currentCurrency==='cdf' ? Math.round(remaining*exchangeRate) : remaining.toFixed(2);
  document.getElementById('repay-overlay').classList.add('open');
}
function closeRepaySheet(){
  document.getElementById('repay-overlay').classList.remove('open');
  repayingDebtId = null;
}
async function confirmRepay(){
  if(!canRepayDebt()){ showToast(dict[currentLang].restrictedFeature); return; }
  const debt = debts.find(d=>d.id===repayingDebtId);
  if(!debt) return;
  const remaining = Math.max(0, debt.totalOwed - debt.amountPaid);
  const rawAmount = parseFloat(document.getElementById('in-repay-amount').value) || 0;
  let amount = toInternal(rawAmount);
  if(amount <= 0){
    showToast(currentLang==='fr' ? "Montant invalide" : "Motángo ekoki te");
    return;
  }
  if(amount > remaining + 0.01) amount = remaining;
  const profitPortion = debt.totalOwed > 0 ? amount * (debt.totalProfit / debt.totalOwed) : 0;
  debt.amountPaid += amount;
  debt.payments.push({ amount, profit: profitPortion, date: Date.now() });
  if(debt.totalOwed - debt.amountPaid <= 0.01){
    debt.status = 'réglé';
  }
  ensureTodayStats();
  stats.todaySales += amount;
  stats.todayProfit += profitPortion;
  stats.totalProfit += profitPortion;
  saveStats();
  saveDebts();
  if(currentRole() !== 'patron'){
    logActivity('debt_repay', dict[currentLang].logDebtRepaid + ' : ' + debt.clientName + ' — ' + formatMoney(amount));
  }
  closeRepaySheet();
  showToast(dict[currentLang].repaySaved);
  render();
}

/* ---------- Dépenses ---------- */
function openExpenseSheet(){
  if(expenses.length >= getMaxExpenses()){ openLimitSheet('expense'); return; }
  document.getElementById('in-expense-desc').value = '';
  document.getElementById('in-expense-amount').value = '';
  document.getElementById('expense-overlay').classList.add('open');
}
function closeExpenseSheet(){
  document.getElementById('expense-overlay').classList.remove('open');
}
async function confirmExpense(){
  if(expenses.length >= getMaxExpenses()){ closeExpenseSheet(); openLimitSheet('expense'); return; }
  const desc = document.getElementById('in-expense-desc').value.trim();
  const rawAmount = parseFloat(document.getElementById('in-expense-amount').value) || 0;
  if(!desc || rawAmount <= 0){
    showToast(currentLang==='fr' ? "Indique une description et un montant" : "Pesa description na motángo");
    return;
  }
  const amount = toInternal(rawAmount);
  expenses.push({ id: Date.now().toString(), desc, amount, date: Date.now() });
  stats.totalExpenses += amount;
  saveStats();
  await saveExpenses();
  if(currentRole() !== 'patron'){
    logActivity('expense_add', dict[currentLang].logExpenseAdded + ' : ' + desc + ' — ' + formatMoney(amount));
  }
  closeExpenseSheet();
  showToast(dict[currentLang].expenseSaved);
  render();
}

/* ---------- Alertes (stock faible / produits périmés) ---------- */
let alertsTab = 'stock';
function openAlertsSheet(){
  // Repli sur "expired" (toujours disponible, pas dans la spec payante) si le palier
  // courant n'a pas l'alerte stock faible — évite d'ouvrir sur un onglet qu'il faudrait
  // aussitôt bloquer.
  alertsTab = isFeatureUnlocked('lowStockAlerts') ? 'stock' : 'expired';
  document.querySelectorAll('#alerts-overlay .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.alertstab===alertsTab));
  renderAlertsSheet();
  document.getElementById('alerts-overlay').classList.add('open');
}
function closeAlertsSheet(){
  document.getElementById('alerts-overlay').classList.remove('open');
}
function setAlertsTab(tab){
  if(tab === 'stock' && !isFeatureUnlocked('lowStockAlerts')){ openLimitSheet('stock'); return; }
  if(tab === 'debts' && !isFeatureUnlocked('customerDebts')){ openLimitSheet('debts'); return; }
  alertsTab = tab;
  document.querySelectorAll('#alerts-overlay .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.alertstab===tab));
  renderAlertsSheet();
}
function getDueSoonDebts(){
  return debts.filter(d=>{
    if(d.status !== 'ouvert') return false;
    if((d.totalOwed - d.amountPaid) <= 0.001) return false;
    if(!d.dueDate) return false;
    return daysUntilDue(d.dueDate) <= 3;
  }).sort((a,b)=>daysUntilDue(a.dueDate)-daysUntilDue(b.dueDate));
}

function showToast(msg, duration){
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'), duration || 1800);
}

/* =========================================================================
   PARRAINAGE : 10 filleuls inscrits (Google) = 1 mois VIP offert.
   Le compte de filleuls n'est JAMAIS basé sur une déclaration de
   l'utilisateur — il est recalculé à chaque fois depuis Firestore, en
   comptant les documents /referrals où referrerUid == mon uid. Chaque
   document /referrals/{referredUid} ne peut être créé qu'une seule fois,
   par le filleul lui-même, uniquement au moment de la toute première
   connexion Google (voir handlePostLogin) — impossible à falsifier
   depuis le navigateur. Réutilise DEV_WHATSAPP (déjà défini plus haut)
   pour recevoir les réclamations VIP.
   ========================================================================= */
const REFERRAL_GOAL = 10;

function getReferralLink(){
  const base = location.origin + location.pathname;
  return base + (base.includes('?') ? '&' : '?') + 'ref=' + currentUser.uid;
}

async function loadReferralStatus(){
  const progressEl = document.getElementById('referral-progress');
  const claimBtn = document.getElementById('referral-claim-btn');
  if(!progressEl || !claimBtn) return;
  if(!cloudEnabled || !db || !currentUser || isEmployeeMode){
    progressEl.textContent = '';
    claimBtn.style.display = 'none';
    return;
  }
  try{
    const snap = await db.collection('referrals').where('referrerUid','==', currentUser.uid).get();
    const count = snap.size;
    const t = dict[currentLang];
    progressEl.textContent = count + ' / ' + REFERRAL_GOAL + ' ' + t.referralProgressSuffix;
    claimBtn.style.display = count >= REFERRAL_GOAL ? 'block' : 'none';
  }catch(e){
    console.error('Erreur chargement parrainage', e);
  }
}

function shareReferralLink(){
  if(!currentUser) return;
  const t = dict[currentLang];
  const link = getReferralLink();
  const message = t.referralShareMessage.replace('{link}', link);
  if(navigator.share){
    navigator.share({ title: 'Mombongo', text: message }).catch(()=>{});
  } else {
    window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
  }
}

function claimReferralVip(){
  if(!currentUser) return;
  const t = dict[currentLang];
  const message = t.referralClaimMessage.replace('{email}', currentUser.email || '');
  window.open('https://wa.me/' + DEV_WHATSAPP + '?text=' + encodeURIComponent(message), '_blank');
}

(function captureReferralParam(){
  try{
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if(ref && /^[a-zA-Z0-9]{10,60}$/.test(ref)){
      localStorage.setItem('mombongo:pendingRef', ref);
    }
  }catch(e){}
})();

/* =========================================================================
   PROPOSITION D'INSTALLATION DE L'APK (à la première visite depuis un lien
   partagé, uniquement si l'app n'est pas déjà installée).
   ========================================================================= */
function isRunningInstalled(){
  const isTWA = document.referrer.startsWith('android-app://');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                        window.matchMedia('(display-mode: fullscreen)').matches ||
                        window.navigator.standalone === true;
  return isTWA || isStandalone;
}

function shouldOfferApkInstall(){
  if(isRunningInstalled()) return false;
  if(localStorage.getItem('mombongo:apkPromptSeen') === '1') return false;
  return true;
}

function openInstallApkSheet(){
  document.getElementById('install-apk-overlay').classList.add('open');
}
function closeInstallApkSheet(){
  document.getElementById('install-apk-overlay').classList.remove('open');
}
function acceptInstallApk(){
  localStorage.setItem('mombongo:apkPromptSeen', '1');
  closeInstallApkSheet();

  if(deferredInstallPrompt){
    // Chemin fluide : vrai prompt natif de Chrome, sans téléchargement ni
    // "sources inconnues" — c'est celui qui donne la sensation "Play Store".
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null; // un prompt ne peut servir qu'une fois
    promptEvent.prompt();
    promptEvent.userChoice.then((choice)=>{
      if(choice.outcome === 'accepted' && typeof fbq === 'function'){
        fbq('trackCustom', 'InstallPWA');
      }
      // Le popup cadeau ne s'affiche ici que si la personne a réellement accepté le prompt natif —
      // sinon on laisse l'évènement 'appinstalled' s'en charger le cas échéant.
      if(choice.outcome === 'accepted'){ setTimeout(maybeShowPromoPopup, 600); }
    }).catch(()=>{});
    return;
  }

  // Secours : téléchargement direct de l'APK (comportement historique,
  // utilisé seulement si le prompt natif n'a jamais été proposé).
  if(typeof fbq === 'function'){
    fbq('trackCustom', 'TelechargementAPK');
  }
  const link = document.createElement('a');
  link.href = './mombongo.apk';
  link.download = 'Mombongo.apk';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Téléchargement en cours… ouvre le fichier une fois terminé pour installer.', 6000);
  // Popup cadeau "50 premiers" — on ne peut pas détecter l'installation réelle de l'APK
  // (le navigateur ne le voit jamais), donc on prend le déclenchement du téléchargement
  // comme le même signal d'action que pour la voie native ci-dessus.
  setTimeout(maybeShowPromoPopup, 1500);
}
function declineInstallApk(){
  localStorage.setItem('mombongo:apkPromptSeen', '1');
  closeInstallApkSheet();
}
function updateDownloadApkLinkVisibility(){
  const link = document.getElementById('t-download-apk-link');
  if(!link) return;
  link.style.display = isRunningInstalled() ? 'none' : 'block';
}

updateDownloadApkLinkVisibility();
if(shouldOfferApkInstall()){
  // Plutôt que d'attendre un temps deviné pour tout le monde, on fait la
  // course : soit Chrome propose son prompt natif, soit ce délai plafond
  // s'écoule — le premier des deux déclenche l'affichage de la fenêtre.
  // Allongé à 30s (au lieu de 10s) pour laisser à Chrome plus de temps de
  // décider que les critères d'installation natifs sont remplis avant de
  // retomber sur le téléchargement APK — la voie native est l'expérience
  // "en un tap" à privilégier chaque fois qu'elle est possible.
  // Ajuste juste ce chiffre si tu veux tester une valeur différente.
  const MAX_WAIT_FOR_NATIVE_PROMPT_MS = 30000;
  let sheetOpened = false;
  const openOnce = () => {
    if(sheetOpened) return;
    sheetOpened = true;
    openInstallApkSheet();
  };
  if(deferredInstallPrompt){
    // Le prompt natif était déjà prêt avant même qu'on regarde (ex: visite
    // répétée, engagement déjà suffisant) — pas besoin d'attendre.
    openOnce();
  } else {
    window.addEventListener('beforeinstallprompt', openOnce, { once:true });
    setTimeout(openOnce, MAX_WAIT_FOR_NATIVE_PROMPT_MS);
  }
}

initVoiceSaleButton();
loadData();
initFirstUsersPromoBadge();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

