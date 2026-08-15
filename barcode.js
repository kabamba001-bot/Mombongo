/* =========================================================================
   SCAN DE CODE-BARRES — fonctionnalité VIP
   ---------------------------------------------------------------------------
   Utilise la caméra du téléphone pour lire un code-barres (bibliothèque
   html5-qrcode, chargée via CDN dans index.html — supporte EAN-13, EAN-8,
   UPC-A, Code128, entre autres formats produits courants).

   Deux usages, avec le même scanner plein écran :
   - "Ajouter" : le code capté est mémorisé, puis le formulaire d'ajout de
     produit s'ouvre pour compléter prix/quantité/seuil (voir
     handleBarcodeForAdd -> openAddSheet dans products.js, qui récupère
     pendingBarcodeForNewProduct à la sauvegarde).
   - "Vendre" : le code capté est comparé aux codes déjà enregistrés sur les
     produits. S'il correspond, une fiche de confirmation s'ouvre (même
     esprit que la confirmation de vente vocale dans sales.js) avec un +/-
     pour ajuster la quantité avant de valider — pas de vente à l'aveugle
     sur une seule lecture caméra.
   ========================================================================= */

let pendingBarcodeForNewProduct = null; // consommé par addProduct()/addCartonProduct() dans products.js
let pendingBarcodeLookupResult = null;  // 'community' | 'off' | 'none' | null — résultat du DERNIER scan "ajout"
let barcodeScannerInstance = null;
let barcodeScanMode = null;   // 'add' | 'sell'
let pendingBarcodeSale = null; // { product, qty }

function isBarcodeLibraryReady(){
  return typeof Html5Qrcode !== 'undefined';
}

