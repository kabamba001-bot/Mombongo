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
let pendingBarcodeNameWasUnknown = false; // vrai si ni la base communautaire ni Open Food Facts n'avaient de nom pour ce code
let barcodeScannerInstance = null;
let barcodeScanMode = null;   // 'add' | 'sell'
let pendingBarcodeSale = null; // { product, qty }

function isBarcodeLibraryReady(){
  return typeof Html5Qrcode !== 'undefined';
}

function openBarcodeScanner(mode){
  if(!isVip){ openLimitSheet('barcode'); return; }
  if(mode === 'add' && !canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(mode === 'sell' && !canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
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

/* =========================================================================
   BASE COMMUNAUTAIRE DE NOMS DE PRODUITS (codes-barres locaux)
   ---------------------------------------------------------------------------
   Open Food Facts ne connaît que les produits internationaux — un produit
   local (fabriqué ou reconditionné en RDC, sans code officiellement
   enregistré) n'y figure presque jamais. Cette base comble le trou :
   quand un commerçant tape lui-même le nom d'un code inconnu, ce nom est
   mémorisé dans Firestore (collection "community_barcodes", un document par
   code) pour que TOUS les autres utilisateurs de Mombongo — pas seulement
   lui — reconnaissent automatiquement ce même code au prochain scan.
   Un nom, une fois soumis, n'est plus jamais écrasé par quelqu'un d'autre
   (voir firestore.rules : create seulement, update/delete bloqués) — ça
   évite qu'un scan hâtif ou une faute de frappe remplace un nom correct
   déjà en place.
   ========================================================================= */
async function lookupCommunityBarcodeName(code){
  if(!cloudEnabled || !db) return null;
  try{
    const doc = await db.collection('community_barcodes').doc(code).get();
    return (doc.exists && doc.data().name) ? doc.data().name : null;
  }catch(e){
    return null; // pas grave : on retombe simplement sur Open Food Facts / la saisie manuelle
  }
}

async function maybeContributeBarcodeName(code, name){
  if(!code || !name || !name.trim() || !cloudEnabled || !db) return;
  try{
    // .set() sur un document qui n'existe pas encore est traité comme un "create" par
    // Firestore (voir firestore.rules) — s'il existe déjà (quelqu'un d'autre a contribué
    // entre-temps), la règle bloque la mise à jour et cet appel échoue silencieusement,
    // ce qui est le comportement voulu : le premier nom correct soumis reste définitif.
    await db.collection('community_barcodes').doc(code).set({
      name: name.trim(),
      addedAt: Date.now()
    });
  }catch(e){
    // Écriture refusée (nom déjà présent) ou hors-ligne : sans conséquence pour
    // l'utilisateur, son produit est déjà enregistré localement dans tous les cas.
  }
}

function handleBarcodeForAdd(code){
  const existing = products.find(function(p){ return p.barcode === code; });
  if(existing){
    // Ce code existe déjà sur un autre produit — on ouvre sa fiche pour corriger plutôt
    // que de créer un doublon avec le même code-barres.
    showToast((currentLang==='fr' ? "Ce code est déjà utilisé par : " : "Code oyo esalelami na : ") + existing.name, 4000);
    openEditSheet(existing.id);
    return;
  }
  openAddSheet();
  pendingBarcodeForNewProduct = code;
  pendingBarcodeNameWasUnknown = false; // sera mis à jour une fois les deux sources vérifiées
  const badge = document.getElementById('add-barcode-badge');
  const nameField = document.getElementById('in-name');
  const t = dict[currentLang];
  if(badge){
    badge.style.display = 'block';
    badge.textContent = '📷 ' + code + ' — ' + (t.barcodeLookingUpName || 'recherche du nom…');
  }

  // Étape 1 : la base communautaire Mombongo — spécifique aux produits locaux, donc
  // vérifiée en premier (plus pertinente qu'Open Food Facts pour ce marché, et un
  // appel Firestore est généralement plus rapide qu'un appel à une API externe).
  lookupCommunityBarcodeName(code).then(function(communityName){
    // Le code-barres a pu changer entre-temps (nouveau scan pendant la recherche) —
    // on ignore une réponse qui ne correspond plus au scan en cours.
    if(pendingBarcodeForNewProduct !== code) return;
    if(communityName){
      if(nameField && !nameField.value.trim()) nameField.value = communityName;
      if(badge) badge.textContent = '📷 ' + code + ' — ' + communityName;
      pendingBarcodeNameWasUnknown = false;
      return;
    }
    // Étape 2 : rien dans la base communautaire — on tente Open Food Facts en
    // secours, pour les produits de marque internationale déjà référencés ailleurs
    // dans le monde (boissons, conserves, médicaments importés...). On ne bloque
    // JAMAIS le formulaire en attendant : le commerçant peut déjà taper le nom
    // lui-même pendant que la recherche tourne en arrière-plan, et elle ne remplace
    // le champ que s'il est encore vide au moment où la réponse arrive.
    fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=product_name')
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(pendingBarcodeForNewProduct !== code) return;
        const foundName = data && data.product && data.product.product_name;
        if(foundName){
          if(nameField && !nameField.value.trim()) nameField.value = foundName;
          if(badge) badge.textContent = '📷 ' + code + ' — ' + foundName;
          pendingBarcodeNameWasUnknown = false;
        } else {
          // Ni la base communautaire ni Open Food Facts ne connaissent ce code — très
          // probablement un produit local. On l'indique clairement : le nom que le
          // commerçant va taper sera mémorisé pour que Mombongo reconnaisse ce même
          // code automatiquement au prochain scan, par n'importe quel utilisateur.
          pendingBarcodeNameWasUnknown = true;
          if(badge) badge.textContent = '📷 ' + code + (t.barcodeNameNotFound ? (' — ' + t.barcodeNameNotFound) : '');
        }
      })
      .catch(function(){
        if(pendingBarcodeForNewProduct !== code) return;
        pendingBarcodeNameWasUnknown = true;
        if(badge) badge.textContent = '📷 ' + code + (t.barcodeNameNotFound ? (' — ' + t.barcodeNameNotFound) : '');
      });
  });
}

function handleBarcodeForSale(code){
  const product = products.find(function(p){ return p.barcode === code; });
  if(!product){
    showToast(currentLang==='fr' ? "Produit non reconnu pour ce code-barres." : "Produit eyebani te na code oyo.", 4000);
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
  document.getElementById('barcode-confirm-qty').textContent = qty;
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

// Les boutons restent visibles pour tout le monde (permission de rôle uniquement) — comme les
// autres fonctions VIP de l'app (ex. notifications), on affiche un cadenas plutôt que de les
// cacher : ça montre que la fonctionnalité existe et donne envie de débloquer le VIP. Appelée
// depuis applyTranslations() (stores-devices.js) pour rester à jour à chaque connexion/langue.
function updateBarcodeButtonsVisibility(){
  const t = dict[currentLang];
  const addBtn = document.getElementById('barcode-add-btn');
  const sellBtn = document.getElementById('barcode-sale-btn');
  if(addBtn){
    addBtn.style.display = canAddProducts() ? 'inline-flex' : 'none';
    addBtn.textContent = isVip ? '📷' : '🔒📷';
    addBtn.title = isVip ? '' : t.limitDescBarcode;
  }
  if(sellBtn){
    sellBtn.style.display = canSell() ? 'inline-flex' : 'none';
    sellBtn.textContent = isVip ? '📷' : '🔒📷';
    sellBtn.title = isVip ? '' : t.limitDescBarcode;
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
