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
let selectedJoinRole = 'patron';

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
  localSet('mombongo:stats', JSON.stringify(stats));
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
  storesDataCache[storeId] = { products, sales, lots, debts, expenses, activityLog, stats, historyClearedAt, customCatalog };
  try{
    const update = { updatedAt: Date.now(), storesData: { [storeId]: storesDataCache[storeId] } };
    if(!isEmployeeMode){
      update.stores = stores;
      update.activeStoreId = activeStoreId;
      update.rate = exchangeRate;
      update.currency = currentCurrency;
      update.email = currentUser.email || '';
      update.displayName = currentUser.displayName || '';
    } else if(employeeRole === 'patron'){
      // Appareil secondaire en rôle patron : mêmes droits que le compte principal
      // sur les boutiques et le taux de change (pas de profil Google à renvoyer ici).
      update.stores = stores;
      update.activeStoreId = activeStoreId;
      update.rate = exchangeRate;
      update.currency = currentCurrency;
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
  vipUntil = data.vipUntil || null;
  isVip = !!(vipUntil && new Date(vipUntil + 'T23:59:59').getTime() > Date.now());
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
  } else {
    // Propriétaire réel, OU appareil secondaire connecté en rôle "patron" (aucune
    // restriction pour ce cas, comme demandé) : accès dynamique à la boutique active.
    activeStoreId = data.activeStoreId && stores.find(s=>s.id===data.activeStoreId) ? data.activeStoreId : stores[0].id;
    if(!storesDataCache[activeStoreId]) storesDataCache[activeStoreId] = emptyStoreData();
    loadStoreDataIntoWorkingArrays(storesDataCache[activeStoreId]);
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
      isVip = false; vipUntil = null;
      const legacyId = 'store_default';
      stores = [{ id: legacyId, name: dict[currentLang].storesTitle, createdAt: Date.now() }];
      activeStoreId = legacyId;
      storesDataCache = { [legacyId]: { products, sales, lots, debts, expenses, stats } };
      await db.collection('mombongo_users').doc(currentUser.uid).set({
        stores, activeStoreId, storesData: storesDataCache, rate: exchangeRate, currency: currentCurrency,
        email: currentUser.email || '', displayName: currentUser.displayName || '', updatedAt: Date.now()
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
      showToast(currentLang==='fr' ? "Compte connecté, données sauvegardées" : "Compte ekangami");
    }
  }catch(e){
    console.error('Erreur récupération cloud', e);
    showToast('Erreur données : ' + (e.code || e.message || e));
  }
  localStorage.removeItem('mombongo:pendingRef');
  renderAccountUI();
  renderStoresList();
  render();
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

// Vérifie si le VIP est réellement encore actif À L'INSTANT PRÉSENT, indépendamment de la dernière
// synchro Firestore reçue. Sans ça, isVip ne se recalcule que quand le document change sur le
// serveur — donc un abonnement qui expire pendant qu'une session reste ouverte (patron ou appareil
// secondaire) ne serait jamais détecté tant que rien d'autre ne déclenche une resynchro.
function checkVipExpiryLive(){
  if(!vipUntil) return;
  const stillVip = new Date(vipUntil + 'T23:59:59').getTime() > Date.now();
  if(stillVip === isVip) return; // rien n'a changé depuis la dernière vérification
  isVip = stillVip;
  renderAccountUI();
  renderStoresList();
  renderDevicesList();
  render();
  if(isVip){
    // VIP redevenu actif (renouvellement détecté) : si cet appareil était mis en pause, on le libère.
    hideVipExpiredBlock();
  } else {
    handleVipJustExpired();
  }
}

function handleVipJustExpired(){
  // Ferme immédiatement toute action VIP en cours, même si l'utilisateur était en train de
  // l'utiliser au moment précis de l'expiration.
  closeNewStoreSheet();
  closeGeneratePinSheet();
  if(isEmployeeMode){
    // Un appareil secondaire EST la fonctionnalité VIP (multi-appareils) : on bloque son usage.
    // On n'efface volontairement ni l'appairage ni les données locales (contrairement à un retrait
    // définitif par le patron) : dès que le VIP est renouvelé, cet appareil redevient actif tout
    // seul, sans qu'il faille un nouveau code de connexion.
    showVipExpiredBlock();
  } else {
    showToast(dict[currentLang].vipExpiredToast, 6000);
  }
}
function showVipExpiredBlock(){
  document.getElementById('vip-expired-block-overlay').classList.add('open');
}
function hideVipExpiredBlock(){
  document.getElementById('vip-expired-block-overlay').classList.remove('open');
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

async function switchStore(storeId){
  if(!canManageStoresAndDevices() || storeId === activeStoreId) return;
  await pushToCloud(); // sauvegarde la boutique quittée
  activeStoreId = storeId;
  if(!storesDataCache[storeId]) storesDataCache[storeId] = emptyStoreData();
  loadStoreDataIntoWorkingArrays(storesDataCache[storeId]);
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
  if(!isVip){ closeAccountSheet(); openLimitSheet('stores'); return; }
  document.getElementById('in-store-name').value = '';
  setNewStoreType('boutique');
  document.getElementById('new-store-overlay').classList.add('open');
}
function closeNewStoreSheet(){
  document.getElementById('new-store-overlay').classList.remove('open');
}
async function confirmAddStore(){
  if(!isVip){ closeNewStoreSheet(); openLimitSheet('stores'); return; }
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
  if(!isVip){ closeAccountSheet(); openLimitSheet('devices'); return; }
  document.getElementById('generate-pin-overlay').classList.add('open');
  generateNewPin();
  watchForDevicePairing();
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
      ownerUid: ownerUid, storeId: activeStoreId, createdAt: Date.now(), expiresAt
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
  selectedJoinRole = 'patron';
  document.querySelectorAll('.join-role-btn').forEach(b=>b.classList.toggle('active', b.dataset.role==='patron'));
  document.getElementById('join-with-code-overlay').classList.add('open');
}
function closeJoinWithCodeSheet(){
  document.getElementById('join-with-code-overlay').classList.remove('open');
}
function selectJoinRole(role, btn){
  selectedJoinRole = role;
  document.querySelectorAll('.join-role-btn').forEach(b=>b.classList.toggle('active', b===btn));
}
async function confirmJoinWithPin(){
  const t = dict[currentLang];
  const pin = document.getElementById('in-join-pin').value.trim();
  const name = document.getElementById('in-join-device-name').value.trim();
  if(!pin || pin.length < 4){ showToast(t.deviceLinkError); return; }
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
    await db.collection('mombongo_users').doc(codeData.ownerUid).collection('devices').doc(myUid).set({
      role: selectedJoinRole, name: name || '', storeId: codeData.storeId, addedAt: Date.now()
    });
    try{ await db.collection('pairing_codes').doc(pin).delete(); }catch(e){}

    isEmployeeMode = true;
    employeeOwnerUid = codeData.ownerUid;
    employeeRole = selectedJoinRole;
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
  return true;
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
      return;
    }
    currentUser = user;
    renderAccountUI();
    if(user) handlePostLogin();
  });
}

