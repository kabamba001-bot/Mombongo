/* ---------- Vente ---------- */
let multiCart = {}; // { productId: qty } — utilisé seulement quand "vente plusieurs" est actif

function openSellSheet(id){
  if(!canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
  sellingProductId = id;
  document.getElementById('in-sell-qty').value = 1;
  document.getElementById('in-is-credit').checked = false;
  document.getElementById('in-client-name').value = '';
  document.getElementById('in-client-phone').value = '';
  setDateValue('in-due-date', '');
  document.getElementById('credit-fields').style.display = 'none';

  document.getElementById('in-is-multi').checked = false;
  document.getElementById('single-sale-fields').style.display = 'block';
  document.getElementById('multi-fields').style.display = 'none';
  document.getElementById('in-multi-search').value = '';
  document.getElementById('in-has-debt').checked = false;
  document.getElementById('debt-fields').style.display = 'none';
  document.getElementById('multi-confirm-fab').style.display = 'none';
  document.getElementById('in-debt-amount').value = '';
  document.getElementById('in-debt-client-name').value = '';
  document.getElementById('in-debt-client-phone').value = '';
  setDateValue('in-debt-due-date', '');
  document.getElementById('debt-toggle-row').style.display = 'flex';
  multiCart = {};
  if(id) multiCart[id] = 1; // le produit sur lequel on a tapé "Vendre" est pré-sélectionné si on bascule en multi

  document.getElementById('sell-overlay').classList.add('open');
  updateSellPreview();
}
function closeSellSheet(){
  document.getElementById('sell-overlay').classList.remove('open');
  document.getElementById('multi-confirm-fab').style.display = 'none';
  sellingProductId = null;
}
function toggleCreditFields(){
  const isCredit = document.getElementById('in-is-credit').checked;
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
  // Bouton flottant ✅ : évite de devoir descendre jusqu'en bas d'un catalogue de
  // plusieurs centaines/milliers de produits juste pour valider le panier.
  document.getElementById('multi-confirm-fab').style.display = isMulti ? 'flex' : 'none';
  if(isMulti) renderMultiProductList();
  else {
    document.getElementById('in-has-debt').checked = false;
    toggleDebtFields();
  }
}
function toggleDebtFields(){
  const hasDebt = document.getElementById('in-has-debt').checked;
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
  if(next === 0) delete multiCart[productId];
  else multiCart[productId] = next;
  renderMultiProductList();
}
function renderMultiProductList(){
  const wrap = document.getElementById('multi-product-list');
  const search = document.getElementById('in-multi-search').value.trim().toLowerCase();
  const list = products.filter(p=> !search || p.name.toLowerCase().includes(search));
  wrap.innerHTML = '';
  list.forEach(p=>{
    const qty = multiCart[p.id] || 0;
    const row = document.createElement('div');
    row.className = 'multi-product-row' + (p.qty<=0 ? ' out-of-stock' : '');
    row.innerHTML =
      '<div class="info">' +
        '<div class="name">' + escapeHtml(p.name) + '</div>' +
        '<div class="meta">' + formatMoney(p.sell) + ' · ' + p.qty + ' disponible' + (p.qty>1?'s':'') + '</div>' +
      '</div>' +
      '<div class="qty-stepper">' +
        '<button type="button" data-id="' + p.id + '" data-d="-1"' + (qty<=0?' disabled':'') + '>−</button>' +
        '<span>' + qty + '</span>' +
        '<button type="button" data-id="' + p.id + '" data-d="1"' + (qty>=p.qty?' disabled':'') + '>+</button>' +
      '</div>';
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('button[data-id]').forEach(btn=>{
    btn.addEventListener('click', ()=> changeMultiQty(btn.dataset.id, parseInt(btn.dataset.d)));
  });
  updateMultiTotal();
}
function getMultiCartItems(){
  return Object.keys(multiCart).map(id=>{
    const product = products.find(p=>p.id===id);
    const qty = multiCart[id];
    return product ? { product, qty, total: qty*product.sell, profit: qty*(product.sell-product.buy) } : null;
  }).filter(Boolean);
}
function updateMultiTotal(){
  const items = getMultiCartItems();
  const total = items.reduce((s,it)=>s+it.total,0);
  document.getElementById('multi-total').textContent = formatMoney(total);

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
  const qty = parseInt(document.getElementById('in-sell-qty').value) || 0;
  const total = qty * product.sell;
  const profit = qty * (product.sell - product.buy);
  document.getElementById('preview-total').textContent = formatMoney(total);
  document.getElementById('preview-profit').textContent = formatMoney(profit);
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
  const qty = parseInt(document.getElementById('in-sell-qty').value) || 0;
  if(qty <= 0 || qty > product.qty){
    showToast(currentLang==='fr' ? "Quantité invalide" : "Motángo ekoki te");
    return;
  }
  const isCredit = document.getElementById('in-is-credit').checked;
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
  const saleTotal = qty*product.sell;
  const saleProfit = qty*(product.sell-product.buy);
  const saleId = Date.now().toString();
  const saleRecord = {
    id: saleId, productId: product.id, productName: product.name,
    qty, total: saleTotal, profit: saleProfit,
    date: Date.now(), isCredit: isCredit
  };
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
    debt.items.push({ saleId, productName: product.name, qty, total: saleTotal, profit: saleProfit, date: Date.now() });
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
    if(it.qty > it.product.qty){
      showToast(currentLang==='fr' ? "Quantité invalide pour " + it.product.name : "Motángo ekoki te");
      return;
    }
  }
  const isCredit = document.getElementById('in-is-credit').checked;
  const clientName = document.getElementById('in-client-name').value.trim();
  if(isCredit && !clientName){
    showToast(currentLang==='fr' ? "Indique le nom du client pour une vente à crédit" : "Pesa nkombo ya client");
    return;
  }
  const clientPhone = document.getElementById('in-client-phone').value.trim();
  const dueDate = getDateValue('in-due-date');

  const grandTotal = items.reduce((s,it)=>s+it.total,0);
  const grandProfit = items.reduce((s,it)=>s+it.profit,0);

  const hasPartialDebt = document.getElementById('in-has-debt').checked;
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
    return {
      id: multiSaleId+'-'+product.id, multiSaleId, productId: product.id, productName: product.name,
      qty: it.qty, total: it.total, profit: it.profit,
      date: Date.now(), isCredit: isCredit
    };
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
      debt.items.push({ saleId: sr.id, productName: sr.productName, qty: sr.qty, total: sr.total, profit: sr.profit, date: Date.now() });
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
  if(parsed.qty > product.qty){
    bodyEl.innerHTML = `<span style="color:var(--alert); font-weight:600;">Stock insuffisant pour ${escapeHtml(product.name)} (reste ${product.qty})</span>`;
    confirmBtn.disabled = true;
    pendingVoiceSale = null;
    return;
  }
  const total = parsed.qty * product.sell;
  bodyEl.innerHTML = `${parsed.qty} × ${escapeHtml(product.name)}<br><span style="color:var(--emerald);">${formatMoney(total)}</span>`;
  confirmBtn.disabled = false;
  pendingVoiceSale = { product, qty: parsed.qty };
}

function startVoiceSale(isAutoRetry){
  if(!canSell()){ showToast(dict[currentLang].restrictedFeature); return; }
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

