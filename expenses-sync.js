/* =========================================================================
   SYNCHRONISATION DES DÉPENSES — étape 2 du chantier de sécurité par rôle,
   suite (voir sales-sync.js / products-sync.js / debts-sync.js pour le même
   principe général, et la note en bas de firestore.rules pour le contexte
   complet).
   ---------------------------------------------------------------------------
   Comme une vente, une dépense n'est JAMAIS modifiée après sa création —
   juste créée, puis éventuellement supprimée (voir deleteExpenseHistoryEntry
   dans products.js et deleteHistoryEntry dans helpers.js) — donc ce fichier
   reprend directement le modèle de sales-sync.js (syncedExpenseIds au lieu
   d'un diff champ par champ comme pour les produits ou les dettes).

   DIFFÉRENCE DE RÔLE avec les ventes/dettes : canManageExpenses() renvoie
   TOUJOURS vrai (patron, caissier ET magasinier peuvent enregistrer une
   dépense — une dépense n'est pas réservée à qui peut vendre), alors que
   seul canDeleteExpense() = isPatron() restreint la suppression. Les règles
   Firestore ci-dessous (voir firestore.rules) reflètent exactement ça :
   n'importe quel rôle lié peut créer une dépense pour SA boutique assignée,
   mais seul le patron peut en supprimer une.

   COMPATIBILITÉ ET HORS LIGNE : mêmes principes que sales-sync.js — reprise
   unique des dépenses de l'ancien format (storesData.{storeId}.expenses) au
   premier chargement après la mise à jour, cache local Firestore qui fait
   continuer à fonctionner onSnapshot hors connexion une fois qu'un premier
   chargement en ligne a eu lieu, et purge à 13 mois (archiveOldData() dans
   data-catalog.js) qui continue de fonctionner sans changement : elle
   raccourcit le tableau local "expenses" puis appelle saveExpenses(), qui
   déduit lui-même qu'il doit supprimer ces entrées côté Firestore.
   ========================================================================= */

let expensesListenerUnsub = null;
let syncedExpenseIds = new Set(); // dépenses déjà confirmées présentes côté Firestore — sert à calculer le delta à chaque saveExpenses()

function expensesCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('expenses');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachExpensesListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachExpensesListener();
  syncedExpenseIds = new Set();
  expensesListenerUnsub = expensesCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].expenses) || [];
      if(legacy.length > 0){
        await migrateLegacyExpenses(ownerUid, storeId, legacy);
        return;
      }
    }
    expenses = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId; // champ technique de routage, pas une propriété de la dépense elle-même
      data.id = d.id;
      return data;
    });
    syncedExpenseIds = new Set(expenses.map(e=>e.id));
    localSet('mombongo:expenses', JSON.stringify(expenses));
    if(typeof renderExpensesHistory === 'function') renderExpensesHistory();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute dépenses', e);
  });
}
function detachExpensesListener(){
  if(expensesListenerUnsub){ expensesListenerUnsub(); expensesListenerUnsub = null; }
}

/* ---------- Reprise unique des dépenses de l'ancien format ---------- */
async function migrateLegacyExpenses(ownerUid, storeId, legacyExpenses){
  try{
    const col = expensesCollectionRef(ownerUid);
    for(let i=0; i<legacyExpenses.length; i+=450){
      const chunk = legacyExpenses.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(ex=>{ batch.set(col.doc(ex.id), Object.assign({}, ex, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des dépenses existantes', e);
  }
}

/* ---------- Sauvegarde : n'envoie que ce qui a réellement changé ---------- */
// Remplace l'ancien saveExpenses() de data-catalog.js (pushToCloud() n'inclut plus
// "expenses"). Aucun appelant n'a besoin de changer : mêmes call sites qu'avant
// (debts-expenses-alerts.js, products.js, export.js, archiveOldData()...), cette
// fonction déduit elle-même quelles dépenses sont nouvelles ou supprimées en comparant
// le tableau local à syncedExpenseIds, tenu à jour par attachExpensesListener() ci-dessus.
async function saveExpenses(){
  localSet('mombongo:expenses', JSON.stringify(expenses));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(expenses.map(e=>e.id));
  const toAdd = expenses.filter(e=>!syncedExpenseIds.has(e.id));
  const toRemove = [...syncedExpenseIds].filter(id=>!currentIds.has(id));
  if(toAdd.length === 0 && toRemove.length === 0) return;

  const col = expensesCollectionRef(ownerUid);

  // Marqué "synchronisé" tout de suite, de façon optimiste — même raison que dans
  // saveSales() (sales-sync.js).
  toAdd.forEach(e=>syncedExpenseIds.add(e.id));
  toRemove.forEach(id=>syncedExpenseIds.delete(id));

  // CRITIQUE : ne JAMAIS attendre ce commit ici — même raison détaillée dans saveSales().
  (async ()=>{
    try{
      for(let i=0; i<toAdd.length; i+=450){
        const chunk = toAdd.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(e=>{ batch.set(col.doc(e.id), Object.assign({}, e, { storeId })); });
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
      console.error('Erreur synchronisation dépenses', e);
      toAdd.forEach(e2=>syncedExpenseIds.delete(e2.id));
      toRemove.forEach(id=>syncedExpenseIds.add(id));
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
