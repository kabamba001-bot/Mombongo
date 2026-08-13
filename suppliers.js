/* =========================================================================
   FOURNISSEURS & ACHATS — fonctionnalité VIP, désactivée par défaut.
   ---------------------------------------------------------------------------
   Symétrique de debts.js : là où Mombongo suit déjà ce que TES CLIENTS te
   doivent (crédits de vente), ce fichier suit l'autre sens — d'où viennent
   tes produits, et ce que TOI tu dois à tes fournisseurs quand ils te
   livrent à crédit.

   MODÈLE DE DONNÉES :
   - suppliers : [{ id, name, phone, createdAt }]
   - purchases : [{ id, supplierId, supplierName, date,
                     items: [{ productId, productName, qty, unitCost, total }],
                     totalAmount, isCredit, amountPaid, totalOwed, status,
                     payments: [{ amount, date }], dueDate }]
     Chaque achat sert AUSSI de dette-fournisseur quand isCredit est vrai —
     exactement comme une vente à crédit sert aussi de dette-client dans
     debts.js. Pas besoin d'une structure séparée.
   - suppliersFeatureEnabled : l'interrupteur (voir toggleSuppliersFeature),
     par boutique, réglable uniquement par un utilisateur VIP.

   CHOIX ASSUMÉ : le prix d'achat (product.buy) affiché sur la fiche produit
   est TOUJOURS le dernier prix payé (pas une moyenne pondérée) — c'est déjà
   comme ça que fonctionne le champ "prix d'achat" ailleurs dans Mombongo
   (ex : quand on modifie un produit à la main), donc enregistrer un achat ne
   fait que réutiliser ce même comportement, sans logique de calcul en plus.

   LIMITE CONNUE : contrairement aux ventes, un achat déjà enregistré ne peut
   pas encore être supprimé depuis l'historique — supprimer un achat sans
   annuler proprement son effet sur le stock et le prix d'achat du produit
   serait risqué. Si une correction est nécessaire, on ajuste directement la
   fiche du produit concerné (quantité, prix d'achat) à la main pour l'instant.
   ========================================================================= */

/* ---------- Permissions (même esprit que canSell()/canRepayDebt() ailleurs) ---------- */
function canManageSuppliers(){
  const r = currentRole();
  return r === 'patron' || r === 'caissier';
}

/* ---------- Interrupteur VIP (menu Compte → Boutiques) ---------- */
async function toggleSuppliersFeature(){
  const t = dict[currentLang];
  const checkbox = document.getElementById('in-suppliers-toggle');
  if(!isVip){
    if(checkbox) checkbox.checked = false;
    closeAccountSheet();
    openLimitSheet('suppliers');
    return;
  }
  suppliersFeatureEnabled = checkbox ? checkbox.checked : !suppliersFeatureEnabled;
  await saveSuppliersFeatureEnabled();
  updateHeaderSuppliersButtonVisibility();
  showToast(suppliersFeatureEnabled ? t.suppliersEnabled : t.suppliersDisabled);
}

// Le bouton d'en-tête n'existe que si : la fonctionnalité est activée pour cette boutique,
// ET l'utilisateur est actuellement VIP (un VIP expiré masque le bouton, sans perdre les
// données déjà enregistrées — elles réapparaissent dès que le VIP est renouvelé), ET son
// rôle l'autorise à voir des informations financières.
function updateHeaderSuppliersButtonVisibility(){
  const btn = document.getElementById('suppliers-header-btn');
  if(!btn) return;
  btn.style.display = (suppliersFeatureEnabled && isVip && canManageSuppliers()) ? 'flex' : 'none';
}
// Se greffe sur render(), comme updateBackupBanner()/updateBarcodeButtonsVisibility() —
// le statut VIP ou le rôle peuvent changer sans repasser par ce fichier.
window.addEventListener('load', function(){
  if(typeof render === 'function' && !render.__suppliersButtonWrapped){
    const _originalRenderForSuppliers = render;
    render = function(){
      _originalRenderForSuppliers.apply(this, arguments);
      updateHeaderSuppliersButtonVisibility();
    };
    render.__suppliersButtonWrapped = true;
  }
  updateHeaderSuppliersButtonVisibility();
});

