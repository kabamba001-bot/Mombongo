/* ---------- Rendu ---------- */
function getDateValue(prefix){
  const dEl = document.getElementById(prefix+'-d');
  const mEl = document.getElementById(prefix+'-m');
  const yEl = document.getElementById(prefix+'-y');
  if(!dEl || !mEl || !yEl) return '';
  const d = dEl.value, m = mEl.value, y = yEl.value;
  if(!d || !m || !y || String(y).length < 4) return '';
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function setDateValue(prefix, iso){
  const dEl = document.getElementById(prefix+'-d');
  const mEl = document.getElementById(prefix+'-m');
  const yEl = document.getElementById(prefix+'-y');
  if(!dEl || !mEl || !yEl) return;
  if(!iso){ dEl.value = ''; mEl.value = ''; yEl.value = ''; return; }
  const [y,m,d] = iso.split('-');
  yEl.value = y; mEl.value = parseInt(m,10); dEl.value = parseInt(d,10);
}

function isToday(ts){
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString();
}
function daysSince(ts){ return Math.floor((Date.now()-ts)/86400000); }

function getFilteredProducts(){
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  if(!q) return products;
  return products.filter(p=>p.name.toLowerCase().includes(q));
}

/* ---------- Pagination de la liste produits ----------
   Sans ça, render() (appelée après CHAQUE vente, ajout, changement d'onglet...)
   reconstruit un <div class="product-card"> pour la totalité du catalogue à chaque
   fois — invisible avec une trentaine de produits, mais ça devient lent sur un
   téléphone d'entrée de gamme dès que le catalogue atteint plusieurs centaines de
   références (grande pharmacie, quincaillerie bien fournie...). On affiche donc les
   produits par lots de PRODUCTS_PAGE_SIZE, avec un bouton "Afficher plus" qui révèle
   le lot suivant sans jamais redemander à l'utilisateur de le retaper.
   productsRevealCount doit survivre à un simple re-rendu (ex: une vente qui vient de
   se conclure ailleurs) pour ne pas ramener l'utilisateur en haut de la liste au
   milieu de sa lecture — seule une recherche qui change réellement la liste filtrée
   repart de zéro, voir la comparaison avec lastProductsSearchQuery ci-dessous. */
const PRODUCTS_PAGE_SIZE = 60;
let productsRevealCount = PRODUCTS_PAGE_SIZE;
let lastProductsSearchQuery = null;

function loadMoreProducts(){
  productsRevealCount += PRODUCTS_PAGE_SIZE;
  render();
}

function render(){
  const t = dict[currentLang];
  ensureTodayStats();
  if(typeof updateProductsCounter === 'function') updateProductsCounter();

  const role = currentRole();
  const hideProfits = (role === 'caissier' || role === 'magasinier');
  const hideTodaySales = (role === 'magasinier');

  document.getElementById('stat-today').textContent = hideTodaySales ? '•••' : formatMoney(stats.todaySales);
  document.getElementById('stat-profit-today').textContent = hideProfits ? '•••' : formatMoney(stats.todayProfit);
  document.getElementById('stat-profit-total').textContent = hideProfits ? '•••' : formatMoney(stats.totalProfit - stats.totalExpenses);
  const expenseRow = document.querySelector('.sub-expense:not(.sub-debt)');
  if(expenseRow){
    expenseRow.style.display = isFeatureUnlocked('expenseTracking') ? '' : 'none';
    document.getElementById('stat-expenses').textContent = formatMoney(stats.totalExpenses);
  }

  document.getElementById('t-add-btn').style.display = (role==='caissier') ? 'none' : '';
  document.getElementById('t-expense-btn').style.display = (role==='patron' || role==='caissier' || role==='magasinier') ? '' : 'none';
  document.getElementById('voice-sale-btn').style.display = canSell() ? '' : 'none';
  ['reset-today-sales-btn','reset-today-profit-btn','reset-total-profit-btn','reset-expenses-btn'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.style.display = isPatron() ? '' : 'none';
  });

  const openDebts = debts.filter(d=>d.status==='ouvert');
  const totalOwed = openDebts.reduce((sum,d)=>sum + Math.max(0, d.totalOwed - d.amountPaid), 0);
  document.getElementById('stat-debts').textContent = formatMoney(totalOwed);
  const debtRow = document.querySelector('.sub-debt');
  if(debtRow) debtRow.style.display = (role==='magasinier' || !isFeatureUnlocked('customerDebts')) ? 'none' : '';

  // Un produit jamais vendu (ex : tout juste importé du catalogue intégré avec une
  // quantité à 0 par défaut) n'a jamais été réellement "en rupture" — il n'a simplement
  // pas encore été mis en vente. On ne le compte en "stock faible" qu'à partir du moment
  // où il a été vendu au moins une fois (lastSoldAt renseigné), pour éviter qu'un import
  // en masse de centaines de produits ne déclenche autant de fausses alertes d'un coup.
  const lowStock = isFeatureUnlocked('lowStockAlerts')
    ? products.filter(p=>p.qty <= p.threshold && p.lastSoldAt) : [];
  const dormant = products.filter(p=>{
    const ref = p.lastSoldAt || p.createdAt;
    return daysSince(ref) >= 14;
  });
  const todayStr = new Date().toISOString().slice(0,10);
  const expired = products.filter(p => p.expiryDate && p.expiryDate < todayStr);
  const expiringSoon = products.filter(p => p.expiryDate && p.expiryDate >= todayStr && daysUntilExpiry(p.expiryDate) <= EXPIRY_WARNING_DAYS);
  const dueSoonDebts = (role==='magasinier' || !isFeatureUnlocked('customerDebts')) ? [] : getDueSoonDebts();
  // Réservé au patron (voir renderAlertsSheet() pour le détail) : les gestes des employés
  // des 7 derniers jours comptent aussi comme une alerte à passer en revue.
  const recentActivityCount = (role==='patron') ? (activityLog||[]).filter(a => Date.now() - a.date < 7*24*60*60*1000).length : 0;
  const alertCount = new Set([...lowStock.map(p=>p.id), ...dormant.map(p=>p.id), ...expired.map(p=>p.id), ...expiringSoon.map(p=>p.id)]).size + dueSoonDebts.length + recentActivityCount;
  document.getElementById('stat-alerts').textContent = alertCount;

  const alertsSection = document.getElementById('alerts-section');
  alertsSection.style.display = alertCount > 0 ? 'block' : 'none';
  document.getElementById('t-alerts-prompt').textContent = t.alertsPrompt;

  const list = document.getElementById('products-list');
  const empty = document.getElementById('empty-state');
  const noResults = document.getElementById('no-results');
  const loadMoreBtn = document.getElementById('load-more-products-btn');
  const deleteAllBtn = document.getElementById('delete-all-products-btn');
  const filtered = getFilteredProducts();
  list.innerHTML = '';

  // Une recherche qui change réellement la liste repart de la première page ; un
  // re-rendu déclenché par autre chose (vente, sync temps réel...) garde la position
  // de lecture déjà atteinte — voir le commentaire sur productsRevealCount plus haut.
  const currentSearchQuery = document.getElementById('search-input').value.trim().toLowerCase();
  if(currentSearchQuery !== lastProductsSearchQuery){
    productsRevealCount = PRODUCTS_PAGE_SIZE;
    lastProductsSearchQuery = currentSearchQuery;
  }

  if(isPatron() && products.length > 0){
    deleteAllBtn.style.display = 'block';
    deleteAllBtn.textContent = t.deleteAllProductsBtn.replace('{n}', products.length);
  } else {
    deleteAllBtn.style.display = 'none';
  }

  if(products.length === 0){
    empty.style.display = 'block';
    noResults.style.display = 'none';
    if(loadMoreBtn) loadMoreBtn.style.display = 'none';
  } else if(filtered.length === 0){
    empty.style.display = 'none';
    noResults.style.display = 'block';
    if(loadMoreBtn) loadMoreBtn.style.display = 'none';
  } else {
    empty.style.display = 'none';
    noResults.style.display = 'none';
    const visible = filtered.slice(0, productsRevealCount);
    // Calculé une seule fois par rendu (pas par produit) : au-delà de la limite du
    // palier courant, les produits les PLUS RÉCENTS sont gelés — voir plans.js.
    const frozenIds = (typeof computeFrozenProductIds === 'function')
      ? computeFrozenProductIds(products) : new Set();
    visible.forEach(p=>{
      const dotClass = p.qty === 0 ? 'red' : (p.qty <= p.threshold ? 'amber' : 'green');
      const frozen = frozenIds.has(p.id);
      const card = document.createElement('div');
      card.className = 'product-card' + (frozen ? ' frozen' : '');
      let actionButtons;
      if(frozen){
        // Gelé : aucune action possible (vendre/modifier/dupliquer/supprimer) tant que
        // le palier n'est pas relevé — un seul cadenas explique pourquoi en un clic.
        actionButtons = `<button class="frozen-badge" onclick="showToast(dict[currentLang].productFrozenMsg, 5000)" aria-label="${t.productFrozenMsg}" title="${t.productFrozenMsg}">🔒</button>`;
      } else {
        const sellBtn = canSell() ? `<button class="sell" onclick="openSellSheet('${p.id}')">${currentLang==='fr'?'Vendre':'Téka'}</button>` : '';
        const editBtn = canEditDeleteProducts() ? `<button class="edit" onclick="openEditSheet('${p.id}')" aria-label="Modifier">✏️</button>` : '';
        // Dupliquer sert surtout pour les variantes (tailles, couleurs, parfums...) d'un produit
        // déjà en stock — mêmes droits que l'ajout, puisque c'est une forme de création de produit.
        const dupBtn = canAddProducts() ? `<button class="edit" onclick="duplicateProduct('${p.id}')" aria-label="${t.duplicateProductLabel}" title="${t.duplicateProductLabel}">📄</button>` : '';
        const delBtn = canEditDeleteProducts() ? `<button class="del" onclick="deleteProduct('${p.id}')" aria-label="Supprimer">🗑</button>` : '';
        actionButtons = `${sellBtn}${editBtn}${dupBtn}${delBtn}`;
      }
      card.innerHTML = `
        <div class="dot ${dotClass}"></div>
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${formatQty(p.qty, p.unit)} ${t.stockUnit}</div>
        </div>
        <div class="price">${formatMoney(p.sell)}</div>
        ${actionButtons}
      `;
      list.appendChild(card);
    });
    if(loadMoreBtn){
      const remaining = filtered.length - visible.length;
      if(remaining > 0){
        loadMoreBtn.style.display = 'block';
        loadMoreBtn.textContent = t.loadMoreProductsBtn.replace('{n}', remaining);
      } else {
        loadMoreBtn.style.display = 'none';
      }
    }
  }
}

