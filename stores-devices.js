/* ---------- Multi-boutiques & multi-appareils/rôles ---------- */
let stores = [];
let activeStoreId = null;
let storesDataCache = {};
let activityLog = [];
let isEmployeeMode = false;
let employeeOwnerUid = null;
let employeeRole = null;      // 'patron' | 'caissier' | 'magasinier'
let employeeStoreId = null;
let employeeDeviceName = '';
let unsubscribeListener = null;
let devicesUnsub = null;
let pairingWaitUnsub = null;
// Tant que cet appareil employé n'a pas reçu au moins une vraie réponse du patron via
// attachRealtimeListener depuis le dernier chargement, pushToCloud() refuse d'écrire :
// ça évite qu'un rafraîchissement de page envoie des tableaux vides (encore non
// synchronisés) qui écraseraient les vraies données du patron dans le cloud.
let employeeSyncReady = false;
let pinCountdownTimer = null;
let selectedGenerateRole = 'caissier';

function currentRole(){
  if(isEmployeeMode) return employeeRole || 'patron';
  return 'patron'; // le titulaire du compte Google est toujours patron
}
function isPatron(){ return currentRole() === 'patron'; }
function canSell(){ const r = currentRole(); return r==='patron' || r==='caissier'; }
function canAddProducts(){ const r = currentRole(); return r==='patron' || r==='magasinier'; }
function canEditDeleteProducts(){ const r = currentRole(); return r==='patron' || r==='magasinier'; }
function canManageExpenses(){ return true; } // patron, caissier et magasinier peuvent enregistrer une dépense
function canDeleteSale(){ const r = currentRole(); return r==='patron' || r==='caissier'; }
function canRepayDebt(){ const r = currentRole(); return r==='patron' || r==='caissier'; }
function canDeleteExpense(){ return isPatron(); }
function canManageStoresAndDevices(){ return !isEmployeeMode || currentRole()==='patron'; }

function getDataOwnerUid(){
  if(isEmployeeMode) return employeeOwnerUid;
  return currentUser ? currentUser.uid : null;
}
function getActiveStoreIdForWrites(){
  if(isEmployeeMode && employeeRole !== 'patron') return employeeStoreId;
  return activeStoreId;
}

function emptyStoreData(){
  return {
    products: [], sales: [], lots: [], debts: [], expenses: [], activityLog: [], historyClearedAt: 0,
    customCatalog: [],
    suppliers: [], purchases: [], suppliersFeatureEnabled: false,
    stats: { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 }
  };
}

function loadStoreDataIntoWorkingArrays(storeData){
  const d = storeData || emptyStoreData();
  products = d.products || [];
  customCatalog = d.customCatalog || [];
  sales = d.sales || [];
  lots = d.lots || [];
  debts = d.debts || [];
  expenses = d.expenses || [];
  activityLog = d.activityLog || [];
  historyClearedAt = d.historyClearedAt || 0;
  suppliers = d.suppliers || [];
  purchases = d.purchases || [];
  suppliersFeatureEnabled = !!d.suppliersFeatureEnabled;
  stats = d.stats || { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 };
  if(typeof stats.totalExpenses !== 'number') stats.totalExpenses = 0;
  localSet('mombongo:products', JSON.stringify(products));
  localSet('mombongo:customCatalog', JSON.stringify(customCatalog));
  localSet('mombongo:sales', JSON.stringify(sales));
  localSet('mombongo:lots', JSON.stringify(lots));
  localSet('mombongo:debts', JSON.stringify(debts));
  localSet('mombongo:expenses', JSON.stringify(expenses));
  localSet('mombongo:activityLog', JSON.stringify(activityLog));
  localSet('mombongo:historyClearedAt', String(historyClearedAt));
  localSet('mombongo:suppliers', JSON.stringify(suppliers));
  localSet('mombongo:purchases', JSON.stringify(purchases));
  localSet('mombongo:suppliersFeatureEnabled', JSON.stringify(suppliersFeatureEnabled));
  localSet('mombongo:stats', JSON.stringify(stats));
  if(typeof updateHeaderSuppliersButtonVisibility === 'function') updateHeaderSuppliersButtonVisibility();
}

let lastSyncOk = true;
let lastSyncErrorMsg = '';
function updateSyncStatusUI(){
  const el = document.getElementById('t-sync-status');
  if(!el) return;
  if(lastSyncOk){
    el.textContent = dict[currentLang].syncOk || "Tes données sont synchronisées.";
    el.style.color = '';
  } else {
    el.textContent = (dict[currentLang].syncError || "⚠️ Échec de synchronisation :") + ' ' + lastSyncErrorMsg;
    el.style.color = 'var(--alert)';
  }
}

async function pushToCloud(){
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;
  // "sales", "products", "debts", "expenses", "suppliers", "purchases" et
  // "activityLog" ne sont plus inclus ici : ils se synchronisent séparément, par
  // élément, via saveSales()/saveProducts()/saveDebts()/saveExpenses()/
  // saveSuppliers()/savePurchases()/saveActivityLog() (sales-sync.js /
  // products-sync.js / debts-sync.js / expenses-sync.js / suppliers-sync.js /
  // purchases-sync.js / activityLog-sync.js — protégés par rôle, voir
  // firestore.rules). Ce qui reste ici (lots, stats, historyClearedAt,
  // customCatalog, suppliersFeatureEnabled) n'a ni le même historique qui grossit
  // sans fin, ni besoin d'une règle différente par rôle — voir la note en bas de
  // firestore.rules.
  storesDataCache[storeId] = { lots, stats, historyClearedAt, customCatalog, suppliersFeatureEnabled };
  try{
    const update = { updatedAt: Date.now(), storesData: { [storeId]: storesDataCache[storeId] } };
    if(!isEmployeeMode){
      update.stores = stores;
      update.activeStoreId = activeStoreId;
      update.rate = exchangeRate;
      update.currency = currentCurrency;
      update.email = currentUser.email || '';
      update.displayName = currentUser.displayName || '';
      // Le patron seul peut faire évoluer le palier (paiement) — un appareil employé
      // ne doit jamais pouvoir réécrire ces champs, même par erreur.
      update.userPlan = userPlan;
      update.userPlanStatus = userPlanStatus;
      update.userPlanTrialEndsAt = userPlanTrialEndsAt;
      update.userPlanExpiresAt = userPlanExpiresAt;
      update.userHasUsedBusinessTrial = userHasUsedBusinessTrial;
      update.pausedPlan = pausedPlan;
      update.pausedPlanStatus = pausedPlanStatus;
      update.pausedPlanTrialEndsAt = pausedPlanTrialEndsAt;
      update.pausedPlanExpiresAt = pausedPlanExpiresAt;
    } else if(employeeRole === 'patron'){
      // Appareil secondaire en rôle patron : mêmes droits que le compte principal
      // sur les boutiques et le taux de change (pas de profil Google à renvoyer ici).
      update.stores = stores;
      update.activeStoreId = activeStoreId;
      update.rate = exchangeRate;
      update.currency = currentCurrency;
      update.userPlan = userPlan;
      update.userPlanStatus = userPlanStatus;
      update.userPlanTrialEndsAt = userPlanTrialEndsAt;
      update.userPlanExpiresAt = userPlanExpiresAt;
      update.userHasUsedBusinessTrial = userHasUsedBusinessTrial;
      update.pausedPlan = pausedPlan;
      update.pausedPlanStatus = pausedPlanStatus;
      update.pausedPlanTrialEndsAt = pausedPlanTrialEndsAt;
      update.pausedPlanExpiresAt = pausedPlanExpiresAt;
    }
    await db.collection('mombongo_users').doc(ownerUid).set(update, { merge: true });
    lastSyncOk = true;
    updateSyncStatusUI();
  }catch(e){
    console.error('Erreur synchronisation cloud', e);
    lastSyncOk = false;
    lastSyncErrorMsg = e.code || e.message || String(e);
    updateSyncStatusUI();
  }
}