/* ---------- Montant dû à un fournisseur (somme de ses achats à crédit non réglés) ---------- */
function supplierTotalOwed(supplierId){
  return purchases
    .filter(p => p.supplierId === supplierId && p.isCredit && p.status !== 'réglé')
    .reduce((sum, p) => sum + Math.max(0, p.totalOwed - p.amountPaid), 0);
}
function totalOwedToAllSuppliers(){
  return purchases
    .filter(p => p.isCredit && p.status !== 'réglé')
    .reduce((sum, p) => sum + Math.max(0, p.totalOwed - p.amountPaid), 0);
}

/* ---------- Fiche principale : liste des fournisseurs ---------- */
function openSuppliersSheet(){
  if(!isVip || !suppliersFeatureEnabled){ openLimitSheet('suppliers'); return; }
  if(!canManageSuppliers()){ showToast(dict[currentLang].restrictedFeature); return; }
  renderSuppliersList();
  document.getElementById('suppliers-overlay').classList.add('open');
}
function closeSuppliersSheet(){
  document.getElementById('suppliers-overlay').classList.remove('open');
}

function renderSuppliersList(){
  const t = dict[currentLang];
  const wrap = document.getElementById('suppliers-list');
  const totalEl = document.getElementById('suppliers-total-owed');
  if(totalEl) totalEl.textContent = formatMoney(totalOwedToAllSuppliers());
  if(!wrap) return;
  wrap.innerHTML = '';
  if(suppliers.length === 0){
    wrap.innerHTML = `<div class="empty" style="padding:20px 0;">${escapeHtml(t.suppliersEmpty)}</div>`;
    return;
  }
  suppliers.forEach(s=>{
    const owed = supplierTotalOwed(s.id);
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${escapeHtml(s.phone || '')}</div>
      </div>
      <div class="amounts">
        ${owed > 0 ? `<div class="alert">${formatMoney(owed)} ${escapeHtml(t.owedToSupplierSuffix)}</div>` : ''}
      </div>
      <button class="del-entry" onclick="openRecordPurchaseSheet('${s.id}')" aria-label="${escapeHtml(t.recordPurchaseTitle)}" title="${escapeHtml(t.recordPurchaseTitle)}">🛒</button>
      ${owed > 0 ? `<button class="del-entry" onclick="openPaySupplierSheet('${s.id}')" aria-label="${escapeHtml(t.paySupplierBtn)}" title="${escapeHtml(t.paySupplierBtn)}">💳</button>` : ''}
      <button class="del-entry" onclick="openSupplierFormSheet('${s.id}')" aria-label="Modifier">✏️</button>
      ${isPatron() ? `<button class="del-entry" onclick="deleteSupplier('${s.id}')" aria-label="Supprimer">🗑</button>` : ''}
    `;
    wrap.appendChild(row);
  });
}

/* ---------- Ajouter / modifier un fournisseur ---------- */
let editingSupplierId = null;
function openSupplierFormSheet(supplierId){
  if(!canManageSuppliers()){ showToast(dict[currentLang].restrictedFeature); return; }
  editingSupplierId = supplierId || null;
  const supplier = supplierId ? suppliers.find(s=>s.id===supplierId) : null;
  document.getElementById('in-supplier-name').value = supplier ? supplier.name : '';
  document.getElementById('in-supplier-phone').value = supplier ? (supplier.phone || '') : '';
  document.getElementById('t-supplier-form-title').textContent = supplier ? dict[currentLang].editSupplierTitle : dict[currentLang].newSupplierTitle;
  document.getElementById('supplier-form-overlay').classList.add('open');
}
function closeSupplierFormSheet(){
  document.getElementById('supplier-form-overlay').classList.remove('open');
  editingSupplierId = null;
}
async function confirmSaveSupplier(){
  const t = dict[currentLang];
  const name = document.getElementById('in-supplier-name').value.trim();
  const phone = document.getElementById('in-supplier-phone').value.trim();
  if(!name){ showToast(t.supplierNameRequired); return; }
  const wasEditing = !!editingSupplierId;
  if(editingSupplierId){
    const supplier = suppliers.find(s=>s.id===editingSupplierId);
    if(supplier){ supplier.name = name; supplier.phone = phone; }
  } else {
    suppliers.push({ id: Date.now().toString(), name, phone, createdAt: Date.now() });
  }
  await saveSuppliers();
  if(currentRole() !== 'patron'){
    logActivity(wasEditing ? 'supplier_edit' : 'supplier_add', (wasEditing ? t.logSupplierEdited : t.logSupplierAdded) + ' : ' + name);
  }
  closeSupplierFormSheet();
  renderSuppliersList();
  showToast(t.supplierSaved);
}
async function deleteSupplier(supplierId){
  const t = dict[currentLang];
  if(!isPatron()){ showToast(t.restrictedFeature); return; }
  if(supplierTotalOwed(supplierId) > 0){
    showToast(t.cannotDeleteSupplierWithDebt, 4000);
    return;
  }
  const supplier = suppliers.find(s=>s.id===supplierId);
  if(!supplier) return;
  const ok = window.confirm(`${t.confirmDeleteSupplier}\n"${supplier.name}"`);
  if(!ok) return;
  suppliers = suppliers.filter(s=>s.id!==supplierId);
  await saveSuppliers();
  renderSuppliersList();
  showToast(t.supplierDeleted);
}

/* ---------- Enregistrer un achat (réapprovisionnement) ---------- */
function openRecordPurchaseSheet(preselectSupplierId){
  const t = dict[currentLang];
  if(!canManageSuppliers()){ showToast(t.restrictedFeature); return; }
  if(suppliers.length === 0){
    showToast(t.addSupplierFirst, 4000);
    return;
  }
  const select = document.getElementById('in-purchase-supplier');
  select.innerHTML = suppliers.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if(typeof preselectSupplierId === 'string') select.value = preselectSupplierId;
  document.getElementById('purchase-items-rows').innerHTML = '';
  addPurchaseItemRow();
  document.getElementById('in-purchase-is-credit').checked = false;
  document.getElementById('purchase-credit-fields').style.display = 'none';
  document.getElementById('in-purchase-due').value = '';
  document.getElementById('in-purchase-paid-now').value = '';
  updatePurchaseTotal();
  document.getElementById('record-purchase-overlay').classList.add('open');
}
function closeRecordPurchaseSheet(){
  document.getElementById('record-purchase-overlay').classList.remove('open');
}
function togglePurchaseCreditFields(){
  const isCredit = document.getElementById('in-purchase-is-credit').checked;
  document.getElementById('purchase-credit-fields').style.display = isCredit ? 'block' : 'none';
}
function addPurchaseItemRow(){
  const t = dict[currentLang];
  const row = document.createElement('div');
  row.className = 'purchase-item-row';

  const select = document.createElement('select');
  select.className = 'purchase-item-product';
  select.innerHTML = `<option value="">${escapeHtml(t.chooseProduct)}</option>` +
    products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.addEventListener('change', function(){
    // Pré-remplit le coût unitaire avec le dernier prix d'achat connu de ce produit —
    // gain de temps, l'utilisateur peut toujours le corriger si le prix a changé.
    const product = products.find(p=>p.id===select.value);
    if(product){
      const costInput = row.querySelector('.purchase-item-cost');
      if(costInput && !costInput.value){
        costInput.value = currentCurrency==='cdf' ? Math.round(product.buy*exchangeRate) : product.buy;
      }
    }
    updatePurchaseTotal();
  });

  const qtyInput = document.createElement('input');
  qtyInput.type = 'number'; qtyInput.inputMode = 'numeric'; qtyInput.className = 'purchase-item-qty';
  qtyInput.placeholder = t.gridColQty || 'Qté';
  qtyInput.addEventListener('input', updatePurchaseTotal);

  const costInput = document.createElement('input');
  costInput.type = 'number'; costInput.inputMode = 'decimal'; costInput.className = 'purchase-item-cost';
  costInput.placeholder = t.unitCostPlaceholder;
  costInput.addEventListener('input', updatePurchaseTotal);

  const delBtn = document.createElement('button');
  delBtn.type = 'button'; delBtn.className = 'grid-row-del';
  delBtn.textContent = '✕';
  delBtn.setAttribute('aria-label', t.gridRemoveRowLabel || 'Supprimer la ligne');
  delBtn.addEventListener('click', function(){ row.remove(); updatePurchaseTotal(); });

  row.appendChild(select); row.appendChild(qtyInput); row.appendChild(costInput); row.appendChild(delBtn);
  document.getElementById('purchase-items-rows').appendChild(row);
}
function updatePurchaseTotal(){
  const rows = document.querySelectorAll('#purchase-items-rows .purchase-item-row');
  let total = 0;
  rows.forEach(row=>{
    const qty = parseFloat(row.querySelector('.purchase-item-qty').value) || 0;
    const cost = parseFloat(row.querySelector('.purchase-item-cost').value) || 0;
    total += qty * cost;
  });
  const totalInternal = toInternal(total);
  document.getElementById('purchase-total-display').textContent = formatMoney(totalInternal);
  return totalInternal;
}
async function confirmRecordPurchase(){
  const t = dict[currentLang];
  if(!canManageSuppliers()){ showToast(t.restrictedFeature); return; }
  const supplierId = document.getElementById('in-purchase-supplier').value;
  const supplier = suppliers.find(s=>s.id===supplierId);
  if(!supplier){ showToast(t.supplierNameRequired); return; }

  const rows = document.querySelectorAll('#purchase-items-rows .purchase-item-row');
  let hasNegative = false;
  rows.forEach(row=>{
    if(!isNonNegativeInput(row.querySelector('.purchase-item-qty').value)) hasNegative = true;
    if(!isNonNegativeInput(row.querySelector('.purchase-item-cost').value)) hasNegative = true;
  });
  if(hasNegative){ showToast(t.negativeValueError); return; }

  const items = [];
  rows.forEach(row=>{
    const productId = row.querySelector('.purchase-item-product').value;
    const product = products.find(p=>p.id===productId);
    const qty = parseInt(row.querySelector('.purchase-item-qty').value, 10) || 0;
    const rawCost = parseFloat(row.querySelector('.purchase-item-cost').value) || 0;
    if(!product || qty <= 0) return; // ligne incomplète, simplement ignorée
    const unitCost = toInternal(rawCost);
    items.push({ productId: product.id, productName: product.name, qty, unitCost, total: qty * unitCost });
  });
  if(items.length === 0){ showToast(t.purchaseNoItems); return; }

  const totalAmount = items.reduce((s,it)=>s+it.total, 0);
  const isCredit = document.getElementById('in-purchase-is-credit').checked;
  const dueDate = document.getElementById('in-purchase-due').value;
  const rawPaidNowStr = document.getElementById('in-purchase-paid-now').value;
  if(!isNonNegativeInput(rawPaidNowStr)){ showToast(t.negativeValueError); return; }
  const rawPaidNow = parseFloat(rawPaidNowStr) || 0;
  const paidNow = isCredit ? Math.min(totalAmount, toInternal(rawPaidNow)) : totalAmount;

  const purchase = {
    id: Date.now().toString(), supplierId: supplier.id, supplierName: supplier.name, date: Date.now(),
    items, totalAmount, isCredit,
    amountPaid: paidNow, totalOwed: totalAmount,
    status: (totalAmount - paidNow <= 0.01) ? 'réglé' : 'ouvert',
    payments: paidNow > 0 ? [{ amount: paidNow, date: Date.now() }] : [],
    dueDate: isCredit ? dueDate : ''
  };
  purchases.push(purchase);

  // Effet sur le stock : la quantité achetée s'ajoute, et le prix d'achat de chaque
  // produit se met à jour avec le dernier coût payé (voir note en tête de fichier).
  items.forEach(it=>{
    const product = products.find(p=>p.id===it.productId);
    if(product){ product.qty += it.qty; product.buy = it.unitCost; }
  });

  await savePurchases();
  await saveProducts();
  if(currentRole() !== 'patron'){
    const creditNote = isCredit ? ' (' + t.creditOpenBadge + ')' : ' (' + t.cashBadge + ')';
    logActivity('purchase_add', t.logPurchaseSaved + ' : ' + supplier.name + ' — ' + formatMoney(totalAmount) + creditNote);
  }
  closeRecordPurchaseSheet();
  renderSuppliersList();
  render();
  showToast(t.purchaseSaved);
}

/* ---------- Historique des achats ---------- */
function openPurchaseHistorySheet(){
  if(!canManageSuppliers()){ showToast(dict[currentLang].restrictedFeature); return; }
  renderPurchaseHistory();
  document.getElementById('purchase-history-overlay').classList.add('open');
}
function closePurchaseHistorySheet(){
  document.getElementById('purchase-history-overlay').classList.remove('open');
}
function renderPurchaseHistory(){
  const t = dict[currentLang];
  const wrap = document.getElementById('purchase-history-list');
  if(!wrap) return;
  wrap.innerHTML = '';
  const sorted = [...purchases].sort((a,b)=>b.date-a.date);
  if(sorted.length === 0){
    wrap.innerHTML = `<div class="empty" style="padding:20px 0;">${escapeHtml(t.purchaseHistoryEmpty)}</div>`;
    return;
  }
  sorted.forEach(p=>{
    const itemsLabel = p.items.length === 1
      ? p.items[0].productName
      : `${p.items[0].productName} ${t.andOthersSuffix.replace('{n}', p.items.length - 1)}`;
    const statusBadge = p.isCredit
      ? (p.status === 'réglé' ? t.creditPaidBadge : t.creditOpenBadge)
      : t.cashBadge;
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(p.supplierName)} — ${escapeHtml(itemsLabel)}</div>
        <div class="meta">${formatDateTime(p.date)} · ${escapeHtml(statusBadge)}</div>
      </div>
      <div class="amounts">
        <div class="${p.isCredit && p.status!=='réglé' ? 'alert' : ''}">${formatMoney(p.totalAmount)}</div>
      </div>
    `;
    wrap.appendChild(row);
  });
}