function ensureTodayStats(){
  const todayStr = new Date().toDateString();
  if(stats.todayDate !== todayStr){
    stats.todayDate = todayStr;
    stats.todaySales = 0;
    stats.todayProfit = 0;
    saveStats();
  }
}

function saveStats(){
  localSet('mombongo:stats', JSON.stringify(stats));
  pushToCloud();
}

async function resetStat(field){
  if(!isPatron()){ showToast(dict[currentLang].restrictedFeature); return; }
  const t = dict[currentLang];
  const ok = window.confirm(t.confirmResetStats);
  if(!ok) return;
  stats[field] = 0;
  saveStats();
  render();
  showToast(t.statsReset);
}

async function resetExpenses(){
  if(!isPatron()){ showToast(dict[currentLang].restrictedFeature); return; }
  const t = dict[currentLang];
  const ok = window.confirm(t.confirmResetStats);
  if(!ok) return;
  stats.totalExpenses = 0;
  saveStats();
  render();
  showToast(t.statsReset);
}

/* ---------- Historique des ventes ---------- */
let historyPeriod = 'day';
let historyCustomFrom = null;
let historyCustomTo = null;
// Pagination de l'historique : au-delà d'un an d'activité, une boutique peut avoir
// des milliers d'entrées (ventes + dépenses + remboursements + activité) — tout
// injecter d'un coup dans le DOM fait ramer, voire geler, le navigateur sur un
// téléphone d'entrée de gamme. On n'affiche donc qu'un nombre limité d'entrées à
// la fois, avec un bouton "Voir plus" pour révéler la suite à la demande.
let historyPage = 1;
const HISTORY_PAGE_SIZE = 50;

