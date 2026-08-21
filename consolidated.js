/* =========================================================================
   RAPPORTS & TABLEAU DE BORD CONSOLIDÉS — PALIER PRO UNIQUEMENT
   ---------------------------------------------------------------------------
   Vue "toutes boutiques confondues" pour un patron qui gère à distance.
   Contrairement au reste de l'app — UNE SEULE boutique chargée en mémoire à
   la fois via activeStoreId/storesDataCache (voir stores-devices.js) et des
   listeners temps réel scopés par storeId (attachSalesListener, etc.) — cet
   écran interroge Firestore directement, en LECTURE UNIQUE (pas un listener,
   voir loadConsolidatedData ci-dessous), SANS filtre storeId, puis regroupe
   les résultats par boutique côté client. Les règles Firestore (/sales,
   /expenses — voir firestore.rules) autorisent déjà cette lecture globale
   pour le propriétaire du compte et tout appareil lié : rien à changer côté
   règles, seulement côté lecture.

   Réservé au PATRON (jamais un caissier/magasinier, même en Pro — voir
   canManageStoresAndDevices()) et au palier PRO (voir isFeatureUnlocked
   ('consolidatedReports'), plans.js). Simple et Business se voient proposer
   de passer à Pro au moindre appui, exactement comme les autres
   fonctionnalités verrouillées de l'app (voir openLimitSheet('consolidated')).
   ========================================================================= */

let consolidatedPeriod = 'month';
let consolidatedCustomFrom = null;
let consolidatedCustomTo = null;
let consolidatedStoreRows = []; // dernier résultat calculé — gardé en mémoire pour l'export, sans le recalculer
let consolidatedExportFormat = 'pdf';

