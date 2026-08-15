/* =========================================================================
   REÇU CLIENT — génère un reçu PDF format "ticket" après chaque vente
   (simple ou multiple), et permet de le repartager depuis l'historique.
   ---------------------------------------------------------------------------
   - S'appuie sur jsPDF, déjà chargé pour l'export (voir export.js) : aucune
     dépendance supplémentaire.
   - Le partage utilise la Web Share API niveau 2 (navigator.share avec
     fichiers) quand le navigateur le permet (Chrome Android, Safari iOS
     récents) — c'est ce qui ouvre le sélecteur natif (WhatsApp, SMS,
     Bluetooth...). Si ce n'est pas supporté (certains navigateurs desktop),
     on bascule automatiquement sur un téléchargement direct du PDF : la
     fonctionnalité reste utilisable partout, juste moins fluide.
   - N'ajoute aucun élément à index.html : comme webview-guard.js, la feuille
     de reçu est construite dynamiquement en JS pour ne rien casser dans le
     HTML existant.
   ========================================================================= */

let lastReceiptItems = null;
let lastReceiptMeta = null;

/* ---------- Construction du contenu ---------- */

function getActiveStoreForReceipt(){
  const t = dict[currentLang];
  return stores.find(s=>s.id===activeStoreId) || { name: t.appname, phone: '' };
}

// items: [{ name, qty, unit, unitPrice, total }]
function buildReceiptItemsFromSaleRecord(saleRecord){
  return [{
    name: saleRecord.productName,
    qty: saleRecord.qty,
    unit: saleRecord.unit || 'pc',
    unitPrice: saleRecord.qty > 0 ? saleRecord.total / saleRecord.qty : 0,
    total: saleRecord.total
  }];
}
function buildReceiptItemsFromSaleRecords(saleRecords){
  return saleRecords.map(sr=>({
    name: sr.productName,
    qty: sr.qty,
    unit: sr.unit || 'pc',
    unitPrice: sr.qty > 0 ? sr.total / sr.qty : 0,
    total: sr.total
  }));
}

/* ---------- Génération du PDF (format ticket 80mm) ---------- */

function generateReceiptPdf(items, meta){
  if(!window.jspdf){ return null; }
  const { jsPDF } = window.jspdf;
  const t = dict[currentLang];
  const store = getActiveStoreForReceipt();

  const lineH = 5.2;
  const headerH = 30;
  const footerH = meta.isCredit ? 24 : 16;
  const estHeight = headerH + items.length * lineH + footerH + 10;
  const doc = new jsPDF({ unit:'mm', format:[80, Math.max(estHeight, 90)] });

  let y = 10;
  doc.setFontSize(13);
  doc.setFont(undefined, 'bold');
  doc.text(store.name || t.appname, 40, y, { align:'center' });
  y += 6;
  doc.setFontSize(8.5);
  doc.setFont(undefined, 'normal');
  if(store.phone){
    doc.text(store.phone, 40, y, { align:'center' });
    y += 4.5;
  }
  doc.text(formatDateTime(meta.date), 40, y, { align:'center' });
  y += 5;
  doc.setLineWidth(0.1);
  doc.line(5, y, 75, y);
  y += 5;

  doc.setFontSize(8.5);
  items.forEach(it=>{
    doc.setFont(undefined, 'bold');
    const nameLines = doc.splitTextToSize(it.name, 48);
    doc.text(nameLines, 5, y);
    doc.setFont(undefined, 'normal');
    doc.text(formatMoney(it.total), 75, y, { align:'right' });
    y += 4.2 * nameLines.length;
    doc.setFontSize(7.5);
    doc.text(`${formatQty(it.qty, it.unit)} × ${formatMoney(it.unitPrice)}`, 5, y);
    doc.setFontSize(8.5);
    y += 4.6;
  });

  doc.line(5, y, 75, y);
  y += 6;
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text(t.summaryRevenue || 'Total', 5, y);
  doc.text(formatMoney(meta.total), 75, y, { align:'right' });
  y += 7;

  if(meta.isCredit){
    doc.setFontSize(8.5);
    doc.setFont(undefined, 'normal');
    const creditLines = doc.splitTextToSize('⚠ ' + t.receiptCreditLine, 70);
    doc.text(creditLines, 40, y, { align:'center' });
    y += 4.2 * creditLines.length + 2;
  }

  doc.setFontSize(9);
  doc.setFont(undefined, 'italic');
  doc.text(t.receiptThanksLine, 40, y, { align:'center' });

  return doc;
}

function receiptFilename(meta){
  const d = new Date(meta.date);
  return `recu_${d.toISOString().slice(0,10)}_${meta.id}`.replace(/[^a-z0-9_]/gi,'_');
}

/* ---------- Partage / téléchargement ---------- */

async function shareOrDownloadReceipt(items, meta){
  const t = dict[currentLang];
  const doc = generateReceiptPdf(items, meta);
  if(!doc){ showToast(t.receiptUnavailable, 4000); return; }
  const filename = receiptFilename(meta) + '.pdf';
  const blob = doc.output('blob');

  try{
    const file = new File([blob], filename, { type:'application/pdf' });
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ files:[file], title: t.receiptSheetTitle });
      return;
    }
  }catch(e){
    // L'utilisateur a pu simplement annuler le partage — pas une erreur à signaler.
    if(e && e.name === 'AbortError') return;
  }
  // Repli universel : téléchargement direct du PDF.
  doc.save(filename);
  showToast(t.receiptDownloaded);
}