function openHistorySheet(){
  historyPeriod = 'day';
  historyCustomFrom = null;
  historyCustomTo = null;
  historyPage = 1;
  document.querySelectorAll('.period-btn').forEach(b=>b.classList.toggle('active', b.dataset.period==='day'));
  document.getElementById('custom-range-fields').style.display = 'none';
  setDateValue('in-period-from', '');
  setDateValue('in-period-to', '');
  renderHistory();
  document.getElementById('history-overlay').classList.add('open');
}
function closeHistorySheet(){
  document.getElementById('history-overlay').classList.remove('open');
}


function renderAccountUI(){
  const t = dict[currentLang];
  const loggedOut = document.getElementById('account-logged-out');
  const loggedIn = document.getElementById('account-logged-in');
  const employeeBox = document.getElementById('account-employee-mode');
  const storesDevicesSection = document.getElementById('account-stores-devices-section');
  const btnLabel = document.getElementById('account-btn-label');

  if(isEmployeeMode){
    loggedOut.style.display = 'none';
    loggedIn.style.display = 'none';
    employeeBox.style.display = 'block';
    const roleLabel = { patron:t.rolePatron, caissier:t.roleCaissier, magasinier:t.roleMagasinier };
    document.getElementById('employee-role-display').textContent = roleLabel[employeeRole] || employeeRole;
    btnLabel.textContent = roleLabel[employeeRole] || t.account;
  } else if(currentUser){
    loggedOut.style.display = 'none';
    loggedIn.style.display = 'block';
    employeeBox.style.display = 'none';
    document.getElementById('account-photo').src = currentUser.photoURL || '';
    document.getElementById('account-name').textContent = currentUser.displayName || '';
    document.getElementById('account-email').textContent = currentUser.email || '';
    const vipBadge = document.getElementById('account-vip-badge');
    if(vipBadge){
      vipBadge.style.display = isVip ? 'inline' : 'none';
      vipBadge.textContent = isVip ? `⭐ VIP · ${dict[currentLang].vipUntilLabel} ${vipUntil}` : '⭐ VIP';
    }
    btnLabel.textContent = currentUser.displayName ? currentUser.displayName.split(' ')[0] : 'Compte';
  } else {
    loggedOut.style.display = 'block';
    loggedIn.style.display = 'none';
    employeeBox.style.display = 'none';
    btnLabel.textContent = dict[currentLang].account || 'Compte';
  }

  // Un appareil secondaire connecté en rôle "patron" gère aussi les boutiques et
  // les appareils, exactement comme le compte principal (aucune restriction).
  if(storesDevicesSection){
    storesDevicesSection.style.display = canManageStoresAndDevices() ? 'block' : 'none';
  }
  if(typeof updatePlanSummary === 'function') updatePlanSummary();
  if(typeof updateNotifButton === 'function') updateNotifButton();
}

