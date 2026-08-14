/* =========================================================================
   SYNCHRONISATION DES ACHATS FOURNISSEURS — étape 2 du chantier de sécurité
   par rôle, suite (voir sales-sync.js / products-sync.js / debts-sync.js /
   expenses-sync.js / suppliers-sync.js pour le même principe général).
   ---------------------------------------------------------------------------
   Symétrique de debts-sync.js : un achat à crédit change EN PLACE au fil des
   règlements (payments, amountPaid, status), exactement comme une dette
   client — donc même modèle (diff par document entier via
   syncedPurchasesSnapshot).

   RÔLES : reflète exactement canManageSuppliers() dans l'app — patron et
   caissier créent/modifient un achat (voir firestore.rules). Contrairement
   aux dettes, l'app ne propose PAS encore de supprimer un achat existant
   (voir la note en tête de suppliers.js) — mais la règle "delete" ci-dessous
   existe quand même, réservée au patron, pour permettre l'archivage à 13
   mois (voir archiveOldData() dans data-catalog.js) : un achat déjà réglé
   et ancien doit pouvoir être retiré de Firestore comme les autres
   collections, même si l'interface ne propose pas encore de le faire à la
   main.

   Comme pour les dettes, un magasinier n'a même pas le droit de LIRE cette
   collection — cohérent avec canManageSuppliers(), qui lui refuse déjà
   l'accès à tout ce qui touche aux fournisseurs côté interface.

   COMPATIBILITÉ ET HORS LIGNE : mêmes principes que les autres fichiers
   *-sync.js.
   ========================================================================= */

let purchasesListenerUnsub = null;
let syncedPurchasesSnapshot = {}; // { [purchaseId]: <dernier état confirmé côté Firestore> }

function purchasesCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('purchases');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachPurchasesListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachPurchasesListener();
  syncedPurchasesSnapshot = {};
  purchasesListenerUnsub = purchasesCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].purchases) || [];
      if(legacy.length > 0){
        await migrateLegacyPurchases(ownerUid, storeId, legacy);
        return;
      }
    }
    purchases = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId;
      data.id = d.id;
      return data;
    });
    syncedPurchasesSnapshot = {};
    purchases.forEach(p=>{ syncedPurchasesSnapshot[p.id] = Object.assign({}, p); });
    localSet('mombongo:purchases', JSON.stringify(purchases));
    if(typeof renderSuppliersList === 'function') renderSuppliersList();
    if(typeof renderPurchaseHistory === 'function') renderPurchaseHistory();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute achats', e);
  });
}
function detachPurchasesListener(){
  if(purchasesListenerUnsub){ purchasesListenerUnsub(); purchasesListenerUnsub = null; }
}

/* ---------- Reprise unique des achats de l'ancien format ---------- */
async function migrateLegacyPurchases(ownerUid, storeId, legacyPurchases){
  try{
    const col = purchasesCollectionRef(ownerUid);
    for(let i=0; i<legacyPurchases.length; i+=450){
      const chunk = legacyPurchases.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(p=>{ batch.set(col.doc(p.id), Object.assign({}, p, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des achats existants', e);
  }
}

/* ---------- Sauvegarde : renvoie chaque achat qui a réellement changé ---------- */
// Remplace l'ancien savePurchases() de data-catalog.js. Aucun appelant n'a besoin de
// changer (suppliers.js, archiveOldData() dans data-catalog.js).
async function savePurchases(){
  localSet('mombongo:purchases', JSON.stringify(purchases));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(purchases.map(p=>p.id));
  const removedIds = Object.keys(syncedPurchasesSnapshot).filter(id=>!currentIds.has(id));
  const toWrite = purchases.filter(p=>JSON.stringify(p) !== JSON.stringify(syncedPurchasesSnapshot[p.id]));
  if(toWrite.length === 0 && removedIds.length === 0) return;

  const col = purchasesCollectionRef(ownerUid);
  toWrite.forEach(p=>{ syncedPurchasesSnapshot[p.id] = Object.assign({}, p); });
  removedIds.forEach(id=>{ delete syncedPurchasesSnapshot[id]; });

  (async ()=>{
    try{
      for(let i=0; i<toWrite.length; i+=450){
        const chunk = toWrite.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(p=>{ batch.set(col.doc(p.id), Object.assign({}, p, { storeId })); });
        await batch.commit();
      }
      for(let i=0; i<removedIds.length; i+=450){
        const chunk = removedIds.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(id=>{ batch.delete(col.doc(id)); });
        await batch.commit();
      }
      lastSyncOk = true;
      updateSyncStatusUI();
    }catch(e){
      console.error('Erreur synchronisation achats', e);
      toWrite.forEach(p=>{ delete syncedPurchasesSnapshot[p.id]; });
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
