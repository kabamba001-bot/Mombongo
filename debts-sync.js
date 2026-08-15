/* =========================================================================
   SYNCHRONISATION DES DETTES — étape 2 du chantier de sécurité par rôle,
   suite (voir sales-sync.js et products-sync.js pour le même principe
   général, et la note en bas de firestore.rules pour le contexte complet).
   ---------------------------------------------------------------------------
   Avant ce fichier, une dette était un champ de plus dans storesData.{storeId},
   réécrit en entier à CHAQUE sauvegarde de n'importe quelle donnée de la
   boutique (produits, dépenses, journal d'activité...) — impossible pour
   Firestore de distinguer "un caissier encaisse un remboursement" de "autre
   chose a changé dans la boutique", donc impossible d'appliquer une règle
   différente par rôle rien que pour les dettes. Ce fichier fait vivre les
   dettes dans leur propre collection Firestore (mombongo_users/{ownerUid}/
   debts), avec des règles qui reflètent exactement canSell()/canRepayDebt()/
   isPatron() (voir firestore.rules) : patron et caissier peuvent créer une
   dette (vente à crédit) et la modifier (remboursement, correction du nom/
   téléphone/échéance) ; seul le patron peut la supprimer. Un magasinier n'a
   même plus le droit de LIRE les dettes — cohérent avec openDebtsSheet(),
   qui lui refuse déjà l'accès côté interface (voir debts-expenses-alerts.js).

   DIFFÉRENCE AVEC LES VENTES : une dette change souvent EN PLACE
   (remboursements successifs, correction d'un champ) — contrairement à
   saveSales() (crée/supprime uniquement), saveDebts() doit donc aussi savoir
   ENVOYER UNE MISE À JOUR. syncedDebtsSnapshot ci-dessous joue le même rôle
   que syncedProductsSnapshot dans products-sync.js, mais SANS avoir besoin
   de calculer un delta champ par champ : contrairement à un produit, une
   dette n'a pas de champs réservés à un rôle en particulier — patron et
   caissier ont tous les deux le droit d'écrire n'importe quel champ d'une
   dette — donc on renvoie simplement le document entier dès qu'il a changé.

   COMPATIBILITÉ ET HORS LIGNE : mêmes principes que sales-sync.js — reprise
   unique des dettes de l'ancien format (storesData.{storeId}.debts) au
   premier chargement après la mise à jour, et cache local Firestore qui
   fait continuer à fonctionner onSnapshot hors connexion une fois qu'un
   premier chargement en ligne a eu lieu.
   ========================================================================= */

let debtsListenerUnsub = null;
let syncedDebtsSnapshot = {}; // { [debtId]: <dernier état confirmé côté Firestore> } — sert à savoir quoi renvoyer

function debtsCollectionRef(ownerUid){
  return db.collection('mombongo_users').doc(ownerUid).collection('debts');
}

/* ---------- Écoute en temps réel, scopée à UNE boutique ---------- */
function attachDebtsListener(ownerUid, storeId){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  detachDebtsListener();
  syncedDebtsSnapshot = {};
  debtsListenerUnsub = debtsCollectionRef(ownerUid).where('storeId','==',storeId).onSnapshot(async (snap)=>{
    if(snap.empty){
      // Peut vouloir dire "aucune dette" OU "pas encore migré" — on vérifie l'ancien
      // champ avant de conclure, exactement comme attachSalesListener().
      const legacy = (storesDataCache[storeId] && storesDataCache[storeId].debts) || [];
      if(legacy.length > 0){
        await migrateLegacyDebts(ownerUid, storeId, legacy);
        return;
      }
    }
    debts = snap.docs.map(d=>{
      const data = Object.assign({}, d.data());
      delete data.storeId; // champ technique de routage, pas une propriété de la dette elle-même
      data.id = d.id;
      return data;
    });
    syncedDebtsSnapshot = {};
    debts.forEach(d=>{ syncedDebtsSnapshot[d.id] = Object.assign({}, d); });
    localSet('mombongo:debts', JSON.stringify(debts));
    // Empêche toute résurrection de dettes supprimées — voir cleanupLegacyField() dans
    // helpers.js et le commentaire détaillé dans sales-sync.js (même bug, même correctif).
    if(storesDataCache[storeId] && storesDataCache[storeId].debts){
      delete storesDataCache[storeId].debts;
    }
    cleanupLegacyField(ownerUid, storeId, 'debts');
    if(typeof renderDebtsList === 'function') renderDebtsList();
    if(typeof render === 'function') render();
  }, (e)=>{
    console.error('Erreur écoute dettes', e);
  });
}
function detachDebtsListener(){
  if(debtsListenerUnsub){ debtsListenerUnsub(); debtsListenerUnsub = null; }
}