/* ---------- Feuille "Vente enregistrée" (construite dynamiquement) ---------- */

function ensureReceiptSheetDom(){
  if(document.getElementById('receipt-sheet-overlay')) return;
  const style = document.createElement('style');
  style.textContent = `
    #receipt-sheet-overlay{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.45);
      display:none;align-items:flex-end;justify-content:center;}
    #receipt-sheet-overlay.open{display:flex;}
    #receipt-sheet-card{background:var(--paper,#fff);width:100%;max-width:480px;border-radius:16px 16px 0 0;
      padding:20px 18px 24px;font-family:inherit;box-shadow:0 -4px 20px rgba(0,0,0,.2);}
    #receipt-sheet-card .rs-title{font-weight:700;font-size:16px;margin-bottom:4px;}
    #receipt-sheet-card .rs-total{font-size:22px;font-weight:700;color:var(--emerald,#146356);margin:6px 0 16px;}
    #receipt-sheet-card button{width:100%;border:none;border-radius:10px;padding:12px;font-size:14.5px;
      font-weight:600;cursor:pointer;margin-bottom:8px;}
    #receipt-sheet-card .rs-share{background:var(--emerald,#146356);color:#fff;}
    #receipt-sheet-card .rs-download{background:var(--paper-2,#f0ece0);}
    #receipt-sheet-card .rs-close{background:transparent;color:var(--charcoal-soft,#777);margin-bottom:0;}
  `;
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'receipt-sheet-overlay';
  overlay.innerHTML = `
    <div id="receipt-sheet-card">
      <div class="rs-title" id="receipt-sheet-title"></div>
      <div class="rs-total" id="receipt-sheet-total"></div>
      <button class="rs-share" id="receipt-sheet-share">📤</button>
      <button class="rs-download" id="receipt-sheet-download">⬇️</button>
      <button class="rs-close" id="receipt-sheet-close">Fermer</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e){
    if(e.target === overlay) closeReceiptSheet();
  });
  document.getElementById('receipt-sheet-close').addEventListener('click', closeReceiptSheet);
  document.getElementById('receipt-sheet-share').addEventListener('click', function(){
    if(lastReceiptItems) shareOrDownloadReceipt(lastReceiptItems, lastReceiptMeta);
  });
  document.getElementById('receipt-sheet-download').addEventListener('click', function(){
    if(!lastReceiptItems) return;
    const doc = generateReceiptPdf(lastReceiptItems, lastReceiptMeta);
    if(!doc){ showToast(dict[currentLang].receiptUnavailable, 4000); return; }
    doc.save(receiptFilename(lastReceiptMeta) + '.pdf');
    showToast(dict[currentLang].receiptDownloaded);
  });
}

function openReceiptSheet(items, meta){
  const t = dict[currentLang];
  ensureReceiptSheetDom();
  lastReceiptItems = items;
  lastReceiptMeta = meta;
  document.getElementById('receipt-sheet-title').textContent = t.receiptSheetTitle;
  document.getElementById('receipt-sheet-total').textContent = formatMoney(meta.total);
  document.getElementById('receipt-sheet-share').textContent = t.receiptShareBtn;
  document.getElementById('receipt-sheet-download').textContent = t.receiptDownloadBtn;
  document.getElementById('receipt-sheet-close').textContent = t.receiptCloseBtn;
  document.getElementById('receipt-sheet-overlay').classList.add('open');
}
function closeReceiptSheet(){
  const el = document.getElementById('receipt-sheet-overlay');
  if(el) el.classList.remove('open');
}

/* ---------- Appelées depuis sales.js après une vente réussie ---------- */

function offerReceiptForSingleSale(saleRecord){
  openReceiptSheet(buildReceiptItemsFromSaleRecord(saleRecord), {
    id: saleRecord.id, date: saleRecord.date, total: saleRecord.total, isCredit: !!saleRecord.isCredit
  });
}
function offerReceiptForMultiSale(saleRecords, grandTotal, isCredit){
  const multiId = saleRecords.length && saleRecords[0].multiSaleId ? saleRecords[0].multiSaleId : Date.now().toString();
  openReceiptSheet(buildReceiptItemsFromSaleRecords(saleRecords), {
    id: multiId, date: Date.now(), total: grandTotal, isCredit: !!isCredit
  });
}

/* ---------- Reproduire le reçu d'une vente passée, depuis l'historique ---------- */
// id vient de buildUnifiedHistory() (render.js) : soit l'id d'une vente simple,
// soit "<multiSaleId>-<productId>" pour une ligne issue d'une vente multiple.
function reprintReceipt(entryId){
  const t = dict[currentLang];
  const direct = sales.find(s=>s.id===entryId);
  let group;
  if(direct && direct.multiSaleId){
    group = sales.filter(s=>s.multiSaleId===direct.multiSaleId);
  } else if(direct){
    group = [direct];
  } else {
    group = [];
  }
  if(group.length === 0){
    showToast(t.receiptNotFound, 4000);
    return;
  }
  const grandTotal = group.reduce((s,sr)=>s+sr.total,0);
  const isCredit = group.some(sr=>sr.isCredit);
  const id = group[0].multiSaleId || group[0].id;
  openReceiptSheet(buildReceiptItemsFromSaleRecords(group), {
    id, date: group[0].date, total: grandTotal, isCredit
  });
}
