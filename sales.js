/* ---------- Vente ---------- */
let multiCart = {}; // { productId: qty } — utilisé seulement quand "vente plusieurs" est actif

/* ---------- Remises / promotions ----------
   Principe : une remise réduit le prix payé par le client, JAMAIS le prix d'achat
   du produit. Le bénéfice enregistré (profit) reste donc toujours revenue - coût,
   recalculé après remise — la marge n'est jamais gonflée ni cachée : une remise de
   500 FC fait baisser le bénéfice de cette vente d'exactement 500 FC, ni plus ni
   moins, quel que soit le prix d'achat du produit. Si la remise dépasse le
   bénéfice, la vente devient une vente à perte assumée — jamais bloquée, mais le
   total ne peut jamais devenir négatif (plafonné à baseTotal).
   Deux formats au choix du vendeur, comme pour la dette (voir in-debt-amount) :
   montant fixe (dans la devise actuellement affichée, via toInternal — pas de
   sélecteur $/FC dédié par souci de simplicité) ou pourcentage du prix de vente. */
function computeDiscountAmount(baseTotal, type, rawValue){
  const raw = parseFloat(rawValue);
  if(isNaN(raw) || raw <= 0 || baseTotal <= 0) return 0;
  const amount = (type === 'percent') ? baseTotal * Math.min(raw, 100) / 100 : toInternal(raw);
  return Math.max(0, Math.min(amount, baseTotal));
}
// Utilisé uniquement à la CONFIRMATION (pas à chaque frappe dans l'aperçu, pour ne
// pas spammer de toast pendant la saisie) : signale que la remise demandée a dû être
// plafonnée, plutôt que de le faire silencieusement. La vente n'est jamais bloquée
// pour autant — plafonner à 100% du total (article offert) reste une décision
// légitime du vendeur.
function discountExceedsTotal(baseTotal, type, rawValue){
  const raw = parseFloat(rawValue);
  if(isNaN(raw) || raw <= 0 || baseTotal <= 0) return false;
  const amount = (type === 'percent') ? baseTotal * raw / 100 : toInternal(raw);
  return amount > baseTotal + 0.01;
}

