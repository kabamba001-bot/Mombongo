/**
 * send-stock-alerts.js
 * -------------------------------------------------------------------------
 * Tourne pÃ©riodiquement via GitHub Actions (voir
 * .github/workflows/check-stock-alerts.yml). Ce script :
 *   1. Lit tous les documents "mombongo_users" dans Firestore.
 *   2. Pour chaque boutique de chaque utilisateur, recalcule les mÃªmes
 *      alertes que l'app (stock faible, produits pÃ©rimÃ©s, produits qui
 *      expirent bientÃ´t) â€” exactement la mÃªme logique que render() dans
 *      index.html.
 *   3. Compare avec l'Ã©tat de la derniÃ¨re exÃ©cution (stockÃ© dans Firestore,
 *      sous mombongo_users/{uid}/notifState/{storeId}) pour ne notifier que
 *      les NOUVELLES alertes (Ã©vite de spammer Ã  chaque run).
 *   4. Envoie une notification push via Firebase Cloud Messaging Ã  tous les
 *      appareils enregistrÃ©s pour cette boutique
 *      (mombongo_users/{uid}/fcmTokens/*).
 *   5. Nettoie les tokens invalides (dÃ©sinstallation, permission retirÃ©eâ€¦).
 *
 * Variable d'environnement attendue : FIREBASE_SERVICE_ACCOUNT
 * (le contenu JSON complet de la clÃ© de compte de service Firebase).
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

const EXPIRY_WARNING_DAYS = 10;

function initAdmin(){
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw){
    console.error('FIREBASE_SERVICE_ACCOUNT manquant. Ajoute ce secret dans les paramÃ¨tres du dÃ©pÃ´t GitHub.');
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

// Recalcule les alertes d'une boutique, exactement comme render() cÃ´tÃ© client.
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

function buildMessage(storeName, lowStock, expired, expiringSoon){
  const parts = [];
  if(lowStock.length) parts.push(`${lowStock.length} produit${lowStock.length>1?'s':''} en stock faible`);
  if(expired.length) parts.push(`${expired.length} produit${expired.length>1?'s':''} pÃ©rimÃ©${expired.length>1?'s':''}`);
  if(expiringSoon.length) parts.push(`${expiringSoon.length} produit${expiringSoon.length>1?'s':''} qui expire${expiringSoon.length>1?'nt':''} bientÃ´t`);
  const body = parts.join(', ');
  const title = `âš ï¸ ${storeName || 'Ta boutique'}`;
  return { title, body };
}

async function run(){
  initAdmin();
  const db = admin.firestore();

  const usersSnap = await db.collection('mombongo_users').get();
  console.log(`Utilisateurs Ã  vÃ©rifier : ${usersSnap.size}`);

  let notificationsSent = 0;

  for(const userDoc of usersSnap.docs){
    const ownerUid = userDoc.id;
    const data = userDoc.data();
    const stores = data.stores || [];
    const storesData = data.storesData || {};

    if(stores.length === 0) continue;

    // Un seul chargement des tokens pour tout le compte (ils sont ensuite
    // filtrÃ©s par boutique si tu veux affiner plus tard).
    const tokensSnap = await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').get();
    if(tokensSnap.empty) continue;
    const tokens = tokensSnap.docs.map(d => ({ id: d.id, token: d.data().token })).filter(t => t.token);
    if(tokens.length === 0) continue;

    for(const store of stores){
      const storeId = store.id;
      const storeData = storesData[storeId];
      if(!storeData) continue;

      const { alertKeys, lowStock, expired, expiringSoon } = computeStoreAlerts(storeData);

      const stateRef = db.collection('mombongo_users').doc(ownerUid).collection('notifState').doc(storeId);
      const stateDoc = await stateRef.get();
      const previousKeys = new Set((stateDoc.exists && stateDoc.data().alertKeys) || []);

      const newKeys = [...alertKeys].filter(k => !previousKeys.has(k));

      // Toujours sauvegarder l'Ã©tat actuel, mÃªme sans nouvelle alerte,
      // pour que les alertes rÃ©solues puis rÃ©apparues renotifient bien.
      await stateRef.set({ alertKeys: [...alertKeys], updatedAt: Date.now() });

      if(newKeys.length === 0) continue;

      const newLow = lowStock.filter(p => newKeys.includes(`low:${p.id}`));
      const newExp = expired.filter(p => newKeys.includes(`exp:${p.id}`));
      const newSoon = expiringSoon.filter(p => newKeys.includes(`soon:${p.id}`));
      const { title, body } = buildMessage(store.name, newLow, newExp, newSoon);

      const message = {
        notification: { title, body },
        data: { storeId: String(storeId), tag: `mombongo-${storeId}` },
        tokens: tokens.map(t => t.token)
      };

      try{
        const response = await admin.messaging().sendEachForMulticast(message);
        notificationsSent += response.successCount;
        console.log(`Boutique "${store.name}" (${ownerUid}) : ${response.successCount}/${tokens.length} notifications envoyÃ©es.`);

        // Nettoyage des tokens invalides (dÃ©sinstallation, permission rÃ©voquÃ©eâ€¦)
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
      }catch(e){
        console.error(`Erreur envoi notification pour ${ownerUid}/${storeId} :`, e.message);
      }
    }
  }

  console.log(`TerminÃ©. ${notificationsSent} notification(s) envoyÃ©e(s) au total.`);
}

run().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