/* ---------- Reprise unique des dettes de l'ancien format ---------- */
async function migrateLegacyDebts(ownerUid, storeId, legacyDebts){
  try{
    const col = debtsCollectionRef(ownerUid);
    // Lots de 450 pour rester sous la limite de 500 écritures par batch Firestore.
    for(let i=0; i<legacyDebts.length; i+=450){
      const chunk = legacyDebts.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(d=>{ batch.set(col.doc(d.id), Object.assign({}, d, { storeId })); });
      await batch.commit();
    }
  }catch(e){
    console.error('Erreur migration des dettes existantes', e);
  }
}

/* ---------- Sauvegarde : renvoie chaque dette qui a réellement changé ---------- */
// Remplace l'ancien saveDebts() de data-catalog.js (pushToCloud() n'inclut plus "debts").
// Aucun appelant n'a besoin de changer : mêmes call sites qu'avant (sales.js,
// debts-expenses-alerts.js, export.js...), cette fonction déduit elle-même quelles
// dettes sont nouvelles, modifiées ou supprimées en comparant le tableau local à
// syncedDebtsSnapshot, tenu à jour par attachDebtsListener() ci-dessus.
async function saveDebts(){
  localSet('mombongo:debts', JSON.stringify(debts));
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  if(isEmployeeMode && !employeeSyncReady) return;
  const storeId = getActiveStoreIdForWrites();
  if(!storeId) return;

  const currentIds = new Set(debts.map(d=>d.id));
  const removedIds = Object.keys(syncedDebtsSnapshot).filter(id=>!currentIds.has(id));
  const toWrite = debts.filter(d=>JSON.stringify(d) !== JSON.stringify(syncedDebtsSnapshot[d.id]));
  if(toWrite.length === 0 && removedIds.length === 0) return;

  const col = debtsCollectionRef(ownerUid);

  // Marqué "synchronisé" tout de suite, de façon optimiste — même raison que dans
  // saveSales()/saveProducts() : éviter qu'un deuxième remboursement juste après
  // celui-ci recalcule le même delta et l'envoie deux fois avant la fin du premier envoi.
  toWrite.forEach(d=>{ syncedDebtsSnapshot[d.id] = Object.assign({}, d); });
  removedIds.forEach(id=>{ delete syncedDebtsSnapshot[id]; });

  // CRITIQUE : ne JAMAIS attendre ces commits ici — même raison détaillée dans
  // saveSales() (sales-sync.js) : un remboursement ou l'ajout d'une vente à crédit ne
  // doit jamais rester bloqué à l'écran en attendant le réseau. En cas d'échec réel, on
  // annule l'optimisme ci-dessus pour que ça se retente tout seul au prochain saveDebts().
  (async ()=>{
    try{
      for(let i=0; i<toWrite.length; i+=450){
        const chunk = toWrite.slice(i, i+450);
        const batch = db.batch();
        chunk.forEach(d=>{ batch.set(col.doc(d.id), Object.assign({}, d, { storeId })); });
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
      console.error('Erreur synchronisation dettes', e);
      toWrite.forEach(d=>{ delete syncedDebtsSnapshot[d.id]; });
      removedIds.forEach(id=>{ /* on ne peut pas restaurer l'ancien contenu supprimé — le prochain saveDebts() renverra au moins la suppression à nouveau */ });
      lastSyncOk = false;
      lastSyncErrorMsg = e.code || e.message || String(e);
      updateSyncStatusUI();
    }
  })();
}
