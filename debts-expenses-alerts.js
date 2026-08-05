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
});

function openDebtsSheet(){
  if(currentRole()==='magasinier'){ showToast(dict[currentLang].restrictedFeature); return; }
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
  closeRepaySheet();
  showToast(dict[currentLang].repaySaved);
  render();
}

/* ---------- Dépenses ---------- */
function openExpenseSheet(){
  document.getElementById('in-expense-desc').value = '';
  document.getElementById('in-expense-amount').value = '';
  document.getElementById('expense-overlay').classList.add('open');
}
function closeExpenseSheet(){
  document.getElementById('expense-overlay').classList.remove('open');
}
async function confirmExpense(){
  const desc = document.getElementById('in-expense-desc').value.trim();
  const rawAmount = parseFloat(document.getElementById('in-expense-amount').value) || 0;
  if(!desc || rawAmount <= 0){
    showToast(currentLang==='fr' ? "Indique une description et un montant" : "Pesa description na motángo");
    return;
  }
  if(!canAddMoreExpenses()){ openLimitSheet('expenses'); return; }
  const amount = toInternal(rawAmount);
  expenses.push({ id: Date.now().toString(), desc, amount, date: Date.now() });
  stats.totalExpenses += amount;
  saveStats();
  await saveExpenses();
  closeExpenseSheet();
  showToast(dict[currentLang].expenseSaved);
  render();
}

/* ---------- Alertes (stock faible / produits périmés) ---------- */
let alertsTab = 'stock';
function openAlertsSheet(){
  alertsTab = 'stock';
  document.querySelectorAll('#alerts-overlay .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.alertstab==='stock'));
  renderAlertsSheet();
  document.getElementById('alerts-overlay').classList.add('open');
}
function closeAlertsSheet(){
  document.getElementById('alerts-overlay').classList.remove('open');
}
function setAlertsTab(tab){
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
  setTimeout(openInstallApkSheet, 700);
}

initVoiceSaleButton();
loadData();
initFirst20Badge();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

