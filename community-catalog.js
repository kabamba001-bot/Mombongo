/* =========================================================================
   CATALOGUE COMMUNAUTAIRE MOMBONGO
   ---------------------------------------------------------------------------
   Open Food Facts (voir barcode.js) connaît surtout des produits de marque
   internationaux — très incomplet pour ce qui se vend réellement dans une
   boutique, pharmacie ou quincaillerie locale. Ce fichier ajoute un second
   catalogue, stocké dans Firestore (/mombongo_catalog/{barcode}) et PARTAGÉ
   entre tous les utilisateurs Mombongo : quand quelqu'un scanne un produit
   que personne n'a encore vu, on lui demande son nom (déjà fait, via le
   formulaire d'ajout) et sa catégorie, puis on l'ajoute au catalogue commun.
   La prochaine personne qui scanne ce même code-barres — même dans une autre
   boutique, une autre ville — le retrouve instantanément. Plus Mombongo a
   d'utilisateurs actifs, plus ce catalogue devient complet et utile pour
   tout le monde : c'est la croissance organique recherchée.

   Priorité de recherche lors d'un scan "Ajouter" (voir barcode.js) :
     1. Catalogue communautaire Mombongo (produits confirmés localement)
     2. Open Food Facts (repli pour les produits de marque importés)
     3. Si aucun des deux : on demande le nom (déjà le cas) puis la catégorie,
        et on verse la nouvelle entrée au catalogue communautaire.

   Ce catalogue alimente aussi, sans action supplémentaire de l'utilisateur,
   les suggestions de saisie et l'"Ajout rapide depuis le catalogue" (voir
   getFullCatalogForActiveStore() dans data-catalog.js) : un produit ajouté
   via scan par n'importe quel utilisateur peut ensuite être ajouté par
   n'importe quel autre utilisateur du même TYPE de commerce, en tapant
   juste les premières lettres — sans jamais avoir eu à le scanner lui-même.
   ========================================================================= */

let communityCatalogCache = {};          // { boutique: [...noms], pharmacie: [...], quincaillerie: [...], autre: [...] }
let communityCatalogFetchedCategory = null;

function activeStoreCategory(){
  // myStoreType (voir config.js) répond directement à "quel est ton métier ?", sans
  // dépendre du multi-boutique (Pro) — c'est la source qui doit gagner dès qu'elle
  // existe. store.type ne reste utile que pour un compte Pro qui gère plusieurs
  // boutiques de métiers DIFFÉRENTS (ex. une pharmacie ET une quincaillerie) — dans ce
  // cas précis, le type de la boutique active prime sur le réglage global.
  const store = stores.find(s=>s.id===activeStoreId);
  if(store && store.type) return store.type;
  if(myStoreType) return myStoreType;
  return 'autre';
}

function getCommunityCatalogNames(){
  return communityCatalogCache[activeStoreCategory()] || [];
}

// Chargé une fois par catégorie et par session (pas la peine de re-télécharger à
// chaque ouverture du formulaire). Toujours en meilleur effort, jamais bloquant :
// si ça échoue (hors ligne, règles Firestore pas encore publiées...), le formulaire
// continue de fonctionner normalement avec le catalogue statique + les suggestions
// personnelles habituelles — ce fichier n'ajoute qu'une source de plus, il n'en
// retire aucune.
async function loadCommunityCatalogForActiveStore(){
  if(!cloudEnabled || !db) return;
  const category = activeStoreCategory();
  if(communityCatalogFetchedCategory === category) return;
  try{
    const snap = await db.collection('mombongo_catalog').where('category','==',category).limit(500).get();
    communityCatalogCache[category] = snap.docs.map(d=>d.data().name).filter(Boolean);
    communityCatalogFetchedCategory = category;
    // La requête est asynchrone : si le formulaire d'ajout est encore ouvert au moment
    // où la réponse arrive, on rafraîchit les suggestions pour l'inclure tout de suite,
    // au lieu d'attendre que l'utilisateur rouvre le formulaire une prochaine fois.
    const addOverlay = document.getElementById('add-overlay');
    if(addOverlay && addOverlay.classList.contains('open') && typeof updateProductNameSuggestions === 'function'){
      updateProductNameSuggestions();
    }
  }catch(e){ /* silencieux — voir commentaire ci-dessus */ }
}

