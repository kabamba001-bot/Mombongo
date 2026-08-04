/* ---------- Export PDF / Excel ---------- */
let exportFormat = 'pdf';
function toggleExportFields(){
  if(!isVip){
    document.getElementById('in-export-toggle').checked = false;
    openLimitSheet('export');
    return;
  }
  const on = document.getElementById('in-export-toggle').checked;
  document.getElementById('export-fields').style.display = on ? 'block' : 'none';
}
function selectExportFormat(fmt, btn){
  exportFormat = fmt;
  document.querySelectorAll('.export-format-btn').forEach(b=>b.classList.toggle('active', b===btn));
}
function periodLabel(){
  const t = dict[currentLang];
  const map = { day:t.periodDay, week:t.periodWeek, month:t.periodMonth, custom:t.periodCustom };
  return map[historyPeriod] || '';
}
function exportHistory(){
  const t = dict[currentLang];
  if(!isPatron()){ showToast(t.restrictedFeature); return; }
  if(!isVip){ openLimitSheet('export'); return; }
  const { start, end } = getPeriodRange();
  const entries = buildUnifiedHistory().filter(e => e.date >= start && e.date <= end);
  if(entries.length === 0){
    showToast(t.exportEmpty);
    return;
  }
  const summary = computePeriodSummary(start, end);
  const storeName = (stores.find(s=>s.id===activeStoreId) || {}).name || t.appname;
  const filenameBase = `mombongo_${storeName.replace(/[^a-z0-9]+/gi,'_')}_${periodLabel().replace(/[^a-z0-9]+/gi,'_')}_${new Date().toISOString().slice(0,10)}`;

  if(exportFormat === 'pdf'){
    exportHistoryPdf(entries, summary, storeName, filenameBase);
  } else {
    exportHistoryExcel(entries, summary, storeName, filenameBase);
  }
  showToast(t.exportSuccess);
}
function exportHistoryPdf(entries, summary, storeName, filenameBase){
  const t = dict[currentLang];
  if(!window.jspdf){ showToast('PDF non disponible (pas de connexion internet ?)'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(`${storeName} — ${t.historyTitle}`, 14, 16);
  doc.setFontSize(10);
  doc.text(`${periodLabel()} — ${new Date().toLocaleDateString('fr-FR')}`, 14, 23);
  doc.setFontSize(11);
  doc.text(`${t.summaryRevenue}: ${formatMoney(summary.revenue)}`, 14, 33);
  doc.text(`${t.summaryExpenses}: ${formatMoney(summary.expensesTotal)}`, 14, 39);
  doc.text(`${t.summaryNet}: ${formatMoney(summary.netGain)}`, 14, 45);

  let y = 56;
  doc.setFontSize(9);
  doc.setFont(undefined, 'bold');
  doc.text('Date', 14, y);
  doc.text('Détail', 46, y);
  doc.text('Montant', 180, y, { align:'right' });
  doc.setFont(undefined, 'normal');
  y += 5;
  doc.setLineWidth(0.1);
  doc.line(14, y, 196, y);
  y += 5;
  entries.forEach(entry=>{
    if(y > 280){ doc.addPage(); y = 16; }
    doc.text(formatDateTime(entry.date), 14, y);
    const label = entry.label.length > 48 ? entry.label.slice(0,45)+'...' : entry.label;
    doc.text(label, 46, y);
    const amountStr = (entry.amount < 0 ? '-' : '') + formatMoney(Math.abs(entry.amount));
    doc.text(amountStr, 180, y, { align:'right' });
    y += 6;
  });
  doc.save(`${filenameBase}.pdf`);
}
function exportHistoryExcel(entries, summary, storeName, filenameBase){
  const t = dict[currentLang];
  if(!window.XLSX){ showToast('Excel non disponible (pas de connexion internet ?)'); return; }
  const rows = entries.map(entry=>({
    Date: formatDateTime(entry.date),
    Détail: entry.label,
    Montant: entry.amount,
  }));
  rows.push({});
  rows.push({ Date:'', Détail: t.summaryRevenue, Montant: summary.revenue });
  rows.push({ Date:'', Détail: t.summaryExpenses, Montant: -summary.expensesTotal });
  rows.push({ Date:'', Détail: t.summaryNet, Montant: summary.netGain });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, storeName.slice(0,28) || 'Historique');
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
}

async function deleteHistoryEntry(type, id, reason){
  const t = dict[currentLang];
  if(type==='sale'){
    if(!canDeleteSale()){ showToast(t.restrictedFeature); return; }
  } else {
    if(!isPatron()){ showToast(t.restrictedFeature); return; }
    const ok = window.confirm(t.confirmDeleteEntry);
    if(!ok) return;
  }
  if(type==='sale'){
    const sale = sales.find(s=>s.id===id);
    if(sale && currentRole()==='caissier'){
      const product = products.find(p=>p.id===sale.productId);
      const pname = product ? product.name : (sale.productName || t.historyDeletedProduct);
      const reasonLabel = reason==='stockout' ? t.deleteReasonStockoutBtn : t.deleteReasonErrorBtn;
      logActivity('sale_delete', dict[currentLang].logSaleDeleted + ' : ' + pname + ' × ' + sale.qty + ' — ' + reasonLabel, { productName: pname, qty: sale.qty });
    }
    sales = sales.filter(s=>s.id!==id);
    await saveSales();
    if(sale){
      // "Erreur de vente" : la vente n'aurait jamais dû être enregistrée, on l'annule complètement
      // comme si elle n'avait jamais eu lieu — le stock revient, et les chiffres du jour, le bénéfice
      // total et la dette liée (vente à crédit) sont corrigés en conséquence.
      // "Rupture de stock" : la vente a réellement eu lieu (l'argent a été encaissé, le produit est
      // parti) — on retire seulement l'entrée de l'historique, le stock et tous les chiffres restent
      // inchangés, puisque la vente elle-même reste valide.
      if(reason !== 'stockout'){
        const product = products.find(p=>p.id===sale.productId);
        if(product){
          if(product.lotId){
            const lot = lots.find(l=>l.id===product.lotId);
            if(lot){
              lot.remainingFraction = Math.min(1, lot.remainingFraction + (sale.qty / product.yieldPerSac));
              recalcLotQuantities(product.lotId);
              saveLots();
            }
          } else {
            product.qty += sale.qty;
          }
          await saveProducts();
        }
        // Annuler l'impact sur les compteurs (seulement si ce n'était pas une vente à crédit,
        // puisque les ventes à crédit non réglées n'ont jamais été comptées dans les compteurs)
        if(!sale.isCredit){
          stats.totalProfit = Math.max(0, stats.totalProfit - sale.profit);
          if(isToday(sale.date)){
            stats.todaySales = Math.max(0, stats.todaySales - sale.total);
            stats.todayProfit = Math.max(0, stats.todayProfit - sale.profit);
          }
          saveStats();
        } else if(sale.debtId){
          // Retirer aussi l'article correspondant de la dette liée, pour ne pas laisser
          // le client "devoir" une vente qui n'existe plus dans l'historique.
          const debt = debts.find(dd=>dd.id===sale.debtId);
          if(debt){
            const itemIdx = debt.items.findIndex(it=>it.saleId===sale.id);
            if(itemIdx !== -1){
              const removedItem = debt.items[itemIdx];
              debt.items.splice(itemIdx, 1);
              debt.totalOwed = Math.max(0, debt.totalOwed - removedItem.total);
              debt.totalProfit = Math.max(0, debt.totalProfit - removedItem.profit);
              // Si des règlements déjà reçus dépassaient le nouveau total, on plafonne
              // pour éviter un solde restant négatif.
              if(debt.amountPaid > debt.totalOwed) debt.amountPaid = debt.totalOwed;
              if(debt.items.length === 0){
                debts = debts.filter(dd=>dd.id!==debt.id);
              } else if(debt.totalOwed - debt.amountPaid <= 0.01){
                debt.status = 'réglé';
              }
              saveDebts();
            }
          }
        }
      }
    }
  } else if(type==='expense'){
    const expense = expenses.find(e=>e.id===id);
    expenses = expenses.filter(e=>e.id!==id);
    await saveExpenses();
    if(expense){
      stats.totalExpenses = Math.max(0, stats.totalExpenses - expense.amount);
      saveStats();
    }
  } else if(type==='repay'){
    // id est au format "<debtId>_p<index>" (voir buildUnifiedHistory)
    const sepIdx = id.lastIndexOf('_p');
    const debtId = sepIdx !== -1 ? id.slice(0, sepIdx) : null;
    const payIdx = sepIdx !== -1 ? parseInt(id.slice(sepIdx+2), 10) : NaN;
    const debt = debts.find(dd=>dd.id===debtId);
    if(debt && debt.payments && debt.payments[payIdx]){
      const payment = debt.payments[payIdx];
      debt.amountPaid = Math.max(0, debt.amountPaid - payment.amount);
      debt.payments.splice(payIdx, 1);
      if(debt.status === 'réglé' && (debt.totalOwed - debt.amountPaid) > 0.01){
        debt.status = 'ouvert';
      }
      stats.totalProfit = Math.max(0, stats.totalProfit - (payment.profit || 0));
      if(isToday(payment.date)){
        stats.todaySales = Math.max(0, stats.todaySales - payment.amount);
        stats.todayProfit = Math.max(0, stats.todayProfit - (payment.profit || 0));
      }
      saveStats();
      saveDebts();
    }
  } else if(type==='activity'){
    activityLog = activityLog.filter(a=>a.id!==id);
    await saveActivityLog();
  }
  renderHistory();
  render();
  showToast(t.entryDeleted);
}

let pendingDeleteSaleId = null;
function openDeleteSaleReasonSheet(saleId){
  if(!canDeleteSale()){ showToast(dict[currentLang].restrictedFeature); return; }
  pendingDeleteSaleId = saleId;
  document.getElementById('delete-sale-reason-overlay').classList.add('open');
}
function closeDeleteSaleReasonSheet(){
  document.getElementById('delete-sale-reason-overlay').classList.remove('open');
  pendingDeleteSaleId = null;
}
async function confirmDeleteSaleWithReason(reason){
  const id = pendingDeleteSaleId;
  closeDeleteSaleReasonSheet();
  if(!id) return;
  await deleteHistoryEntry('sale', id, reason);
}
async function clearAllHistory(){
  const t = dict[currentLang];
  if(!isPatron()){ showToast(t.restrictedFeature); return; }
  const ok = window.confirm(t.confirmClearHistory);
  if(!ok) return;
  // On masque tout ce qui précède ce moment au lieu de le supprimer :
  // le stock, les dettes et les compteurs réels ne sont jamais touchés.
  historyClearedAt = Date.now();
  localSet('mombongo:historyClearedAt', String(historyClearedAt));
  await pushToCloud();
  renderHistory();
  render();
  showToast(t.historyCleared);
}

