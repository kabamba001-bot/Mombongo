/* =========================================================================
   SYNCHRONISATION DES FOURNISSEURS — étape 2 du chantier de sécurité par
   rôle, suite (voir sales-sync.js / products-sync.js / debts-sync.js /
   expenses-sync.js pour le même principe général).
   ---------------------------------------------------------------------------
   Un fournisseur change rarement (nom, téléphone) mais EN PLACE, comme une
   dette — donc ce fichier reprend le modèle de debts-sync.js (diff par
   document entier via syncedSuppliersSnapshot) plutôt que celui, plus simple,
   de sales-sync.js/expenses-sync.js (création/suppression uniquement).

   RÔLES : reflète exactement canManageSuppliers()/isPatron() dans l'app —
   patron et caissier créent/modifient un fournisseur ; seul le patron peut
   en supprimer un (voir firestore.rules). Comme pour les dettes, un
   magasinier n'a même pas le droit de LIRE cette collection — cohérent avec
   openSuppliersSheet(), qui lui refuse déjà l'accès côté interface.

   COMPATIBILITÉ ET HORS LIGNE : mêmes principes que les autres fichiers
   *-sync.js — reprise unique de l'ancien format (storesData.{storeId}.
   suppliers) au premier chargement après la mise à jour, cache local
   Firestore qui fait continuer à fonctionner onSnapshot hors connexion.
   ========================================================================= */

let suppliersListenerUnsub = null;
let syncedSuppliersSnapshot = {}; // { [supplierId]: <dernier état confirmé côté Firestore> }

function suppliersCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('suppliers');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachSuppliersListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachSuppliersListener();
  syncedSuppliersSnapshot = {};
  suppliersListenerUnsub = suppliersCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].suppliers) || [];
      if(legacy.length > 0){
        await migrateLegacySuppliers(ownerUid, storeId, legacy);
        return;
      }
    }
    suppliers = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId;
      data.id = d.id;
      return data;
    });
    syncedSuppliersSnapshot = {};
    suppliers.forEach(s=>{ syncedSuppliersSnapshot[s.id] = Object.assign({}, s); });
    localSet('mombongo:suppliers', JSON.stringify(suppliers));
    if(typeof renderSuppliersList === 'function') renderSuppliersList();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute fournisseurs', e);
  });
}
function detachSuppliersListener(){
  if(suppliersListenerUnsub){ suppliersListenerUnsub(); suppliersListenerUnsub = null; }
}

/* ---------- Reprise unique des fournisseurs de l'ancien format ---------- */
async function migrateLegacySuppliers(ownerUid, storeId, legacySuppliers){
  try{
    const col = suppliersCollectionRef(ownerUid);
    for(let i=0; i<legacySuppliers.length; i+=450){
      const chunk = legacySuppliers.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(s=>{ batch.set(col.doc(s.id), Object.assign({}, s, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des fournisseurs existants', e);
  }
}

/* ---------- Sauvegarde : renvoie chaque fournisseur qui a réellement changé ---------- */
// Remplace l'ancien saveSuppliers() de data-catalog.js. Aucun appelant n'a besoin de
// changer (suppliers.js).
async function saveSuppliers(){
  localSet('mombongo:suppliers', JSON.stringify(suppliers));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(suppliers.map(s=>s.id));
  const removedIds = Object.keys(syncedSuppliersSnapshot).filter(id=>!currentIds.has(id));
  const toWrite = suppliers.filter(s=>JSON.stringify(s) !== JSON.stringify(syncedSuppliersSnapshot[s.id]));
  if(toWrite.length === 0 && removedIds.length === 0) return;

  const col = suppliersCollectionRef(ownerUid);
  toWrite.forEach(s=>{ syncedSuppliersSnapshot[s.id] = Object.assign({}, s); });
  removedIds.forEach(id=>{ delete syncedSuppliersSnapshot[id]; });

  (async ()=>{
    try{
      for(let i=0; i<toWrite.length; i+=450){
        const chunk = toWrite.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(s=>{ batch.set(col.doc(s.id), Object.assign({}, s, { storeId })); });
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
      console.error('Erreur synchronisation fournisseurs', e);
      toWrite.forEach(s=>{ delete syncedSuppliersSnapshot[s.id]; });
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