/* ---- Remise vente simple ---- */
let saleDiscountType = 'amount';
function setSaleDiscountType(type){
  saleDiscountType = type;
  document.querySelectorAll('#discount-type-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.type===type));
  updateSellPreview();
}
function toggleSaleDiscountFields(){
  const cb = document.getElementById('in-has-discount');
  if(cb.checked && !isFeatureUnlocked('saleDiscounts')){
    cb.checked = false;
    openLimitSheet('discount');
    return;
  }
  document.getElementById('discount-fields').style.display = cb.checked ? 'block' : 'none';
  if(!cb.checked) document.getElementById('in-discount-value').value = '';
  updateSellPreview();
}

/* ---- Remise par produit + remise globale, panier "vente plusieurs" ----
   multiCartDiscounts est le pendant, pour les remises, de multiCart pour les
   quantités : { productId: { type:'amount'|'percent', value: <texte brut saisi> } }.
   Nettoyé au même rythme que multiCart (produit retiré du panier = sa remise
   éventuelle disparaît aussi, sinon elle réapparaîtrait si le produit est
   resélectionné plus tard dans la même vente). */
let multiCartDiscounts = {};
let multiGlobalDiscountType = 'amount';
function setGlobalDiscountType(type, btn){
  multiGlobalDiscountType = type;
  document.querySelectorAll('#global-discount-type-toggle button').forEach(b=>b.classList.toggle('active', b===btn));
  updateMultiTotal();
}
function toggleGlobalDiscountFields(){
  const cb = document.getElementById('in-has-global-discount');
  if(cb.checked && !isFeatureUnlocked('saleDiscounts')){
    cb.checked = false;
    openLimitSheet('discount');
    return;
  }
  document.getElementById('global-discount-fields').style.display = cb.checked ? 'block' : 'none';
  if(!cb.checked) document.getElementById('in-global-discount-value').value = '';
  updateMultiTotal();
}

function openSellSheet(id){
  if(!canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(typeof isProductFrozen === 'function' && isProductFrozen(id, products)){
    showToast(dict[currentLang].productFrozenMsg, 5000);
    return;
  }
  sellingProductId = id;
  const sellingProduct = products.find(p=>p.id===id);
  const sellingUnit = (sellingProduct && sellingProduct.unit) || 'pc';
  const qtyInput = document.getElementById('in-sell-qty');
  qtyInput.step = unitStep(sellingUnit);
  qtyInput.inputMode = unitInputMode(sellingUnit);
  qtyInput.value = 1;
  document.getElementById('in-is-credit').checked = false;
  document.getElementById('in-client-name').value = '';
  document.getElementById('in-client-phone').value = '';
  setDateValue('in-due-date', '');
  document.getElementById('credit-fields').style.display = 'none';

  document.getElementById('in-has-discount').checked = false;
  document.getElementById('discount-fields').style.display = 'none';
  document.getElementById('in-discount-value').value = '';
  saleDiscountType = 'amount';
  document.querySelectorAll('#discount-type-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.type==='amount'));
  const discountPreviewEl = document.getElementById('discount-preview');
  if(discountPreviewEl) discountPreviewEl.textContent = '';

  document.getElementById('in-is-multi').checked = false;
  document.getElementById('single-sale-fields').style.display = 'block';
  document.getElementById('multi-fields').style.display = 'none';
  document.getElementById('in-multi-search').value = '';
  document.getElementById('in-has-debt').checked = false;
  document.getElementById('debt-fields').style.display = 'none';
  document.getElementById('clear-multi-cart-btn').style.display = 'none';
  document.getElementById('in-debt-amount').value = '';
  document.getElementById('in-debt-client-name').value = '';
  document.getElementById('in-debt-client-phone').value = '';
  setDateValue('in-debt-due-date', '');
  document.getElementById('debt-toggle-row').style.display = 'flex';

  document.getElementById('in-has-global-discount').checked = false;
  document.getElementById('global-discount-fields').style.display = 'none';
  document.getElementById('in-global-discount-value').value = '';
  multiGlobalDiscountType = 'amount';
  document.querySelectorAll('#global-discount-type-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.gdtype==='amount'));

  multiCart = {};
  multiCartDiscounts = {};
  if(id) multiCart[id] = 1; // le produit sur lequel on a tapé "Vendre" est pré-sélectionné si on bascule en multi

  document.getElementById('sell-overlay').classList.add('open');
  updateSellPreview();
}
function closeSellSheet(){
  document.getElementById('sell-overlay').classList.remove('open');
  sellingProductId = null;
}
function toggleCreditFields(){
  const cb = document.getElementById('in-is-credit');
  // Dettes/crédits clients : gratuits et illimités pour tous les paliers, y compris
  // Simple gratuit — voir plans.js (customerDebts n'existe plus comme fonctionnalité
  // à débloquer). Seules les DÉPENSES restent plafonnées sur Simple gratuit (voir
  // openExpenseSheet() dans debts-expenses-alerts.js).
  const isCredit = cb.checked;
  document.getElementById('credit-fields').style.display = isCredit ? 'block' : 'none';
  // Une vente est soit 100% crédit, soit partiellement en dette — pas les deux.
  if(isCredit && document.getElementById('in-has-debt').checked){
    document.getElementById('in-has-debt').checked = false;
    toggleDebtFields();
  }
}
function toggleMultiFields(){
  const isMulti = document.getElementById('in-is-multi').checked;
  document.getElementById('single-sale-fields').style.display = isMulti ? 'none' : 'block';
  document.getElementById('multi-fields').style.display = isMulti ? 'block' : 'none';
  // "Tout supprimer" n'a de sens que sur un panier à plusieurs produits — masqué en
  // vente simple (voir aussi le 🗑️ par produit, dans renderMultiProductRow()).
  document.getElementById('clear-multi-cart-btn').style.display = isMulti ? 'block' : 'none';
  if(isMulti) renderMultiProductList();
  else {
    document.getElementById('in-has-debt').checked = false;
    toggleDebtFields();
  }
}
// Vide entièrement le panier en cours (mode "vente plusieurs") — bouton "🗑️ Tout
// supprimer", sous "Confirmer la vente". Pour retirer UN SEUL produit, voir plutôt le
// 🗑️ affiché sur chaque ligne déjà sélectionnée (renderMultiProductRow()).
function clearMultiCart(){
  multiCart = {};
  multiCartDiscounts = {};
  renderMultiProductList();
}
function toggleDebtFields(){
  const cb = document.getElementById('in-has-debt');
  if(cb.checked && !isFeatureUnlocked('customerDebts')){
    cb.checked = false;
    openLimitSheet('debts');
    return;
  }
  const hasDebt = cb.checked;
  document.getElementById('debt-fields').style.display = hasDebt ? 'block' : 'none';
  if(hasDebt && document.getElementById('in-is-credit').checked){
    document.getElementById('in-is-credit').checked = false;
    toggleCreditFields();
  }
  updateMultiTotal();
}
function changeMultiQty(productId, delta){
  const product = products.find(p=>p.id===productId);
  if(!product) return;
  const current = multiCart[productId] || 0;
  const next = Math.max(0, Math.min(product.qty, current + delta));
  if(next === 0){ delete multiCart[productId]; delete multiCartDiscounts[productId]; }
  else multiCart[productId] = next;
  renderMultiProductList();
}
// Pour les unités décimales (kg/L/m) : un +/- de 1 n'a pas de sens sur du vrac, donc
// saisie directe dans un champ texte plutôt qu'un stepper — voir renderMultiProductList().
// Mise à jour légère (total seulement) à chaque frappe, pour ne pas perdre le focus du
// champ en train d'être tapé ; renderMultiProductList() ne repasse qu'au blur, pour
// normaliser/arrondir l'affichage une fois la saisie terminée.
function setMultiQtyDirect(productId, rawValue){
  const product = products.find(p=>p.id===productId);
  if(!product) return;
  const unit = product.unit || 'pc';
  let qty = parseQtyForUnit(rawValue, unit);
  qty = Math.max(0, Math.min(product.qty, qty));
  if(qty === 0){ delete multiCart[productId]; delete multiCartDiscounts[productId]; }
  else multiCart[productId] = qty;
  updateMultiTotal();
}
/* ---------- Pagination de la liste "vente plusieurs" ----------
   Même esprit que PRODUCTS_PAGE_SIZE dans render.js (tableau de bord principal) : sans
   ça, un catalogue de plusieurs centaines de produits rendrait la fiche de vente lente à
   ouvrir. Les produits DÉJÀ dans le panier restent toujours visibles tout en haut, quelle
   que soit la page affichée — un caissier qui cherche un autre article ne doit jamais
   perdre de vue ce qu'il a déjà sélectionné pour ce client. */
const MULTI_LIST_PAGE_SIZE = 50;
let multiListRevealCount = MULTI_LIST_PAGE_SIZE;
let lastMultiSearchQuery = null;
function loadMoreMultiProducts(){
  multiListRevealCount += MULTI_LIST_PAGE_SIZE;
  renderMultiProductList();
}
function renderMultiProductRow(p, removable){
  const qty = multiCart[p.id] || 0;
  const unit = p.unit || 'pc';
  const row = document.createElement('div');
  row.className = 'multi-product-row' + (p.qty<=0 ? ' out-of-stock' : '') + (removable ? ' has-discount-row' : '');
  const qtyControlHtml = isDecimalUnit(unit)
    ? '<input type="number" class="multi-qty-input" inputmode="decimal" step="' + unitStep(unit) + '" min="0" max="' + p.qty + '" value="' + (qty || '') + '" placeholder="0" data-id="' + p.id + '">'
    : '<div class="qty-stepper">' +
        '<button type="button" data-id="' + p.id + '" data-d="-1"' + (qty<=0?' disabled':'') + '>−</button>' +
        '<span>' + qty + '</span>' +
        '<button type="button" data-id="' + p.id + '" data-d="1"' + (qty>=p.qty?' disabled':'') + '>+</button>' +
      '</div>';
  // 🗑️ uniquement sur les lignes déjà DANS le panier (voir l'appel depuis
  // renderMultiProductList()) — retirer un produit qu'on n'a pas encore sélectionné
  // n'aurait pas de sens, le stepper à 0 suffit pour celles-là.
  const removeBtnHtml = removable
    ? '<button type="button" class="multi-row-remove" data-remove-id="' + p.id + '" aria-label="Retirer">🗑️</button>'
    : '';
  const topRowHtml =
    '<div class="mpr-top">' +
      '<div class="info">' +
        '<div class="name">' + escapeHtml(p.name) + '</div>' +
        '<div class="meta">' + formatMoney(p.sell) + ' · ' + formatQty(p.qty, unit) + ' disponible' + (p.qty>1?'s':'') + '</div>' +
      '</div>' +
      qtyControlHtml + removeBtnHtml +
    '</div>';
  // Remise PAR PRODUIT — seulement affichée pour les lignes déjà dans le panier
  // (removable===true) : régler une remise sur un produit qu'on n'a pas encore
  // choisi de vendre n'aurait pas de sens. Se cumule avec la remise globale du
  // panier (voir global-discount-fields, index.html) — chacune s'applique sur ce
  // qu'il reste après l'autre, jamais les deux sur le même montant.
  let discountRowHtml = '';
  if(removable){
    const t = dict[currentLang];
    const d = multiCartDiscounts[p.id] || { type:'amount', value:'' };
    discountRowHtml =
      '<div class="mpr-discount">' +
        '<div class="disc-type-toggle">' +
          '<button type="button" class="disc-type-btn' + (d.type==='amount'?' active':'') + '" data-disc-type-id="' + p.id + '" data-disc-type="amount">' + (currentCurrency==='usd'?'$':'FC') + '</button>' +
          '<button type="button" class="disc-type-btn' + (d.type==='percent'?' active':'') + '" data-disc-type-id="' + p.id + '" data-disc-type="percent">%</button>' +
        '</div>' +
        '<input type="number" class="mpr-discount-input" inputmode="decimal" min="0" placeholder="' + escapeHtml(t.itemDiscountPlaceholder || 'Remise') + '" value="' + escapeHtml(d.value || '') + '" data-disc-id="' + p.id + '">' +
      '</div>';
  }
  row.innerHTML = topRowHtml + discountRowHtml;
  return row;
}
function renderMultiProductList(){
  const wrap = document.getElementById('multi-product-list');
  const search = document.getElementById('in-multi-search').value.trim().toLowerCase();
  // Une recherche qui change réellement la liste repart de la première page (même
  // logique que la liste principale, voir render.js).
  if(search !== lastMultiSearchQuery){
    multiListRevealCount = MULTI_LIST_PAGE_SIZE;
    lastMultiSearchQuery = search;
  }
  const filtered = products.filter(p=> !search || p.name.toLowerCase().includes(search));
  const selected = filtered.filter(p => (multiCart[p.id]||0) > 0);
  const rest = filtered.filter(p => !(multiCart[p.id]||0) > 0);
  const visibleRest = rest.slice(0, multiListRevealCount);
  wrap.innerHTML = '';
  selected.forEach(p => wrap.appendChild(renderMultiProductRow(p, true)));
  if(selected.length > 0 && visibleRest.length > 0){
    const sep = document.createElement('div');
    sep.className = 'multi-list-separator';
    wrap.appendChild(sep);
  }
  visibleRest.forEach(p => wrap.appendChild(renderMultiProductRow(p, false)));
  const loadMoreBtn = document.getElementById('load-more-multi-btn');
  if(loadMoreBtn){
    const remaining = rest.length - visibleRest.length;
    loadMoreBtn.style.display = remaining > 0 ? 'block' : 'none';
    if(remaining > 0){
      loadMoreBtn.textContent = (dict[currentLang].loadMoreProductsBtn || 'Afficher plus ({n} restants)').replace('{n}', remaining);
    }
  }
  wrap.querySelectorAll('button[data-id]').forEach(btn=>{
    btn.addEventListener('click', ()=> changeMultiQty(btn.dataset.id, parseInt(btn.dataset.d)));
  });
  wrap.querySelectorAll('button[data-remove-id]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ delete multiCart[btn.dataset.removeId]; renderMultiProductList(); });
  });
  wrap.querySelectorAll('input.multi-qty-input').forEach(inp=>{
    inp.addEventListener('input', ()=> setMultiQtyDirect(inp.dataset.id, inp.value));
    inp.addEventListener('blur', ()=> renderMultiProductList());
  });
  wrap.querySelectorAll('button[data-disc-type-id]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(!isFeatureUnlocked('saleDiscounts')){ openLimitSheet('discount'); return; }
      const id = btn.dataset.discTypeId;
      const existing = multiCartDiscounts[id] || { type:'amount', value:'' };
      multiCartDiscounts[id] = { type: btn.dataset.discType, value: existing.value };
      renderMultiProductList();
    });
  });
  wrap.querySelectorAll('input.mpr-discount-input').forEach(inp=>{
    inp.addEventListener('focus', ()=>{
      if(!isFeatureUnlocked('saleDiscounts')){ inp.blur(); openLimitSheet('discount'); }
    });
    inp.addEventListener('input', ()=>{
      if(!isFeatureUnlocked('saleDiscounts')){ inp.value = ''; inp.blur(); openLimitSheet('discount'); return; }
      const id = inp.dataset.discId;
      if(!inp.value){ delete multiCartDiscounts[id]; }
      else {
        const existing = multiCartDiscounts[id] || { type:'amount', value:'' };
        multiCartDiscounts[id] = { type: existing.type, value: inp.value };
      }
      updateMultiTotal();
    });
  });
  updateMultiTotal();
}
// Chaque item porte déjà sa remise PAR PRODUIT (si réglée) : total/profit ci-dessous
// sont donc le prix "après remise ligne", AVANT l'éventuelle remise globale du
// panier — celle-ci est répartie ensuite au prorata (voir updateMultiTotal() et
// confirmMultiSaleInner()), comme le reliquat de dette partielle l'est déjà pour
// le bénéfice (debtProfitShare) un peu plus bas dans ce fichier.
function getMultiCartItems(){
  return Object.keys(multiCart).map(id=>{
    const product = products.find(p=>p.id===id);
    if(!product) return null;
    const qty = multiCart[id];
    const grossTotal = qty*product.sell;
    const grossProfit = qty*(product.sell-product.buy);
    const d = isFeatureUnlocked('saleDiscounts') ? multiCartDiscounts[id] : null;
    const itemDiscount = d ? computeDiscountAmount(grossTotal, d.type, d.value) : 0;
    return {
      product, qty, grossTotal, grossProfit, itemDiscount,
      total: grossTotal - itemDiscount, profit: grossProfit - itemDiscount
    };
  }).filter(Boolean);
}
function updateMultiTotal(){
  const items = getMultiCartItems();
  const subtotal = items.reduce((s,it)=>s+it.total,0);
  const itemDiscountsSum = items.reduce((s,it)=>s+it.itemDiscount,0);
  const hasGlobalDiscount = document.getElementById('in-has-global-discount').checked && isFeatureUnlocked('saleDiscounts');
  const globalDiscountAmount = hasGlobalDiscount
    ? computeDiscountAmount(subtotal, multiGlobalDiscountType, document.getElementById('in-global-discount-value').value)
    : 0;
  const total = subtotal - globalDiscountAmount;
  document.getElementById('multi-total').textContent = formatMoney(total);

  const discountPreviewEl = document.getElementById('multi-discount-preview');
  if(discountPreviewEl){
    const totalDiscount = itemDiscountsSum + globalDiscountAmount;
    discountPreviewEl.textContent = totalDiscount > 0
      ? '−' + formatMoney(totalDiscount) + ' ' + (dict[currentLang].discountLabel || 'remise').toLowerCase()
      : '';
  }

  const debtPreviewEl = document.getElementById('debt-cash-preview');
  if(document.getElementById('in-has-debt').checked){
    const rawDebt = parseFloat(document.getElementById('in-debt-amount').value) || 0;
    const debtAmount = toInternal(rawDebt);
    const cashNow = Math.max(0, total - debtAmount);
    const label = currentLang==='fr' ? 'Payé maintenant : ' : (currentLang==='ln' ? 'Efutami sikoyo : ' : 'Imelipwa sasa : ');
    debtPreviewEl.textContent = label + formatMoney(cashNow);
  } else if(debtPreviewEl){
    debtPreviewEl.textContent = '';
  }
}
function updateSellPreview(){
  const product = products.find(p=>p.id===sellingProductId);
  if(!product) return;
  const qty = parseQtyForUnit(document.getElementById('in-sell-qty').value, product.unit || 'pc');
  const grossTotal = qty * product.sell;
  const grossProfit = qty * (product.sell - product.buy);
  const hasDiscount = document.getElementById('in-has-discount').checked && isFeatureUnlocked('saleDiscounts');
  const discountAmount = hasDiscount
    ? computeDiscountAmount(grossTotal, saleDiscountType, document.getElementById('in-discount-value').value)
    : 0;
  // La remise vient toujours en réduction du BÉNÉFICE, jamais du coût d'achat : le
  // stock a coûté ce qu'il a coûté, seule la marge encaisse la remise consentie.
  const total = grossTotal - discountAmount;
  const profit = grossProfit - discountAmount;
  document.getElementById('preview-total').textContent = formatMoney(total);
  document.getElementById('preview-profit').textContent = formatMoney(profit);
  const discountPreviewEl = document.getElementById('discount-preview');
  if(discountPreviewEl){
    discountPreviewEl.textContent = discountAmount > 0 ? '−' + formatMoney(discountAmount) + ' ' + (dict[currentLang].discountLabel || 'remise').toLowerCase() : '';
  }
}
let saveInProgress = false; // garde-fou partagé contre les doubles clics (vente, produit)