/* ---------- Régler une dette fournisseur ---------- */
let payingSupplierId = null;
function openPaySupplierSheet(supplierId){
  const t = dict[currentLang];
  if(!canManageSuppliers()){ showToast(t.restrictedFeature); return; }
  const owed = supplierTotalOwed(supplierId);
  if(owed <= 0) return;
  payingSupplierId = supplierId;
  const supplier = suppliers.find(s=>s.id===supplierId);
  document.getElementById('pay-supplier-display').value = `${supplier ? supplier.name : ''} — ${formatMoney(owed)} ${t.owedToSupplierSuffix}`;
  document.getElementById('in-pay-supplier-amount').value = currentCurrency==='cdf' ? Math.round(owed*exchangeRate) : owed.toFixed(2);
  document.getElementById('pay-supplier-overlay').classList.add('open');
}
function closePaySupplierSheet(){
  document.getElementById('pay-supplier-overlay').classList.remove('open');
  payingSupplierId = null;
}
async function confirmPaySupplier(){
  const t = dict[currentLang];
  if(!canManageSuppliers()){ showToast(t.restrictedFeature); return; }
  if(!isNonNegativeInput(document.getElementById('in-pay-supplier-amount').value)){
    showToast(t.negativeValueError); return;
  }
  let amount = toInternal(parseFloat(document.getElementById('in-pay-supplier-amount').value) || 0);
  if(amount <= 0){ showToast(t.invalidAmount); return; }
  const originalAmount = amount;

  // On règle les achats à crédit les plus anciens en premier (comme une file d'attente),
  // jusqu'à épuisement du montant versé.
  const openPurchases = purchases
    .filter(p => p.supplierId === payingSupplierId && p.isCredit && p.status !== 'réglé')
    .sort((a,b)=>a.date-b.date);
  for(const p of openPurchases){
    if(amount <= 0) break;
    const remaining = p.totalOwed - p.amountPaid;
    const applied = Math.min(remaining, amount);
    p.amountPaid += applied;
    p.payments.push({ amount: applied, date: Date.now() });
    if(p.totalOwed - p.amountPaid <= 0.01) p.status = 'réglé';
    amount -= applied;
  }
  await savePurchases();
  if(currentRole() !== 'patron'){
    const supplier = suppliers.find(s=>s.id===payingSupplierId);
    logActivity('supplier_pay', t.logSupplierPaid + ' : ' + (supplier ? supplier.name : '') + ' — ' + formatMoney(originalAmount));
  }
  closePaySupplierSheet();
  renderSuppliersList();
  showToast(t.paymentSaved);
}
