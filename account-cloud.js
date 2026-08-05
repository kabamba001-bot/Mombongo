/* ---------- Compte Google & synchronisation cloud ---------- */
function openAccountSheet(){
  document.getElementById('account-overlay').classList.add('open');
  renderStoresList();
  renderDevicesList();
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
    products = [];
    sales = [];
    lots = [];
    debts = [];
    expenses = [];
    activityLog = [];
    isVip = false;
    vipUntil = null;
    stores = [];
    activeStoreId = null;
    storesDataCache = {};
    stats = { todayDate: '', todaySales: 0, todayProfit: 0, totalProfit: 0, totalExpenses: 0 };
    localSet('mombongo:products', JSON.stringify(products));
    localSet('mombongo:sales', JSON.stringify(sales));
    localSet('mombongo:lots', JSON.stringify(lots));
    localSet('mombongo:debts', JSON.stringify(debts));
    localSet('mombongo:expenses', JSON.stringify(expenses));
    localSet('mombongo:activityLog', JSON.stringify(activityLog));
    localSet('mombongo:stats', JSON.stringify(stats));
    renderStoresList();
    render();
    showToast(currentLang==='fr' ? "Déconnecté, données locales effacées" : "Ekangwami te lisusu");
  });
  closeAccountSheet();
}