function openConsolidatedSheet(){
  if(!isFeatureUnlocked('consolidatedReports')){ openLimitSheet('consolidated'); return; }
  if(!canManageStoresAndDevices()){ showToast(dict[currentLang].restrictedFeature); return; }
  closeAccountSheet();
  consolidatedPeriod = 'month';
  consolidatedCustomFrom = null;
  consolidatedCustomTo = null;
  consolidatedExportFormat = 'pdf';
  document.querySelectorAll('#consolidated-overlay .period-btn').forEach(b=>b.classList.toggle('active', b.dataset.period==='month'));
  document.querySelectorAll('#consolidated-export-format-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.fmt==='pdf'));
  document.getElementById('consolidated-custom-range-fields').style.display = 'none';
  setDateValue('in-consolidated-from', '');
  setDateValue('in-consolidated-to', '');
  document.getElementById('consolidated-overlay').classList.add('open');
  loadConsolidatedData();
}
function closeConsolidatedSheet(){
  document.getElementById('consolidated-overlay').classList.remove('open');
}
function setConsolidatedPeriod(period){
  consolidatedPeriod = period;
  document.querySelectorAll('#consolidated-overlay .period-btn').forEach(b=>b.classList.toggle('active', b.dataset.period===period));
  document.getElementById('consolidated-custom-range-fields').style.display = period==='custom' ? 'block' : 'none';
  if(period !== 'custom' || (consolidatedCustomFrom && consolidatedCustomTo)) loadConsolidatedData();
}
function applyConsolidatedCustomRange(){
  const from = getDateValue('in-consolidated-from');
  const to = getDateValue('in-consolidated-to');
  if(!from || !to){
    showToast(currentLang==='fr' ? "Choisis les deux dates" : (currentLang==='ln' ? "Poná ba dates mibale" : "Chagua tarehe zote mbili"));
    return;
  }
  consolidatedCustomFrom = from;
  consolidatedCustomTo = to;
  loadConsolidatedData();
}
function selectConsolidatedExportFormat(fmt, btn){
  consolidatedExportFormat = fmt;
  document.querySelectorAll('#consolidated-export-format-toggle button').forEach(b=>b.classList.toggle('active', b===btn));
}

// Même découpage jour/semaine/mois/personnalisé que getPeriodRange() (navigation.js)
// pour l'historique d'une boutique — mais sur son propre état (consolidatedPeriod),
// jamais partagé avec historyPeriod : les deux écrans doivent pouvoir avoir des
// périodes différentes ouvertes en même temps sans se marcher dessus.
function getConsolidatedPeriodRange(){
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  if(consolidatedPeriod === 'day') return { start: startOfToday.getTime(), end: endOfToday.getTime() };
  if(consolidatedPeriod === 'week'){
    const start = new Date(startOfToday); start.setDate(start.getDate() - 6);
    return { start: start.getTime(), end: endOfToday.getTime() };
  }
  if(consolidatedPeriod === 'month'){
    const start = new Date(startOfToday); start.setDate(start.getDate() - 29);
    return { start: start.getTime(), end: endOfToday.getTime() };
  }
  if(consolidatedCustomFrom && consolidatedCustomTo){
    return {
      start: new Date(consolidatedCustomFrom + 'T00:00:00').getTime(),
      end: new Date(consolidatedCustomTo + 'T23:59:59').getTime()
    };
  }
  return { start: startOfToday.getTime(), end: endOfToday.getTime() };
}

async function loadConsolidatedData(){
  // Filet de sécurité : si le palier a expiré pendant que la fiche était déjà
  // ouverte (essai Business/Pro qui se termine en session), on n'interroge même
  // pas Firestore — même principe que hasDiscount/hasGlobalDiscount côté ventes.
  if(!isFeatureUnlocked('consolidatedReports')) return;
  const t = dict[currentLang];
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid){
    showToast(t.consolidatedNeedsConnection);
    return;
  }
  renderConsolidatedLoading();
  const { start, end } = getConsolidatedPeriodRange();
  try{
    // Lecture UNIQUE (.get(), pas onSnapshot) sur TOUTE la collection du compte —
    // volontairement sans filtre storeId ni date (Firestore n'a pas d'index composite
    // prêt pour ça, et le reste de l'app ne filtre déjà jamais par date côté serveur
    // non plus, voir attachSalesListener) : le filtrage par période se fait ici,
    // après coup, comme partout ailleurs dans Mombongo.
    const [salesSnap, expensesSnap] = await Promise.all([
      salesCollectionRef(ownerUid).get(),
      expensesCollectionRef(ownerUid).get()
    ]);
    const byStore = {};
    stores.forEach(s => { byStore[s.id] = { storeId: s.id, name: s.name, revenue:0, profit:0, expenses:0, salesCount:0 }; });
    salesSnap.forEach(doc=>{
      const d = doc.data();
      if(!d.storeId || !d.date || d.date < start || d.date > end) return;
      if(!byStore[d.storeId]) byStore[d.storeId] = { storeId: d.storeId, name: t.consolidatedUnknownStore, revenue:0, profit:0, expenses:0, salesCount:0 };
      byStore[d.storeId].revenue += (d.total || 0);
      byStore[d.storeId].profit += (d.profit || 0);
      byStore[d.storeId].salesCount += 1;
    });
    expensesSnap.forEach(doc=>{
      const d = doc.data();
      if(!d.storeId || !d.date || d.date < start || d.date > end) return;
      if(!byStore[d.storeId]) byStore[d.storeId] = { storeId: d.storeId, name: t.consolidatedUnknownStore, revenue:0, profit:0, expenses:0, salesCount:0 };
      byStore[d.storeId].expenses += (d.amount || 0);
    });
    // Triées par bénéfice net décroissant : la première ligne EST "celle qui vend le
    // mieux", les lignes en négatif à la fin sont "là où sont les pertes" — l'ordre
    // porte l'information demandée, pas juste un tri alphabétique par nom.
    consolidatedStoreRows = Object.values(byStore)
      .map(r => Object.assign({}, r, { net: r.profit - r.expenses }))
      .sort((a,b) => b.net - a.net);
    renderConsolidatedDashboard();
  }catch(e){
    console.error('Erreur chargement rapport consolidé', e);
    showToast(t.consolidatedLoadError);
    const list = document.getElementById('consolidated-stores-list');
    if(list) list.innerHTML = '';
    document.getElementById('consolidated-summary-card').style.display = 'none';
  }
}

