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
  if(mode==='sac' && mesuretteCount===0){
    addMesuretteRow(); addMesuretteRow(); addMesuretteRow();
  }
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
  updateProductNameSuggestions();
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
  resetMesurettes();
  setAddMode('simple');
  resetFieldCurrencies();
  document.getElementById('in-name').value = product.name;
  document.getElementById('in-buy').value = currentCurrency==='cdf' ? Math.round(product.buy*exchangeRate) : product.buy;
  document.getElementById('in-sell').value = currentCurrency==='cdf' ? Math.round(product.sell*exchangeRate) : product.sell;
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
   'sac-name','sac-buy','sac-threshold'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.value='';
  });
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
}

function toInternal(raw){
  return currentCurrency === 'cdf' ? raw / exchangeRate : raw;
}

/* ---------- Devise indépendante par champ de prix ---------- */
let priceFieldCurrency = {};
function resetFieldCurrencies(){
  priceFieldCurrency = { buy: currentCurrency, sell: currentCurrency, cartonBuy: currentCurrency, cartonSell: currentCurrency, sacBuy: currentCurrency };
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
  const map = { buy:'in-buy', sell:'in-sell', cartonBuy:'carton-buy', cartonSell:'carton-sell', sacBuy:'sac-buy' };
  if(map[field]) return map[field];
  if(field.indexOf('mesurette') === 0) return 'mesurette-sell-' + field.replace('mesurette','');
  return null;
}
function toInternalField(raw, field){
  const cur = priceFieldCurrency[field] || currentCurrency;
  return cur === 'cdf' ? raw / exchangeRate : raw;
}

function canAddMoreProducts(countToAdd){
  if(isVip) return true;
  return (products.length + countToAdd) <= FREE_PRODUCT_LIMIT;
}
function canAddMoreExpenses(){
  if(isVip) return true;
  return expenses.length < FREE_EXPENSE_LIMIT;
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
  reason = reason || 'products';
  // "HitProductLimit" : la personne a rempli ses 30 produits gratuits — signal fort
  // qu'elle utilise vraiment l'app pour de bon et envisage de contacter le développeur
  // pour débloquer l'illimité.
  if(reason === 'products' && typeof fbq === 'function'){
    fbq('trackCustom', 'HitProductLimit');
  }
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
    const descKey = { products:'limitDesc', expenses:'limitDescExpenses', history:'limitDescHistory', stores:'limitDescStores', devices:'limitDescDevices', notif:'limitDescNotif', export:'limitDescExport' }[reason];
    const msgKey = { products:'limitWhatsappMsg', expenses:'limitWhatsappMsgExpenses', history:'limitWhatsappMsgHistory', stores:'limitWhatsappMsgStores', devices:'limitWhatsappMsgDevices', notif:'limitWhatsappMsgNotif', export:'limitWhatsappMsgExport' }[reason];
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
  const name = document.getElementById('in-name').value.trim();
  const rawBuy = parseFloat(document.getElementById('in-buy').value) || 0;
  const rawSell = parseFloat(document.getElementById('in-sell').value) || 0;
  // Chaque champ (achat/vente) convertit selon sa propre devise sélectionnée
  const buy = toInternalField(rawBuy, 'buy');
  const sell = toInternalField(rawSell, 'sell');
  const qty = parseInt(document.getElementById('in-qty').value) || 0;
  const threshold = parseInt(document.getElementById('in-threshold').value) || 3;
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
      product.name = name; product.buy = buy; product.sell = sell;
      product.qty = qty; product.threshold = threshold; product.expiryDate = expiryDate;
    }
  } else {
    if(!canAddMoreProducts(1)){ openLimitSheet(); return; }
    products.push({ id: Date.now().toString(), name, buy, sell, qty, threshold, expiryDate, lastSoldAt: null, createdAt: Date.now() });
  }
  const wasEditing = !!editingProductId;
  await saveProducts();
  closeAddSheet();
  showToast(wasEditing ? dict[currentLang].updated : dict[currentLang].saved);
  render();
  if(!wasEditing){
    maybeOfferCustomCatalogSave(name);
    maybeTrackFirstProduct();
  }
}

async function addCartonProduct(){
  const name = document.getElementById('carton-name').value.trim();
  const cartonQty = parseInt(document.getElementById('carton-qty').value) || 0;
  const rawCartonBuy = parseFloat(document.getElementById('carton-buy').value) || 0;
  const rawSell = parseFloat(document.getElementById('carton-sell').value) || 0;
  const threshold = parseInt(document.getElementById('carton-threshold').value) || 3;
  if(!name || !cartonQty || !rawSell){
    showToast(currentLang==='fr' ? "Remplis le nom, le nombre de pièces et le prix de vente" : "Pesa nkombo, motángo na ntalo ya kotéka");
    return;
  }
  if(!canAddMoreProducts(1)){ openLimitSheet(); return; }
  const cartonBuyInternal = toInternalField(rawCartonBuy, 'cartonBuy');
  const buyPerPiece = cartonBuyInternal / cartonQty;
  const sell = toInternalField(rawSell, 'cartonSell');
  const hasExpiry = document.getElementById('carton-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('carton-expiry-date') || null) : null;
  products.push({
    id: Date.now().toString(), name, buy: buyPerPiece, sell,
    qty: cartonQty, threshold, expiryDate, lastSoldAt: null, createdAt: Date.now()
  });
  await saveProducts();
  closeAddSheet();
  showToast(dict[currentLang].saved);
  render();
  maybeOfferCustomCatalogSave(name);
  maybeTrackFirstProduct();
}

async function addSacProduct(){
  const name = document.getElementById('sac-name').value.trim();
  const rawSacBuy = parseFloat(document.getElementById('sac-buy').value) || 0;
  const threshold = parseInt(document.getElementById('sac-threshold').value) || 3;
  if(!name || !rawSacBuy){
    showToast(currentLang==='fr' ? "Remplis le nom et le prix d'achat du sac" : "Pesa nkombo na ntalo ya sac");
    return;
  }
  const sacBuyInternal = toInternalField(rawSacBuy, 'sacBuy');
  const rows = document.querySelectorAll('#mesurettes-list .mesurette-row');
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
  if(!canAddMoreProducts(validRows.length)){ openLimitSheet(); return; }
  const hasExpiry = document.getElementById('sac-has-expiry').checked;
  const expiryDate = hasExpiry ? (getDateValue('sac-expiry-date') || null) : null;
  const lotId = 'lot' + Date.now().toString();
  let offset = 0;
  validRows.forEach(({mName, rawMSell, mQty, idx})=>{
    const mSell = toInternalField(rawMSell, 'mesurette'+idx);
    const buyPerUnit = sacBuyInternal / mQty;
    offset++;
    products.push({
      id: (Date.now()+offset).toString(), name: `${name} (${mName})`, buy: buyPerUnit, sell: mSell,
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

function saveActivityLog(){
  localSet('mombongo:activityLog', JSON.stringify(activityLog));
  pushToCloud();
}
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
  logActivity('product_delete', dict[currentLang].logProductDeleted + ' : ' + product.name + ' × ' + product.qty, { productName: product.name, qty: product.qty });
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

function scrollConfirmIntoView(){
  setTimeout(()=>{
    const btn = document.getElementById('t-confirm-sale');
    if(btn) btn.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 300);
}