/* ---------- Recherche par code-barres (scan "Ajouter", voir barcode.js) ---------- */
async function lookupBarcodeInCommunityCatalog(code){
  if(!cloudEnabled || !db) return null;
  try{
    const doc = await db.collection('mombongo_catalog').doc(code).get();
    if(!doc.exists) return null;
    const data = doc.data();
    if(!data || !data.name) return null;
    return { name: data.name, category: data.category };
  }catch(e){ return null; }
}

// Meilleur effort : quelqu'un qui retrouve ce même code-barres confirme simplement que
// l'entrée existante est correcte (un compteur qui grandit avec l'usage). Les règles
// Firestore n'autorisent JAMAIS cette écriture à changer le nom ou la catégorie déjà
// enregistrés — seul confirmCount peut bouger après la création de l'entrée.
async function confirmCommunityCatalogEntry(code){
  if(!cloudEnabled || !db || !firebase.auth().currentUser) return;
  try{
    await db.collection('mombongo_catalog').doc(code).update({
      confirmCount: firebase.firestore.FieldValue.increment(1)
    });
  }catch(e){ /* silencieux */ }
}

async function contributeToCommunityCatalog(code, name, category){
  if(!cloudEnabled || !db || !firebase.auth().currentUser) return;
  try{
    await db.collection('mombongo_catalog').doc(code).set({
      name, category, confirmCount: 1, addedAt: Date.now()
    });
  }catch(e){
    // Ex : quelqu'un d'autre vient de créer ce code-barres entre-temps avec un nom
    // différent — le produit local de l'utilisateur reste correct dans tous les cas ;
    // seule la contribution au catalogue partagé échoue silencieusement.
  }
}

/* ---------- Feuille "à quelle catégorie appartient ce produit ?" ----------
   Construite dynamiquement (comme le reçu de vente, voir receipt.js) pour ne rien
   ajouter au HTML existant. Ne s'affiche que pour un produit ajouté par scan et que
   NI le catalogue communautaire NI Open Food Facts n'ont reconnu — voir
   maybeContributeScannedProduct(), appelée depuis products.js après l'enregistrement. */
let pendingCategoryPromptCallback = null;