function applyDocData(data){
  userPlan = data.userPlan || 'simple';
  userPlanStatus = data.userPlanStatus || 'free';
  userPlanTrialEndsAt = data.userPlanTrialEndsAt || null;
  userPlanExpiresAt = data.userPlanExpiresAt || null;
  userHasUsedBusinessTrial = !!data.userHasUsedBusinessTrial;
  pausedPlan = data.pausedPlan || null;
  pausedPlanStatus = data.pausedPlanStatus || null;
  pausedPlanTrialEndsAt = data.pausedPlanTrialEndsAt || null;
  pausedPlanExpiresAt = data.pausedPlanExpiresAt || null;
  planDataLoaded = true;
  if(typeof savePlanToCache === 'function') savePlanToCache();
  if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
      if(typeof enforceSupplierFeatureForPlan === 'function') enforceSupplierFeatureForPlan();
  // Revérifie la fenêtre J-5 avec les valeurs qui font foi (Firestore) — le cache local
  // utilisé au tout premier rendu pouvait être périmé (ex. palier changé depuis un
  // autre appareil, ou activé manuellement côté Firestore après un paiement).
  if(typeof checkPlanExpiryLive === 'function') checkPlanExpiryLive();
  if(data.rate){ const parsedRate = parseFloat(data.rate); if(parsedRate > 0) exchangeRate = parsedRate; }
  if(data.currency) currentCurrency = data.currency;
  storesDataCache = data.storesData || {};

  // Récupération : les versions précédentes de l'app pouvaient écrire par erreur
  // un champ littéral "storesData.<id>" (avec un point dans le nom) au lieu d'un
  // objet imbriqué. On récupère ces données si elles existent, pour ne rien perdre.
  Object.keys(data).forEach(key=>{
    if(key.indexOf('storesData.') === 0){
      const legacyStoreId = key.slice('storesData.'.length);
      if(!storesDataCache[legacyStoreId]){
        storesDataCache[legacyStoreId] = data[key];
      }
    }
  });

  if(data.stores && data.stores.length){
    stores = data.stores;
  } else {
    // Migration d'un ancien compte mono-boutique
    const legacyId = 'store_default';
    stores = [{ id: legacyId, name: currentLang==='fr' ? 'Boutique principale' : (dict[currentLang].storesTitle), createdAt: Date.now() }];
    storesDataCache[legacyId] = {
      products: data.products || [], sales: data.sales || [], lots: data.lots || [],
      debts: data.debts || [], expenses: data.expenses || [], activityLog: data.activityLog || [],
      stats: data.stats || { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 }
    };
    data.activeStoreId = legacyId;
  }

  if(isEmployeeMode && employeeRole !== 'patron'){
    // Caissier ou magasinier : figé sur la boutique reçue au moment du couplage par code.
    if(!storesDataCache[employeeStoreId]) storesDataCache[employeeStoreId] = emptyStoreData();
    loadStoreDataIntoWorkingArrays(storesDataCache[employeeStoreId]);
    if(typeof attachSalesListener === 'function') attachSalesListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachProductsListener === 'function') attachProductsListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachDebtsListener === 'function') attachDebtsListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachExpensesListener === 'function') attachExpensesListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachSuppliersListener === 'function') attachSuppliersListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachPurchasesListener === 'function') attachPurchasesListener(getDataOwnerUid(), employeeStoreId);
    if(typeof attachActivityLogListener === 'function') attachActivityLogListener(getDataOwnerUid(), employeeStoreId);
  } else {
    // Propriétaire réel, OU appareil secondaire connecté en rôle "patron" (aucune
    // restriction pour ce cas, comme demandé) : accès dynamique à la boutique active.
    activeStoreId = data.activeStoreId && stores.find(s=>s.id===data.activeStoreId) ? data.activeStoreId : stores[0].id;
    if(!storesDataCache[activeStoreId]) storesDataCache[activeStoreId] = emptyStoreData();
    loadStoreDataIntoWorkingArrays(storesDataCache[activeStoreId]);
    if(typeof attachSalesListener === 'function') attachSalesListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachProductsListener === 'function') attachProductsListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachDebtsListener === 'function') attachDebtsListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachExpensesListener === 'function') attachExpensesListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachSuppliersListener === 'function') attachSuppliersListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachPurchasesListener === 'function') attachPurchasesListener(getDataOwnerUid(), activeStoreId);
    if(typeof attachActivityLogListener === 'function') attachActivityLogListener(getDataOwnerUid(), activeStoreId);
  }

  // Le taux de change et la devise choisis par le patron doivent s'afficher pareil
  // sur TOUS les appareils liés (patron secondaire, caissier, magasinier), pas
  // seulement sur le compte Google principal.
  localSet('mombongo:rate', String(exchangeRate));
  localSet('mombongo:currency', currentCurrency);
  document.getElementById('in-rate').value = exchangeRate;
  setCurrency(currentCurrency);
}

async function handlePostLogin(){
  if(!cloudEnabled || !db || !currentUser) return;
  try{
    const doc = await db.collection('mombongo_users').doc(currentUser.uid).get();
    if(doc.exists){
      applyDocData(doc.data());
      await archiveOldData();
      await pushToCloud();
      showToast(currentLang==='fr' ? "Données récupérées depuis ton compte" : "Ba données ezongi");
    } else {
      userPlan = 'simple'; userPlanStatus = 'free'; userPlanTrialEndsAt = null; userPlanExpiresAt = null;
      userHasUsedBusinessTrial = false;
      pausedPlan = null; pausedPlanStatus = null; pausedPlanTrialEndsAt = null; pausedPlanExpiresAt = null;
      planDataLoaded = true;
      if(typeof savePlanToCache === 'function') savePlanToCache();
      if(typeof enforceAllowedCurrencyForPlan === 'function') enforceAllowedCurrencyForPlan();
      if(typeof enforceSupplierFeatureForPlan === 'function') enforceSupplierFeatureForPlan();
      const legacyId = 'store_default';
      stores = [{ id: legacyId, name: dict[currentLang].storesTitle, createdAt: Date.now() }];
      activeStoreId = legacyId;
      storesDataCache = { [legacyId]: { products, sales, lots, debts, expenses, stats } };
      await db.collection('mombongo_users').doc(currentUser.uid).set({
        stores, activeStoreId, storesData: storesDataCache, rate: exchangeRate, currency: currentCurrency,
        email: currentUser.email || '', displayName: currentUser.displayName || '', updatedAt: Date.now(),
        userPlan, userPlanStatus, userPlanTrialEndsAt, userPlanExpiresAt, userHasUsedBusinessTrial,
        pausedPlan, pausedPlanStatus, pausedPlanTrialEndsAt, pausedPlanExpiresAt
      }, { merge: true });
      const pendingRef = localStorage.getItem('mombongo:pendingRef');
      if(pendingRef && pendingRef !== currentUser.uid){
        try{
          await db.collection('referrals').doc(currentUser.uid).set({
            referrerUid: pendingRef,
            referredUid: currentUser.uid,
            timestamp: Date.now()
          });
        }catch(e){ console.error('Erreur enregistrement parrainage', e); }
      }
      // La promo "50 places par palier" (voir debts-expenses-alerts.js) ne se joue plus
      // ici : elle se tente au moment où le patron choisit explicitement Business ou Pro
      // sur l'écran "Choisis ton profil" qui s'affiche juste après (voir
      // maybeShowPlanOnboarding() plus bas et choosePlanOnboarding() dans
      // plan-onboarding.js) — c'est ce choix qui détermine dans quelle catégorie (et donc
      // quel compteur de 50 places) tenter sa chance.
      showToast(currentLang==='fr' ? "Compte connecté, données sauvegardées" : "Compte ekangami");
    }
  }catch(e){
    console.error('Erreur récupération cloud', e);
    showToast('Erreur données : ' + (e.code || e.message || e));
  }
  localStorage.removeItem('mombongo:pendingRef');
  renderAccountUI();
  renderStoresList();
  // Pas de render() ici volontairement : à ce stade, applyDocData() vient de remettre
  // products/sales/debts/expenses/activityLog/suppliers/purchases à vide en mémoire
  // (ces données ne vivent plus dans le document principal, voir loadStoreDataIntoWorkingArrays)
  // — un render() ici peindrait donc un flash "Aucun produit" avant que
  // attachSalesListener/attachProductsListener/etc. (déjà lancés dans applyDocData) ne
  // livrent les vraies données un instant plus tard, chacun avec son propre render().
  // Le dernier affichage à l'écran (basé sur le cache local, déjà correct) reste donc
  // visible sans interruption jusqu'à ce que les vraies données arrivent.
  attachRealtimeListener(currentUser.uid);
  if(notificationsSupported() && Notification.permission === 'granted') registerFcmToken();
  loadReferralStatus();
}

