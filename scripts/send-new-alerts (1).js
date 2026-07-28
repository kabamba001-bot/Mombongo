/**
 * send-new-alerts.js
 * -------------------------------------------------------------------------
 * Tourne fréquemment (voir .github/workflows/check-new-alerts.yml) pour
 * notifier UNIQUEMENT les NOUVELLES alertes (quasi-instantané).
 *
 * Compare avec l'état de la dernière exécution (stocké dans Firestore, sous
 * mombongo_users/{uid}/notifState/{storeId}) pour ne jamais renotifier une
 * alerte déjà connue, tant qu'elle n'a pas disparu puis réapparu.
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

      const { alertKeys, lowStock, expired, expiringSoon, dueSoonDebts } = computeStoreAlerts(storeData);

      const stateRef = db.collection('mombongo_users').doc(ownerUid).collection('notifState').doc(storeId);
      const stateDoc = await stateRef.get();
      const previousKeys = new Set((stateDoc.exists && stateDoc.data().alertKeys) || []);

      const newKeys = [...alertKeys].filter(k => !previousKeys.has(k));

      // Toujours sauvegarder l'état actuel, même sans nouvelle alerte,
      // pour que les alertes résolues puis réapparues renotifient bien.
      await stateRef.set({ alertKeys: [...alertKeys], updatedAt: Date.now() });

      if(newKeys.length === 0) continue;

      const newLow = lowStock.filter(p => newKeys.includes(`low:${p.id}`));
      // La clé d'un produit expiré/bientôt périmé ou d'une dette inclut le nombre de
      // jours (ex: "exp:xyz:-2", "soon:xyz:3", "due:xyz:2"), qui change chaque jour —
      // donc chaque jour du compte à rebours (et chaque jour de retard une fois la
      // date passée) est traité comme une nouvelle alerte à part entière.
      const newExp = expired.filter(p => newKeys.some(k => k.startsWith(`exp:${p.id}:`)));
      const newSoon = expiringSoon.filter(p => newKeys.some(k => k.startsWith(`soon:${p.id}:`)));
      const newDue = (dueSoonDebts || []).filter(d => newKeys.some(k => k.startsWith(`due:${d.id}:`)));
      const { title, body } = buildMessage(store.name, newLow, newExp, newSoon, newDue, '⚠️');

      try{
        notificationsSent += await sendAndCleanup(db, ownerUid, store.name, storeId, tokens, title, body);
      }catch(e){
        console.error(`Erreur envoi notification pour ${ownerUid}/${storeId} :`, e.message);
      }
    }
  }

  console.log(`Terminé. ${notificationsSent} notification(s) envoyée(s) au total.`);
}

run().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
