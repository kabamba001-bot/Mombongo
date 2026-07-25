/**
 * alert-utils.js
 * -------------------------------------------------------------------------
 * Fonctions partagées entre send-new-alerts.js (nouvelles alertes,
 * quasi-instantané) et send-daily-recap.js (rappel quotidien à 6h).
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

const EXPIRY_WARNING_DAYS = 10;

function initAdmin(){
  if(admin.apps.length) return; // évite une double initialisation
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw){
    console.error('FIREBASE_SERVICE_ACCOUNT manquant. Ajoute ce secret dans les paramètres du dépôt GitHub.');
    process.exit(1);
  }
  let serviceAccount;
  try{
    serviceAccount = JSON.parse(raw);
  }catch(e){
    console.error('FIREBASE_SERVICE_ACCOUNT invalide (JSON illisible) :', e.message);
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function daysUntilExpiry(expiryDate){
  if(!expiryDate) return Infinity;
  const exp = new Date(expiryDate + 'T00:00:00');
  const now = new Date();
  now.setHours(0,0,0,0);
  return Math.floor((exp - now) / 86400000);
}

// Recalcule les alertes d'une boutique, exactement comme render() côté client.
function computeStoreAlerts(storeData){
  const products = (storeData && storeData.products) || [];
  const todayStr = new Date().toISOString().slice(0,10);

  const lowStock = products.filter(p => typeof p.qty === 'number' && typeof p.threshold === 'number' && p.qty <= p.threshold);
  const expired = products.filter(p => p.expiryDate && p.expiryDate < todayStr);
  const expiringSoon = products.filter(p => p.expiryDate && p.expiryDate >= todayStr && daysUntilExpiry(p.expiryDate) <= EXPIRY_WARNING_DAYS);

  const alertKeys = new Set();
  lowStock.forEach(p => alertKeys.add(`low:${p.id}`));
  expired.forEach(p => alertKeys.add(`exp:${p.id}`));
  expiringSoon.forEach(p => alertKeys.add(`soon:${p.id}`));

  return { alertKeys, lowStock, expired, expiringSoon };
}

function buildMessage(storeName, lowStock, expired, expiringSoon, prefix){
  const parts = [];
  if(lowStock.length) parts.push(`${lowStock.length} produit${lowStock.length>1?'s':''} en stock faible`);
  if(expired.length) parts.push(`${expired.length} produit${expired.length>1?'s':''} périmé${expired.length>1?'s':''}`);
  if(expiringSoon.length) parts.push(`${expiringSoon.length} produit${expiringSoon.length>1?'s':''} qui expire${expiringSoon.length>1?'nt':''} bientôt`);
  const body = parts.join(', ');
  const title = `${prefix} ${storeName || 'Ta boutique'}`;
  return { title, body };
}

async function getTokensForUser(db, ownerUid){
  const tokensSnap = await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').get();
  return tokensSnap.docs.map(d => ({ id: d.id, token: d.data().token })).filter(t => t.token);
}

// Envoie la notification à tous les tokens d'un compte et nettoie les tokens invalides.
//
// Message "data-only" (pas de champ "notification" au niveau racine) : c'est volontaire.
// Quand un message contient à la fois "notification" ET "data", le téléphone affiche
// automatiquement une notification à partir du champ "notification" — en plus de celle
// que service-worker.js affiche lui-même via showNotification(). Résultat sur certains
// téléphones/versions : soit une notification en double, soit un comportement
// imprévisible selon le navigateur. En envoyant uniquement "data", c'est TOUJOURS notre
// propre code (dans service-worker.js et index.html) qui décide de l'affichage, une
// seule fois, de façon fiable partout.
async function sendAndCleanup(db, ownerUid, storeName, storeId, tokens, title, body){
  const message = {
    data: {
      title,
      body,
      storeId: String(storeId),
      tag: `mombongo-${storeId}`
    },
    tokens: tokens.map(t => t.token)
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Boutique "${storeName}" (${ownerUid}) : ${response.successCount}/${tokens.length} notifications envoyées.`);

  const invalidTokenDocIds = [];
  response.responses.forEach((r, i) => {
    if(!r.success){
      const code = r.error && r.error.code;
      if(code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'){
        invalidTokenDocIds.push(tokens[i].id);
      }
    }
  });
  for(const docId of invalidTokenDocIds){
    await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').doc(docId).delete();
  }

  return response.successCount;
}

module.exports = { initAdmin, computeStoreAlerts, buildMessage, getTokensForUser, sendAndCleanup };