async function confirmSale(){
  if(saveInProgress) return; // un appui précédent est déjà en train d'être traité
  saveInProgress = true;
  try{
    await confirmSaleInner();
  } finally {
    saveInProgress = false;
  }
}
async function confirmSaleInner(){
  if(!canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(document.getElementById('in-is-multi').checked){
    await confirmMultiSaleInner();
    return;
  }
  const product = products.find(p=>p.id===sellingProductId);
  if(!product) return;
  const unit = product.unit || 'pc';
  const qty = parseQtyForUnit(document.getElementById('in-sell-qty').value, unit);
  // Tolérance infime pour absorber l'arrondi flottant sur les unités décimales (kg/L/m) —
  // sans elle, vendre exactement tout le stock restant (ex: 2.50 kg pour 2.50 kg en stock)
  // pourrait être refusé à cause d'un 2.4999999999999996 côté JS.
  if(qty <= 0 || qty > product.qty + 1e-9){
    showToast(currentLang==='fr' ? "Quantité invalide" : "Motángo ekoki te");
    return;
  }
  const isCredit = document.getElementById('in-is-credit').checked;
  if(isCredit && !isFeatureUnlocked('customerDebts')){
    document.getElementById('in-is-credit').checked = false;
    openLimitSheet('debts');
    return;
  }
  const clientName = document.getElementById('in-client-name').value.trim();
  if(isCredit && !clientName){
    showToast(currentLang==='fr' ? "Indique le nom du client pour une vente à crédit" : "Pesa nkombo ya client");
    return;
  }
  const clientPhone = document.getElementById('in-client-phone').value.trim();
  const dueDate = getDateValue('in-due-date');

  if(product.lotId){
    const lot = lots.find(l=>l.id===product.lotId);
    if(lot){
      const fractionConsumed = qty / product.yieldPerSac;
      lot.remainingFraction = Math.max(0, lot.remainingFraction - fractionConsumed);
      recalcLotQuantities(product.lotId);
      products.filter(p=>p.lotId===product.lotId).forEach(p=>{ p.lastSoldAt = Date.now(); });
      saveLots();
    } else {
      product.qty -= qty;
      product.lastSoldAt = Date.now();
    }
  } else {
    product.qty -= qty;
    product.lastSoldAt = Date.now();
  }
  const grossTotal = qty*product.sell;
  const grossProfit = qty*(product.sell-product.buy);
  const hasDiscount = document.getElementById('in-has-discount').checked && isFeatureUnlocked('saleDiscounts');
  const discountAmount = hasDiscount
    ? computeDiscountAmount(grossTotal, saleDiscountType, document.getElementById('in-discount-value').value)
    : 0;
  if(hasDiscount && discountExceedsTotal(grossTotal, saleDiscountType, document.getElementById('in-discount-value').value)){
    showToast(dict[currentLang].discountTooHighMsg, 3500);
  }
  const saleTotal = grossTotal - discountAmount;
  const saleProfit = grossProfit - discountAmount;
  const saleId = Date.now().toString();
  const saleRecord = {
    id: saleId, productId: product.id, productName: product.name,
    qty, unit, total: saleTotal, profit: saleProfit,
    date: Date.now(), isCredit: isCredit
  };
  // Champ optionnel : jamais 0/undefined écrit tel quel (Firestore refuse "undefined",
  // et on préfère ne pas polluer chaque vente d'un "discount:0" sans intérêt).
  if(discountAmount > 0) saleRecord.discount = discountAmount;
  await saveProducts();

  // Signal d'activation réelle : la personne a fait plus que s'inscrire, elle a
  // enregistré une vraie vente. On ne l'envoie qu'une fois par appareil.
  if(typeof fbq === 'function' && localStorage.getItem('mombongo:firstSaleTracked') !== '1'){
    localStorage.setItem('mombongo:firstSaleTracked', '1');
    fbq('track', 'Lead');
  }

  if(isCredit){
    // On ne fusionne avec une dette ouverte existante que si le nom correspond ET,
    // quand un numéro est connu des deux côtés, que ce numéro correspond aussi —
    // sinon deux clients différents portant le même prénom se retrouveraient mélangés
    // dans une seule et même dette.
    let debt = debts.find(d=>{
      if(d.status!=='ouvert') return false;
      if(d.clientName.toLowerCase() !== clientName.toLowerCase()) return false;
      if(clientPhone && d.phone) return d.phone === clientPhone;
      return true;
    });
    if(!debt){
      debt = {
        id: 'debt'+Date.now().toString(), clientName, phone: clientPhone, dueDate,
        items: [], totalOwed: 0, totalProfit: 0, amountPaid: 0, payments: [],
        createdAt: Date.now(), status: 'ouvert'
      };
      debts.push(debt);
    } else {
      if(clientPhone) debt.phone = clientPhone;
      if(dueDate) debt.dueDate = dueDate;
    }
    saleRecord.debtId = debt.id;
    debt.items.push({ saleId, productName: product.name, qty, unit, total: saleTotal, profit: saleProfit, date: Date.now() });
    debt.totalOwed += saleTotal;
    debt.totalProfit += saleProfit;
    sales.push(saleRecord);
    saveDebts();
    await saveSales();
    closeSellSheet();
    showToast(currentLang==='fr' ? "Vente à crédit enregistrée" : "Kotéka ya nyongo ekómi");
    if(typeof offerReceiptForSingleSale === 'function') offerReceiptForSingleSale(saleRecord);
  } else {
    sales.push(saleRecord);
    ensureTodayStats();
    stats.todaySales += saleTotal;
    stats.todayProfit += saleProfit;
    stats.totalProfit += saleProfit;
    saveStats();
    await saveSales();
    closeSellSheet();
    showToast(dict[currentLang].sold);
    if(typeof offerReceiptForSingleSale === 'function') offerReceiptForSingleSale(saleRecord);
  }
  render();
  if(typeof updateBackupBanner === 'function') updateBackupBanner();
}

/* ---------- Vente plusieurs (catalogue complet + dette partielle) ---------- */
async function confirmMultiSale(){
  if(saveInProgress) return;
  saveInProgress = true;
  try{
    await confirmMultiSaleInner();
  } finally {
    saveInProgress = false;
  }
}
async function confirmMultiSaleInner(){
  const items = getMultiCartItems();
  if(items.length === 0){
    showToast(currentLang==='fr' ? "Sélectionne au moins un produit" : "Pona ata produit moko");
    return;
  }
  for(const it of items){
    // Même tolérance flottante que confirmSaleInner() pour les unités décimales (kg/L/m).
    if(it.qty > it.product.qty + 1e-9){
      showToast(currentLang==='fr' ? "Quantité invalide pour " + it.product.name : "Motángo ekoki te");
      return;
    }
  }
  // Même principe que discountExceedsTotal() pour la remise globale (plus bas) :
  // on avertit sans bloquer si une remise PAR PRODUIT dépassait le total de sa
  // propre ligne — elle reste plafonnée à 100% de cette ligne (article offert),
  // mais le vendeur doit le savoir avant de confirmer, pas le découvrir après coup.
  const overDiscountedNames = isFeatureUnlocked('saleDiscounts')
    ? items.filter(it => { const d = multiCartDiscounts[it.product.id]; return d && discountExceedsTotal(it.grossTotal, d.type, d.value); }).map(it => it.product.name)
    : [];
  if(overDiscountedNames.length){
    showToast(
      (currentLang==='fr' ? "Remise trop élevée sur : " : (currentLang==='ln' ? "Remise eleki mingi na : " : "Punguzo kubwa mno kwa : "))
      + overDiscountedNames.join(', '), 3500
    );
  }
  const isCredit = document.getElementById('in-is-credit').checked;
  if(isCredit && !isFeatureUnlocked('customerDebts')){
    document.getElementById('in-is-credit').checked = false;
    openLimitSheet('debts');
    return;
  }
  const clientName = document.getElementById('in-client-name').value.trim();
  if(isCredit && !clientName){
    showToast(currentLang==='fr' ? "Indique le nom du client pour une vente à crédit" : "Pesa nkombo ya client");
    return;
  }
  const clientPhone = document.getElementById('in-client-phone').value.trim();
  const dueDate = getDateValue('in-due-date');

  // items[].total/profit incluent déjà chaque remise PAR PRODUIT. La remise GLOBALE
  // du panier s'applique ensuite sur ce sous-total, puis est répartie au prorata sur
  // chaque ligne (voir plus bas) pour que chaque saleRecord reste cohérent avec
  // lui-même — indispensable pour que la suppression d'UNE SEULE ligne d'une vente
  // multiple (voir deleteHistoryEntry(), export.js) réajuste correctement le stock et
  // les stats sans devoir recalculer toute la vente.
  const subtotal = items.reduce((s,it)=>s+it.total,0);
  const subtotalProfit = items.reduce((s,it)=>s+it.profit,0);
  const hasGlobalDiscount = document.getElementById('in-has-global-discount').checked && isFeatureUnlocked('saleDiscounts');
  const globalDiscountAmount = hasGlobalDiscount
    ? computeDiscountAmount(subtotal, multiGlobalDiscountType, document.getElementById('in-global-discount-value').value)
    : 0;
  if(hasGlobalDiscount && discountExceedsTotal(subtotal, multiGlobalDiscountType, document.getElementById('in-global-discount-value').value)){
    showToast(dict[currentLang].discountTooHighMsg, 3500);
  }
  const grandTotal = subtotal - globalDiscountAmount;
  const grandProfit = subtotalProfit - globalDiscountAmount;

  const hasPartialDebt = document.getElementById('in-has-debt').checked;
  if(hasPartialDebt && !isFeatureUnlocked('customerDebts')){
    document.getElementById('in-has-debt').checked = false;
    openLimitSheet('debts');
    return;
  }
  let debtAmount = 0, debtClientName = '', debtClientPhone = '', debtDueDate = '';
  if(hasPartialDebt){
    debtClientName = document.getElementById('in-debt-client-name').value.trim();
    if(!debtClientName){
      showToast(currentLang==='fr' ? "Indique le nom du client pour la dette" : "Pesa nkombo ya client");
      return;
    }
    const rawDebt = parseFloat(document.getElementById('in-debt-amount').value);
    if(isNaN(rawDebt) || rawDebt <= 0){
      showToast(currentLang==='fr' ? "Indique un montant de dette valide" : "Pesa motángo ya nyongo oyo ekoki");
      return;
    }
    debtAmount = toInternal(rawDebt);
    if(debtAmount > grandTotal + 0.01){
      showToast(currentLang==='fr' ? "La dette ne peut pas dépasser le total de la vente" : "Nyongo ekoki koleka total te");
      return;
    }
    debtClientPhone = document.getElementById('in-debt-client-phone').value.trim();
    debtDueDate = getDateValue('in-debt-due-date');
  }

  const multiSaleId = Date.now().toString();
  const saleRecords = items.map(it=>{
    const product = it.product;
    if(product.lotId){
      const lot = lots.find(l=>l.id===product.lotId);
      if(lot){
        const fractionConsumed = it.qty / product.yieldPerSac;
        lot.remainingFraction = Math.max(0, lot.remainingFraction - fractionConsumed);
        recalcLotQuantities(product.lotId);
        products.filter(p=>p.lotId===product.lotId).forEach(p=>{ p.lastSoldAt = Date.now(); });
        saveLots();
      } else {
        product.qty -= it.qty;
        product.lastSoldAt = Date.now();
      }
    } else {
      product.qty -= it.qty;
      product.lastSoldAt = Date.now();
    }
    // Part de la remise globale attribuée à CETTE ligne, au prorata de son poids dans
    // le sous-total (déjà net de sa propre remise produit) — même logique que
    // debtProfitShare un peu plus bas pour une dette partielle.
    const globalShare = subtotal > 0 ? globalDiscountAmount * (it.total / subtotal) : 0;
    const rec = {
      id: multiSaleId+'-'+product.id, multiSaleId, productId: product.id, productName: product.name,
      qty: it.qty, unit: product.unit || 'pc', total: it.total - globalShare, profit: it.profit - globalShare,
      date: Date.now(), isCredit: isCredit
    };
    if(it.itemDiscount > 0) rec.itemDiscount = it.itemDiscount;
    if(globalShare > 0) rec.globalDiscountShare = globalShare;
    return rec;
  });
  await saveProducts();

  if(typeof fbq === 'function' && localStorage.getItem('mombongo:firstSaleTracked') !== '1'){
    localStorage.setItem('mombongo:firstSaleTracked', '1');
    fbq('track', 'Lead');
  }

  if(isCredit){
    let debt = debts.find(d=>{
      if(d.status!=='ouvert') return false;
      if(d.clientName.toLowerCase() !== clientName.toLowerCase()) return false;
      if(clientPhone && d.phone) return d.phone === clientPhone;
      return true;
    });
    if(!debt){
      debt = {
        id: 'debt'+Date.now().toString(), clientName, phone: clientPhone, dueDate,
        items: [], totalOwed: 0, totalProfit: 0, amountPaid: 0, payments: [],
        createdAt: Date.now(), status: 'ouvert'
      };
      debts.push(debt);
    } else {
      if(clientPhone) debt.phone = clientPhone;
      if(dueDate) debt.dueDate = dueDate;
    }
    saleRecords.forEach(sr=>{
      sr.debtId = debt.id;
      debt.items.push({ saleId: sr.id, productName: sr.productName, qty: sr.qty, unit: sr.unit, total: sr.total, profit: sr.profit, date: Date.now() });
    });
    debt.totalOwed += grandTotal;
    debt.totalProfit += grandProfit;
    sales.push(...saleRecords);
    saveDebts();
    await saveSales();
    closeSellSheet();
    showToast(currentLang==='fr' ? "Vente à crédit enregistrée" : "Kotéka ya nyongo ekómi");
    if(typeof offerReceiptForMultiSale === 'function') offerReceiptForMultiSale(saleRecords, grandTotal, true);
  } else if(hasPartialDebt){
    // La vente entière est d'abord comptée comme payée au comptant, puis on
    // bascule le reliquat (montant libre, pas lié à un produit précis) vers
    // le même système `debts` que la vente 100% crédit ci-dessus.
    sales.push(...saleRecords);
    ensureTodayStats();
    stats.todaySales += grandTotal;
    stats.todayProfit += grandProfit;
    stats.totalProfit += grandProfit;

    const debtProfitShare = grandTotal > 0 ? grandProfit * (debtAmount / grandTotal) : 0;
    let debt = debts.find(d=>{
      if(d.status!=='ouvert') return false;
      if(d.clientName.toLowerCase() !== debtClientName.toLowerCase()) return false;
      if(debtClientPhone && d.phone) return d.phone === debtClientPhone;
      return true;
    });
    if(!debt){
      debt = {
        id: 'debt'+Date.now().toString(), clientName: debtClientName, phone: debtClientPhone, dueDate: debtDueDate,
        items: [], totalOwed: 0, totalProfit: 0, amountPaid: 0, payments: [],
        createdAt: Date.now(), status: 'ouvert'
      };
      debts.push(debt);
    } else {
      if(debtClientPhone) debt.phone = debtClientPhone;
      if(debtDueDate) debt.dueDate = debtDueDate;
    }
    const debtLabel = currentLang==='fr' ? 'Vente multiple (reliquat)' : (currentLang==='ln' ? 'Kotéka ebele (mikakatano)' : 'Uuzaji mengi (deni)');
    debt.items.push({ saleId: multiSaleId, productName: debtLabel, qty: null, total: debtAmount, profit: debtProfitShare, date: Date.now(), partial: true });
    debt.totalOwed += debtAmount;
    debt.totalProfit += debtProfitShare;

    stats.todaySales -= debtAmount;
    stats.todayProfit -= debtProfitShare;
    stats.totalProfit -= debtProfitShare;
    saveStats();
    saveDebts();
    await saveSales();
    closeSellSheet();
    showToast(currentLang==='fr' ? "Vente enregistrée avec une dette partielle" : "Kotéka ekómi na nyongo moke");
    if(typeof offerReceiptForMultiSale === 'function') offerReceiptForMultiSale(saleRecords, grandTotal, false);
  } else {
    sales.push(...saleRecords);
    ensureTodayStats();
    stats.todaySales += grandTotal;
    stats.todayProfit += grandProfit;
    stats.totalProfit += grandProfit;
    saveStats();
    await saveSales();
    closeSellSheet();
    showToast(dict[currentLang].sold);
    if(typeof offerReceiptForMultiSale === 'function') offerReceiptForMultiSale(saleRecords, grandTotal, false);
  }
  render();
  if(typeof updateBackupBanner === 'function') updateBackupBanner();
}

/* ---------- Vente par la voix (français uniquement) ---------- */
const FRENCH_NUMBER_WORDS = {
  un:1, une:1, deux:2, trois:3, quatre:4, cinq:5, six:6, sept:7, huit:8, neuf:9, dix:10,
  onze:11, douze:12, treize:13, quatorze:14, quinze:15, seize:16, vingt:20
};

let voiceRecognition = null;
let pendingVoiceSale = null;
let voiceListening = false;
let voiceStopRequested = false;
let voiceStartTimestamp = null;
let voiceMinTimer = null;
let voiceAutoRetryCount = 0;
const VOICE_MIN_LISTEN_MS = 5000; // durée minimale d'écoute avant de pouvoir arrêter, même si le doigt est relâché plus tôt
const VOICE_MAX_AUTO_RETRY = 3; // nombre de réessais automatiques avant de laisser la main à l'utilisateur

// Quand rien n'a été capté (silence), relance l'écoute automatiquement au lieu de forcer
// l'utilisateur à annuler puis réessayer — sauf si la fenêtre a été fermée entre-temps
// (annulation manuelle) ou si le nombre max de réessais automatiques est atteint.
function scheduleVoiceAutoRetry(retryingText, giveUpText){
  const overlay = document.getElementById('voice-confirm-overlay');
  if(overlay.classList.contains('open') && voiceAutoRetryCount < VOICE_MAX_AUTO_RETRY){
    document.getElementById('voice-live-transcript').textContent = retryingText;
    setTimeout(()=>{
      if(document.getElementById('voice-confirm-overlay').classList.contains('open')){
        startVoiceSale(true);
      }
    }, 400);
  } else {
    document.getElementById('voice-live-transcript').textContent = giveUpText;
  }
}

function createVoiceRecognition(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return null;
  const rec = new SR();
  rec.lang = 'fr-FR';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let gotResult = false;
  let gotError = false;
  let watchdogTimer = null;
  const VOICE_WATCHDOG_MS = 12000; // au-delà, on considère que le service vocal ne répondra plus

  rec.onstart = () => {
    voiceListening = true;
    gotResult = false;
    gotError = false;
    const btn = document.getElementById('voice-sale-btn');
    btn.classList.remove('pressed');
    btn.classList.add('listening');
    // Ne plus arrêter immédiatement même si le doigt a déjà été relâché :
    // stopVoiceSale() se charge de respecter le délai minimum d'écoute (VOICE_MIN_LISTEN_MS).
    // Filet de sécurité : si le service vocal (serveurs Google) ne répond vraiment plus rien —
    // souvent un VPN actif ou une connexion instable qui bloque le trafic en silence, sans
    // déclencher d'erreur réseau franche — on abandonne proprement au lieu de rester bloqué
    // sur "Écoute en cours..." indéfiniment.
    if(watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(()=>{
      if(!gotResult){
        gotError = true; // évite que onend ne relance un réessai automatique inutile
        try{ rec.abort(); }catch(e){}
        voiceListening = false;
        document.getElementById('voice-sale-btn').classList.remove('pressed','listening');
        document.getElementById('voice-live-transcript').textContent = "🎙️ Le service vocal ne répond pas depuis trop longtemps. Vérifie ta connexion internet — si tu utilises un VPN, essaie de le désactiver puis réessaie.";
      }
    }, VOICE_WATCHDOG_MS);
  };
  rec.onresult = (event) => {
    gotResult = true;
    if(watchdogTimer){ clearTimeout(watchdogTimer); watchdogTimer = null; }
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript;
    updateVoiceLiveDisplay(transcript, result.isFinal);
  };
  rec.onerror = (event) => {
    gotError = true;
    if(watchdogTimer){ clearTimeout(watchdogTimer); watchdogTimer = null; }
    voiceListening = false;
    document.getElementById('voice-sale-btn').classList.remove('pressed','listening');
    if(event.error === 'aborted') return;
    if(event.error === 'no-speech'){
      scheduleVoiceAutoRetry("🎙️ Aucun son détecté — nouvel essai…", "🎙️ Aucun son détecté.");
      return;
    }
    if(event.error === 'not-allowed' || event.error === 'service-not-allowed'){
      closeVoiceConfirmOverlay();
      showToast("Micro refusé — autorise le micro pour Mombongo dans les réglages de Chrome.", 5000);
      return;
    }
    if(event.error === 'audio-capture'){
      closeVoiceConfirmOverlay();
      showToast("Micro inaccessible sur ce téléphone. Sur certains Xiaomi/MIUI, il existe une autorisation micro séparée dans l'app Sécurité (Paramètres > Applications > Autorisations > Micro > Chrome), en plus de celle de Chrome.", 7000);
      return;
    }
    if(event.error === 'network'){
      closeVoiceConfirmOverlay();
      showToast("Le service de reconnaissance vocale de Google n'a pas répondu (problème réseau ou services Google restreints sur ce téléphone). Vérifie ta connexion, ou que les services Google ne sont pas bloqués.", 7000);
      return;
    }
    document.getElementById('voice-live-transcript').textContent = "🎙️ Erreur micro : " + event.error;
  };
  rec.onend = () => {
    if(watchdogTimer){ clearTimeout(watchdogTimer); watchdogTimer = null; }
    voiceListening = false;
    document.getElementById('voice-sale-btn').classList.remove('pressed','listening');
    if(!gotResult && !gotError){
      scheduleVoiceAutoRetry("🎙️ Rien reçu — nouvel essai…", "🎙️ Rien reçu — réessaie.");
    }
  };

  return rec;
}

// Met à jour en direct la phrase entendue + le produit qui lui ressemble le plus, pendant la dictée
function updateVoiceLiveDisplay(transcript, isFinal){
  const liveEl = document.getElementById('voice-live-transcript');
  const bodyEl = document.getElementById('voice-confirm-body');
  const confirmBtn = document.getElementById('t-voice-confirm-btn');
  liveEl.textContent = `🎙️ "${transcript}"`;

  const parsed = parseVoiceSaleCommand(transcript);
  if(!parsed){
    bodyEl.innerHTML = `<span style="color:var(--charcoal-soft); font-weight:400;">…</span>`;
    confirmBtn.disabled = true;
    pendingVoiceSale = null;
    return;
  }
  const product = findProductMatch(parsed.productText);
  if(!product){
    bodyEl.innerHTML = `<span style="color:var(--charcoal-soft); font-weight:400;">Produit non reconnu${isFinal ? ' : "'+escapeHtml(parsed.productText)+'"' : '…'}</span>`;
    confirmBtn.disabled = true;
    pendingVoiceSale = null;
    return;
  }
  if(typeof isProductFrozen === 'function' && isProductFrozen(product.id, products)){
    bodyEl.innerHTML = `<span style="color:var(--charcoal-soft); font-weight:400;">🔒 ${escapeHtml(product.name)} — ${dict[currentLang].productFrozenMsg}</span>`;
    confirmBtn.disabled = true;
    pendingVoiceSale = null;
    return;
  }
  if(parsed.qty > product.qty){
    bodyEl.innerHTML = `<span style="color:var(--alert); font-weight:600;">Stock insuffisant pour ${escapeHtml(product.name)} (reste ${formatQty(product.qty, product.unit)})</span>`;
    confirmBtn.disabled = true;
    pendingVoiceSale = null;
    return;
  }
  const total = parsed.qty * product.sell;
  bodyEl.innerHTML = `${formatQty(parsed.qty, product.unit)} × ${escapeHtml(product.name)}<br><span style="color:var(--emerald);">${formatMoney(total)}</span>`;
  confirmBtn.disabled = false;
  pendingVoiceSale = { product, qty: parsed.qty };
}

function startVoiceSale(isAutoRetry){
  if(!canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
  if(!isFeatureUnlocked('voiceSales')){ openLimitSheet('voice'); return; }
  if(!(window.SpeechRecognition || window.webkitSpeechRecognition)){
    showToast("La reconnaissance vocale n'est pas disponible sur ce navigateur.");
    return;
  }
  voiceAutoRetryCount = isAutoRetry ? (voiceAutoRetryCount + 1) : 0;
  voiceStopRequested = false;
  voiceListening = false;
  pendingVoiceSale = null;
  if(voiceMinTimer){ clearTimeout(voiceMinTimer); voiceMinTimer = null; }
  voiceStartTimestamp = Date.now();
  document.getElementById('voice-sale-btn').classList.add('pressed');
  openVoiceListeningSheet();
  // Un moteur tout neuf à chaque appui : évite qu'une tentative précédente
  // laisse le micro bloqué dans un état invalide (comportement connu sur Android).
  voiceRecognition = createVoiceRecognition();
  try{
    voiceRecognition.start();
  }catch(e){
    document.getElementById('voice-sale-btn').classList.remove('pressed');
    closeVoiceConfirmOverlay();
    showToast("Micro indisponible : " + (e.message || e.name || 'erreur inconnue'), 4000);
  }
}

function stopVoiceSale(){
  voiceStopRequested = true;
  // On respecte toujours un minimum de VOICE_MIN_LISTEN_MS d'écoute depuis l'appui sur le micro,
  // que le doigt soit relâché tôt ou tard : on retarde l'arrêt réel si besoin.
  const elapsed = voiceStartTimestamp ? (Date.now() - voiceStartTimestamp) : VOICE_MIN_LISTEN_MS;
  const remaining = VOICE_MIN_LISTEN_MS - elapsed;
  if(voiceMinTimer){ clearTimeout(voiceMinTimer); voiceMinTimer = null; }
  if(remaining > 0){
    voiceMinTimer = setTimeout(performVoiceStop, remaining);
  } else {
    performVoiceStop();
  }
}

function performVoiceStop(){
  voiceMinTimer = null;
  const btn = document.getElementById('voice-sale-btn');
  if(voiceListening){
    btn.classList.remove('listening');
    if(voiceRecognition){ try{ voiceRecognition.stop(); }catch(e){} }
  } else {
    // Pas encore réellement démarré (permission/initialisation en cours) : on annule proprement.
    btn.classList.remove('pressed');
    if(voiceRecognition){ try{ voiceRecognition.abort(); }catch(e){} }
  }
}

function normalizeForMatch(s){
  return s.toLowerCase()
    .normalize('NFC')
    .replace(/ç/g, 's')       // le "ç" se prononce /s/ — à traiter AVANT le retrait générique des
                               // accents ci-dessous, sinon il devient un simple "c" (qui sonnerait
                               // "k" devant a/o/u dans notre clé phonétique : "ça" → "ka" au lieu de "sa")
    .replace(/['’]/g, '')     // "s'en", "l'eau", "qu'il"... : l'apostrophe ne doit pas empêcher
                               // de comparer les lettres avant/après comme un seul bloc sonore
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}

// Reconnaît "pain", "2 pain", "pain vendu", "2 pains vendus"... — "vendu(s)" est optionnel
function parseVoiceSaleCommand(transcript){
  let text = transcript.trim().toLowerCase().replace(/[.,!?]/g,'').trim();
  if(!text) return null;

  const soldMatch = text.match(/^(.*?)\s*vendus?\s*$/);
  let rest = (soldMatch && soldMatch[1].trim()) ? soldMatch[1].trim() : text;
  if(!rest) return null;

  const words = rest.split(/\s+/);
  let qty = 1;
  const firstWord = words[0];
  if(/^\d+$/.test(firstWord)){
    qty = parseInt(firstWord, 10);
    words.shift();
  } else if(FRENCH_NUMBER_WORDS[firstWord] !== undefined){
    qty = FRENCH_NUMBER_WORDS[firstWord];
    words.shift();
  }
  const productText = words.join(' ').trim();
  if(!productText) return null;
  return { qty, productText };
}

// Mots vides à ignorer dans la comparaison (ne différencient pas les produits entre eux)
const VOICE_STOPWORDS = new Set(['le','la','les','un','une','des','de','du','au','aux','et']);

// Convertit un mot en une "clé phonétique" simplifiée du français : regroupe les graphies
// qui se prononcent pareil (ex: "au"/"eau" -> même son, "ph" -> "f", lettres finales muettes
// supprimées...). Sert à comparer ce qui a été DIT (le son) plutôt que ce qui a été TRANSCRIT
// (l'orthographe précise choisie par le moteur de dictée) — un produit doit être reconnu même
// si le micro l'a mal orthographié, tant que ça sonne pareil. Heuristique simple, pas un moteur
// linguistique complet : elle couvre les cas les plus fréquents en français, pas chaque exception.
function frenchPhoneticKey(word){
  let w = word;
  const rules = [
    [/ch/g, 'sh'],
    [/eau/g, 'o'], [/oeu/g, 'eu'], [/au/g, 'o'],
    [/ain|ein|aim/g, 'in'],
    [/oi|oy/g, 'wa'],
    [/ou/g, 'u'],
    [/an|am|en|em/g, 'an'],
    [/in|im|yn|ym|un|um/g, 'in'],
    [/on|om/g, 'on'],
    [/gn/g, 'ny'],
    [/ill/g, 'i'],
    [/ph/g, 'f'],
    [/qu/g, 'k'],
    [/gu(?=[eiy])/g, 'g'],
    [/th/g, 't'],
    [/ai|ei/g, 'e'],
    [/c(?=[eiy])/g, 's'],
    [/c/g, 'k'],
    [/g(?=[eiy])/g, 'j'],
    [/x/g, 'ks'],
    [/q/g, 'k'],
    [/y/g, 'i'],
  ];
  rules.forEach(([re, rep]) => { w = w.replace(re, rep); });
  // "e" final muet, très fréquent en français (ex: "coque" ~ "coq", "grande" ~ "grand") —
  // un seul retrait, pas de boucle : on ne touche pas aux consonnes finales, trop souvent
  // réellement prononcées (ex: le "s" de "chaise") pour être retirées sans risque.
  if(/e$/.test(w)) w = w.slice(0, -1);
  // Lettres doublées consécutives -> une seule (n'affecte pas le son en français)
  return w.replace(/(.)\1+/g, '$1');
}

// Deux mots sont considérés "proches" si leur clé phonétique correspond exactement (ils sonnent
// pareil), ou à défaut si leurs clés partagent un début suffisant — tolère les petites
// imprécisions de la dictée qui subsistent même après normalisation phonétique.
function wordsAreClose(a, b){
  if(a === b) return true;
  const ka = frenchPhoneticKey(a), kb = frenchPhoneticKey(b);
  if(ka && ka === kb) return true;
  const minLen = Math.min(ka.length, kb.length);
  if(minLen < 2) return false;
  let common = 0;
  while(common < minLen && ka[common] === kb[common]) common++;
  return common >= 2 && common >= minLen - 1;
}

// Cherche le produit le plus proche du texte dicté, dans l'inventaire réel de la boutique active.
// Comparaison mot à mot (en ignorant les mots vides) plutôt que par simple sous-chaîne : ça évite
// qu'un nom de produit court et générique (ex: "savon") batte par erreur un nom plus précis et
// plus proche de ce qui a réellement été dit (ex: "Savon le coq") simplement parce qu'il est
// contenu tel quel dans une transcription imparfaite comme "savons les coques".
function findProductMatch(productText){
  const norm = normalizeForMatch(productText);
  if(!norm) return null;
  const wordsA = norm.split(/\s+/).filter(w => w && !VOICE_STOPWORDS.has(w));
  if(wordsA.length === 0) return null;

  let best = null, bestScore = 0;
  products.forEach(p=>{
    const pn = normalizeForMatch(p.name);
    const wordsB = pn.split(/\s+/).filter(w => w && !VOICE_STOPWORDS.has(w));
    if(wordsB.length === 0) return;

    const matchedCount = wordsB.filter(wb => wordsA.some(wa => wordsAreClose(wa, wb))).length;
    if(matchedCount === 0) return;

    const productCoverage = matchedCount / wordsB.length;     // part du nom du produit retrouvée dans la dictée
    const transcriptCoverage = matchedCount / wordsA.length;  // part de ce qui a été dit qui correspond à ce produit
    const score = (productCoverage + transcriptCoverage) * 50 + matchedCount;

    if(score > bestScore){ bestScore = score; best = p; }
  });
  return bestScore >= 60 ? best : null;
}

function openVoiceListeningSheet(){
  document.getElementById('voice-live-transcript').textContent = '🎙️ Écoute en cours…';
  document.getElementById('voice-confirm-body').innerHTML = '<span style="color:var(--charcoal-soft); font-weight:400;">…</span>';
  document.getElementById('t-voice-confirm-btn').disabled = true;
  document.getElementById('voice-confirm-overlay').classList.add('open');
}

function closeVoiceConfirmOverlay(){
  document.getElementById('voice-confirm-overlay').classList.remove('open');
}

function cancelVoiceSale(){
  pendingVoiceSale = null;
  closeVoiceConfirmOverlay();
  if(voiceRecognition){ try{ voiceRecognition.abort(); }catch(e){} }
  voiceListening = false;
  document.getElementById('voice-sale-btn').classList.remove('pressed','listening');
}

async function confirmVoiceSale(){
  if(!pendingVoiceSale) return;
  const { product, qty } = pendingVoiceSale;
  sellingProductId = product.id;
  document.getElementById('in-sell-qty').value = qty;
  document.getElementById('in-is-credit').checked = false;
  document.getElementById('in-is-multi').checked = false;
  document.getElementById('single-sale-fields').style.display = 'block';
  document.getElementById('multi-fields').style.display = 'none';
  document.getElementById('in-has-debt').checked = false;
  closeVoiceConfirmOverlay();
  pendingVoiceSale = null;
  if(voiceRecognition){ try{ voiceRecognition.abort(); }catch(e){} }
  await confirmSale();
}

function initVoiceSaleButton(){
  const btn = document.getElementById('voice-sale-btn');
  if(!btn) return;
  if(!(window.SpeechRecognition || window.webkitSpeechRecognition)){
    btn.style.display = 'none';
    return;
  }
  btn.addEventListener('touchstart', e=>{ e.preventDefault(); startVoiceSale(); });
  btn.addEventListener('touchend', e=>{ e.preventDefault(); stopVoiceSale(); });
  btn.addEventListener('touchcancel', stopVoiceSale);
  btn.addEventListener('mousedown', startVoiceSale);
  btn.addEventListener('mouseup', stopVoiceSale);
  btn.addEventListener('mouseleave', stopVoiceSale);
}

/* =========================================================================
   PANIER EN PAUSE — voir la doc complète sur heldCarts (config.js).
   ========================================================================= */
function saveHeldCarts(){
  try{ localSet('mombongo:heldCarts', JSON.stringify(heldCarts)); }catch(e){}
}

// Appelée depuis navigation.js quand le bouton retour (Android/navigateur) est pressé
// pendant qu'une vente est ouverte. Renvoie :
//   'none'    → rien à mettre en pause (vente simple, ou panier vide) : fermeture normale.
//   'paused'  → panier mis de côté avec succès : fermeture normale, mais le panier
//               réapparaîtra dans la liste "🧺" au lieu d'être perdu.
//   'blocked' → 3 ventes déjà en attente : on refuse d'en empiler une 4e en silence
//               (mieux vaut forcer à en reprendre/annuler une d'abord que de perdre
//               discrètement les articles déjà choisis pour ce client-ci).
function pauseCurrentCartIfAny(){
  const isMulti = document.getElementById('in-is-multi').checked;
  const itemCount = Object.keys(multiCart).length;
  if(!isMulti || itemCount === 0) return 'none';
  if(heldCarts.length >= MAX_HELD_CARTS){
    showToast(dict[currentLang].heldCartsFullMsg, 4500);
    return 'blocked';
  }
  heldCarts.push({ id: 'held' + Date.now() + Math.random().toString(36).slice(2,6), cart: { ...multiCart }, discounts: { ...multiCartDiscounts }, savedAt: Date.now() });
  saveHeldCarts();
  updateHeldCartsBadge();
  showToast(dict[currentLang].cartPausedMsg, 3000);
  return 'paused';
}

// Bouton 🧺, à gauche du micro (même emplacement, en miroir, que 📷 à droite) — visible
// uniquement s'il y a au moins un panier en attente, avec un badge "1"/"2"/"3" au-dessus.
function updateHeldCartsBadge(){
  const btn = document.getElementById('held-carts-btn');
  const badge = document.getElementById('held-carts-badge');
  if(!btn || !badge) return;
  const n = heldCarts.length;
  btn.style.display = (n > 0 && canSell()) ? 'flex' : 'none';
  badge.textContent = n;
}

function openHeldCartsSheet(){
  renderHeldCartsList();
  document.getElementById('held-carts-overlay').classList.add('open');
}
function closeHeldCartsSheet(){
  document.getElementById('held-carts-overlay').classList.remove('open');
}
function renderHeldCartsList(){
  const wrap = document.getElementById('held-carts-list');
  const t = dict[currentLang];
  wrap.innerHTML = '';
  heldCarts.forEach((held, index)=>{
    const items = Object.entries(held.cart).map(([id, qty])=>{
      const product = products.find(p=>p.id===id);
      return product ? { product, qty } : null;
    }).filter(Boolean);
    const total = items.reduce((s,it)=>s + it.qty*it.product.sell, 0);
    const row = document.createElement('div');
    row.className = 'held-cart-row';
    row.innerHTML =
      '<div class="info">' +
        '<div class="name">' + t.heldCartLabel.replace('{n}', index+1) + '</div>' +
        '<div class="meta">' + (t.heldCartItemsCount || '{n} article(s)').replace('{n}', items.length) + ' · ' + formatMoney(total) + '</div>' +
      '</div>' +
      '<button type="button" class="btn-secondary held-cart-drop" data-drop="' + index + '" aria-label="' + t.heldCartDropBtn + '">🗑️</button>' +
      '<button type="button" class="btn-primary held-cart-resume" data-resume="' + index + '">' + t.heldCartResumeBtn + '</button>';
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('button[data-resume]').forEach(btn=>{
    btn.addEventListener('click', ()=> resumeHeldCart(parseInt(btn.dataset.resume,10)));
  });
  wrap.querySelectorAll('button[data-drop]').forEach(btn=>{
    btn.addEventListener('click', ()=> dropHeldCart(parseInt(btn.dataset.drop,10)));
  });
}
function resumeHeldCart(index){
  const held = heldCarts[index];
  if(!held) return;
  heldCarts.splice(index, 1);
  saveHeldCarts();
  updateHeldCartsBadge();
  closeHeldCartsSheet();
  openSellSheet(null);
  multiCart = { ...held.cart };
  multiCartDiscounts = { ...(held.discounts || {}) }; // remises par produit du panier repris, si elles existaient (voir pauseCurrentCartIfAny)
  document.getElementById('in-is-multi').checked = true;
  toggleMultiFields();
}
// Retire une vente de la liste d'attente SANS la reprendre — pour un client qui a
// finalement renoncé à cet achat pendant qu'il patientait dans les rayons.
function dropHeldCart(index){
  heldCarts.splice(index, 1);
  saveHeldCarts();
  updateHeldCartsBadge();
  renderHeldCartsList();
}

