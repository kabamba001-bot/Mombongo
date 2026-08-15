/* ---------- Ajout / modification produit ---------- */
let editingProductId = null;
let addMode = 'simple';
let mesuretteCount = 0;

function setAddMode(mode){
  addMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  document.getElementById('mode-simple-fields').style.display = mode==='simple' ? 'block':'none';
  document.getElementById('mode-carton-fields').style.display = mode==='carton' ? 'block':'none';
  document.getElementById('mode-sac-fields').style.display = mode==='sac' ? 'block':'none';
  if(mode==='sac'){
    onSacUnitChange();
  }
}

/* ---------- Unité de mesure du sac ----------
   Le choix de l'unité (juste sous le nom du produit, dans l'onglet "Sac") détermine
   comment le sac est réparti :
   - "mesurette" : portions personnalisées nommées par le commerçant (comportement
     historique) -> voir sac-mesurette-group / addMesuretteRow().
   - kg / g / l / ml / m / cm : un seul produit est créé dans cette unité. Le
     commerçant donne une ESTIMATION de la quantité totale contenue dans le sac
     (ex : 25 kg pour un sac de riz) : c'est ce qui permet de calculer le prix
     d'achat réel par kg/L/m (prix du sac ÷ quantité estimée) et donc le bénéfice —
     sans cette estimation, impossible de savoir combien coûte réellement 1 kg. */
function onSacUnitChange(){
  const unitEl = document.getElementById('sac-unit');
  const unit = unitEl ? unitEl.value : 'mesurette';
  const isMesurette = unit === 'mesurette';
  const mesuretteGroup = document.getElementById('sac-mesurette-group');
  const genericGroup = document.getElementById('sac-generic-group');
  if(mesuretteGroup) mesuretteGroup.style.display = isMesurette ? 'block' : 'none';
  if(genericGroup) genericGroup.style.display = isMesurette ? 'none' : 'block';
  const t = dict[currentLang];
  const uLabel = unitLabel(unit);
  const thresholdLabel = document.getElementById('t-sac-threshold');
  if(thresholdLabel){
    thresholdLabel.textContent = isMesurette
      ? t.sacThreshold
      : (t.sacThresholdUnit || "Seuil d'alerte (par {unit})").replace('{unit}', uLabel);
  }
  const sellLabel = document.getElementById('t-sac-generic-sell');
  if(sellLabel){
    sellLabel.textContent = (t.sacGenericSellLabel || 'Prix de vente (par {unit})').replace('{unit}', uLabel);
  }
  const qtyLabel = document.getElementById('t-sac-generic-qty');
  if(qtyLabel){
    qtyLabel.textContent = (t.sacGenericQtyLabel || 'Quantité estimée dans le sac ({unit})').replace('{unit}', uLabel);
  }
  const genericQtyInput = document.getElementById('sac-generic-qty');
  if(genericQtyInput){
    genericQtyInput.inputMode = unitInputMode(unit);
  }
  if(isMesurette && mesuretteCount===0){
    addMesuretteRow(); addMesuretteRow(); addMesuretteRow();
  }
}

// Ajuste dynamiquement le "pas" et le clavier (numérique vs décimal) des champs
// quantité/seuil selon l'unité choisie — appelé au changement du <select> unité, à
// l'ouverture du formulaire, et à l'édition d'un produit existant. "prefix" permet de
// réutiliser cette fonction pour d'autres formulaires plus tard (aujourd'hui : 'in').
function onUnitChange(prefix){
  const unitEl = document.getElementById(prefix+'-unit');
  const unit = unitEl ? unitEl.value : 'pc';
  ['qty','threshold'].forEach(function(field){
    const el = document.getElementById(prefix+'-'+field);
    if(!el) return;
    el.step = unitStep(unit);
    el.inputMode = unitInputMode(unit);
  });
}

function addMesuretteRow(){
  mesuretteCount++;
  const idx = mesuretteCount;
  priceFieldCurrency['mesurette'+idx] = 'usd';
  const wrap = document.createElement('div');
  wrap.className = 'mesurette-row';
  wrap.id = 'mesurette-row-'+idx;
  const t = dict[currentLang];
  wrap.innerHTML = `
    <div class="field">
      <label>${t.mesuretteName}</label>
      <input id="mesurette-name-${idx}" type="text" value="${t.mesuretteDefault} ${idx}">
    </div>
    <div class="two-col">
      <div class="field">
        <label>${t.mesuretteSell}</label><span class="field-currency-toggle" id="fc-toggle-mesurette${idx}"><button type="button" class="active" data-cur="usd" onclick="setFieldCurrency('mesurette${idx}','usd')">$</button><button type="button" data-cur="cdf" onclick="setFieldCurrency('mesurette${idx}','cdf')">FC</button></span>
        <input id="mesurette-sell-${idx}" type="number" inputmode="decimal">
      </div>
      <div class="field">
        <label>${t.mesuretteQty}</label>
        <input id="mesurette-qty-${idx}" type="number" inputmode="numeric">
      </div>
    </div>
    <button type="button" class="remove-mesurette" onclick="removeMesuretteRow(${idx})">✕ ${t.mesuretteRemove}</button>
  `;
  document.getElementById('mesurettes-list').appendChild(wrap);
}
function removeMesuretteRow(idx){
  const el = document.getElementById('mesurette-row-'+idx);
  if(el) el.remove();
}
function resetMesurettes(){
  document.getElementById('mesurettes-list').innerHTML = '';
  mesuretteCount = 0;
}

