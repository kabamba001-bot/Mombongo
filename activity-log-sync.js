/* =========================================================================
   SYNCHRONISATION DU JOURNAL D'ACTIVITÉ — dernier morceau de l'étape 2 du
   chantier de sécurité par rôle (voir sales-sync.js / expenses-sync.js pour
   le même principe général — une entrée de journal n'est jamais modifiée
   après sa création, seulement créée puis, individuellement, supprimée par
   le patron — voir deleteHistoryEntry() dans helpers.js, cas 'activity').

   ---------------------------------------------------------------------------
   DIFFÉRENCE DE RÔLE avec les autres collections : contrairement aux dettes/
   fournisseurs/achats, N'IMPORTE QUEL rôle (patron, caissier, magasinier)
   peut CRÉER une entrée de journal — logActivity() (products.js) est appelée
   automatiquement quand n'importe quel employé fait une action à tracer
   (ex : un magasinier qui supprime un produit). Restreindre la lecture par
   rôle comme pour /debts ou /suppliers casserait donc la synchronisation
   pour un magasinier (il pourrait écrire mais jamais recevoir l'état
   existant, et retenterait sans fin d'écrire les mêmes entrées). Cette
   collection reste donc lisible par tout appareil lié, comme /sales et
   /products — cohérent avec le risque résiduel qu'elle représente : le
   journal n'est de toute façon affiché qu'au patron côté interface
   (buildUnifiedHistory() dans navigation.js) et ne porte aucun argent ; au
   pire un employé malveillant pourrait l'effacer ou le falsifier, jamais
   créer de perte financière directe. Seule la SUPPRESSION reste réservée au
   patron (isPatron(), voir firestore.rules).

   PURGE : logActivity() garde déjà un plafond de 300 entrées LOCALEMENT
   (activityLog.slice(0,300) dans products.js) — comme saveActivityLog()
   ci-dessous calcule son delta par rapport à ce tableau local, une entrée
   qui sort de ce plafond est automatiquement supprimée aussi côté Firestore,
   en plus de la purge à 13 mois (archiveOldData(), voir data-catalog.js) :
   double filet de sécurité contre un document qui grossirait sans fin.

   COMPATIBILITÉ ET HORS LIGNE : mêmes principes que les autres fichiers
   *-sync.js — reprise unique de l'ancien format (storesData.{storeId}.
   activityLog) au premier chargement après la mise à jour.
   ========================================================================= */

let activityLogListenerUnsub = null;
let syncedActivityLogIds = new Set(); // entrées déjà confirmées présentes côté Firestore

function activityLogCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('activityLog');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachActivityLogListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachActivityLogListener();
  syncedActivityLogIds = new Set();
  activityLogListenerUnsub = activityLogCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].activityLog) || [];
      if(legacy.length > 0){
        await migrateLegacyActivityLog(ownerUid, storeId, legacy);
        return;
      }
    }
    activityLog = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId;
      data.id = d.id;
      return data;
    }).sort((a,b)=>b.date-a.date);
    syncedActivityLogIds = new Set(activityLog.map(a=>a.id));
    localSet('mombongo:activityLog', JSON.stringify(activityLog));
    if(typeof renderHistory === 'function') renderHistory();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute journal d\'activité', e);
  });
}
function detachActivityLogListener(){
  if(activityLogListenerUnsub){ activityLogListenerUnsub(); activityLogListenerUnsub = null; }
}

/* ---------- Reprise unique du journal de l'ancien format ---------- */
async function migrateLegacyActivityLog(ownerUid, storeId, legacyLog){
  try{
    const col = activityLogCollectionRef(ownerUid);
    for(let i=0; i<legacyLog.length; i+=450){
      const chunk = legacyLog.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(a=>{ batch.set(col.doc(a.id), Object.assign({}, a, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration du journal d\'activité existant', e);
  }
}

/* ---------- Sauvegarde : n'envoie que ce qui a réellement changé ---------- */
// Remplace l'ancien saveActivityLog() de products.js. Aucun appelant n'a besoin de
// changer (logActivity() dans products.js, deleteHistoryEntry() dans helpers.js,
// archiveOldData() dans data-catalog.js).
async function saveActivityLog(){
  localSet('mombongo:activityLog', JSON.stringify(activityLog));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(activityLog.map(a=>a.id));
  const toAdd = activityLog.filter(a=>!syncedActivityLogIds.has(a.id));
  const toRemove = [...syncedActivityLogIds].filter(id=>!currentIds.has(id));
  if(toAdd.length === 0 && toRemove.length === 0) return;

  const col = activityLogCollectionRef(ownerUid);
  toAdd.forEach(a=>syncedActivityLogIds.add(a.id));
  toRemove.forEach(id=>syncedActivityLogIds.delete(id));

  (async ()=>{
    try{
      for(let i=0; i<toAdd.length; i+=450){
        const chunk = toAdd.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(a=>{ batch.set(col.doc(a.id), Object.assign({}, a, { storeId })); });
        await batch.commit();
      }
      for(let i=0; i<toRemove.length; i+=450){
        const chunk = toRemove.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(id=>{ batch.delete(col.doc(id)); });
        await batch.commit();
      }
      lastSyncOk = true;
      updateSyncStatusUI();
    }catch(e){
      console.error('Erreur synchronisation journal d\'activité', e);
      toAdd.forEach(a=>syncedActivityLogIds.delete(a.id));
      toRemove.forEach(id=>syncedActivityLogIds.add(id));
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
