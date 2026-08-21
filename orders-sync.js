/* =========================================================================
   SYNCHRONISATION DES COMMANDES FOURNISSEURS EN ATTENTE — voir suppliers.js
   pour toute la logique métier (openNewOrderSheet, openReceiveOrderSheet...).
   ---------------------------------------------------------------------------
   Même principe que purchases-sync.js : une commande change EN PLACE au fil
   de sa vie (en_attente → reçue ou annulée), donc même modèle de diff par
   document entier via syncedOrdersSnapshot. Contrairement aux achats, il n'y
   a pas de données "legacy" à migrer — les commandes sont une donnée toute
   neuve, jamais stockée ailleurs qu'ici.

   RÔLES : identique à purchasesCollectionRef — reflète canManageSuppliers()
   (patron + caissier), un magasinier n'a même pas le droit de lire cette
   collection (voir firestore.rules, même bloc que /purchases).
   ========================================================================= */

let ordersListenerUnsub = null;
let syncedOrdersSnapshot = {}; // { [orderId]: <dernier état confirmé côté Firestore> }

function ordersCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('orders');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachOrdersListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachOrdersListener();
  syncedOrdersSnapshot = {};
  ordersListenerUnsub = ordersCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot((snap)=>{
    orders = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId;
      data.id = d.id;
      return data;
    });
    syncedOrdersSnapshot = {};
    orders.forEach(o=>{ syncedOrdersSnapshot[o.id] = Object.assign({}, o); });
    localSet('mombongo:orders', JSON.stringify(orders));
    if(typeof renderOrdersList === 'function') renderOrdersList();
    if(typeof renderSuppliersList === 'function') renderSuppliersList();
  }, (e)=>{
    console.error('Erreur écoute commandes', e);
  });
}
function detachOrdersListener(){
  if(ordersListenerUnsub){ ordersListenerUnsub(); ordersListenerUnsub = null; }
}

/* ---------- Sauvegarde : renvoie chaque commande qui a réellement changé ---------- */
async function saveOrders(){
  localSet('mombongo:orders', JSON.stringify(orders));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(orders.map(o=>o.id));
  const removedIds = Object.keys(syncedOrdersSnapshot).filter(id=>!currentIds.has(id));
  const toWrite = orders.filter(o=>JSON.stringify(o) !== JSON.stringify(syncedOrdersSnapshot[o.id]));
  if(toWrite.length === 0 && removedIds.length === 0) return;

  const col = ordersCollectionRef(ownerUid);
  toWrite.forEach(o=>{ syncedOrdersSnapshot[o.id] = Object.assign({}, o); });
  removedIds.forEach(id=>{ delete syncedOrdersSnapshot[id]; });

  (async ()=>{
    try{
      for(let i=0; i<toWrite.length; i+=450){
        const chunk = toWrite.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(o=>{ batch.set(col.doc(o.id), Object.assign({}, o, { storeId })); });
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
      console.error('Erreur synchronisation commandes', e);
      toWrite.forEach(o=>{ delete syncedOrdersSnapshot[o.id]; });
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