function renderStoresList(){
  const container = document.getElementById('stores-list');
  if(!container) return;
  container.innerHTML = '';
  if(!canManageStoresAndDevices() || (!currentUser && !isEmployeeMode)){
    return;
  }
  stores.forEach(s=>{
    const row = document.createElement('div');
    row.className = 'debt-item';
    row.style.padding = '10px 12px';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    const active = s.id === activeStoreId;
    const typeIcons = { boutique:'🏪', pharmacie:'🏥', quincaillerie:'🔧', autre:'❓' };
    const typeBadge = s.type ? `<span style="font-size:11px; color:var(--charcoal-soft);">${typeIcons[s.type]||''}</span> ` : '';
    const renameBtn = `<button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--paper-2); border-radius:8px; margin:0 0 0 6px;" onclick="renameStore('${s.id}')" aria-label="Renommer">✏️</button>`;
    const phoneBtn = `<button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--paper-2); border-radius:8px; margin:0 0 0 6px;" onclick="editStorePhone('${s.id}')" aria-label="Téléphone">☎️</button>`;
    const delBtn = stores.length > 1
      ? `<button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--alert-bg); color:var(--alert); border-radius:8px; margin:0 0 0 6px;" onclick="deleteStore('${s.id}')" aria-label="Supprimer">🗑</button>`
      : '';
    row.innerHTML = `
      <div style="flex:1; min-width:0;">
        <div style="font-weight:700; font-size:13.5px;">${typeBadge}${escapeHtml(s.name)}${active ? ' <span style="color:var(--emerald); font-size:11px;">● '+dict[currentLang].activeStoreTag+'</span>' : ''}</div>
      </div>
      <div style="display:flex; align-items:center;">
        ${active ? '' : `<button class="btn-secondary" style="width:auto; padding:6px 12px; background:var(--paper-2); border-radius:8px; margin:0;" onclick="switchStore('${s.id}')">${currentLang==='fr'?'Choisir':'Poná'}</button>`}
        ${renameBtn}
        ${phoneBtn}
        ${delBtn}
      </div>
    `;
    container.appendChild(row);
  });
}