function renderConsolidatedLoading(){
  const t = dict[currentLang];
  const list = document.getElementById('consolidated-stores-list');
  if(list) list.innerHTML = '<p class="consolidated-status-msg">' + escapeHtml(t.consolidatedLoading) + '</p>';
  document.getElementById('consolidated-summary-card').style.display = 'none';
}

function renderConsolidatedDashboard(){
  const t = dict[currentLang];
  const list = document.getElementById('consolidated-stores-list');
  const summaryEl = document.getElementById('consolidated-summary-card');
  if(consolidatedStoreRows.length === 0){
    list.innerHTML = '<p class="consolidated-status-msg">' + escapeHtml(t.consolidatedEmpty) + '</p>';
    summaryEl.style.display = 'none';
    return;
  }
  const totalRevenue = consolidatedStoreRows.reduce((s,r)=>s+r.revenue,0);
  const totalProfit = consolidatedStoreRows.reduce((s,r)=>s+r.profit,0);
  const totalExpenses = consolidatedStoreRows.reduce((s,r)=>s+r.expenses,0);
  const totalNet = totalProfit - totalExpenses;
  summaryEl.style.display = 'flex';
  document.getElementById('consolidated-total-revenue').textContent = formatMoney(totalRevenue);
  document.getElementById('consolidated-total-expenses').textContent = formatMoney(totalExpenses);
  document.getElementById('consolidated-total-net').textContent = formatMoney(totalNet);

  list.innerHTML = '';
  consolidatedStoreRows.forEach((r, idx)=>{
    const row = document.createElement('div');
    row.className = 'store-compare-row' + (r.net < 0 ? ' loss' : '');
    // 🏆 seulement sur la meilleure boutique ET seulement si elle est réellement
    // profitable (jamais de "gagnant" affiché si même la première est en perte).
    const badge = (idx===0 && r.net > 0) ? '🏆 ' : (r.net < 0 ? '⚠️ ' : '');
    row.innerHTML =
      '<div class="scr-top"><span class="scr-name">' + badge + escapeHtml(r.name) + '</span><span class="scr-net">' + formatMoney(r.net) + '</span></div>' +
      '<div class="scr-detail">' +
        '<span>' + escapeHtml(t.summaryRevenue) + ' : ' + formatMoney(r.revenue) + '</span>' +
        '<span>' + escapeHtml(t.profit) + ' : ' + formatMoney(r.profit) + '</span>' +
        '<span>' + escapeHtml(t.summaryExpenses) + ' : ' + formatMoney(r.expenses) + '</span>' +
        '<span>' + r.salesCount + ' ' + escapeHtml(t.consolidatedColSalesCount).toLowerCase() + '</span>' +
      '</div>';
    list.appendChild(row);
  });
}

/* ---------- Export PDF / Excel du rapport consolidé ----------
   Distinct de exportHistory() (export.js), qui reste limité à UNE boutique à la
   fois — celle-ci exporte exactement ce qui est affiché à l'écran
   (consolidatedStoreRows), donc jamais désynchronisé de ce que le patron voit. */