function attachRealtimeListener(ownerUid){
  if(!cloudEnabled || !db) return;
  if(unsubscribeListener) { unsubscribeListener(); unsubscribeListener = null; }
  employeeSyncReady = false;
  unsubscribeListener = db.collection('mombongo_users').doc(ownerUid).onSnapshot((doc)=>{
    if(!doc.exists) return;
    applyDocData(doc.data());
    if(isEmployeeMode) employeeSyncReady = true;
    renderAccountUI();
    renderStoresList();
    renderDevicesList();
    render();
  }, (e)=>{
    console.error('Erreur écoute temps réel', e);
    if(isEmployeeMode && (e.code === 'permission-denied')){
      // Le patron a retiré cet appareil (ou l'a supprimé de son compte) : on nettoie localement.
      leaveDeviceCleanup();
      renderAccountUI();
      render();
      showToast(dict[currentLang].deviceRemoved);
    }
  });
}

/* ---------- Boutiques ---------- */

async function renameStore(storeId){
  const t = dict[currentLang];
  const store = stores.find(s=>s.id===storeId);
  if(!store) return;
  const newName = window.prompt(t.renameStorePrompt, store.name);
  if(newName === null) return; // annulé
  const trimmed = newName.trim();
  if(!trimmed || trimmed === store.name) return;
  store.name = trimmed;
  await pushToCloud();
  renderStoresList();
  render();
  showToast(t.storeRenamed);
}

async function editStorePhone(storeId){
  const t = dict[currentLang];
  const store = stores.find(s=>s.id===storeId);
  if(!store) return;
  const newPhone = window.prompt(t.storePhonePrompt, store.phone || '');
  if(newPhone === null) return; // annulé
  const trimmed = newPhone.trim();
  if(trimmed === (store.phone || '')) return;
  store.phone = trimmed;
  await pushToCloud();
  renderStoresList();
  showToast(t.storePhoneUpdated);
}

async function switchStore(storeId){
  if(!canManageStoresAndDevices() || storeId === activeStoreId) return;
  await pushToCloud(); // sauvegarde la boutique quittée
  activeStoreId = storeId;
  if(!storesDataCache[storeId]) storesDataCache[storeId] = emptyStoreData();
  loadStoreDataIntoWorkingArrays(storesDataCache[storeId]);
  if(typeof attachSalesListener === 'function') attachSalesListener(getDataOwnerUid(), storeId);
  if(typeof attachProductsListener === 'function') attachProductsListener(getDataOwnerUid(), storeId);
  await pushToCloud(); // persiste activeStoreId
  renderStoresList();
  render();
  showToast(dict[currentLang].storeSwitched);
}