function toggleExpiryField(mode){
  const checked = document.getElementById(mode==='simple' ? 'in-has-expiry' : mode+'-has-expiry').checked;
  document.getElementById('expiry-field-'+mode).style.display = checked ? 'block' : 'none';
}

function openAddSheet(){
  if(!canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  editingProductId = null;
  updateAddFieldLabels();
  document.getElementById('t-add-title').textContent = dict[currentLang].addTitle;
  document.getElementById('t-save').textContent = dict[currentLang].save;
  document.getElementById('add-mode-row').style.display = 'flex';
  resetMesurettes();
  setAddMode('simple');
  resetFieldCurrencies();
  document.getElementById('in-unit').value = 'pc';
  onUnitChange('in');
  updateProductNameSuggestions();
  if(typeof loadCommunityCatalogForActiveStore === 'function') loadCommunityCatalogForActiveStore();
  // Réinitialisé par défaut ici — c'est handleBarcodeForAdd() (barcode.js) qui le remet
  // juste après cet appel quand on arrive depuis un scan de code-barres.
  pendingBarcodeForNewProduct = null;
  const barcodeBadge = document.getElementById('add-barcode-badge');
  if(barcodeBadge) barcodeBadge.style.display = 'none';
  document.getElementById('add-overlay').classList.add('open');
}
function openEditSheet(id){
  if(!canEditDeleteProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  const product = products.find(p=>p.id===id);
  if(!product) return;
  editingProductId = id;
  updateAddFieldLabels();
  document.getElementById('t-add-title').textContent = dict[currentLang].editTitle;
  document.getElementById('t-save').textContent = dict[currentLang].saveEdit;
  document.getElementById('add-mode-row').style.display = 'none';
  const bulkBtn = document.getElementById('t-bulk-catalog-open-btn');
  if(bulkBtn) bulkBtn.style.display = 'none';
  const gridBtn = document.getElementById('t-grid-add-open-btn');
  if(gridBtn) gridBtn.style.display = 'none';
  resetMesurettes();
  setAddMode('simple');
  resetFieldCurrencies();
  document.getElementById('in-name').value = product.name;
  document.getElementById('in-buy').value = currentCurrency==='cdf' ? Math.round(product.buy*exchangeRate) : product.buy;
  document.getElementById('in-sell').value = currentCurrency==='cdf' ? Math.round(product.sell*exchangeRate) : product.sell;
  document.getElementById('in-unit').value = product.unit || 'pc';
  onUnitChange('in');
  document.getElementById('in-qty').value = product.qty;
  document.getElementById('in-threshold').value = product.threshold;
  document.getElementById('in-has-expiry').checked = !!product.expiryDate;
  setDateValue('in-expiry-date', product.expiryDate || '');
  toggleExpiryField('simple');
  document.getElementById('add-overlay').classList.add('open');
}
function closeAddSheet(){
  document.getElementById('add-overlay').classList.remove('open');
  ['in-name','in-buy','in-sell','in-qty','in-threshold',
   'carton-name','carton-qty','carton-buy','carton-sell','carton-threshold',
   'sac-name','sac-buy','sac-threshold','sac-generic-qty','sac-generic-sell'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.value='';
  });
  document.getElementById('in-unit').value = 'pc';
  const sacUnitEl = document.getElementById('sac-unit');
  if(sacUnitEl) sacUnitEl.value = 'mesurette';
  setDateValue('in-expiry-date', '');
  setDateValue('carton-expiry-date', '');
  setDateValue('sac-expiry-date', '');
  ['in-has-expiry','carton-has-expiry','sac-has-expiry'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.checked = false;
  });
  ['expiry-field-simple','expiry-field-carton','expiry-field-sac'].forEach(id=>{
    document.getElementById(id).style.display = 'none';
  });
  resetMesurettes();
  editingProductId = null;
  pendingBarcodeForNewProduct = null;
  const barcodeBadge = document.getElementById('add-barcode-badge');
  if(barcodeBadge) barcodeBadge.style.display = 'none';
}

function toInternal(raw){
  return currentCurrency === 'cdf' ? raw / exchangeRate : raw;
}