function renderDevicesList(){
  const containers = ['devices-list-inline','devices-list']
    .map(id=>document.getElementById(id))
    .filter(Boolean);
  if(containers.length === 0) return;
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid || !canManageStoresAndDevices()){
    containers.forEach(c=>c.innerHTML = '');
    return;
  }
  const t = dict[currentLang];
  db.collection('mombongo_users').doc(ownerUid).collection('devices').get().then(snap=>{
    containers.forEach(list=>{
      list.innerHTML = '';
      if(snap.empty){
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = t.noDevices;
        list.appendChild(p);
        return;
      }
      const roleLabel = { patron:t.rolePatron, caissier:t.roleCaissier, magasinier:t.roleMagasinier };
      snap.forEach(docu=>{
        const dv = docu.data();
        const row = document.createElement('div');
        row.className = 'debt-item';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.innerHTML = `
          <div>
            <div style="font-weight:700; font-size:13.5px;">${escapeHtml(dv.name || roleLabel[dv.role] || dv.role)}</div>
            <div style="font-size:11.5px; color:var(--charcoal-soft);">${escapeHtml(roleLabel[dv.role] || dv.role)}</div>
          </div>
          <div style="display:flex; align-items:center;">
            <button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--paper-2); border-radius:8px; margin:0 6px 0 0;" onclick="renameDevice('${docu.id}', this)" data-name="${escapeHtml(dv.name || '')}" aria-label="${t.renameDeviceBtn}">✏️</button>
            <button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--alert-bg); color:var(--alert); border-radius:8px; margin:0;" onclick="removeDevice('${docu.id}')" aria-label="${t.removeDeviceBtn}">🗑️</button>
          </div>
        `;
        list.appendChild(row);
      });
    });
  }).catch(e=>console.error('Erreur chargement appareils', e));
}

function renderCatalogPanel(fieldId, items){
  const panel = document.getElementById('catalog-panel-'+fieldId);
  if(!panel) return;
  panel.innerHTML = '';
  if(items.length === 0){
    const empty = document.createElement('div');
    empty.className = 'catalog-panel-empty';
    empty.textContent = currentLang==='fr' ? 'Aucun résultat' : (currentLang==='ln' ? 'Ezali te' : 'Hakuna matokeo');
    panel.appendChild(empty);
  } else {
    items.forEach(name=>{
      const row = document.createElement('div');
      row.className = 'catalog-panel-item';
      row.textContent = name;
      row.addEventListener('mousedown', e=>e.preventDefault());
      row.addEventListener('click', ()=>pickCatalogItem(fieldId, name));
      panel.appendChild(row);
    });
  }
  panel.style.display = 'block';
}

