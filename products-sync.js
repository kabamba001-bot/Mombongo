/* =========================================================================
   SYNCHRONISATION DES PRODUITS — suite de l'étape 2 du chantier de sécurité
   par rôle (voir sales-sync.js pour la vente, même principe général ici).
   ---------------------------------------------------------------------------
   Différence importante avec les ventes : une vente n'est jamais modifiée
   après sa création (juste créée, puis éventuellement supprimée), alors
   qu'un produit change tout le temps EN PLACE (prix, stock, seuil...). La
   synchronisation doit donc suivre précisément QUELS CHAMPS ont changé
   depuis la dernière fois, pas juste "quels produits sont nouveaux ou
   supprimés" — sinon un caissier (qui n'a le droit de toucher qu'à qty/buy/
   lastSoldAt, voir firestore.rules) risquerait d'envoyer accidentellement
   un champ resté périmé localement (ex: un prix changé entre-temps par le
   patron sur un autre appareil), et Firestore rejetterait TOUTE l'écriture
   — y compris la vente légitime en cours. syncedProductsSnapshot retient
   donc, pour chaque produit, son dernier état confirmé côté serveur, et
   saveProducts() n'envoie jamais que la différence avec cet état.
   ========================================================================= */

let productsListenerUnsub = null;
let syncedProductsSnapshot = {}; // { [productId]: <dernier état confirmé côté Firestore> }

function productsCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('products');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachProductsListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachProductsListener();
  syncedProductsSnapshot = {};
  productsListenerUnsub = productsCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].products) || [];
      if(legacy.length > 0){
        await migrateLegacyProducts(ownerUid, storeId, legacy);
        return;
      }
    }
    products = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId; // champ technique de routage, pas une propriété du produit lui-même
      data.id = d.id;
      return data;
    });
    syncedProductsSnapshot = {};
    products.forEach(p=>{ syncedProductsSnapshot[p.id] = Object.assign({}, p); });
    localSet('mombongo:products', JSON.stringify(products));
    // Empêche toute résurrection de produits supprimés — voir cleanupLegacyField() dans
    // helpers.js et le commentaire détaillé dans sales-sync.js (même bug, même correctif).
    if(storesDataCache[storeId] && storesDataCache[storeId].products){
      delete storesDataCache[storeId].products;
    }
    cleanupLegacyField(ownerUid, storeId, 'products');
    if(typeof render === 'function') render();
    if(typeof updateProductNameSuggestions === 'function') updateProductNameSuggestions();
  }, (e)=>{
    console.error('Erreur écoute produits', e);
  });
}
function detachProductsListener(){
  if(productsListenerUnsub){ productsListenerUnsub(); productsListenerUnsub = null; }
}

/* ---------- Reprise unique des produits de l'ancien format ---------- */
async function migrateLegacyProducts(ownerUid, storeId, legacyProducts){
  try{
    const col = productsCollectionRef(ownerUid);
    for(let i=0; i<legacyProducts.length; i+=450){
      const chunk = legacyProducts.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(p=>{ batch.set(col.doc(p.id), Object.assign({}, p, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des produits existants', e);
  }
}

/* ---------- Sauvegarde : n'envoie, pour chaque produit, que les champs réellement modifiés ---------- */
// Remplace l'ancien saveProducts() de data-catalog.js. Mêmes call sites qu'avant dans
// tout le reste de l'app (products.js, sales.js, suppliers.js, community-catalog.js...) :
// aucun n'a besoin de changer, cette fonction déduit elle-même le delta.
async function saveProducts(){
  localSet('mombongo:products', JSON.stringify(products));
  localSet('mombongo:customCatalog', JSON.stringify(customCatalog));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(products.map(p=>p.id));
  const removedIds = Object.keys(syncedProductsSnapshot).filter(id=>!currentIds.has(id));

  const col = productsCollectionRef(ownerUid);
  const ops = []; // { id, ref, data, isCreate }
  products.forEach(p=>{
    const prevSynced = syncedProductsSnapshot[p.id];
    if(!prevSynced){
      ops.push({ id: p.id, ref: col.doc(p.id), data: Object.assign({}, p, { storeId }), isCreate: true });
      return;
    }
    const changed = {};
    Object.keys(p).forEach(key=>{
      if(JSON.stringify(p[key]) !== JSON.stringify(prevSynced[key])) changed[key] = p[key];
    });
    if(Object.keys(changed).length > 0){
      ops.push({ id: p.id, ref: col.doc(p.id), data: changed, isCreate: false });
    }
  });

  if(ops.length === 0 && removedIds.length === 0) return;

  // Marqué "synchronisé" tout de suite, de façon optimiste — voir le même commentaire
  // dans saveSales() (sales-sync.js) pour la raison.
  ops.forEach(op=>{
    const current = products.find(p=>p.id===op.id);
    if(current) syncedProductsSnapshot[op.id] = Object.assign({}, current);
  });
  removedIds.forEach(id=>{ delete syncedProductsSnapshot[id]; });

  // CRITIQUE : ne JAMAIS attendre ces commits ici (voir le commentaire détaillé dans
  // saveSales()) — l'ajout/la modification d'un produit ne doit jamais rester bloqué(e)
  // à l'écran en attendant le réseau. Tout se termine en arrière-plan ; l'échec éventuel
  // est simplement journalisé (pas de retour en arrière ici : products.js retentera de
  // lui-même la prochaine fois que ce produit sera modifié, puisque syncedProductsSnapshot
  // ne reflète alors plus fidèlement ce qui est vraiment confirmé côté serveur — un léger
  // désaccord temporaire préférable à bloquer l'utilisateur).
  (async ()=>{
    try{
      for(let i=0; i<ops.length; i+=450){
        const chunk = ops.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(op=>{ op.isCreate ? batch.set(op.ref, op.data) : batch.update(op.ref, op.data); });
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
      console.error('Erreur synchronisation produits', e);
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