/* ---------- Devise indépendante par champ de prix ---------- */
let priceFieldCurrency = {};
function resetFieldCurrencies(){
  priceFieldCurrency = { buy: currentCurrency, sell: currentCurrency, cartonBuy: currentCurrency, cartonSell: currentCurrency, sacBuy: currentCurrency, sacGenericSell: currentCurrency };
  document.querySelectorAll('.field-currency-toggle').forEach(group=>{
    const key = group.id.replace('fc-toggle-','');
    const cur = priceFieldCurrency[key] || currentCurrency;
    group.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b.dataset.cur===cur));
  });
}
function setFieldCurrency(field, cur){
  const oldCur = priceFieldCurrency[field] || currentCurrency;
  priceFieldCurrency[field] = cur;
  const group = document.getElementById('fc-toggle-'+field);
  if(group){
    group.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b.dataset.cur===cur));
  }
  if(oldCur === cur) return;
  // Convertit la valeur déjà tapée pour qu'elle représente toujours le même montant réel,
  // au lieu de garder le même chiffre affiché avec une nouvelle unité (ce qui fausserait le prix).
  const input = document.getElementById(fieldToInputId(field));
  if(input && input.value !== ''){
    const raw = parseFloat(input.value);
    if(!isNaN(raw)){
      let converted;
      if(oldCur === 'usd' && cur === 'cdf') converted = raw * exchangeRate;
      else if(oldCur === 'cdf' && cur === 'usd') converted = raw / exchangeRate;
      else converted = raw;
      input.value = cur === 'cdf' ? Math.round(converted) : (Math.round(converted * 100) / 100);
    }
  }
}
function fieldToInputId(field){
  const map = { buy:'in-buy', sell:'in-sell', cartonBuy:'carton-buy', cartonSell:'carton-sell', sacBuy:'sac-buy', sacGenericSell:'sac-generic-sell' };
  if(map[field]) return map[field];
  if(field.indexOf('mesurette') === 0) return 'mesurette-sell-' + field.replace('mesurette','');
  return null;
}
function toInternalField(raw, field){
  const cur = priceFieldCurrency[field] || currentCurrency;
  return cur === 'cdf' ? raw / exchangeRate : raw;
}

// L'ajout de produits est illimité pour tout le monde (gratuit ou VIP) — l'ancienne
// limite de FREE_PRODUCT_LIMIT (30) pour les comptes gratuits a été retirée.
function canAddMoreProducts(countToAdd){
  return true;
}
// Dépenses illimitées pour tout le monde (gratuit ou VIP) — l'ancienne limite de
// FREE_EXPENSE_LIMIT (3) pour les comptes gratuits a été retirée.
function canAddMoreExpenses(){
  return true;
}

/* ---------- Suivi Meta Pixel : engagement réel avec l'app ---------- */
// "FirstProductAdded" : la personne a réellement essayé l'outil (bien meilleur
// signal d'intérêt que l'ouverture du menu de compte). Ne se déclenche qu'une
// seule fois par appareil, pour ne pas gonfler artificiellement le chiffre à
// chaque produit ajouté ensuite.
function maybeTrackFirstProduct(){
  if(typeof fbq !== 'function') return;
  if(localStorage.getItem('mombongo:firstProductTracked')) return;
  localStorage.setItem('mombongo:firstProductTracked', '1');
  fbq('trackCustom', 'FirstProductAdded');
}
function openLimitSheet(reason){
  const t = dict[currentLang];
  // "products" retiré : l'ajout de produits est illimité pour tous, ce cas ne se
  // déclenche donc plus (canAddMoreProducts() renvoie toujours true) — reste géré ici
  // par prudence uniquement s'il était encore appelé quelque part avec cette valeur.
  reason = reason || 'history';
  const link = document.getElementById('limit-whatsapp-link');
  if(!currentUser){
    document.getElementById('t-limit-desc').textContent = t.limitNeedsLoginDesc;
    link.textContent = t.limitLoginBtn;
    link.href = '#';
    link.onclick = function(e){
      e.preventDefault();
      closeLimitSheet();
      openAccountSheet();
    };
  } else {
    const descKey = { history:'limitDescHistory', stores:'limitDescStores', devices:'limitDescDevices', notif:'limitDescNotif', export:'limitDescExport', barcode:'limitDescBarcode', voice:'limitDescVoice', suppliers:'limitDescSuppliers' }[reason];
    const msgKey = { history:'limitWhatsappMsgHistory', stores:'limitWhatsappMsgStores', devices:'limitWhatsappMsgDevices', notif:'limitWhatsappMsgNotif', export:'limitWhatsappMsgExport', barcode:'limitWhatsappMsgBarcode', voice:'limitWhatsappMsgVoice', suppliers:'limitWhatsappMsgSuppliers' }[reason];
    document.getElementById('t-limit-desc').textContent = t[descKey];
    const msg = encodeURIComponent(t[msgKey]);
    link.textContent = t.limitUnlockBtn;
    link.href = `https://wa.me/${DEV_WHATSAPP}?text=${msg}`;
    link.onclick = null;
  }
  document.getElementById('add-overlay').classList.remove('open');
  document.getElementById('expense-overlay').classList.remove('open');
  document.getElementById('limit-overlay').classList.add('open');
}
function closeLimitSheet(){
  document.getElementById('limit-overlay').classList.remove('open');
}