let newStoreType = 'boutique';
function setNewStoreType(type){
  newStoreType = type;
  document.querySelectorAll('#store-type-row .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.type===type));
}
function openNewStoreSheet(){
  if(!isFeatureUnlocked('multiStore')){ closeAccountSheet(); openLimitSheet('stores'); return; }
  document.getElementById('in-store-name').value = '';
  setNewStoreType('boutique');
  document.getElementById('new-store-overlay').classList.add('open');
}
function closeNewStoreSheet(){
  document.getElementById('new-store-overlay').classList.remove('open');
}
async function confirmAddStore(){
  if(!isFeatureUnlocked('multiStore')){ closeNewStoreSheet(); openLimitSheet('stores'); return; }
  const name = document.getElementById('in-store-name').value.trim();
  if(!name){ showToast(currentLang==='fr' ? "Indique un nom de boutique" : "Tia nkombo ya boutique"); return; }
  const id = 'store_' + Date.now();
  stores.push({ id, name, type: newStoreType, createdAt: Date.now() });
  storesDataCache[id] = emptyStoreData();
  await pushToCloud(); // sauvegarde la boutique courante avant de basculer
  activeStoreId = id;
  loadStoreDataIntoWorkingArrays(storesDataCache[id]);
  await pushToCloud();
  closeNewStoreSheet();
  renderStoresList();
  render();
  showToast(dict[currentLang].storeAdded);
}

async function deleteStore(storeId){
  const t = dict[currentLang];
  if(stores.length <= 1){ showToast(t.cantDeleteLastStore); return; }
  const store = stores.find(s=>s.id===storeId);
  if(!store) return;
  if(!window.confirm(`${t.confirmDeleteStore}\n"${store.name}"`)) return;

  const wasActive = storeId === activeStoreId;
  stores = stores.filter(s=>s.id!==storeId);
  delete storesDataCache[storeId];

  if(wasActive){
    activeStoreId = stores[0].id;
    if(!storesDataCache[activeStoreId]) storesDataCache[activeStoreId] = emptyStoreData();
    loadStoreDataIntoWorkingArrays(storesDataCache[activeStoreId]);
  }

  try{
    const ownerUid = getDataOwnerUid();
    if(cloudEnabled && db && ownerUid){
      await db.collection('mombongo_users').doc(ownerUid).set({
        stores, activeStoreId,
        storesData: { [storeId]: firebase.firestore.FieldValue.delete() },
        updatedAt: Date.now()
      }, { merge: true });
    }
  }catch(e){ console.error('Erreur suppression boutique', e); }

  renderStoresList();
  render();
  showToast(t.storeDeleted);
}

/* ---------- Appareils & rôles (PIN de couplage) ---------- */
function openDevicesSheet(){
  document.getElementById('devices-overlay').classList.add('open');
  renderDevicesList();
}
function closeDevicesSheet(){
  document.getElementById('devices-overlay').classList.remove('open');
}
async function renameDevice(deviceUid, btnEl){
  const t = dict[currentLang];
  const currentName = btnEl ? btnEl.dataset.name : '';
  const newName = window.prompt(t.renameDevicePrompt, currentName);
  if(newName === null) return; // annulé
  const trimmed = newName.trim();
  if(trimmed === currentName) return;
  const ownerUid = getDataOwnerUid();
  try{
    await db.collection('mombongo_users').doc(ownerUid).collection('devices').doc(deviceUid).update({ name: trimmed });
    showToast(t.deviceRenamed);
    renderDevicesList();
  }catch(e){ console.error('Erreur renommage appareil', e); showToast('Erreur : ' + (e.code || e.message || e), 5000); }
}
async function removeDevice(deviceUid){
  const t = dict[currentLang];
  if(!window.confirm(t.confirmRemoveDevice)) return;
  const ownerUid = getDataOwnerUid();
  try{
    await db.collection('mombongo_users').doc(ownerUid).collection('devices').doc(deviceUid).delete();
    showToast(t.deviceRemoved);
    renderDevicesList();
  }catch(e){ console.error('Erreur suppression appareil', e); showToast('Erreur : ' + (e.code || e.message || e), 5000); }
}

function openGeneratePinSheet(){
  if(!isFeatureUnlocked('multiDevice')){ closeAccountSheet(); openLimitSheet('devices'); return; }
  selectedGenerateRole = 'caissier';
  document.querySelectorAll('.join-role-btn').forEach(b=>b.classList.toggle('active', b.dataset.role==='caissier'));
  document.getElementById('generate-pin-overlay').classList.add('open');
  generateNewPin();
  watchForDevicePairing();
}
function selectGenerateRole(role, btn){
  selectedGenerateRole = role;
  document.querySelectorAll('.join-role-btn').forEach(b=>b.classList.toggle('active', b===btn));
  // Un code déjà affiché reste lié au rôle avec lequel il a été généré : on en
  // génère un nouveau tout de suite pour que le code affiché corresponde
  // toujours exactement au rôle actuellement sélectionné à l'écran.
  generateNewPin();
}
function closeGeneratePinSheet(){
  document.getElementById('generate-pin-overlay').classList.remove('open');
  if(pinCountdownTimer){ clearInterval(pinCountdownTimer); pinCountdownTimer = null; }
  stopWatchingDevicePairing();
}

// Surveille en direct l'arrivée d'un nouvel appareil pendant que le code de couplage est affiché.
// Dès qu'un appareil rejoint (document ajouté dans /devices), on ferme automatiquement les sheets
// et on retourne à un accueil à jour — sans que le patron ait besoin de fermer manuellement.
function watchForDevicePairing(){
  stopWatchingDevicePairing();
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  let firstSnapshot = true;
  pairingWaitUnsub = db.collection('mombongo_users').doc(ownerUid).collection('devices')
    .onSnapshot(snap=>{
      if(firstSnapshot){
        // Le tout premier instantané ne fait qu'établir l'état de départ (appareils déjà connectés),
        // ce n'est pas une nouvelle connexion.
        firstSnapshot = false;
        return;
      }
      const deviceAdded = snap.docChanges().some(ch => ch.type === 'added');
      if(deviceAdded) onDevicePaired();
    }, e=>console.error('Erreur écoute couplage appareil', e));
}
function stopWatchingDevicePairing(){
  if(pairingWaitUnsub){ pairingWaitUnsub(); pairingWaitUnsub = null; }
}
function onDevicePaired(){
  stopWatchingDevicePairing();
  if(pinCountdownTimer){ clearInterval(pinCountdownTimer); pinCountdownTimer = null; }
  document.getElementById('generate-pin-overlay').classList.remove('open');
  closeAccountSheet();
  renderDevicesList();
  render();
  showToast(dict[currentLang].deviceConnectedSuccess);
}
let currentPin = null;
let currentPinExpiresAt = 0;
async function generateNewPin(){
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid || !canManageStoresAndDevices()) return;
  if(pinCountdownTimer){ clearInterval(pinCountdownTimer); pinCountdownTimer = null; }
  if(currentPin){
    try{ await db.collection('pairing_codes').doc(currentPin).delete(); }catch(e){}
  }
  const pin = String(Math.floor(10000 + Math.random() * 90000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  try{
    await db.collection('pairing_codes').doc(pin).set({
      ownerUid: ownerUid, storeId: activeStoreId, role: selectedGenerateRole, createdAt: Date.now(), expiresAt
    });
    currentPin = pin;
    currentPinExpiresAt = expiresAt;
    document.getElementById('pin-display').textContent = pin;
    pinCountdownTimer = setInterval(updatePinCountdown, 1000);
    updatePinCountdown();
  }catch(e){
    console.error('Erreur génération code', e);
    const hint = (e.code === 'permission-denied')
      ? " — les règles de sécurité Firestore ne sont probablement pas publiées."
      : "";
    showToast('Erreur code : ' + (e.code || e.message || e) + hint, 5000);
  }
}
function updatePinCountdown(){
  const t = dict[currentLang];
  const remaining = Math.max(0, Math.floor((currentPinExpiresAt - Date.now())/1000));
  const mm = Math.floor(remaining/60), ss = remaining%60;
  document.getElementById('pin-countdown').textContent = `${t.pinExpiresIn} ${mm}:${String(ss).padStart(2,'0')}`;
  if(remaining <= 0 && pinCountdownTimer){ clearInterval(pinCountdownTimer); pinCountdownTimer = null; }
}

function openJoinWithCodeSheet(){
  document.getElementById('in-join-pin').value = '';
  document.getElementById('in-join-device-name').value = '';
  document.getElementById('join-with-code-overlay').classList.add('open');
}
function closeJoinWithCodeSheet(){
  document.getElementById('join-with-code-overlay').classList.remove('open');
}
async function confirmJoinWithPin(){
  const t = dict[currentLang];
  const pin = document.getElementById('in-join-pin').value.trim();
  const name = document.getElementById('in-join-device-name').value.trim();
  if(!pin || pin.length < 4){ showToast(t.deviceLinkError); return; }
  // Le prénom du caissier/magasinier est désormais obligatoire à chaque connexion d'un
  // nouvel appareil : sans ça, "Caissier" tout court dans le journal d'activité ne permet
  // pas de savoir LEQUEL des 3-4 caissiers a fait quoi, et n'importe qui peut nier.
  if(!name){ showToast(t.deviceNameRequiredError || t.deviceLinkError); return; }
  if(!cloudEnabled || !db){ showToast('Erreur de connexion'); return; }
  try{
    if(!firebase.auth().currentUser){
      await firebase.auth().signInAnonymously();
    }
    const codeDoc = await db.collection('pairing_codes').doc(pin).get();
    if(!codeDoc.exists){ showToast(t.deviceLinkError); return; }
    const codeData = codeDoc.data();
    if(codeData.expiresAt < Date.now()){ showToast(t.pinExpired); return; }
    const myUid = firebase.auth().currentUser.uid;
    // Le rôle vient du code lui-même (choisi par le patron en le générant), jamais d'un
    // choix fait ici — "usedPin" permet aux règles Firestore de vérifier que ce rôle
    // correspond bien à celui du code utilisé, avant d'accepter la création du document.
    const grantedRole = codeData.role || 'caissier';
    await db.collection('mombongo_users').doc(codeData.ownerUid).collection('devices').doc(myUid).set({
      role: grantedRole, name: name || '', storeId: codeData.storeId, addedAt: Date.now(), usedPin: pin
    });
    try{ await db.collection('pairing_codes').doc(pin).delete(); }catch(e){}

    isEmployeeMode = true;
    employeeOwnerUid = codeData.ownerUid;
    employeeRole = grantedRole;
    employeeStoreId = codeData.storeId;
    employeeDeviceName = name || '';
    localSet('mombongo:employeeOwnerUid', employeeOwnerUid);
    localSet('mombongo:employeeRole', employeeRole);
    localSet('mombongo:employeeStoreId', employeeStoreId);
    localSet('mombongo:employeeDeviceName', employeeDeviceName);

    closeJoinWithCodeSheet();
    closeAccountSheet();
    showToast(t.deviceLinked);
    renderAccountUI();
    attachRealtimeListener(employeeOwnerUid);
    if(notificationsSupported() && Notification.permission === 'granted') registerFcmToken();
  }catch(e){
    console.error('Erreur rejoindre', e);
    showToast('Erreur : ' + (e.code || e.message || e), 5000);
  }
}

function leaveDeviceCleanup(){
  if(unsubscribeListener){ unsubscribeListener(); unsubscribeListener = null; }
  if(typeof detachSalesListener === 'function') detachSalesListener();
  if(typeof detachProductsListener === 'function') detachProductsListener();
  syncedSaleIds = new Set();
  syncedProductsSnapshot = {};
  employeeSyncReady = false;
  isEmployeeMode = false;
  employeeOwnerUid = null; employeeRole = null; employeeStoreId = null; employeeDeviceName = '';
  localStorage.removeItem('mombongo:employeeOwnerUid');
  localStorage.removeItem('mombongo:employeeRole');
  localStorage.removeItem('mombongo:employeeStoreId');
  localStorage.removeItem('mombongo:employeeDeviceName');
  products = []; sales = []; lots = []; debts = []; expenses = []; activityLog = [];
  stats = { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 };
  localSet('mombongo:products', '[]'); localSet('mombongo:sales', '[]'); localSet('mombongo:lots', '[]');
  localSet('mombongo:debts', '[]'); localSet('mombongo:expenses', '[]'); localSet('mombongo:activityLog', '[]');
  localSet('mombongo:stats', JSON.stringify(stats));
}

function confirmLeaveDevice(){
  const t = dict[currentLang];
  if(!window.confirm(t.confirmLeaveDevice)) return;
  removeFcmToken();
  leaveDeviceCleanup();
  closeAccountSheet();
  renderAccountUI();
  render();
}

function initEmployeeModeIfAny(){
  const ownerUidResult = localGet('mombongo:employeeOwnerUid');
  if(!ownerUidResult || !ownerUidResult.value) return false;
  isEmployeeMode = true;
  employeeOwnerUid = ownerUidResult.value;
  const roleResult = localGet('mombongo:employeeRole');
  employeeRole = (roleResult && roleResult.value) || 'caissier';
  const storeIdResult = localGet('mombongo:employeeStoreId');
  employeeStoreId = storeIdResult ? storeIdResult.value : null;
  const deviceNameResult = localGet('mombongo:employeeDeviceName');
  employeeDeviceName = (deviceNameResult && deviceNameResult.value) || '';
  if(cloudEnabled){
    firebase.auth().signInAnonymously().then(()=>{
      if(notificationsSupported() && Notification.permission === 'granted') registerFcmToken();
    }).catch(e=>console.error('Erreur connexion anonyme', e));
  }
  renderAccountUI();
  attachRealtimeListener(employeeOwnerUid);
  hideBootLoading();
  return true;
}

// Écran de chargement au démarrage/rechargement : reste affiché jusqu'à ce que Firebase
// Révèle l'app (voir data-catalog.js, fin de loadData(), qui l'appelle dès que les
// données en cache sont affichées — plus rapide que d'attendre Auth). Appelée aussi ici
// une fois Auth réellement résolu (idempotente, ne fait rien la 2e fois) pour couvrir le
// mode employé (compte anonyme, jamais traité par loadData()) et servir de filet de
// sécurité si loadData() n'a pas pu tourner normalement.
function hideBootLoading(){
  const el = document.getElementById('boot-loading-overlay');
  if(el) el.style.display = 'none';
  if(typeof maybeShowPlanOnboarding === 'function') maybeShowPlanOnboarding();
}
// Filet de sécurité ultime : si pour une raison quelconque ni loadData() ni Auth n'ont
// démasqué l'app (script cassé, exception inattendue...), on ne laisse jamais l'écran de
// chargement bloqué pour de bon.
setTimeout(hideBootLoading, 6000);
if(!cloudEnabled){
  // Rien à attendre côté cloud : l'app doit rester utilisable hors-ligne sans délai.
  authResolved = true;
  hideBootLoading();
}

if(cloudEnabled){
  firebase.auth().getRedirectResult().then((result)=>{
    if(result && result.user){
      showToast(currentLang==='fr' ? "Connexion réussie, chargement..." : "Ekangami, ezali kotia...");
    }
  }).catch((e)=>{
    console.error('Erreur résultat de redirection', e);
    showToast('Erreur redirection : ' + (e.code || e.message || e));
  });
  const wasEmployeeMode = initEmployeeModeIfAny();
  firebase.auth().onAuthStateChanged((user)=>{
    if(user && user.isAnonymous){
      // Appareil employé : ne pas traiter comme un compte Google
      hideBootLoading();
      return;
    }
    currentUser = user;
    authResolved = true;
    renderAccountUI();
    if(user) handlePostLogin();
    hideBootLoading();
    if(typeof maybeScheduleAuthGate === 'function') maybeScheduleAuthGate();
  });
}

// Vérification périodique de l'expiration du palier en temps réel (essai Business à 14j,
// abonnements Business/Pro) — voir plans.js. Une resynchro Firestore ne se déclenche que
// si le document change sur le serveur, donc sans ça un abonnement qui expire pendant
// qu'une session reste ouverte ne serait jamais détecté avant un rechargement manuel.
// Pas d'appel immédiat ICI : ce fichier s'exécute avant data-catalog.js (voir l'ordre des
// balises <script> dans index.html), donc planDataLoaded serait encore à false à ce
// stade — le premier appel utile est fait depuis loadData() elle-même.
setInterval(checkPlanExpiryLive, 60000);
// Revérifie aussi dès que l'app revient au premier plan (téléphone déverrouillé après une veille
// qui a duré plus longtemps que prévu) — plus réactif que d'attendre le prochain intervalle.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible'){
    checkPlanExpiryLive();
  }
});

