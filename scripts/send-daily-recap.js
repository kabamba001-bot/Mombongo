/**
 * send-daily-recap.js
 * -------------------------------------------------------------------------
 * Tourne UNE FOIS PAR JOUR à 6h (voir .github/workflows/daily-recap.yml) et
 * envoie un rappel listant TOUTES les alertes actuellement actives — qu'elles
 * soient nouvelles ou déjà connues.
 *
 * ⚠️ N'écrit PAS dans notifState : cette collection est réservée à
 * send-new-alerts.js. Si ce script y touchait, il perturberait la détection
 * des "nouvelles" alertes de l'autre job.
 *
 * Variable d'environnement attendue : FIREBASE_SERVICE_ACCOUNT
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');
const { initAdmin, computeStoreAlerts, buildMessage, getTokensForUser, sendAndCleanup } = require('./alert-utils');

async function run(){
  initAdmin();
  const db = admin.firestore();

  const usersSnap = await db.collection('mombongo_users').get();
  console.log(`Utilisateurs à vérifier : ${usersSnap.size}`);

  let notificationsSent = 0;

  for(const userDoc of usersSnap.docs){
    const ownerUid = userDoc.id;
    const data = userDoc.data();
    const stores = data.stores || [];
    const storesData = data.storesData || {};
    if(stores.length === 0) continue;

    const tokens = await getTokensForUser(db, ownerUid);
    if(tokens.length === 0) continue;

    for(const store of stores){
      const storeId = store.id;
      const storeData = storesData[storeId];
      if(!storeData) continue;

      // Les dettes ne vivent plus dans storeData (voir debts-sync.js côté app) — on les
      // récupère directement dans leur propre collection, scopées à cette boutique.
      const debtsSnap = await db.collection('mombongo_users').doc(ownerUid).collection('debts')
        .where('storeId', '==', storeId).get();
      const storeDebts = debtsSnap.docs.map(d => d.data());

      const { lowStock, expired, expiringSoon, dueSoonDebts } = computeStoreAlerts(storeData, storeDebts);
      if(lowStock.length === 0 && expired.length === 0 && expiringSoon.length === 0 && (!dueSoonDebts || dueSoonDebts.length === 0)) continue;

      const { title, body } = buildMessage(store.name, lowStock, expired, expiringSoon, dueSoonDebts, '🔔 Rappel —');

      try{
        notificationsSent += await sendAndCleanup(db, ownerUid, store.name, storeId, tokens, title, body);
      }catch(e){
        console.error(`Erreur envoi rappel pour ${ownerUid}/${storeId} :`, e.message);
      }
    }
  }

  console.log(`Terminé. ${notificationsSent} rappel(s) envoyé(s) au total.`);
}

run().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