function renderExpensesHistory(){
  const t = dict[currentLang];
  const list = document.getElementById('expenses-history-list');
  const empty = document.getElementById('expenses-history-empty');
  const sorted = [...expenses].sort((a,b)=>b.date-a.date);
  list.innerHTML = '';
  if(sorted.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  sorted.forEach(e=>{
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(e.desc)}</div>
        <div class="meta">${formatDateTime(e.date)}</div>
      </div>
      <div class="amounts">
        <div class="total negative">-${formatMoney(e.amount)}</div>
      </div>
      <button class="del-entry" onclick="deleteExpenseHistoryEntry('${e.id}')" aria-label="Supprimer">🗑</button>
    `;
    list.appendChild(div);
  });
}

function renderHistory(){
  const t = dict[currentLang];
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const { start, end } = getPeriodRange();
  const role = currentRole();

  const summary = computePeriodSummary(start, end);
  document.getElementById('summary-revenue').textContent = (role==='magasinier') ? '•••' : formatMoney(summary.revenue);
  document.getElementById('summary-expenses').textContent = formatMoney(summary.expensesTotal);
  document.getElementById('summary-net').textContent = (role==='caissier' || role==='magasinier') ? '•••' : formatMoney(summary.netGain);

  const exportRow = document.querySelector('.toggle-row');
  if(exportRow) exportRow.style.display = isPatron() ? 'flex' : 'none';
  const exportFields = document.getElementById('export-fields');
  if(!isPatron() && exportFields) exportFields.style.display = 'none';
  const clearHistoryBtn = document.getElementById('t-clear-history');
  if(clearHistoryBtn) clearHistoryBtn.style.display = isPatron() ? 'block' : 'none';

  let sorted = buildUnifiedHistory().filter(e => e.date >= start && e.date <= end);
  if(role === 'magasinier'){
    sorted = sorted.filter(e => e.type === 'expense');
  } else if(role === 'caissier'){
    sorted = sorted.map(e => e.type === 'sale' ? { ...e, sub: '' } : e); // masque le bénéfice par vente
  }
  list.innerHTML = '';
  if(sorted.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  // On ne construit les nœuds DOM QUE pour la page courante — jamais pour la liste
  // entière — c'est ça qui évite le ralentissement sur un gros historique. Charger
  // une page de plus ne refait pas de calcul lourd : "sorted" est déjà prêt, on
  // élargit juste la tranche affichée.
  const visible = sorted.slice(0, historyPage * HISTORY_PAGE_SIZE);
  visible.forEach(entry=>{
    const div = document.createElement('div');
    div.className = 'history-item';
    const amountClass = entry.amount < 0 ? 'total negative' : 'total';
    const canDeleteThis = entry.deletable && (entry.type==='sale' ? canDeleteSale() : isPatron());
    const delBtn = canDeleteThis
      ? (entry.type==='sale'
          ? `<button class="del-entry" onclick="openDeleteSaleReasonSheet('${entry.id}')" aria-label="Supprimer">🗑</button>`
          : `<button class="del-entry" onclick="deleteHistoryEntry('${entry.type}','${entry.id}')" aria-label="Supprimer">🗑</button>`)
      : '';
    const receiptBtn = entry.type==='sale'
      ? `<button class="del-entry" onclick="reprintReceipt('${entry.id}')" aria-label="Reçu" title="${dict[currentLang].receiptViewBtn}">🧾</button>`
      : '';
    div.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(entry.label)}</div>
        <div class="meta">${formatDateTime(entry.date)}</div>
      </div>
      <div class="amounts">
        ${entry.type==='activity' ? '' : `<div class="${amountClass}">${entry.amount < 0 ? '-' : ''}${formatMoney(Math.abs(entry.amount))}</div>`}
        ${entry.sub ? `<div class="profit">${entry.sub}</div>` : ''}
      </div>
      ${receiptBtn}
      ${delBtn}
    `;
    list.appendChild(div);
  });
  if(sorted.length > visible.length){
    const remaining = sorted.length - visible.length;
    const loadMoreDiv = document.createElement('div');
    loadMoreDiv.className = 'history-load-more';
    loadMoreDiv.innerHTML = `<button type="button" class="btn-secondary" onclick="loadMoreHistory()">${(dict[currentLang].historyLoadMoreBtn || 'Voir plus ({n} restants)').replace('{n}', remaining)}</button>`;
    list.appendChild(loadMoreDiv);
  }
}
// Révèle une page de plus dans l'historique déjà affiché (voir HISTORY_PAGE_SIZE).
function loadMoreHistory(){
  historyPage++;
  renderHistory();
}