function openExpensesHistorySheet(){
  renderExpensesHistory();
  document.getElementById('expenses-history-overlay').classList.add('open');
}
function closeExpensesHistorySheet(){
  document.getElementById('expenses-history-overlay').classList.remove('open');
}
async function deleteExpenseHistoryEntry(id){
  const t = dict[currentLang];
  if(!canDeleteExpense()){ showToast(t.restrictedFeature); return; }
  const ok = window.confirm(t.confirmDeleteEntry);
  if(!ok) return;
  const expense = expenses.find(e=>e.id===id);
  expenses = expenses.filter(e=>e.id!==id);
  await saveExpenses();
  if(expense){
    stats.totalExpenses = Math.max(0, stats.totalExpenses - expense.amount);
    saveStats();
  }
  renderExpensesHistory();
  render();
  showToast(t.entryDeleted);
}

async function handleAddSave(){
  const requiredPermission = editingProductId ? canEditDeleteProducts() : canAddProducts();
  if(!requiredPermission){ showToast(dict[currentLang].restrictedFeature); closeAddSheet(); return; }
  if(addMode === 'simple'){ await addProduct(); return; }
  if(addMode === 'carton'){ await addCartonProduct(); return; }
  if(addMode === 'sac'){ await addSacProduct(); return; }
}