function openBarcodeScanner(mode){
  if(mode === 'add' && !canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(mode === 'sell' && !canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(!isVip){ openLimitSheet('barcode'); return; }
  if(!isBarcodeLibraryReady()){
    showToast(currentLang==='fr' ? "Scanner indisponible (vérifie ta connexion internet)" : "Scanner ezali te (talá connexion)", 4000);
    return;
  }
  barcodeScanMode = mode;
  document.getElementById('barcode-scan-overlay').classList.add('open');
  barcodeScannerInstance = new Html5Qrcode('barcode-scan-region');
  const config = { fps: 10, qrbox: { width: 260, height: 160 } };
  barcodeScannerInstance.start(
    { facingMode: 'environment' },
    config,
    onBarcodeDetected,
    function(){ /* erreurs image par image ignorées : bruit normal pendant la visée */ }
  ).catch(function(){
    showToast(currentLang==='fr' ? "Impossible d'accéder à la caméra." : "Caméra ekoki kofungwama te", 4000);
    closeBarcodeScanner();
  });
}

function closeBarcodeScanner(){
  document.getElementById('barcode-scan-overlay').classList.remove('open');
  const instance = barcodeScannerInstance;
  barcodeScannerInstance = null; // coupé tout de suite pour ignorer une détection qui arriverait entre-temps
  if(instance){
    instance.stop().catch(function(){}).finally(function(){
      try{ instance.clear(); }catch(e){}
    });
  }
}

function onBarcodeDetected(code){
  if(!barcodeScannerInstance) return; // scanner déjà fermé, on ignore les détections tardives
  const mode = barcodeScanMode;
  closeBarcodeScanner();
  if(mode === 'add') handleBarcodeForAdd(code);
  else handleBarcodeForSale(code);
}

async function handleBarcodeForAdd(code){
  const existing = products.find(function(p){ return p.barcode === code; });
  if(existing){
    // Ce code existe déjà sur un autre produit — on ouvre sa fiche pour corriger plutôt
    // que de créer un doublon avec le même code-barres.
    showToast((currentLang==='fr' ? "Ce code est déjà utilisé par : " : "Code oyo esalelami na : ") + existing.name, 4000);
    openEditSheet(existing.id);
    return;
  }
  // Le bouton scan vit DANS le formulaire d'ajout, juste à côté des boutons simple/
  // carton/sac (voir index.html) — la feuille est donc déjà ouverte et l'utilisateur a pu
  // choisir "Carton" ou "Sac" AVANT de scanner. On ne réinitialise ni la feuille ni le
  // mode ici : openAddSheet() forçait toujours "produit simple", ce qui renvoyait de
  // force vers ce mode un commerçant en train de scanner un carton ou un sac — bug
  // corrigé. On n'ouvre la feuille que si elle n'était pas déjà ouverte (scan déclenché
  // depuis un autre point d'entrée éventuel, dans le futur).
  if(!document.getElementById('add-overlay').classList.contains('open')){
    openAddSheet();
  }
  pendingBarcodeForNewProduct = code;
  pendingBarcodeLookupResult = null;
  // Le nom retrouvé doit atterrir dans le champ visible du mode ACTUELLEMENT choisi —
  // 'in-name' (simple), 'carton-name' ou 'sac-name' — jamais toujours 'in-name'.
  const nameFieldId = addMode === 'carton' ? 'carton-name' : (addMode === 'sac' ? 'sac-name' : 'in-name');
  const badge = document.getElementById('add-barcode-badge');
  const nameField = document.getElementById(nameFieldId);
  const t = dict[currentLang];
  if(badge){
    badge.style.display = 'block';
    badge.textContent = '📷 ' + code + ' — ' + (t.barcodeLookingUpName || 'recherche du nom…');
  }

  // 1) D'abord le catalogue communautaire Mombongo (voir community-catalog.js) — des
  // produits déjà vus et confirmés localement par d'autres commerçants, bien plus
  // pertinents ici que la base internationale.
  const communityMatch = await lookupBarcodeInCommunityCatalog(code);
  if(pendingBarcodeForNewProduct !== code) return; // le scan a changé entre-temps, on ignore
  if(communityMatch){
    pendingBarcodeLookupResult = 'community';
    if(nameField && !nameField.value.trim()) nameField.value = communityMatch.name;
    if(badge) badge.textContent = '📷 ' + code + ' — ' + communityMatch.name + ' (🌍 ' + t.communityCatalogBadge + ')';
    confirmCommunityCatalogEntry(code); // meilleur effort, fait grandir la confiance dans cette entrée
    return;
  }

  // 2) Repli : Open Food Facts, surtout utile pour les produits de marque importés
  // (boissons, conserves, médicaments importés...) qu'on ne trouvera pas forcément
  // encore dans le catalogue communautaire tant que personne ne les a scannés ici.
  fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=product_name')
    .then(function(r){ return r.json(); })
    .then(function(data){
      // Le code-barres a pu changer entre-temps (nouveau scan pendant que celui-ci cherchait) —
      // on ignore une réponse qui ne correspond plus au scan en cours.
      if(pendingBarcodeForNewProduct !== code) return;
      const foundName = data && data.product && data.product.product_name;
      if(foundName){
        pendingBarcodeLookupResult = 'off';
        if(nameField && !nameField.value.trim()) nameField.value = foundName;
        if(badge) badge.textContent = '📷 ' + code + ' — ' + foundName;
      } else {
        pendingBarcodeLookupResult = 'none';
        if(badge) badge.textContent = '📷 ' + code + (t.barcodeNameNotFound ? (' — ' + t.barcodeNameNotFound) : '');
      }
    })
    .catch(function(){
      if(pendingBarcodeForNewProduct !== code) return;
      pendingBarcodeLookupResult = 'none';
      if(badge) badge.textContent = '📷 ' + code;
    });
}

async function handleBarcodeForSale(code){
  const t = dict[currentLang];
  const product = products.find(function(p){ return p.barcode === code; });
  if(!product){
    // Le produit peut très bien être connu de Mombongo (via le catalogue communautaire)
    // sans être dans LE STOCK de cet utilisateur — ce n'est pas la même chose que "code
    // totalement inconnu", donc le message ne doit pas dire la même chose.
    const communityMatch = await lookupBarcodeInCommunityCatalog(code);
    if(communityMatch){
      showToast(t.barcodeNotInYourStock.replace('{name}', communityMatch.name), 5500);
    } else {
      showToast(t.barcodeUnrecognized, 4000);
    }
    return;
  }
  if(product.qty <= 0){
    showToast((currentLang==='fr' ? "Stock épuisé : " : "Stock esili : ") + product.name, 4000);
    return;
  }
  pendingBarcodeSale = { product: product, qty: 1 };
  renderBarcodeSaleConfirm();
  document.getElementById('barcode-confirm-overlay').classList.add('open');
}

function changeBarcodeSaleQty(delta){
  if(!pendingBarcodeSale) return;
  const product = pendingBarcodeSale.product;
  pendingBarcodeSale.qty = Math.max(1, Math.min(product.qty, pendingBarcodeSale.qty + delta));
  renderBarcodeSaleConfirm();
}

function renderBarcodeSaleConfirm(){
  if(!pendingBarcodeSale) return;
  const product = pendingBarcodeSale.product;
  const qty = pendingBarcodeSale.qty;
  document.getElementById('barcode-confirm-name').textContent = product.name;
  document.getElementById('barcode-confirm-qty').textContent = formatQty(qty, product.unit);
  document.getElementById('barcode-confirm-total').textContent = formatMoney(qty * product.sell);
  document.getElementById('barcode-qty-minus').disabled = qty <= 1;
  document.getElementById('barcode-qty-plus').disabled = qty >= product.qty;
}

function cancelBarcodeSale(){
  pendingBarcodeSale = null;
  document.getElementById('barcode-confirm-overlay').classList.remove('open');
}

// Réutilise exactement le même chemin que la vente vocale confirmée (voir confirmVoiceSale
// dans sales.js) : on prépare le formulaire de vente simple, puis on appelle confirmSale().
async function confirmBarcodeSale(){
  if(!pendingBarcodeSale) return;
  const product = pendingBarcodeSale.product;
  const qty = pendingBarcodeSale.qty;
  sellingProductId = product.id;
  document.getElementById('in-sell-qty').value = qty;
  document.getElementById('in-is-credit').checked = false;
  document.getElementById('in-is-multi').checked = false;
  document.getElementById('single-sale-fields').style.display = 'block';
  document.getElementById('multi-fields').style.display = 'none';
  document.getElementById('in-has-debt').checked = false;
  document.getElementById('barcode-confirm-overlay').classList.remove('open');
  pendingBarcodeSale = null;
  await confirmSale();
}

// Les boutons restent visibles selon la permission de rôle uniquement — le scan
// code-barres est gratuit pour tous les utilisateurs Mombongo. Appelée depuis
// applyTranslations() (stores-devices.js) pour rester à jour à chaque connexion/langue.
function updateBarcodeButtonsVisibility(){
  const addBtn = document.getElementById('barcode-add-btn');
  const sellBtn = document.getElementById('barcode-sale-btn');
  if(addBtn){
    addBtn.style.display = canAddProducts() ? 'inline-flex' : 'none';
    addBtn.textContent = '📷';
    addBtn.title = '';
  }
  if(sellBtn){
    sellBtn.style.display = canSell() ? 'inline-flex' : 'none';
    sellBtn.textContent = '📷';
    sellBtn.title = '';
  }
}

// Le statut VIP peut changer sans passage par applyTranslations() (connexion, promo gagnée,
// déconnexion...) — on se greffe sur render() comme le fait déjà updateBackupBanner() dans
// account-cloud.js, plutôt que de modifier render.js, pour rester à jour partout sans risquer
// de casser le rendu principal.
window.addEventListener('load', function(){
  if(typeof render === 'function' && !render.__barcodeButtonsWrapped){
    const _originalRenderForBarcode = render;
    render = function(){
      _originalRenderForBarcode.apply(this, arguments);
      updateBarcodeButtonsVisibility();
    };
    render.__barcodeButtonsWrapped = true;
  }
  updateBarcodeButtonsVisibility();
});