function ensureCategoryPromptDom(){
  if(document.getElementById('category-prompt-overlay')) return;
  const style = document.createElement('style');
  style.textContent = `
    #category-prompt-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.45);
      display:none;align-items:flex-end;justify-content:center;}
    #category-prompt-overlay.open{display:flex;}
    #category-prompt-card{background:var(--paper,#fff);width:100%;max-width:480px;border-radius:16px 16px 0 0;
      padding:20px 18px 24px;font-family:inherit;box-shadow:0 -4px 20px rgba(0,0,0,.2);}
    #category-prompt-card .cp-title{font-weight:700;font-size:16px;margin-bottom:4px;}
    #category-prompt-card .cp-desc{font-size:13px; color:var(--charcoal-soft,#777); line-height:1.5; margin-bottom:14px;}
    #category-prompt-card button.cp-opt{display:block;width:100%;border:none;border-radius:10px;padding:12px;
      font-size:14.5px;font-weight:600;cursor:pointer;margin-bottom:8px;background:var(--paper-2,#f0ece0);text-align:left;}
    #category-prompt-card .cp-skip{background:transparent;color:var(--charcoal-soft,#777);margin-bottom:0;font-weight:500;width:100%;
      border:none;padding:10px;font-size:14px;cursor:pointer;}
  `;
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'category-prompt-overlay';
  overlay.innerHTML = `
    <div id="category-prompt-card">
      <div class="cp-title" id="category-prompt-title"></div>
      <div class="cp-desc" id="category-prompt-desc"></div>
      <button type="button" class="cp-opt" data-cat="boutique"></button>
      <button type="button" class="cp-opt" data-cat="pharmacie"></button>
      <button type="button" class="cp-opt" data-cat="quincaillerie"></button>
      <button type="button" class="cp-opt" data-cat="autre"></button>
      <button type="button" class="cp-skip" id="category-prompt-skip"></button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e){ if(e.target === overlay) closeCategoryPromptSheet(); });
  overlay.querySelectorAll('.cp-opt').forEach(function(btn){
    btn.addEventListener('click', function(){
      const cat = btn.dataset.cat;
      closeCategoryPromptSheet();
      if(pendingCategoryPromptCallback) pendingCategoryPromptCallback(cat);
      pendingCategoryPromptCallback = null;
    });
  });
  document.getElementById('category-prompt-skip').addEventListener('click', function(){
    closeCategoryPromptSheet();
    pendingCategoryPromptCallback = null; // l'utilisateur préfère ne pas contribuer cette fois-ci
  });
}
function openCategoryPromptSheet(onChoose, titleKey, descKey){
  const t = dict[currentLang];
  ensureCategoryPromptDom();
  pendingCategoryPromptCallback = onChoose;
  document.getElementById('category-prompt-title').textContent = t[titleKey] || t.categoryPromptTitle;
  document.getElementById('category-prompt-desc').textContent = t[descKey] || t.categoryPromptDesc;
  document.querySelector('#category-prompt-card .cp-opt[data-cat="boutique"]').textContent = t.storeTypeBoutique;
  document.querySelector('#category-prompt-card .cp-opt[data-cat="pharmacie"]').textContent = t.storeTypePharmacie;
  document.querySelector('#category-prompt-card .cp-opt[data-cat="quincaillerie"]').textContent = t.storeTypeQuincaillerie;
  document.querySelector('#category-prompt-card .cp-opt[data-cat="autre"]').textContent = t.storeTypeAutre;
  document.getElementById('category-prompt-skip').textContent = t.categoryPromptSkip;
  document.getElementById('category-prompt-overlay').classList.add('open');
}
function closeCategoryPromptSheet(){
  const el = document.getElementById('category-prompt-overlay');
  if(el) el.classList.remove('open');
}

/* ---------- Type de commerce universel (voir myStoreType, config.js) ----------
   Décorrélé du multi-boutique (Pro) : n'importe quel compte, gratuit ou payant, hors
   ligne ou connecté, peut répondre à "quel est ton métier ?" pour débloquer le bon
   catalogue partagé dans "Ajout rapide depuis le catalogue" (voir openBulkCatalogSheet()
   dans products.js, seul point d'entrée actuel). */
function setMyStoreType(type){
  myStoreType = type;
  localSet('mombongo:storeType', type);
  // Si un compte Google avec au moins une boutique existe déjà (aucune n'a encore de
  // type — le cas le plus courant, une boutique par défaut créée sans qu'on lui ait
  // jamais demandé) : on le renseigne aussi là, par cohérence si ce compte passe un jour
  // à Pro et se met à gérer plusieurs boutiques. Ne redéfinit jamais un type déjà choisi
  // explicitement pour une boutique précise (voir openNewStoreSheet()).
  if(typeof stores !== 'undefined' && stores.length && !stores[0].type){
    stores[0].type = type;
    if(typeof pushToCloud === 'function') pushToCloud();
  }
  // Le catalogue communautaire déjà mis en cache correspondait à l'ancienne catégorie
  // ('autre' par défaut) — on force un rechargement pour la nouvelle.
  communityCatalogFetchedCategory = null;
}

/* ---------- Point d'entrée : appelé depuis products.js juste après l'enregistrement
   d'un produit ajouté par scan, uniquement si ce code-barres n'a été reconnu ni par
   le catalogue communautaire ni par Open Food Facts (lookupResult === 'none'). ---------- */
function maybeContributeScannedProduct(barcode, name, lookupResult){
  if(!barcode || lookupResult !== 'none' || !name) return;
  openCategoryPromptSheet(function(category){
    contributeToCommunityCatalog(barcode, name, category);
    showToast(dict[currentLang].communityCatalogContributed, 3000);
  });
}