function setLang(lang){
  currentLang = lang;
  document.getElementById('btn-fr').classList.toggle('active', lang==='fr');
  document.getElementById('btn-ln').classList.toggle('active', lang==='ln');
  document.getElementById('btn-sw').classList.toggle('active', lang==='sw');
  applyTranslations();
  render();
}

function setCurrency(cur){
  if(cur === 'usd' && !getAllowedCurrencies().includes('usd')){
    openLimitSheet('currency');
    return;
  }
  currentCurrency = cur;
  document.getElementById('btn-usd').classList.toggle('active', cur==='usd');
  document.getElementById('btn-cdf').classList.toggle('active', cur==='cdf');
  document.getElementById('rate-fields-wrap').style.display = (cur==='cdf') ? 'block' : 'none';
  localSet('mombongo:currency', cur);
  updateAddFieldLabels();
  render();
}

async function updateRate(){
  const val = parseFloat(document.getElementById('in-rate').value);
  if(val > 0){
    exchangeRate = val;
    localSet('mombongo:rate', String(val));
    updateAddFieldLabels();
    render();
    if(document.getElementById('sell-overlay').classList.contains('open')) updateSellPreview();
  }
}

function formatMoney(amount){
  if(currentCurrency === 'usd'){
    return amount.toFixed(2) + ' $';
  } else {
    return Math.round(amount * exchangeRate).toLocaleString('fr-FR') + ' FC';
  }
}