function exportConsolidatedReport(){
  const t = dict[currentLang];
  if(!isFeatureUnlocked('consolidatedReports')){ openLimitSheet('consolidated'); return; }
  if(!canManageStoresAndDevices()){ showToast(t.restrictedFeature); return; }
  if(consolidatedStoreRows.length === 0){ showToast(t.exportEmpty); return; }
  const { start, end } = getConsolidatedPeriodRange();
  const periodStr = new Date(start).toLocaleDateString('fr-FR') + ' \u2192 ' + new Date(end).toLocaleDateString('fr-FR');
  const filenameBase = `mombongo_consolide_${new Date().toISOString().slice(0,10)}`;
  if(consolidatedExportFormat === 'excel'){
    exportConsolidatedExcel(consolidatedStoreRows, periodStr, filenameBase);
  } else {
    exportConsolidatedPdf(consolidatedStoreRows, periodStr, filenameBase);
  }
  showToast(t.exportSuccess);
}
function exportConsolidatedPdf(rows, periodStr, filenameBase){
  const t = dict[currentLang];
  if(!window.jspdf){ showToast('PDF non disponible (pas de connexion internet ?)'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(t.consolidatedTitle, 14, 16);
  doc.setFontSize(10);
  doc.text(periodStr + ' \u2014 ' + new Date().toLocaleDateString('fr-FR'), 14, 23);

  const totalRevenue = rows.reduce((s,r)=>s+r.revenue,0);
  const totalProfit = rows.reduce((s,r)=>s+r.profit,0);
  const totalExpenses = rows.reduce((s,r)=>s+r.expenses,0);
  doc.setFontSize(11);
  doc.text(`${t.summaryRevenue}: ${formatMoneyForPdf(totalRevenue)}`, 14, 33);
  doc.text(`${t.summaryExpenses}: ${formatMoneyForPdf(totalExpenses)}`, 14, 39);
  doc.text(`${t.summaryNet}: ${formatMoneyForPdf(totalProfit - totalExpenses)}`, 14, 45);

  let y = 56;
  doc.setFontSize(9);
  doc.setFont(undefined, 'bold');
  doc.text(t.consolidatedColStore, 14, y);
  doc.text(t.summaryRevenue, 100, y, { align:'right' });
  doc.text(t.profit, 135, y, { align:'right' });
  doc.text(t.summaryExpenses, 168, y, { align:'right' });
  doc.text(t.consolidatedColNet, 196, y, { align:'right' });
  doc.setFont(undefined, 'normal');
  y += 5;
  doc.setLineWidth(0.1);
  doc.line(14, y, 196, y);
  y += 5;
  rows.forEach(r=>{
    if(y > 280){ doc.addPage(); y = 16; }
    const name = r.name.length > 24 ? r.name.slice(0,22)+'...' : r.name;
    doc.text(name, 14, y);
    doc.text(formatMoneyForPdf(r.revenue), 100, y, { align:'right' });
    doc.text(formatMoneyForPdf(r.profit), 135, y, { align:'right' });
    doc.text(formatMoneyForPdf(r.expenses), 168, y, { align:'right' });
    doc.text(formatMoneyForPdf(r.net), 196, y, { align:'right' });
    y += 6;
  });
  doc.save(`${filenameBase}.pdf`);
}
function exportConsolidatedExcel(rows, periodStr, filenameBase){
  const t = dict[currentLang];
  if(!window.XLSX){ showToast('Excel non disponible (pas de connexion internet ?)'); return; }
  const sheetRows = rows.map(r => ({
    [t.consolidatedColStore]: r.name,
    [t.summaryRevenue]: r.revenue,
    [t.profit]: r.profit,
    [t.summaryExpenses]: r.expenses,
    [t.consolidatedColNet]: r.net,
    [t.consolidatedColSalesCount]: r.salesCount
  }));
  const totalRevenue = rows.reduce((s,r)=>s+r.revenue,0);
  const totalProfit = rows.reduce((s,r)=>s+r.profit,0);
  const totalExpenses = rows.reduce((s,r)=>s+r.expenses,0);
  sheetRows.push({});
  sheetRows.push({ [t.consolidatedColStore]: t.summaryRevenue, [t.summaryRevenue]: totalRevenue });
  sheetRows.push({ [t.consolidatedColStore]: t.summaryExpenses, [t.summaryRevenue]: -totalExpenses });
  sheetRows.push({ [t.consolidatedColStore]: t.summaryNet, [t.summaryRevenue]: totalProfit - totalExpenses });
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.consolidatedTitle.slice(0,28));
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
}