async function addProduct(){
  if(typeof saveInProgress !== 'undefined' && saveInProgress) return; // un appui précédent est déjà en train d'être traité
  if(typeof saveInProgress !== 'undefined') saveInProgress = true;
  try{
    await addProductInner();
  } finally {
    if(typeof saveInProgress !== 'undefined') saveInProgress = false;
  }
}
async function addProductInner(){
  const name = document.getElementById('in-name').value.trim();
  if(hasNegativeInputs(['in-buy','in-sell','in-qty','in-threshold'])){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const rawBuy = parseFloat(document.getElementById('in-buy').value) || 0;
  const rawSell = parseFloat(document.getElementById('in-sell').value) || 0;
  // Chaque champ (achat/vente) convertit selon sa propre devise sélectionnée
  const buy = toInternalField(rawBuy, 'buy');
  const sell = toInternalField(rawSell, 'sell');
  const unit = document.getElementById('in-unit').value || 'pc';
  const qty = parseQtyForUnit(document.getElementById('in-qty').value, unit);
  const threshold = parseQtyForUnit(document.getElementById('in-threshold').value, unit) || (isDecimalUnit(unit) ? 1 : 3);
  const hasExpiry = document.getElementById('in-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('in-expiry-date') || null) : null;
  if(!name || !sell){
    showToast(currentLang==='fr' ? "Donne au moins un nom et un prix de vente" : "Pesa nkombo na ntalo ya kotéka");
    return;
  }
  if(editingProductId){
    const product = products.find(p=>p.id===editingProductId);
    if(product){
      if(currentRole()==='magasinier'){
        logActivity('product_edit', dict[currentLang].logProductEdited + ' : ' + product.name);
      }
      product.name = name; product.buy = buy; product.sell = sell; product.unit = unit;
      product.qty = qty; product.threshold = threshold; product.expiryDate = expiryDate;
    }
  } else {
    products.push({
      id: Date.now().toString(), name, buy, sell, unit, qty, threshold, expiryDate,
      lastSoldAt: null, createdAt: Date.now(),
      barcode: pendingBarcodeForNewProduct || null
    });
  }
  // Capturés AVANT closeAddSheet() (qui remet pendingBarcodeForNewProduct à null) — on en a
  // besoin après pour, le cas échéant, proposer de contribuer au catalogue communautaire.
  const scannedBarcode = pendingBarcodeForNewProduct;
  const scannedLookupResult = pendingBarcodeLookupResult;
  const wasEditing = !!editingProductId;
  await saveProducts();
  closeAddSheet();
  showToast(wasEditing ? dict[currentLang].updated : dict[currentLang].saved);
  render();
  if(!wasEditing){
    maybeOfferCustomCatalogSave(name);
    maybeTrackFirstProduct();
    if(typeof maybeContributeScannedProduct === 'function'){
      maybeContributeScannedProduct(scannedBarcode, name, scannedLookupResult);
    }
  }
}

async function addCartonProduct(){
  const name = document.getElementById('carton-name').value.trim();
  if(hasNegativeInputs(['carton-qty','carton-buy','carton-sell','carton-threshold'])){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const cartonQty = parseInt(document.getElementById('carton-qty').value) || 0;
  const rawCartonBuy = parseFloat(document.getElementById('carton-buy').value) || 0;
  const rawSell = parseFloat(document.getElementById('carton-sell').value) || 0;
  const threshold = parseInt(document.getElementById('carton-threshold').value) || 3;
  if(!name || !cartonQty || !rawSell){
    showToast(currentLang==='fr' ? "Remplis le nom, le nombre de pièces et le prix de vente" : "Pesa nkombo, motángo na ntalo ya kotéka");
    return;
  }
  const cartonBuyInternal = toInternalField(rawCartonBuy, 'cartonBuy');
  const buyPerPiece = cartonBuyInternal / cartonQty;
  const sell = toInternalField(rawSell, 'cartonSell');
  const hasExpiry = document.getElementById('carton-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('carton-expiry-date') || null) : null;
  products.push({
    id: Date.now().toString(), name, buy: buyPerPiece, sell, unit: 'pc',
    qty: cartonQty, threshold, expiryDate, lastSoldAt: null, createdAt: Date.now(),
    barcode: pendingBarcodeForNewProduct || null
  });
  pendingBarcodeForNewProduct = null;
  await saveProducts();
  closeAddSheet();
  showToast(dict[currentLang].saved);
  render();
  maybeOfferCustomCatalogSave(name);
  maybeTrackFirstProduct();
}

async function addSacProduct(){
  const unit = document.getElementById('sac-unit') ? document.getElementById('sac-unit').value : 'mesurette';
  if(unit !== 'mesurette'){ await addSacProductGeneric(unit); return; }
  await addSacProductMesurette();
}

/* ---------- Sac réparti en mesurettes personnalisées (comportement historique) ---------- */
async function addSacProductMesurette(){
  const name = document.getElementById('sac-name').value.trim();
  if(hasNegativeInputs(['sac-buy','sac-threshold'])){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const rawSacBuy = parseFloat(document.getElementById('sac-buy').value) || 0;
  const threshold = parseInt(document.getElementById('sac-threshold').value) || 3;
  if(!name || !rawSacBuy){
    showToast(currentLang==='fr' ? "Remplis le nom et le prix d'achat du sac" : "Pesa nkombo na ntalo ya sac");
    return;
  }
  const sacBuyInternal = toInternalField(rawSacBuy, 'sacBuy');
  const rows = document.querySelectorAll('#mesurettes-list .mesurette-row');
  const rowIds = [];
  rows.forEach((row)=>{
    const idx = row.id.replace('mesurette-row-','');
    rowIds.push('mesurette-sell-'+idx, 'mesurette-qty-'+idx);
  });
  if(hasNegativeInputs(rowIds)){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const validRows = [];
  rows.forEach((row)=>{
    const idx = row.id.replace('mesurette-row-','');
    const mName = document.getElementById('mesurette-name-'+idx).value.trim();
    const rawMSell = parseFloat(document.getElementById('mesurette-sell-'+idx).value) || 0;
    const mQty = parseInt(document.getElementById('mesurette-qty-'+idx).value) || 0;
    if(mName && rawMSell && mQty) validRows.push({ mName, rawMSell, mQty, idx });
  });
  if(validRows.length === 0){
    showToast(currentLang==='fr' ? "Remplis au moins une mesurette complète" : "Pesa aumoins mesurette moko mobimba");
    return;
  }
  const hasExpiry = document.getElementById('sac-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('sac-expiry-date') || null) : null;
  const lotId = 'lot' + Date.now().toString();
  let offset = 0;
  validRows.forEach(({mName, rawMSell, mQty, idx})=>{
    const mSell = toInternalField(rawMSell, 'mesurette'+idx);
    const buyPerUnit = sacBuyInternal / mQty;
    offset++;
    products.push({
      id: (Date.now()+offset).toString(), name: `${name} (${mName})`, buy: buyPerUnit, sell: mSell, unit: 'pc',
      qty: mQty, threshold, expiryDate, lastSoldAt: null, createdAt: Date.now(),
      lotId: lotId, yieldPerSac: mQty
    });
  });
  lots.push({ id: lotId, name, remainingFraction: 1, createdAt: Date.now() });
  await saveProducts();
  saveLots();
  closeAddSheet();
  showToast(dict[currentLang].saved);
  render();
  maybeOfferCustomCatalogSave(name);
  maybeTrackFirstProduct();
}

/* ---------- Sac réparti dans une unité standard (kg, g, L, ml, m, cm) ----------
   Un seul produit est créé, dans l'unité choisie. Le prix d'achat par unité vient
   de : prix d'achat du sac ÷ quantité ESTIMÉE contenue dans le sac (fournie par le
   commerçant, ex: "environ 25 kg"). Sans cette estimation, aucun moyen de calculer
   un coût par kg/L/m réel, donc pas de bénéfice fiable pour ce produit. */
async function addSacProductGeneric(unit){
  const name = document.getElementById('sac-name').value.trim();
  if(hasNegativeInputs(['sac-buy','sac-threshold','sac-generic-qty','sac-generic-sell'])){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const rawSacBuy = parseFloat(document.getElementById('sac-buy').value) || 0;
  const rawEstQty = parseFloat(document.getElementById('sac-generic-qty').value) || 0;
  const rawSell = parseFloat(document.getElementById('sac-generic-sell').value) || 0;
  const threshold = parseQtyForUnit(document.getElementById('sac-threshold').value, unit) || (isDecimalUnit(unit) ? 1 : 3);
  if(!name || !rawSacBuy || !rawEstQty || !rawSell){
    showToast(currentLang==='fr' ? "Remplis le nom, le prix d'achat du sac, la quantité estimée et le prix de vente" : (currentLang==='ln' ? "Pesa nkombo, ntalo ya sac, motángo ya estimation na ntalo ya kotéka" : "Jaza jina, bei ya gunia, kiasi cha makadirio na bei ya mauzo"));
    return;
  }
  const estQty = parseQtyForUnit(rawEstQty, unit);
  if(!estQty){
    showToast(currentLang==='fr' ? "La quantité estimée doit être supérieure à 0" : (currentLang==='ln' ? "Motángo ya estimation esengeli koleka 0" : "Kiasi cha makadirio kinapaswa kuwa zaidi ya 0"));
    return;
  }
  const sacBuyInternal = toInternalField(rawSacBuy, 'sacBuy');
  const buyPerUnit = sacBuyInternal / estQty;
  const sell = toInternalField(rawSell, 'sacGenericSell');
  const hasExpiry = document.getElementById('sac-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('sac-expiry-date') || null) : null;
  products.push({
    id: Date.now().toString(), name, buy: buyPerUnit, sell, unit,
    qty: estQty, threshold, expiryDate, lastSoldAt: null, createdAt: Date.now(),
    barcode: pendingBarcodeForNewProduct || null
  });
  await saveProducts();
  closeAddSheet();
  showToast(dict[currentLang].saved);
  render();
  maybeOfferCustomCatalogSave(name);
  maybeTrackFirstProduct();
}

// saveActivityLog() vit maintenant dans activity-log-sync.js (journal d'activité dans
// sa propre collection Firestore, avec purge automatique — voir firestore.rules).
function logActivity(action, label, extra){
  const roleLabel = { patron:'Patron', caissier:'Caissier', magasinier:'Magasinier' };
  const who = employeeDeviceName ? `${roleLabel[currentRole()]} (${employeeDeviceName})` : roleLabel[currentRole()];
  activityLog.unshift(Object.assign({ id: 'act'+Date.now()+Math.random().toString(36).slice(2,6), action, label, who, date: Date.now() }, extra||{}));
  if(activityLog.length > 300) activityLog = activityLog.slice(0, 300);
  saveActivityLog();
}

/* ---------- Suppression produit ---------- */
async function deleteProduct(id){
  if(!canEditDeleteProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  const product = products.find(p=>p.id===id);
  if(!product) return;
  const ok = window.confirm(`${dict[currentLang].confirmDelete}\n"${product.name}"`);
  if(!ok) return;
  logActivity('product_delete', dict[currentLang].logProductDeleted + ' : ' + product.name + ' × ' + formatQty(product.qty, product.unit), { productName: product.name, qty: product.qty, unit: product.unit || 'pc' });
  products = products.filter(p=>p.id!==id);
  await saveProducts();
  showToast(dict[currentLang].deleted);
  render();
}

async function deleteAllProducts(){
  const t = dict[currentLang];
  if(!isPatron()){ showToast(t.restrictedFeature); return; }
  if(products.length === 0) return;
  const msg = t.confirmDeleteAllProducts.replace('{n}', products.length);
  const ok = window.confirm(msg);
  if(!ok) return;
  products = [];
  await saveProducts();
  showToast(t.allProductsDeleted);
  render();
}

/* =========================================================================
   AJOUT RAPIDE EN MASSE DEPUIS LE CATALOGUE — sert aussi de "kit de démarrage"
   ---------------------------------------------------------------------------
   Pensé pour les boutiques qui démarrent avec un gros catalogue (pharmacie,
   quincaillerie...) et n'ont pas envie d'ouvrir/remplir/valider le formulaire
   d'ajout des centaines de fois. On voit TOUT le catalogue intégré du métier
   de la boutique (1268 en pharmacie, 595 en quincaillerie, 415 en boutique
   générale) et on coche ce qu'on vend.

   Sélection illimitée pour tout le monde (l'ancienne limite de 30 produits pour
   les comptes gratuits a été retirée). Seul le bouton "Tout cocher" (qui prend le
   catalogue entier en un clic sans avoir à cocher case par case) reste une
   commodité réservée aux comptes VIP.

   Le prix d'achat par défaut reste à 0 : à la différence du nom (connu à
   l'avance dans un catalogue métier), le prix d'achat dépend du fournisseur
   du commerçant et n'a aucune raison d'être identique pour tous les
   produits — mieux vaut le corriger produit par produit ensuite (via
   "Modifier ✏️") que de figer une fausse valeur pour 500 produits.
   ========================================================================= */
let bulkCatalogSelection = new Set();

function openBulkCatalogSheet(){
  if(!canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  const merged = getFullCatalogForActiveStore();
  if(!merged || merged.length === 0){
    showToast(currentLang==='fr' ? "Pas encore de catalogue pour cette boutique" : (currentLang==='ln' ? "Catalogue ezali nanu te" : "Bado hakuna katalogi kwa duka hili"));
    return;
  }
  bulkCatalogSelection = new Set();
  document.getElementById('in-bulk-search').value = '';
  document.getElementById('in-bulk-default-sell').value = '';
  document.getElementById('in-bulk-default-qty').value = '';
  document.getElementById('in-bulk-default-threshold').value = '3';
  renderBulkCatalogList('');
  document.getElementById('bulk-catalog-overlay').classList.add('open');
}
function closeBulkCatalogSheet(){
  document.getElementById('bulk-catalog-overlay').classList.remove('open');
}
function renderBulkCatalogList(query){
  const merged = getFullCatalogForActiveStore();
  const q = (query||'').trim().toLowerCase();
  // Affichage limité à 300 lignes à la fois pour rester fluide sur un catalogue de plus
  // de 1000 produits — la recherche permet de retrouver le reste. Sélection illimitée
  // pour tous les comptes.
  const list = (q ? merged.filter(n=>n.toLowerCase().includes(q)) : merged).slice(0, 300);
  const wrap = document.getElementById('bulk-catalog-list');
  wrap.innerHTML = '';
  list.forEach(name=>{
    const checked = bulkCatalogSelection.has(name);
    const row = document.createElement('label');
    row.className = 'bulk-catalog-row';
    row.innerHTML = `
      <input type="checkbox" data-name="${escapeHtml(name)}" ${checked?'checked':''}>
      <span>${escapeHtml(name)}</span>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      if(cb.checked){
        bulkCatalogSelection.add(cb.dataset.name);
      } else {
        bulkCatalogSelection.delete(cb.dataset.name);
      }
      renderBulkCatalogList(document.getElementById('in-bulk-search').value);
    });
  });
  updateBulkCatalogCount();
}
function onBulkCatalogSearch(){
  renderBulkCatalogList(document.getElementById('in-bulk-search').value);
}
// Prend tout le catalogue affiché par la recherche en cours (ou tout le catalogue si
// aucune recherche n'est tapée) — disponible pour tous les comptes, gratuit ou VIP.
function selectAllBulkCatalog(){
  const merged = getFullCatalogForActiveStore();
  const q = document.getElementById('in-bulk-search').value.trim().toLowerCase();
  const list = q ? merged.filter(n=>n.toLowerCase().includes(q)) : merged;
  list.forEach(name=>bulkCatalogSelection.add(name));
  renderBulkCatalogList(q);
}
function deselectAllBulkCatalog(){
  bulkCatalogSelection.clear();
  renderBulkCatalogList(document.getElementById('in-bulk-search').value);
}
function updateBulkCatalogCount(){
  const btn = document.getElementById('t-bulk-confirm-btn');
  if(!btn) return;
  const t = dict[currentLang];
  const n = bulkCatalogSelection.size;
  const countLabel = document.getElementById('bulk-catalog-count');
  if(countLabel){
    countLabel.textContent = (t.bulkSelectedCountVip || '{n} sélectionnés').replace('{n}', n);
  }
  btn.textContent = (t.bulkAddBtn || 'Ajouter {n} produits').replace('{n}', n);
  btn.disabled = n === 0;
}
async function confirmBulkCatalogAdd(){
  if(bulkCatalogSelection.size === 0) return;
  if(hasNegativeInputs(['in-bulk-default-sell','in-bulk-default-qty','in-bulk-default-threshold'])){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  const rawSell = parseFloat(document.getElementById('in-bulk-default-sell').value) || 0;
  const rawQty = parseInt(document.getElementById('in-bulk-default-qty').value) || 0;
  const threshold = parseInt(document.getElementById('in-bulk-default-threshold').value) || 3;
  const sell = toInternal(rawSell);
  const names = Array.from(bulkCatalogSelection);
  let offset = 0;
  names.forEach(name=>{
    offset++;
    products.push({
      id: (Date.now()+offset).toString(), name, buy: 0, sell,
      qty: rawQty, threshold, expiryDate: null, lastSoldAt: null, createdAt: Date.now()
    });
  });
  await saveProducts();
  closeBulkCatalogSheet();
  closeAddSheet();
  const t = dict[currentLang];
  const msg = (t.bulkAddSuccess || '{n} produits ajoutés — pense à corriger les prix un par un si besoin').replace('{n}', names.length);
  showToast(msg, 4000);
  render();
}

/* ---------- Dupliquer un produit (utile pour les variantes : tailles, couleurs, parfums...) ---------- */
async function duplicateProduct(id){
  if(!canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  const product = products.find(p=>p.id===id);
  if(!product) return;
  const copy = {
    id: Date.now().toString(), name: product.name + ' (copie)',
    buy: product.buy, sell: product.sell, qty: 0, threshold: product.threshold,
    expiryDate: product.expiryDate || null, lastSoldAt: null, createdAt: Date.now()
  };
  // Une copie démarre comme un produit indépendant, jamais rattachée au même lot/sac
  // que l'original — sinon vendre l'un modifierait le stock de l'autre par erreur.
  products.push(copy);
  await saveProducts();
  render();
  openEditSheet(copy.id);
}

/* =========================================================================
   SAISIE RAPIDE EN TABLEAU
   ---------------------------------------------------------------------------
   Une grille façon tableur — une ligne par produit (nom | achat | vente | qté)
   — pour taper plusieurs produits à la suite sans rouvrir/fermer le formulaire
   d'ajout habituel à chaque fois. Contrairement à l'ajout depuis le catalogue,
   ça ne dépend d'aucun catalogue existant : utile pour des produits faits
   maison ou spécifiques à la boutique, dont le nom n'est dans aucune liste.
   Le seuil d'alerte est fixé à GRID_DEFAULT_THRESHOLD pour tous les produits
   créés ici (pas de colonne dédiée, pour garder la grille rapide à remplir) —
   modifiable ensuite produit par produit avec "Modifier ✏️" si besoin.
   ========================================================================= */
const GRID_DEFAULT_THRESHOLD = 3;
const GRID_INITIAL_ROWS = 8;

function openGridAddSheet(){
  if(!canAddProducts()){ showToast(dict[currentLang].restrictedFeature); return; }
  document.getElementById('grid-add-rows').innerHTML = '';
  for(let i=0; i<GRID_INITIAL_ROWS; i++) addGridRow();
  updateGridConfirmCount();
  document.getElementById('grid-add-overlay').classList.add('open');
}
function closeGridAddSheet(){
  document.getElementById('grid-add-overlay').classList.remove('open');
}
function addGridRow(){
  const t = dict[currentLang];
  const row = document.createElement('div');
  row.className = 'grid-add-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'grid-name';
  nameInput.placeholder = t.gridColName || 'Nom';
  nameInput.addEventListener('input', updateGridConfirmCount);

  const buyInput = document.createElement('input');
  buyInput.type = 'number'; buyInput.inputMode = 'decimal'; buyInput.className = 'grid-buy'; buyInput.placeholder = '0';

  const sellInput = document.createElement('input');
  sellInput.type = 'number'; sellInput.inputMode = 'decimal'; sellInput.className = 'grid-sell'; sellInput.placeholder = '0';

  const qtyInput = document.createElement('input');
  qtyInput.type = 'number'; qtyInput.inputMode = 'numeric'; qtyInput.className = 'grid-qty'; qtyInput.placeholder = '0';

  const delBtn = document.createElement('button');
  delBtn.type = 'button'; delBtn.className = 'grid-row-del'; delBtn.textContent = '✕';
  delBtn.setAttribute('aria-label', t.gridRemoveRowLabel || 'Supprimer la ligne');
  delBtn.addEventListener('click', function(){ row.remove(); updateGridConfirmCount(); });

  row.appendChild(nameInput); row.appendChild(buyInput); row.appendChild(sellInput);
  row.appendChild(qtyInput); row.appendChild(delBtn);
  document.getElementById('grid-add-rows').appendChild(row);
}
function updateGridConfirmCount(){
  const rows = document.querySelectorAll('#grid-add-rows .grid-add-row');
  let n = 0;
  rows.forEach(row=>{
    if(row.querySelector('.grid-name').value.trim()) n++;
  });
  const btn = document.getElementById('t-grid-confirm-btn');
  if(!btn) return;
  const t = dict[currentLang];
  btn.textContent = (t.gridConfirmBtn || 'Enregistrer {n} produits').replace('{n}', n);
  btn.disabled = n === 0;
}
async function confirmGridAdd(){
  const rows = document.querySelectorAll('#grid-add-rows .grid-add-row');
  const toCreate = [];
  let hasNegative = false;
  rows.forEach(row=>{
    const name = row.querySelector('.grid-name').value.trim();
    if(!name) return; // ligne laissée vide, simplement ignorée
    const buyEl = row.querySelector('.grid-buy');
    const sellEl = row.querySelector('.grid-sell');
    const qtyEl = row.querySelector('.grid-qty');
    if(!isNonNegativeInput(buyEl.value) || !isNonNegativeInput(sellEl.value) || !isNonNegativeInput(qtyEl.value)){
      hasNegative = true;
      return;
    }
    const rawBuy = parseFloat(buyEl.value) || 0;
    const rawSell = parseFloat(sellEl.value) || 0;
    const qty = parseInt(qtyEl.value, 10) || 0;
    toCreate.push({ name, buy: toInternal(rawBuy), sell: toInternal(rawSell), qty });
  });
  if(hasNegative){
    showToast(dict[currentLang].negativeValueError);
    return;
  }
  if(toCreate.length === 0) return;
  let offset = 0;
  toCreate.forEach(item=>{
    offset++;
    products.push({
      id: (Date.now()+offset).toString(), name: item.name, buy: item.buy, sell: item.sell,
      qty: item.qty, threshold: GRID_DEFAULT_THRESHOLD, expiryDate: null, lastSoldAt: null, createdAt: Date.now()
    });
  });
  await saveProducts();
  closeGridAddSheet();
  closeAddSheet();
  const t = dict[currentLang];
  const msg = (t.gridAddSuccess || '{n} produits ajoutés').replace('{n}', toCreate.length);
  showToast(msg, 3500);
  render();
}

function scrollConfirmIntoView(){
  setTimeout(()=>{
    const btn = document.getElementById('t-confirm-sale');
    if(btn) btn.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 300);
}