// Empêche l'injection HTML/JS via un nom de produit, de client, une description de
// dépense, etc. (ces textes sont saisis par n'importe quel appareil/rôle puis
// réaffichés chez le patron et les autres employés).
function escapeHtml(str){
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateAddFieldLabels(){
  const t = dict[currentLang];
  document.getElementById('t-buy').textContent = t.buy;
  document.getElementById('t-sell').textContent = t.sell;
  document.getElementById('t-currency-hint').textContent = t.currencyHint;
  document.getElementById('t-mode-simple').textContent = t.modeSimple;
  document.getElementById('t-mode-carton').textContent = t.modeCarton;
  document.getElementById('t-mode-sac').textContent = t.modeSac;
  document.getElementById('t-carton-name').textContent = t.cartonName;
  document.getElementById('t-carton-qty').textContent = t.cartonQty;
  document.getElementById('t-carton-buy').textContent = t.cartonBuy;
  document.getElementById('t-carton-sell').textContent = t.cartonSell;
  document.getElementById('t-carton-threshold').textContent = t.cartonThreshold;
  document.getElementById('t-carton-hint').textContent = t.cartonHint;
  document.getElementById('t-sac-name').textContent = t.sacName;
  document.getElementById('t-sac-unit').textContent = t.sacUnitLabel || t.unitFieldLabel;
  document.getElementById('t-sac-buy').textContent = t.sacBuy;
  document.getElementById('t-sac-hint').textContent = t.sacHint;
  document.getElementById('t-add-mesurette').textContent = t.addMesurette;
  document.getElementById('t-sac-generic-hint').textContent = t.sacGenericHint || document.getElementById('t-sac-generic-hint').textContent;
  // t-sac-threshold / t-sac-generic-sell / t-sac-generic-qty sont mis à jour dynamiquement
  // par onSacUnitChange() selon l'unité choisie (mesurette, kg, L, m...) — appelé quand on
  // ouvre l'onglet "Sac" ou qu'on change d'unité, pas ici (sinon ça ajouterait des lignes
  // de mesurette en arrière-plan même quand le formulaire n'est pas ouvert).
  if(document.getElementById('sac-mesurette-group') && document.getElementById('mode-sac-fields').style.display !== 'none'){
    onSacUnitChange();
  } else {
    document.getElementById('t-sac-threshold').textContent = t.sacThreshold;
  }
  document.getElementById('in-buy').placeholder = '0.5';
  document.getElementById('in-sell').placeholder = '1';
}

function applyTranslations(){
  const t = dict[currentLang];
  updateAddFieldLabels();
  document.getElementById('t-history-btn').textContent = t.historyBtn;
  document.getElementById('t-history-title').textContent = t.historyTitle;
  document.getElementById('t-history-empty').textContent = t.historyEmpty;
  document.getElementById('t-clear-history').textContent = t.clearHistory;
  document.getElementById('t-cancel4').textContent = t.close;
  document.getElementById('t-appname').textContent = t.appname;
  document.getElementById('t-tagline').textContent = t.tagline;
  document.getElementById('t-boot-loading-text').textContent = t.bootLoadingText;
  document.getElementById('t-employee-plan-block-title').textContent = t.employeePlanBlockTitle;
  document.getElementById('t-employee-plan-block-body').textContent = t.employeePlanBlockBody;
  document.getElementById('t-seo-subtitle').textContent = t.seoSubtitle;
  document.getElementById('t-today').textContent = t.today;
  document.getElementById('t-profit-today').textContent = t.profitToday;
  document.getElementById('t-profit-total').textContent = t.profitTotal;
  document.getElementById('t-alerts').textContent = t.alerts;
  document.getElementById('t-alerts-prompt').textContent = t.alertsPrompt;
  document.getElementById('t-alerts-sheet-title').textContent = t.alertsTitle;
  document.getElementById('t-alerts-tab-stock').textContent = t.alertsTabStock;
  document.getElementById('t-alerts-tab-expired').textContent = t.alertsTabExpired;
  document.getElementById('t-alerts-tab-debts').textContent = t.alertsTabDebts;
  document.getElementById('t-alerts-tab-activity').textContent = t.alertsTabActivity;
  document.getElementById('t-alerts-sheet-empty').textContent = t.alertsSheetEmpty;
  document.getElementById('t-cancel10').textContent = t.close;
  document.getElementById('t-products-title').textContent = t.productsTitle;
  document.getElementById('t-favorites-tab').textContent = t.favoritesTab;
  document.getElementById('t-clear-multi-cart-btn').textContent = t.clearMultiCartBtn;
  document.getElementById('t-held-carts-title').textContent = t.heldCartsTitle;
  document.getElementById('t-cancel-held-carts').textContent = t.close;
  document.getElementById('t-privacy-link').textContent = t.privacyLink;
  document.getElementById('t-privacy-title').textContent = t.privacyTitle;
  document.getElementById('t-delete-account-title').textContent = t.deleteAccountTitle;
  document.getElementById('t-delete-account-desc').textContent = t.deleteAccountDesc;
  document.getElementById('t-delete-account-btn').textContent = t.deleteAccountBtn;
  document.getElementById('t-cancel-privacy').textContent = t.close;
  document.getElementById('t-delete-confirm-title').textContent = t.deleteConfirmTitle;
  document.getElementById('t-delete-confirm-desc').textContent = t.deleteConfirmDesc;
  document.getElementById('t-delete-confirm-label').textContent = (t.deleteConfirmLabel || '').replace('{word}', t.deleteConfirmWord);
  document.getElementById('t-delete-confirm-btn').textContent = t.deleteConfirmBtn;
  document.getElementById('t-delete-confirm-cancel').textContent = t.close;
  document.getElementById('t-authgate-login-title').textContent = t.authGateLoginTitle;
  document.getElementById('t-authgate-login-subtitle').textContent = t.authGateLoginSubtitle;
  document.getElementById('t-authgate-login-phone-label').textContent = t.authGateLoginPhoneLabel;
  document.getElementById('t-authgate-login-code-label').textContent = t.authGateLoginCodeLabel;
  if(!document.getElementById('t-authgate-login-btn').disabled) document.getElementById('t-authgate-login-btn').textContent = t.authGateLoginBtn;
  document.getElementById('t-authgate-no-account').textContent = t.authGateNoAccount;
  document.getElementById('t-authgate-signup-link').textContent = t.authGateSignupLink;
  document.getElementById('t-authgate-forgot').textContent = t.authGateForgot;
  document.getElementById('t-authgate-signup-title').textContent = t.authGateSignupTitle;
  document.getElementById('t-authgate-signup-subtitle').textContent = t.authGateSignupSubtitle;
  document.getElementById('t-authgate-signup-phone-label').textContent = t.authGateSignupPhoneLabel;
  document.getElementById('t-authgate-signup-code-label').textContent = t.authGateSignupCodeLabel;
  document.getElementById('t-authgate-signup-code2-label').textContent = t.authGateSignupCode2Label;
  if(!document.getElementById('t-authgate-signup-btn').disabled) document.getElementById('t-authgate-signup-btn').textContent = t.authGateSignupBtn;
  document.getElementById('t-authgate-have-account').textContent = t.authGateHaveAccount;
  document.getElementById('t-authgate-login-link').textContent = t.authGateLoginLink;
  document.getElementById('t-authgate-or').textContent = t.authGateOr;
  document.getElementById('t-authgate-google-btn').textContent = t.authGateGoogleBtn;
  document.getElementById('t-authgate-note').textContent = t.authGateNote;
  if(document.getElementById('privacy-overlay').classList.contains('open')){
    document.getElementById('privacy-content').innerHTML = t.privacyPolicyHtml || '';
  }
  if(typeof renderHeldCartsList === 'function' && document.getElementById('held-carts-overlay').classList.contains('open')){
    renderHeldCartsList();
  }
  document.getElementById('t-empty').textContent = t.empty;
  document.getElementById('t-no-results').textContent = t.noResults;
  document.getElementById('search-input').placeholder = t.searchPlaceholder;
  document.getElementById('t-add-btn').textContent = t.addBtnShort;
  document.getElementById('t-add-title').textContent = t.addTitle;
  document.getElementById('t-name').textContent = t.name;
  document.getElementById('t-buy').textContent = t.buy;
  document.getElementById('t-sell').textContent = t.sell;
  document.getElementById('t-qty').textContent = t.qty;
  document.getElementById('t-threshold').textContent = t.threshold;
  document.getElementById('t-save').textContent = t.save;
  document.getElementById('t-cancel').textContent = t.cancel;
  document.getElementById('sell-title').textContent = t.sellTitle;
  document.getElementById('t-sell-qty').textContent = t.sellQty;
  document.getElementById('t-total-label').textContent = t.total;
  document.getElementById('t-profit-label').textContent = t.profit;
  document.getElementById('t-confirm-sale').textContent = t.confirmSale;
  document.getElementById('t-cancel2').textContent = t.cancel;
  document.getElementById('t-rate-label').textContent = t.rateLabel;
  document.getElementById('t-expense-btn').textContent = t.expenseBtnShort;
  document.getElementById('t-expenses-label').textContent = t.expensesLabel;
  document.getElementById('t-debts-label').textContent = '💳 ' + t.debtsLabel;
  document.getElementById('t-credit-toggle').textContent = t.creditToggle;
  document.getElementById('t-backup-banner-title').textContent = t.backupBannerTitle;
  document.getElementById('t-backup-banner-text').textContent = t.backupBannerText;
  document.getElementById('t-backup-banner-btn').textContent = t.backupBannerBtn;
  document.getElementById('t-client-name').textContent = t.clientName;
  document.getElementById('t-client-phone').textContent = t.clientPhone;
  document.getElementById('t-due-date').textContent = t.dueDateField;
  document.getElementById('t-multi-toggle').textContent = t.multiToggle;
  document.getElementById('t-debt-amount').textContent = t.debtAmount;
  document.getElementById('t-debt-client-name').textContent = t.debtClientName;
  document.getElementById('t-debt-client-phone').textContent = t.debtClientPhone;
  document.getElementById('t-debt-due-date').textContent = t.debtDueDate;
  document.getElementById('t-debts-title').textContent = t.debtsTitle;
  document.getElementById('t-debts-empty').textContent = t.debtsEmpty;
  document.getElementById('t-cancel5').textContent = t.close;
  document.getElementById('t-repay-title').textContent = t.repayTitle;
  document.getElementById('t-repay-client').textContent = t.repayClientLabel;
  document.getElementById('t-repay-amount').textContent = t.repayAmountLabel;
  document.getElementById('t-confirm-repay').textContent = t.confirmRepayBtn;
  document.getElementById('t-cancel6').textContent = t.cancel;
  document.getElementById('t-expense-title').textContent = t.expenseTitle;
  document.getElementById('t-expense-desc').textContent = t.expenseDescLabel;
  document.getElementById('t-expense-amount').textContent = t.expenseAmountLabel;
  document.getElementById('t-confirm-expense').textContent = t.confirmExpenseBtn;
  document.getElementById('t-cancel7').textContent = t.cancel;
  document.getElementById('t-limit-title').textContent = t.limitTitle;
  document.getElementById('t-limit-desc').textContent = currentUser ? t.limitDesc : t.limitNeedsLoginDesc;
  document.getElementById('limit-whatsapp-link').textContent = currentUser ? t.limitUnlockBtn : t.limitLoginBtn;
  document.getElementById('t-cancel8').textContent = t.cancel;
  document.getElementById('t-period-day').textContent = t.periodDay;
  document.getElementById('t-period-week').textContent = t.periodWeek;
  document.getElementById('t-period-month').textContent = t.periodMonth;
  document.getElementById('t-period-custom').textContent = t.periodCustom;
  document.getElementById('t-period-from').textContent = t.periodFrom;
  document.getElementById('t-period-to').textContent = t.periodTo;
  document.getElementById('t-period-apply').textContent = t.periodApply;
  document.getElementById('t-summary-revenue').textContent = t.summaryRevenue;
  document.getElementById('t-summary-expenses').textContent = t.summaryExpenses;
  document.getElementById('t-summary-net').textContent = t.summaryNet;
  document.getElementById('t-expenses-history-title').textContent = t.expensesHistoryTitle;
  document.getElementById('t-expenses-history-empty').textContent = t.expensesHistoryEmpty;
  document.getElementById('t-cancel9').textContent = t.close;
  document.getElementById('t-expiry-toggle').textContent = t.expiryToggle;
  document.getElementById('t-expiry-date').textContent = t.expiryDateLabel;
  document.getElementById('t-expiry-toggle-carton').textContent = t.expiryToggle;
  document.getElementById('t-expiry-date-carton').textContent = t.expiryDateLabel;
  document.getElementById('t-expiry-toggle-sac').textContent = t.expiryToggle;
  document.getElementById('t-expiry-date-sac').textContent = t.expiryDateLabelSac;

  document.getElementById('t-download-apk-link').textContent = t.downloadApkLink;
  document.getElementById('t-guide-link').textContent = t.guideLink;
  document.getElementById('t-whatsapp-contact-link').textContent = t.whatsappContactLink;
  document.getElementById('t-install-apk-title').textContent = t.installApkTitle;
  document.getElementById('t-install-apk-desc').textContent = t.installApkDesc;
  document.getElementById('t-install-apk-accept').textContent = t.installApkAccept;
  document.getElementById('t-install-apk-decline').textContent = t.installApkDecline;
  document.getElementById('t-promo-popup-title').textContent = t.promoPopupTitle;
  document.getElementById('t-promo-popup-body').textContent = t.promoPopupBody;
  document.getElementById('t-promo-popup-accept').textContent = t.promoPopupAccept;
  document.getElementById('t-promo-popup-decline').textContent = t.promoPopupDecline;
  if(typeof initFirstUsersPromoBadge === 'function') initFirstUsersPromoBadge();
  document.getElementById('t-bulk-catalog-open-btn').textContent = t.bulkCatalogOpenBtn;
  document.getElementById('t-excel-import-open-btn').textContent = '📊 ' + (t.excelImportBtn || 'Importer depuis Excel/CSV');
  document.getElementById('t-excel-import-template-link').textContent = '📄 ' + (t.excelImportTemplateLink || 'Télécharger le modèle');
  document.getElementById('t-bulk-catalog-title').textContent = t.bulkCatalogTitle;
  document.getElementById('t-bulk-catalog-desc').textContent = t.bulkCatalogDesc;
  document.getElementById('t-bulk-default-sell').textContent = t.bulkDefaultSell;
  document.getElementById('t-bulk-default-qty').textContent = t.bulkDefaultQty;
  document.getElementById('t-bulk-default-threshold').textContent = t.bulkDefaultThreshold;
  document.getElementById('in-bulk-search').placeholder = t.bulkSearchPlaceholder;
  document.getElementById('t-bulk-cancel-btn').textContent = t.close;
  document.getElementById('t-bulk-select-all-btn').textContent = t.bulkSelectAllBtn;
  document.getElementById('t-bulk-deselect-all-btn').textContent = t.bulkDeselectAllBtn;
  if(typeof updateBulkCatalogCount === 'function') updateBulkCatalogCount();
  if(typeof updateBulkCatalogTypeLabel === 'function') updateBulkCatalogTypeLabel();
  document.getElementById('t-discover-btn').textContent = t.discoverBtn;
  document.getElementById('t-discover-title').textContent = t.discoverTitle;
  document.getElementById('t-discover-intro').textContent = t.discoverIntro;
  document.getElementById('t-discover-close-btn').textContent = t.close;
  if(typeof renderDiscoverContent === 'function') renderDiscoverContent();
  document.getElementById('t-barcode-scan-title').textContent = t.barcodeScanTitle;
  document.getElementById('t-barcode-scan-cancel').textContent = t.barcodeScanCancel;
  document.getElementById('t-barcode-confirm-title').textContent = t.barcodeConfirmTitle;
  document.getElementById('t-barcode-confirm-btn').textContent = t.barcodeConfirmBtn;
  document.getElementById('t-barcode-confirm-cancel').textContent = t.barcodeConfirmCancel;
  if(typeof updateBarcodeButtonsVisibility === 'function') updateBarcodeButtonsVisibility();

  document.getElementById('t-stores-title').textContent = t.storesTitle;
  document.getElementById('t-add-store-btn').textContent = t.addStoreBtn;
  document.getElementById('t-new-store-title').textContent = t.newStoreTitle;
  document.getElementById('t-store-name').textContent = t.storeNameLabel;
  document.getElementById('in-store-name').placeholder = t.storeNamePlaceholder;
  document.getElementById('t-store-type-label').textContent = t.storeTypeLabel;
  document.getElementById('t-store-type-boutique').textContent = t.storeTypeBoutique;
  document.getElementById('t-store-type-pharmacie').textContent = t.storeTypePharmacie;
  document.getElementById('t-store-type-quincaillerie').textContent = t.storeTypeQuincaillerie;
  document.getElementById('t-store-type-autre').textContent = t.storeTypeAutre;
  document.getElementById('t-store-type-hint').textContent = t.storeTypeHint;
  document.getElementById('t-save-store').textContent = t.saveStoreBtn;
  document.getElementById('t-cancel-new-store').textContent = t.cancel;

  document.getElementById('t-delete-sale-reason-title').textContent = t.deleteSaleReasonTitle;
  document.getElementById('t-delete-reason-error-btn').textContent = t.deleteReasonErrorBtn;
  document.getElementById('t-delete-reason-error-desc').textContent = t.deleteReasonErrorDesc;
  document.getElementById('t-delete-reason-stockout-btn').textContent = t.deleteReasonStockoutBtn;
  document.getElementById('t-delete-reason-stockout-desc').textContent = t.deleteReasonStockoutDesc;
  document.getElementById('t-cancel11').textContent = t.cancel;

  document.getElementById('t-edit-debt-title').textContent = t.editDebtTitle;
  document.getElementById('t-edit-debt-name-label').textContent = t.clientName;
  document.getElementById('t-edit-debt-phone-label').textContent = t.editDebtPhoneLabel;
  document.getElementById('t-edit-debt-due-label').textContent = t.editDebtDueLabel;
  document.getElementById('t-edit-debt-amount-label').textContent = t.editDebtAmountLabel;
  document.getElementById('t-edit-debt-save').textContent = t.save;
  document.getElementById('t-cancel12').textContent = t.cancel;


  document.getElementById('t-devices-title').textContent = t.devicesTitle;
  document.getElementById('t-devices-title2').textContent = t.devicesTitle;
  document.getElementById('t-devices-desc').textContent = t.devicesDesc;
  document.getElementById('t-add-device-btn').textContent = t.addDeviceBtn;
  document.getElementById('t-referral-title').textContent = t.referralTitle;
  document.getElementById('t-referral-desc').textContent = t.referralDesc;
  document.getElementById('t-referral-share-btn').textContent = t.referralShareBtn;
  document.getElementById('referral-claim-btn').textContent = t.referralClaimBtn;
  loadReferralStatus();
  document.getElementById('t-generate-device-btn2').textContent = t.addDeviceBtn;
  document.getElementById('t-join-with-code-btn').textContent = t.joinWithCodeBtn;
  document.getElementById('t-cancel-devices').textContent = t.close;
  document.getElementById('t-employee-connected-as').textContent = t.employeeConnectedAs;
  document.getElementById('t-leave-device-btn').textContent = t.leaveDeviceBtn;

  document.getElementById('t-generate-pin-title').textContent = t.generatePinTitle;
  document.getElementById('t-generate-pin-desc').textContent = t.generatePinDesc;
  document.getElementById('t-pin-regenerate').textContent = t.pinRegenerate;
  document.getElementById('t-cancel-pin').textContent = t.close;

  document.getElementById('t-enter-pin-title').textContent = t.enterPinTitle;
  document.getElementById('t-enter-pin-desc').textContent = t.enterPinDesc;
  document.getElementById('in-join-pin').placeholder = t.enterPinPlaceholder;
  document.getElementById('t-choose-role-title').textContent = t.chooseRoleTitle;
  document.getElementById('t-role-patron').textContent = t.rolePatron;
  document.getElementById('t-role-caissier').textContent = t.roleCaissier;
  document.getElementById('t-role-magasinier').textContent = t.roleMagasinier;
  document.getElementById('t-device-name').textContent = t.deviceNameLabel;
  document.getElementById('in-join-device-name').placeholder = t.deviceNamePlaceholder;
  document.getElementById('t-join-confirm-btn').textContent = t.joinConfirmBtn;
  document.getElementById('t-cancel-join').textContent = t.cancelJoin;

  document.getElementById('t-export-label').textContent = t.exportLabel;
  document.getElementById('t-export-format-pdf').textContent = t.exportFormatPdf;
  document.getElementById('t-export-format-excel').textContent = t.exportFormatExcel;
  document.getElementById('t-export-btn').textContent = t.exportBtn;

  document.getElementById('t-suppliers-header-btn').textContent = t.suppliersHeaderBtn;
  document.getElementById('t-suppliers-toggle-label').textContent = t.suppliersToggleLabel;
  document.getElementById('t-suppliers-toggle-desc').textContent = t.suppliersToggleDesc;
  document.getElementById('t-suppliers-title').textContent = t.suppliersTitle;
  document.getElementById('t-suppliers-total-label').textContent = t.suppliersTotalLabel;
  document.getElementById('t-add-supplier-btn').textContent = t.addSupplierBtn;
  document.getElementById('t-purchase-history-btn').textContent = t.purchaseHistoryBtn;
  document.getElementById('t-cancel-suppliers').textContent = t.close;
  document.getElementById('t-supplier-name-label').textContent = t.supplierNameLabel;
  document.getElementById('t-supplier-phone-label').textContent = t.supplierPhoneLabel;
  document.getElementById('t-supplier-form-save').textContent = t.supplierFormSave;
  document.getElementById('t-cancel-supplier-form').textContent = t.cancel;
  document.getElementById('t-record-purchase-title').textContent = t.recordPurchaseTitle;
  document.getElementById('t-purchase-supplier-label').textContent = t.purchaseSupplierLabel;
  document.getElementById('t-purchase-items-label').textContent = t.purchaseItemsLabel;
  document.getElementById('t-purchase-add-row').textContent = t.purchaseAddRow;
  document.getElementById('t-purchase-is-credit-label').textContent = t.purchaseIsCreditLabel;
  document.getElementById('t-purchase-paid-now-label').textContent = t.purchasePaidNowLabel;
  document.getElementById('t-purchase-due-label').textContent = t.purchaseDueLabel;
  document.getElementById('t-purchase-total-label').textContent = t.purchaseTotalLabel;
  document.getElementById('t-record-purchase-save').textContent = t.recordPurchaseSave;
  document.getElementById('t-cancel-record-purchase').textContent = t.cancel;
  document.getElementById('t-purchase-history-title').textContent = t.purchaseHistoryTitle;
  document.getElementById('t-cancel-purchase-history').textContent = t.close;
  document.getElementById('t-pay-supplier-title').textContent = t.paySupplierTitle;
  document.getElementById('t-pay-supplier-who-label').textContent = t.paySupplierWhoLabel;
  document.getElementById('t-pay-supplier-amount-label').textContent = t.paySupplierAmountLabel;
  document.getElementById('t-pay-supplier-save').textContent = t.paySupplierSave;
  document.getElementById('t-cancel-pay-supplier').textContent = t.cancel;
  document.getElementById('t-plan-section-title').textContent = t.planSectionTitle;
  document.getElementById('t-plan-switch-btn').textContent = t.planSwitchBtn;
  document.getElementById('t-plan-onb-title').textContent = t.planOnbTitle;
  document.getElementById('t-plan-onb-subtitle').textContent = t.planOnbSubtitle;
  document.getElementById('t-plan-onb-simple-badge').textContent = t.planOnbSimpleBadge;
  document.getElementById('t-plan-onb-simple-title').textContent = t.planOnbSimpleTitle;
  document.getElementById('t-plan-onb-simple-desc').textContent = t.planOnbSimpleDesc;
  document.getElementById('t-plan-onb-simple-btn').textContent = t.planOnbSimpleBtn;
  document.getElementById('t-plan-onb-business-badge').textContent = t.planOnbBusinessBadge;
  document.getElementById('t-plan-onb-business-title').textContent = t.planOnbBusinessTitle;
  document.getElementById('t-plan-onb-business-desc').textContent = t.planOnbBusinessDesc;
  document.getElementById('t-plan-onb-business-btn').textContent = t.planOnbBusinessBtn;
  document.getElementById('t-plan-onb-pro-badge').textContent = t.planOnbProBadge;
  document.getElementById('t-plan-onb-pro-title').textContent = t.planOnbProTitle;
  document.getElementById('t-plan-onb-pro-desc').textContent = t.planOnbProDesc;
  document.getElementById('t-plan-onb-pro-btn').textContent = t.planOnbProBtn;
  document.getElementById('t-plan-onb-skip').textContent = t.planOnbSkip;
  document.getElementById('t-plan-pro-confirm-title').textContent = t.planProConfirmTitle;
  document.getElementById('t-plan-pro-confirm-body').textContent = t.planProConfirmBody;
  document.getElementById('t-plan-pro-confirm-yes').textContent = t.planProConfirmYes;
  document.getElementById('t-plan-pro-confirm-no').textContent = t.planProConfirmNo;
}