function renderDebtsList(){
  const t = dict[currentLang];
  const list = document.getElementById('debts-list');
  const empty = document.getElementById('debts-empty');
  const openDebts = debts.filter(d=>d.status==='ouvert' && (d.totalOwed - d.amountPaid) > 0.001)
    .sort((a,b)=>b.createdAt-a.createdAt);
  list.innerHTML = '';
  if(openDebts.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const canEditDebt = isPatron() || currentRole()==='caissier';
  openDebts.forEach(d=>{
    const remaining = Math.max(0, d.totalOwed - d.amountPaid);
    const itemsSummary = d.items.map(it=>`${escapeHtml(it.productName)} ×${formatQty(it.qty, it.unit)}`).join(', ');
    const safePhone = escapeHtml(d.phone);
    const safeClientName = escapeHtml(d.clientName);
    const editBtn = canEditDebt
      ? `<button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--paper-2); border-radius:8px; margin:0 0 0 6px;" onclick="openEditDebtSheet('${d.id}')" aria-label="${t.renameTitle || 'Modifier'}">✏️</button>`
      : '';
    const delBtn = isPatron()
      ? `<button class="btn-secondary" style="width:auto; padding:6px 10px; background:var(--alert-bg); color:var(--alert); border-radius:8px; margin:0 0 0 6px;" onclick="deleteDebt('${d.id}')" aria-label="Supprimer">🗑</button>`
      : '';
    const div = document.createElement('div');
    div.className = 'debt-item';
    div.innerHTML = `
      <div class="top-row">
        <div>
          <div class="name">${d.phone ? `<a href="tel:${safePhone}" class="client-call-link">📞 ${safeClientName}</a>` : safeClientName}</div>
          ${d.phone ? `<div class="phone">${safePhone}</div>` : ''}
        </div>
        <div style="display:flex; align-items:center;">
          <div class="owed">${formatMoney(remaining)}</div>
          ${editBtn}
          ${delBtn}
        </div>
      </div>
      <div class="items-list">${itemsSummary}</div>
      ${d.dueDate ? `<div class="due">📅 ${t.dueLabel} : ${d.dueDate} — <b>${dueDateLabel(t, daysUntilDue(d.dueDate))}</b></div>` : ''}
      ${canRepayDebt() ? `<button class="pay-btn" onclick="openRepaySheet('${d.id}')">${t.payBtn}</button>` : ''}
    `;
    list.appendChild(div);
  });
}

function renderAlertsSheet(){
  const t = dict[currentLang];
  const list = document.getElementById('alerts-sheet-list');
  const empty = document.getElementById('alerts-sheet-empty');
  // Même règle que pour le compteur du tableau de bord : un produit jamais vendu ne
  // s'affiche pas dans "stock faible" tant qu'il n'a pas été vendu au moins une fois.
  const lowStock = isFeatureUnlocked('lowStockAlerts')
    ? products.filter(p=>p.qty <= p.threshold && p.lastSoldAt) : [];
  const dormant = products.filter(p=>{
    const ref = p.lastSoldAt || p.createdAt;
    return daysSince(ref) >= 14;
  });
  const todayStr = new Date().toISOString().slice(0,10);
  const expired = products.filter(p => p.expiryDate && p.expiryDate < todayStr);
  const expiringSoon = products.filter(p => p.expiryDate && p.expiryDate >= todayStr && daysUntilExpiry(p.expiryDate) <= EXPIRY_WARNING_DAYS)
    .sort((a,b)=>daysUntilExpiry(a.expiryDate)-daysUntilExpiry(b.expiryDate));
  const dueSoonDebts = (currentRole()==='magasinier' || !isFeatureUnlocked('customerDebts')) ? [] : getDueSoonDebts();
  // Réservé au patron : les gestes des employés (voir logActivity() dans products.js,
  // appelée depuis debts-expenses-alerts.js et suppliers.js) restent visibles en détail
  // dans l'historique 👁️, et les 7 derniers jours réapparaissent aussi ici, en alerte,
  // pour que le patron n'ait pas besoin d'aller les chercher pour les remarquer.
  const recentActivity = isPatron() ? (activityLog||[]).filter(a => Date.now() - a.date < 7*24*60*60*1000) : [];

  const debtsTabBtn = document.getElementById('t-alerts-tab-debts');
  if(debtsTabBtn){
    debtsTabBtn.style.display = dueSoonDebts.length > 0 ? '' : 'none';
    if(dueSoonDebts.length === 0 && alertsTab === 'debts'){
      alertsTab = 'stock';
      document.querySelectorAll('#alerts-overlay .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.alertstab==='stock'));
    }
  }
  const activityTabBtn = document.getElementById('t-alerts-tab-activity');
  if(activityTabBtn){
    activityTabBtn.style.display = recentActivity.length > 0 ? '' : 'none';
    if(recentActivity.length === 0 && alertsTab === 'activity'){
      alertsTab = 'stock';
      document.querySelectorAll('#alerts-overlay .mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.alertstab==='stock'));
    }
  }

  list.innerHTML = '';
  let items = [];
  if(alertsTab === 'stock'){
    lowStock.forEach(p=>items.push(`<b>${escapeHtml(p.name)}</b> — ${t.lowStock} (${formatQty(p.qty, p.unit)} ${t.stockUnit})`));
    dormant.forEach(p=>items.push(`<b>${escapeHtml(p.name)}</b> — ${t.dormant}`));
  } else if(alertsTab === 'expired'){
    expiringSoon.forEach(p=>items.push(`⏳ <b>${escapeHtml(p.name)}</b> — ${expiryLabel(t, daysUntilExpiry(p.expiryDate))}`));
    expired.forEach(p=>items.push(`⏰ <b>${escapeHtml(p.name)}</b> — ${t.expiredAlert} (${p.expiryDate})`));
  } else if(alertsTab === 'debts'){
    dueSoonDebts.forEach(d=>{
      const remaining = Math.max(0, d.totalOwed - d.amountPaid);
      items.push(`💳 <b>${escapeHtml(d.clientName)}</b> — ${dueDateLabel(t, daysUntilDue(d.dueDate))} (${formatMoney(remaining)})`);
    });
  } else if(alertsTab === 'activity'){
    recentActivity.forEach(a=>{
      const delBtn = isPatron()
        ? `<button class="del-entry" onclick="deleteHistoryEntry('activity','${a.id}')" aria-label="Supprimer">🗑</button>`
        : '';
      items.push(`<div class="alert-activity-row"><span>👁️ ${escapeHtml(a.label)} — <b>${escapeHtml(a.who)}</b> · ${formatDateTime(a.date)}</span>${delBtn}</div>`);
    });
  }

  if(items.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  if(alertsTab === 'activity' && isPatron() && recentActivity.length > 0){
    const clearAllDiv = document.createElement('div');
    clearAllDiv.className = 'alert-clear-all';
    clearAllDiv.innerHTML = `<button type="button" class="btn-danger-outline" onclick="clearAllActivityLog()">🗑️ ${t.clearAllActivityBtn}</button>`;
    list.appendChild(clearAllDiv);
  }
  items.forEach(html=>{
    const div = document.createElement('div');
    div.className = 'alert-banner';
    div.innerHTML = html;
    list.appendChild(div);
  });
}