// Vérification périodique de l'expiration VIP en temps réel : une resynchro Firestore ne se
// déclenche que si le document change sur le serveur, donc sans ça un abonnement qui expire
// pendant qu'une session reste ouverte ne serait jamais détecté avant un rechargement manuel.
vipExpiryCheckTimer = setInterval(checkVipExpiryLive, 60000);
// Revérifie aussi dès que l'app revient au premier plan (téléphone déverrouillé après une veille
// qui a duré plus longtemps que prévu) — plus réactif que d'attendre le prochain intervalle.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible') checkVipExpiryLive();
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
  currentCurrency = cur;
  document.getElementById('btn-usd').classList.toggle('active', cur==='usd');
  document.getElementById('btn-cdf').classList.toggle('active', cur==='cdf');
  document.getElementById('rate-row').style.display = (cur==='cdf') ? 'block' : 'none';
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
  document.getElementById('t-sac-buy').textContent = t.sacBuy;
  document.getElementById('t-sac-threshold').textContent = t.sacThreshold;
  document.getElementById('t-sac-hint').textContent = t.sacHint;
  document.getElementById('t-add-mesurette').textContent = t.addMesurette;
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
  document.getElementById('t-alerts-sheet-empty').textContent = t.alertsSheetEmpty;
  document.getElementById('t-cancel10').textContent = t.close;
  document.getElementById('t-products-title').textContent = t.productsTitle;
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
  document.getElementById('t-client-name').textContent = t.clientName;
  document.getElementById('t-client-phone').textContent = t.clientPhone;
  document.getElementById('t-due-date').textContent = t.dueDateField;
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
  document.getElementById('t-vip-expired-title').textContent = t.vipExpiredBlockTitle;
  document.getElementById('t-vip-expired-desc').textContent = t.vipExpiredBlockDesc;
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
  document.getElementById('t-pwa-install-btn').textContent = t.pwaInstallBtn;
  document.getElementById('t-whatsapp-contact-link').textContent = t.whatsappContactLink;
  document.getElementById('t-install-apk-title').textContent = t.installApkTitle;
  document.getElementById('t-install-apk-desc').textContent = t.installApkDesc;
  document.getElementById('t-install-apk-accept').textContent = t.installApkAccept;
  document.getElementById('t-install-apk-decline').textContent = t.installApkDecline;

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
}

