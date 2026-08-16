/* =========================================================================
   ZONE À PERSONNALISER : remplace les valeurs ci-dessous par celles de TON
   propre projet Firebase gratuit (Réglages du projet > Tes applications).
   Tant que ce n'est pas fait, la connexion Google ne fonctionnera pas.
   ========================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyAwVvxkSekMU0mXpR1A5lGcplJNwXcU9F4",
  authDomain: "mombongo-15323.firebaseapp.com",
  projectId: "mombongo-15323",
  storageBucket: "mombongo-15323.firebasestorage.app",
  messagingSenderId: "212073636592",
  appId: "1:212073636592:web:a15328ff9389c6b8ebd835"
};

let cloudEnabled = true;
let db = null;
let currentUser = null;
let isVip = false;
let vipUntil = null;
let vipExpiryCheckTimer = null;
let currentLang = 'fr';
let currentCurrency = 'usd';
let exchangeRate = 2300;
// (ancienne FREE_EXPENSE_LIMIT retirée — dépenses illimitées pour tous)
const DEV_WHATSAPP = '243980979141';

try{
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  db.enablePersistence().catch(()=>{});
}catch(e){
  cloudEnabled = false;
  console.error('Firebase non configuré :', e);
}

/* =========================================================================
   NOTIFICATIONS PUSH (Firebase Cloud Messaging), à la WhatsApp.
   ZONE À PERSONNALISER : colle ici ta clé VAPID, générée dans
   Firebase Console > Project Settings > Cloud Messaging > "Web Push
   certificates" (bouton "Generate key pair"). Sans cette clé, le bouton
   "Activer les notifications" affichera une erreur.
   ========================================================================= */
const FCM_VAPID_KEY = "BPZU_DN8OKvv_zYHAeZmBRC_xakW9UrxhQb0CPl3vpcaPs1p9biH7wHjtBa4JitjHYo01BNdH4eKPGNTkWpxxmI";

let fcmMessaging = null;
(async function initFcmMessaging(){
  try{
    // firebase.messaging.isSupported() renvoie une Promise<boolean> (pas un booléen direct) dans
    // cette version du SDK — il faut l'attendre, sinon la Promise est toujours "vraie" en JS et le
    // code tente d'initialiser la messagerie même sur un navigateur qui ne la supporte pas.
    if(cloudEnabled && firebase.messaging && firebase.messaging.isSupported && await firebase.messaging.isSupported()){
      fcmMessaging = firebase.messaging();
    }
  }catch(e){ console.error('FCM non disponible :', e); }
  if(fcmMessaging){
    // L'app est ouverte au premier plan : FCM ne montre pas de notification
    // système automatiquement, donc on l'affiche nous-mêmes.
    fcmMessaging.onMessage((payload)=>{
      const title = (payload.notification && payload.notification.title) || 'Mombongo';
      const body = (payload.notification && payload.notification.body) || '';
      showToast(`${title} — ${body}`, 6000);
      try{
        navigator.serviceWorker.ready.then(reg=>{
          reg.showNotification(title, {
            body,
            icon: './icon-192.png',
            badge: './icon-192.png',
            data: payload.data || {},
            tag: (payload.data && payload.data.tag) || 'mombongo-alert'
          });
        });
      }catch(e){}
    });
  }
})();

function notificationsSupported(){
  return !!(fcmMessaging && ('Notification' in window) && ('serviceWorker' in navigator));
}

async function saveFcmToken(token){
  const ownerUid = getDataOwnerUid();
  const authUser = firebase.auth().currentUser;
  if(!ownerUid || !authUser || !db){
    console.error('saveFcmToken: contexte manquant', { ownerUid, hasAuthUser: !!authUser, hasDb: !!db });
    showToast('Erreur notif (contexte) : ownerUid=' + ownerUid + ' / auth=' + (authUser ? authUser.uid : 'aucun'), 6000);
    return;
  }
  try{
    await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').doc(authUser.uid).set({
      token,
      updatedAt: Date.now(),
      lang: currentLang,
      role: currentRole()
    }, { merge:true });
  }catch(e){
    console.error('Erreur sauvegarde token notification', e);
    showToast('Erreur sauvegarde token : ' + (e.code || e.message || e), 6000);
  }
}

async function removeFcmToken(){
  const ownerUid = getDataOwnerUid();
  const authUser = firebase.auth().currentUser;
  if(!ownerUid || !authUser || !db) return;
  try{
    await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').doc(authUser.uid).delete();
  }catch(e){ /* silencieux */ }
}

async function registerFcmToken(){
  if(!notificationsSupported()){
    showToast('Notif non supportée : fcmMessaging=' + !!fcmMessaging + ' / Notification=' + ('Notification' in window) + ' / SW=' + ('serviceWorker' in navigator), 6000);
    return;
  }
  try{
    const reg = await navigator.serviceWorker.ready;
    const token = await fcmMessaging.getToken({ vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
    if(token){
      await saveFcmToken(token);
    } else {
      showToast('Aucun token FCM retourné (getToken vide)', 6000);
    }
  }catch(e){
    console.error('Erreur récupération token FCM', e);
    showToast('Erreur getToken : ' + (e.code || e.message || e), 6000);
  }
}


async function toggleNotifications(){
  const t = dict[currentLang];
  if(!isFeatureUnlocked('pushNotifications')){ closeAccountSheet(); openLimitSheet('notif'); return; }
  if(!notificationsSupported()){
    showToast(t.notifUnsupported, 5000);
    return;
  }
  if(Notification.permission === 'granted'){
    await removeFcmToken();
    showToast(t.notifDisabled);
    updateNotifButton();
    return;
  }
  if(Notification.permission === 'denied'){
    showToast(t.notifBlocked, 5000);
    return;
  }
  const perm = await Notification.requestPermission();
  if(perm === 'granted'){
    await registerFcmToken();
    showToast(t.notifEnabled);
  }
  updateNotifButton();
}

function updateNotifButton(){
  const t = dict[currentLang];
  document.querySelectorAll('.notif-toggle-btn').forEach(btn=>{
    if(!isFeatureUnlocked('pushNotifications')){
      btn.textContent = '🔒 ' + t.notifOff;
      btn.disabled = false;
      return;
    }
    if(!notificationsSupported()){
      btn.textContent = '🔕 ' + t.notifUnsupported;
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if(Notification.permission === 'granted'){
      btn.textContent = '🔔 ' + t.notifOn;
    } else if(Notification.permission === 'denied'){
      btn.textContent = '🔕 ' + t.notifBlockedShort;
    } else {
      btn.textContent = '🔔 ' + t.notifOff;
    }
  });
}


