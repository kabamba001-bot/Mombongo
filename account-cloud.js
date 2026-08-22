/* ---------- Compte Google & synchronisation cloud ---------- */
function openAccountSheet(){
  // Mesure combien de visiteurs vont jusqu'à ouvrir le menu de compte —
  // première étape du parcours, avant même de voir le bouton "Connexion Google".
  // Utile pour distinguer "personne ne trouve/n'ouvre le menu" de
  // "les gens ouvrent le menu mais n'arrivent pas à se connecter".
  if(typeof fbq === 'function'){
    fbq('trackCustom', 'ClickAccountButton');
  }
  document.getElementById('account-overlay').classList.add('open');
  if(typeof updatePlanSummary === 'function') updatePlanSummary();
  renderStoresList();
  renderDevicesList();
  if(typeof updateAiReportsBadge === 'function') updateAiReportsBadge();
  const suppliersToggle = document.getElementById('in-suppliers-toggle');
  if(typeof enforceSupplierFeatureForPlan === 'function') enforceSupplierFeatureForPlan();
  if(suppliersToggle) suppliersToggle.checked = !!suppliersFeatureEnabled;
}
function closeAccountSheet(){ document.getElementById('account-overlay').classList.remove('open'); }

function signInWithGoogle(){
  if(typeof fbq === 'function'){
    fbq('trackCustom', 'ClicConnexionGoogle');
  }
  if(!cloudEnabled){
    showToast("La connexion n'est pas encore configurée (voir la note du développeur dans le code)");
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  firebase.auth().signInWithPopup(provider).then((result)=>{
    if(result && result.user){
      showToast(currentLang==='fr' ? "Connexion réussie" : "Ekangami");
      // On ne compte comme "inscription" que la toute première connexion de ce compte
      // (Firebase l'indique via additionalUserInfo.isNewUser) — sinon chaque reconnexion
      // d'un utilisateur existant fausserait les statistiques d'inscription dans Meta.
      if(typeof fbq === 'function' && result.additionalUserInfo && result.additionalUserInfo.isNewUser){
        fbq('track', 'CompleteRegistration');
      }
      // Demande le métier (boutique/pharmacie/quincaillerie/autre) dès l'inscription plutôt
      // que d'attendre le premier "Ajout rapide depuis le catalogue" — pour que TOUT nouveau
      // compte (VIP ou non) profite du bon catalogue suggéré dès l'ajout en masse initial.
      // Un compte existant qui se reconnecte, ou qui a déjà répondu (myStoreType déjà réglé
      // localement ou via un autre appareil du même compte), n'est jamais re-sollicité —
      // reste modifiable ensuite via le lien 🏪 dans la fenêtre d'ajout rapide (voir
      // community-catalog.js §9, PALIERS.md). Skippable ("Ne pas partager") sans bloquer
      // l'accès au reste de l'app.
      if(result.additionalUserInfo && result.additionalUserInfo.isNewUser && !myStoreType){
        if(typeof openCategoryPromptSheet === 'function'){
          openCategoryPromptSheet(function(cat){
            setMyStoreType(cat);
          }, 'myStoreTypeTitle', 'myStoreTypeDesc');
        }
      }
      updateBackupBanner();
    }
  }).catch((e)=>{
    console.error('Erreur de connexion', e);
    showToast('Erreur : ' + (e.code || e.message || e), 5000);
  });
}
function signOutGoogle(){
  const t = dict[currentLang];
  const msg = lastSyncOk ? t.confirmSignOut : t.confirmSignOutUnsynced;
  if(!window.confirm(msg)) return;
  removeFcmToken();
  firebase.auth().signOut().then(()=>{
    if(unsubscribeListener){ unsubscribeListener(); unsubscribeListener = null; }
    if(typeof detachSalesListener === 'function') detachSalesListener();
    if(typeof detachProductsListener === 'function') detachProductsListener();
    if(typeof detachDebtsListener === 'function') detachDebtsListener();
    if(typeof detachExpensesListener === 'function') detachExpensesListener();
    if(typeof detachSuppliersListener === 'function') detachSuppliersListener();
    if(typeof detachPurchasesListener === 'function') detachPurchasesListener();
    if(typeof detachActivityLogListener === 'function') detachActivityLogListener();
    syncedSaleIds = new Set();
    syncedProductsSnapshot = {};
    syncedDebtsSnapshot = {};
    syncedExpenseIds = new Set();
    syncedSuppliersSnapshot = {};
    syncedPurchasesSnapshot = {};
    syncedActivityLogIds = new Set();
    products = [];
    sales = [];
    lots = [];
    debts = [];
    expenses = [];
    activityLog = [];
    suppliers = [];
    purchases = [];
    suppliersFeatureEnabled = false;
    userPlan = 'simple'; userPlanStatus = 'free'; userPlanTrialEndsAt = null; userPlanExpiresAt = null;
    pausedPlan = null; pausedPlanStatus = null; pausedPlanTrialEndsAt = null; pausedPlanExpiresAt = null;
    if(typeof savePlanToCache === 'function') savePlanToCache();
    if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
    stores = [];
    activeStoreId = null;
    storesDataCache = {};
    stats = { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 };
    // Le panier en pause (heldCarts) et le panier "vente plusieurs" en cours (multiCart)
    // sont propres à une session/un appareil, jamais synchronisés (voir §11, PALIERS.md) —
    // mais ils survivaient à la déconnexion car rien ne les réinitialisait ici, laissant
    // le bouton 🧺 visible (vide) pour le compte suivant sur le même appareil.
    heldCarts = [];
    if(typeof multiCart !== 'undefined') multiCart = {};
    localSet('mombongo:heldCarts', JSON.stringify(heldCarts));
    if(typeof updateHeldCartsBadge === 'function') updateHeldCartsBadge();
    localSet('mombongo:products', JSON.stringify(products));
    localSet('mombongo:sales', JSON.stringify(sales));
    localSet('mombongo:lots', JSON.stringify(lots));
    localSet('mombongo:debts', JSON.stringify(debts));
    localSet('mombongo:expenses', JSON.stringify(expenses));
    localSet('mombongo:activityLog', JSON.stringify(activityLog));
    localSet('mombongo:suppliers', JSON.stringify(suppliers));
    localSet('mombongo:purchases', JSON.stringify(purchases));
    localSet('mombongo:suppliersFeatureEnabled', JSON.stringify(suppliersFeatureEnabled));
    localSet('mombongo:stats', JSON.stringify(stats));
    localStorage.removeItem('mombongo:lastAccount');
    if(typeof updateHeaderSuppliersButtonVisibility === 'function') updateHeaderSuppliersButtonVisibility();
    renderStoresList();
    render();
    showToast(currentLang==='fr' ? "Déconnecté, données locales effacées" : "Ekangwami te lisusu");
  });
  closeAccountSheet();
}

/* ---------- Bandeau "Sauvegarde inactive" ---------- */
// Affiché uniquement à ceux qui NE sont PAS connectés à Google, et seulement
// à partir de leur première vente (avant ça, il n'y a encore rien à perdre).
// Un clic sur × le masque pendant quelques jours plutôt que pour toujours —
// pour rester incitatif sans devenir agaçant à chaque ouverture.
const BACKUP_BANNER_SNOOZE_MS = 3*24*60*60*1000; // 3 jours
function updateBackupBanner(){
  const banner = document.getElementById('backup-banner');
  if(!banner) return;
  const dismissedAt = parseInt(localStorage.getItem('mombongo:backupBannerDismissedAt')) || 0;
  const snoozed = (Date.now() - dismissedAt) < BACKUP_BANNER_SNOOZE_MS;
  const hasSold = typeof sales !== 'undefined' && Array.isArray(sales) && sales.length > 0;
  const shouldShow = !currentUser && !isEmployeeMode && hasSold && !snoozed;
  // Bascule la classe .show plutôt que style.display directement : la fiche des chiffres
  // juste en dessous (.stats-row) remonte volontairement de 18px pour chevaucher joliment
  // le bandeau vert du haut quand ce message n'est PAS affiché — la règle CSS
  // « .backup-banner.show + .stats-row » annule ce chevauchement uniquement quand la
  // classe .show est présente. Passer par style.display directement ne déclenchait jamais
  // cette règle (elle ne réagit qu'à la classe), d'où le chevauchement visuel avec le
  // message "Sauvegarde inactive".
  banner.classList.toggle('show', shouldShow);
}
function dismissBackupBanner(){
  localStorage.setItem('mombongo:backupBannerDismissedAt', Date.now().toString());
  updateBackupBanner();
}
// Filet de sécurité : on se greffe sur render() (déjà appelée après chaque
// vente, chaque connexion/déconnexion, et au chargement initial ailleurs
// dans l'app) pour que le bandeau reste à jour partout, sans devoir modifier
// render.js — au cas où il ne serait pas encore défini au moment où ce
// fichier s'exécute, on attend le tout premier "load" de la page.
window.addEventListener('load', function(){
  if(typeof render === 'function' && !render.__backupBannerWrapped){
    const _originalRender = render;
    render = function(){
      _originalRender.apply(this, arguments);
      updateBackupBanner();
    };
    render.__backupBannerWrapped = true;
  }
  updateBackupBanner();
});

/* =========================================================================
   POLITIQUE DE CONFIDENTIALITÉ + SUPPRESSION DE COMPTE
   ========================================================================= */
function openPrivacySheet(){
  const el = document.getElementById('privacy-content');
  if(el) el.innerHTML = dict[currentLang].privacyPolicyHtml || '';
  document.getElementById('privacy-overlay').classList.add('open');
}
function closePrivacySheet(){
  document.getElementById('privacy-overlay').classList.remove('open');
}

function startDeleteAccountFlow(){
  const t = dict[currentLang];
  if(isEmployeeMode){
    // Un appareil employé (caissier/magasinier) n'a jamais de vrai compte Google
    // (currentUser reste null, voir getDataOwnerUid()) — seul le patron, depuis SON
    // appareil, peut décider de supprimer tout le compte.
    showToast(t.deleteAccountEmployeeMsg, 5000);
    return;
  }
  if(!currentUser){
    showToast(t.deleteAccountNoAccountMsg, 5000);
    return;
  }
  closePrivacySheet();
  document.getElementById('in-delete-confirm-word').value = '';
  document.getElementById('delete-account-confirm-overlay').classList.add('open');
}
function closeDeleteAccountConfirm(){
  document.getElementById('delete-account-confirm-overlay').classList.remove('open');
}

// Supprime tous les documents d'une sous-collection Firestore par lots de 400 (marge
// sous la limite de 500 opérations par batch) — nécessaire car Firestore ne propose
// aucune opération "supprimer toute la collection" côté client.
async function deleteAllDocsInCollection(collRef){
  const snap = await collRef.get();
  if(snap.empty) return;
  const docs = snap.docs;
  for(let i=0; i<docs.length; i+=400){
    const batch = db.batch();
    docs.slice(i, i+400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

async function confirmDeleteAccountFinal(){
  const t = dict[currentLang];
  const word = document.getElementById('in-delete-confirm-word').value.trim().toUpperCase();
  const expected = (t.deleteConfirmWord || 'SUPPRIMER').toUpperCase();
  if(word !== expected){
    showToast(t.deleteConfirmWordMismatch, 4000);
    return;
  }
  if(!currentUser || !db) return;
  const uid = currentUser.uid;
  const btn = document.getElementById('t-delete-confirm-btn');
  if(btn) btn.disabled = true;
  showToast(t.deleteAccountInProgress, 20000);
  try{
    const userRef = db.collection('mombongo_users').doc(uid);
    // Toutes les sous-collections réelles de ce compte — voir products-sync.js,
    // sales-sync.js, debts-sync.js, expenses-sync.js, suppliers-sync.js,
    // purchases-sync.js, activity-log-sync.js, et le token FCM (config.js).
    await deleteAllDocsInCollection(userRef.collection('products'));
    await deleteAllDocsInCollection(userRef.collection('sales'));
    await deleteAllDocsInCollection(userRef.collection('debts'));
    await deleteAllDocsInCollection(userRef.collection('expenses'));
    await deleteAllDocsInCollection(userRef.collection('suppliers'));
    await deleteAllDocsInCollection(userRef.collection('purchases'));
    await deleteAllDocsInCollection(userRef.collection('activityLog'));
    await deleteAllDocsInCollection(userRef.collection('fcmTokens'));
    // mombongo_promo_claims/{uid} n'est PAS supprimé volontairement : ce n'est pas une
    // donnée personnelle de l'utilisateur mais un registre anti-fraude de la promo "50
    // places par palier" (voir debts-expenses-alerts.js) — le garder empêche de
    // supprimer son compte pour en recréer un autre et réclamer une deuxième fois le
    // même cadeau, qui n'est censé être obtenu qu'une seule fois à vie.
    await userRef.delete();
    await firebase.auth().currentUser.delete();
    showToast(t.deleteAccountDone, 4000);
    // Le moyen le plus sûr de garantir qu'aucune miette d'état en mémoire (compte,
    // panier en pause, produits affichés...) ne survit à une suppression de compte est
    // de recharger l'app à zéro, comme au tout premier lancement.
    localStorage.clear();
    setTimeout(()=> window.location.reload(), 1200);
  }catch(e){
    console.error('Erreur suppression de compte', e);
    if(e.code === 'auth/requires-recent-login'){
      // Firebase exige une connexion "récente" pour un geste aussi sensible qu'une
      // suppression de compte — on redemande la connexion Google puis on relance la
      // suppression depuis le tout début, plutôt que de continuer à un stade
      // intermédiaire incertain (certaines sous-collections déjà vidées, d'autres non).
      showToast(t.deleteAccountNeedsRelogin, 6000);
      try{
        const provider = new firebase.auth.GoogleAuthProvider();
        await firebase.auth().currentUser.reauthenticateWithPopup(provider);
        if(btn) btn.disabled = false;
        await confirmDeleteAccountFinal();
        return;
      }catch(e2){
        console.error('Erreur reconnexion pour suppression', e2);
      }
    } else {
      showToast(t.deleteAccountError, 6000);
    }
    if(btn) btn.disabled = false;
  }
}
