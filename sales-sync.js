/* =========================================================================
   SYNCHRONISATION DES VENTES — étape 2 du chantier de sécurité par rôle.
   ---------------------------------------------------------------------------
   Avant ce fichier, les ventes étaient un champ de plus dans le même gros
   document que produits/dettes/dépenses (storesData.{storeId}.sales),
   réécrit en entier à chaque sauvegarde. Firestore ne pouvait donc pas
   distinguer "un caissier enregistre une vente" de "quelqu'un modifie
   n'importe quoi d'autre dans ce document" — impossible d'appliquer une
   règle de sécurité différente par rôle. Ce fichier fait vivre les ventes
   dans leur propre collection Firestore (mombongo_users/{ownerUid}/sales),
   avec des règles qui reflètent exactement canSell()/canDeleteSale() (voir
   firestore.rules) : patron et caissier peuvent créer/supprimer une vente,
   le magasinier ne peut ni l'un ni l'autre — même en contournant l'app.

   COMPATIBILITÉ : les ventes déjà enregistrées par des utilisateurs existants
   vivent encore dans l'ancien champ (storesData.{storeId}.sales). La toute
   première fois qu'un compte charge ce fichier après la mise à jour,
   attachSalesListener() constate que la nouvelle collection est vide,
   reprend une fois pour toutes ces anciennes ventes dedans (migrateLegacySales),
   puis n'y touche plus jamais — la nouvelle collection devient alors la seule
   source de vérité, y compris pour cette même boutique la prochaine fois.
   pushToCloud() (stores-devices.js) a été mis à jour pour ne plus jamais
   réécrire l'ancien champ "sales" — il reste figé tel quel après la
   migration, uniquement comme trace, jamais relu.

   HORS LIGNE : Firestore garde automatiquement en cache local (IndexedDB,
   via enablePersistence() dans config.js) le résultat de la requête ci-
   dessous, donc onSnapshot continue de fonctionner hors connexion une fois
   qu'un premier chargement en ligne a eu lieu — comme le reste de l'app.
   ========================================================================= */

let salesListenerUnsub = null;
let syncedSaleIds = new Set(); // ventes déjà confirmées présentes côté Firestore — sert à calculer le delta à chaque saveSales()

function salesCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('sales');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachSalesListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachSalesListener();
  syncedSaleIds = new Set();
  salesListenerUnsub = salesCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      // Peut vouloir dire "aucune vente" OU "pas encore migré" — on vérifie l'ancien
      // champ avant de conclure. migrateLegacySales() déclenche elle-même un nouveau
      // snapshot une fois terminée (on s'arrête là pour cette passe-ci).
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].sales) || [];
      if(legacy.length > 0){
        await migrateLegacySales(ownerUid, storeId, legacy);
        return;
      }
    }
    sales = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId; // champ technique de routage, pas une propriété de la vente elle-même
      data.id = d.id;
      return data;
    });
    syncedSaleIds = new Set(sales.map(s=>s.id));
    localSet('mombongo:sales', JSON.stringify(sales));
    if(typeof renderHistory === 'function') renderHistory();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute ventes', e);
  });
}
function detachSalesListener(){
  if(salesListenerUnsub){ salesListenerUnsub(); salesListenerUnsub = null; }
}

/* ---------- Reprise unique des ventes de l'ancien format ---------- */
async function migrateLegacySales(ownerUid, storeId, legacySales){
  try{
    const col = salesCollectionRef(ownerUid);
    // Lots de 450 pour rester sous la limite de 500 écritures par batch Firestore.
    for(let i=0; i<legacySales.length; i+=450){
      const chunk = legacySales.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(s=>{ batch.set(col.doc(s.id), Object.assign({}, s, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des ventes existantes', e);
  }
}

/* ---------- Sauvegarde : n'envoie que ce qui a réellement changé ---------- */
// Remplace l'ancien saveSales() de data-catalog.js (pushToCloud() n'inclut plus "sales").
// Aucun appelant n'a besoin de changer : mêmes call sites qu'avant (sales.js, helpers.js...),
// cette fonction déduit elle-même quelles ventes sont nouvelles ou supprimées en comparant
// le tableau local à syncedSaleIds, tenu à jour par attachSalesListener() ci-dessus.
async function saveSales(){
  localSet('mombongo:sales', JSON.stringify(sales));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(sales.map(s=>s.id));
  const toAdd = sales.filter(s=>!syncedSaleIds.has(s.id));
  const toRemove = [...syncedSaleIds].filter(id=>!currentIds.has(id));
  if(toAdd.length === 0 && toRemove.length === 0) return;

  const col = salesCollectionRef(ownerUid);
  const batch = db.batch();
  toAdd.forEach(s=>{ batch.set(col.doc(s.id), Object.assign({}, s, { storeId })); });
  toRemove.forEach(id=>{ batch.delete(col.doc(id)); });

  // Marqué "synchronisé" tout de suite, de façon optimiste — sinon une deuxième vente
  // juste après celle-ci recalculerait le même delta et l'enverrait deux fois avant que
  // le premier envoi n'ait eu le temps de se terminer.
  toAdd.forEach(s=>syncedSaleIds.add(s.id));
  toRemove.forEach(id=>syncedSaleIds.delete(id));

  // CRITIQUE : ne JAMAIS attendre ce commit ici. La fermeture de la fiche de vente, le
  // toast de confirmation et la mise à jour des chiffres à l'écran ne doivent jamais
  // dépendre de la vitesse du réseau — exactement comme le faisait déjà pushToCloud()
  // avant cette migration. La synchro continue en arrière-plan, sans bloquer l'interface ;
  // en cas d'échec réel, on annule l'optimisme ci-dessus pour que ça se retente tout seul
  // au prochain saveSales().
  batch.commit().then(()=>{
    lastSyncOk = true;
    updateSyncStatusUI();
  }).catch((e)=>{
    console.error('Erreur synchronisation ventes', e);
    toAdd.forEach(s=>syncedSaleIds.delete(s.id));
    toRemove.forEach(id=>syncedSaleIds.add(id));
    lastSyncOk = false;
    lastSyncErrorMsg = e.code || e.message || String(e);
    updateSyncStatusUI();
  });
}
