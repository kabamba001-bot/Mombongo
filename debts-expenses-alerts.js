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
  // Popup "places offertes" — installation confirmée (voie native) ; n'affiche quoi que
  // ce soit que s'il y a une campagne promo active au sens de PROMO_CAMPAIGNS ci-dessous.
  setTimeout(maybeShowPromoPopup, 600);
});

/* =========================================================================
   PROMOS "PLACES OFFERTES PAR PALIER" (Business et/ou Pro) — SYSTÈME GÉNÉRALISÉ.
   ---------------------------------------------------------------------------
   Contrairement à la toute première version (une seule promo, tout codé en dur),
   PROMO_CAMPAIGNS ci-dessous est une LISTE : lancer une nouvelle promo ponctuelle
   ("X places Business et Y Pro, pendant 1 semaine, 1 mois offert") ne demande
   plus de toucher à la logique, juste d'ajouter une ligne à ce tableau — voir le
   modèle donné en commentaire juste après.

   Le cadeau n'est jamais accordé automatiquement à la création du compte — il se
   joue au moment où le patron CHOISIT explicitement Business ou Pro (voir
   choosePlanOnboarding() dans plan-onboarding.js), et porte directement sur CE
   palier : le patron reçoit alors `giftMonths` mois de ce palier directement
   actifs (userPlanStatus='active', pas un essai à surveiller).

   NOMBRE DE PLACES : volontairement PAS dans ce tableau JS, mais dans un document
   Firestore (mombongo_meta/{campaignId}) que TOI seul crées/modifies à la main
   via la console Firebase quand tu lances une promo — voir la marche à suivre
   complète dans PALIERS.md §7. Ça permet d'ajuster un nombre de places (ou de
   suivre en direct combien ont déjà été prises) sans jamais redéployer l'app —
   seule la FENÊTRE (dates) et la durée du cadeau restent ici, dans le code,
   parce qu'elles doivent être connues par TOUS les appareils dès l'ouverture de
   l'app, avant même la moindre connexion réseau.

   Un seul cadeau par compte, à VIE, tous paliers ET toutes campagnes confondus :
   le verrou est un unique document mombongo_promo_claims/{uid}. Quelqu'un qui a
   déjà gagné une promo passée (Business ou Pro, peu importe laquelle) ne peut
   plus jamais rien gagner d'une promo suivante — voir tryClaimPlanPromo().

   Anti-fraude / anti-course : comme pour la première version, tout le comptage
   passe par une transaction Firestore (jamais une déclaration du client), et les
   règles Firestore (firestore.rules) revérifient indépendamment côté serveur que
   le rang réclamé correspond bien au compteur de la bonne catégorie et ne dépasse
   jamais le plafond fixé manuellement dans mombongo_meta/{campaignId}.
   ========================================================================= */
const PROMO_CAMPAIGNS = [
  {
    id: 'promo_2026_launch',                          // sert d'identifiant Firestore — voir mombongo_meta/{id}
    start: new Date(2026, 7, 1).getTime(),             // 1er août 2026 00:00 (mois 0-indexé : 7 = août)
    end: new Date(2026, 10, 1).getTime(),               // 1er novembre 2026 00:00 (fin exclusive)
    giftMonths: 2
  }
  // Modèle pour une promo ponctuelle : "20 places Business + 10 Pro, 1 mois offert,
  // du 15 au 22 septembre 2026" — ajoute simplement CET OBJET ici (aucune autre
  // ligne de code à toucher), PUIS crée à la main sur Firebase le document
  // mombongo_meta/promo_rentree_sept2026 avec { maxSlotsBusiness: 20, claimedBusiness: 0,
  // maxSlotsPro: 10, claimedPro: 0 } (voir PALIERS.md §7) :
  // {
  //   id: 'promo_rentree_sept2026',
  //   start: new Date(2026, 8, 15).getTime(),
  //   end: new Date(2026, 8, 22).getTime(),
  //   giftMonths: 1
  // },
];
let promoPopupShown = false;

// La campagne active EN CE MOMENT, s'il y en a une (jamais deux en même temps dans
// l'usage prévu — si jamais deux fenêtres se chevauchaient par erreur de config, la
// première trouvée dans le tableau gagne).
function getActivePromoCampaign(){
  const now = Date.now();
  return PROMO_CAMPAIGNS.find(c => now >= c.start && now < c.end) || null;
}
function isPromoWindowOpen(){
  return getActivePromoCampaign() !== null;
}

// Tente d'accorder la promo en cours (s'il y en a une) pour le palier CHOISI
// (plan = 'business' ou 'pro') au compte connecté uid. Renvoie true si gagné.
// Appelée uniquement depuis choosePlanOnboarding() (plan-onboarding.js), au moment
// précis où le patron choisit ce palier — jamais à la création du compte.
async function tryClaimPlanPromo(uid, plan){
  if(!cloudEnabled || !db) return false;
  if(plan !== 'business' && plan !== 'pro') return false;
  const campaign = getActivePromoCampaign();
  if(!campaign) return false;
  const claimedField = plan === 'business' ? 'claimedBusiness' : 'claimedPro';
  const maxField = plan === 'business' ? 'maxSlotsBusiness' : 'maxSlotsPro';
  const counterRef = db.collection('mombongo_meta').doc(campaign.id);
  const claimRef = db.collection('mombongo_promo_claims').doc(uid);
  try{
    const won = await db.runTransaction(async (tx)=>{
      const claimSnap = await tx.get(claimRef);
      if(claimSnap.exists) return false; // cadeau déjà utilisé une fois, campagne/palier peu importe
      const counterSnap = await tx.get(counterRef);
      // Le document n'existe pas encore ⇒ la promo n'a pas (ou plus) été configurée
      // côté Firestore, même si sa fenêtre de dates est ouverte dans le code — voir
      // PALIERS.md §7 : ce document doit être créé à la main AVANT le début réel.
      if(!counterSnap.exists) return false;
      const data = counterSnap.data();
      const claimed = data[claimedField] || 0;
      const maxSlots = data[maxField] || 0;
      if(claimed >= maxSlots) return false;
      tx.update(counterRef, { [claimedField]: claimed + 1 });
      tx.set(claimRef, { uid, plan, campaignId: campaign.id, rank: claimed + 1, timestamp: Date.now() });
      return true;
    });
    if(won){
      const until = new Date();
      until.setMonth(until.getMonth() + campaign.giftMonths);
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

// Nombre de places restantes par catégorie pour la campagne active, en direct sur le
// document Firestore partagé — pour ne jamais promettre (popup, badge) un cadeau qui
// n'existe plus. Renvoie 0/0 s'il n'y a pas de campagne active, hors ligne, ou si le
// document Firestore n'a pas encore été créé (voir tryClaimPlanPromo()).
async function getPromoRemaining(){
  const campaign = getActivePromoCampaign();
  if(!campaign || !cloudEnabled || !db) return { business: 0, pro: 0 };
  try{
    const snap = await db.collection('mombongo_meta').doc(campaign.id).get();
    if(!snap.exists) return { business: 0, pro: 0 };
    const data = snap.data();
    return {
      business: Math.max(0, (data.maxSlotsBusiness||0) - (data.claimedBusiness||0)),
      pro: Math.max(0, (data.maxSlotsPro||0) - (data.claimedPro||0))
    };
  }catch(e){
    return { business: 0, pro: 0 };
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

