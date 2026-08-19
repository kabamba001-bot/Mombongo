/* ---------- Bouton retour Android ----------
   1 appui : ferme l'écran/onglet ouvert et revient à l'accueil.
   Si on est déjà à l'accueil : 1er appui affiche "Appuie encore pour quitter",
   2e appui (dans les 2s) quitte réellement l'application. */
let readyToExitApp = false;
let exitArmTimeout = null;
try{ history.pushState({ mombongoBuffer: true }, ''); }catch(e){}
window.addEventListener('popstate', function(){
  const openSheet = document.querySelector('.sheet-overlay.open');
  if(openSheet){
    // Certains écrans gardent un état (variables JS) ou des boutons flottants en dehors
    // de la fenêtre elle-même (ex. #sell-overlay ↔ multiCart, voir sales.js) — un simple
    // retrait de la classe .open ne les nettoie pas, contrairement à un clic sur leur
    // propre bouton "Fermer"/"Annuler". Sans ça, après un retour arrière pendant une
    // "vente plusieurs", le panier restait figé avec les anciens produits sélectionnés,
    // et le prochain "Vendre" tapé ailleurs revendait ces anciens produits au lieu de
    // ceux vraiment affichés à l'écran.
    if(openSheet.id === 'sell-overlay'){
      // Un panier "vente plusieurs" non vide n'est pas juste perdu : il est mis de côté
      // (voir pauseCurrentCartIfAny(), sales.js) pour être repris plus tard depuis le
      // bouton 🧺 — sauf si la file d'attente est déjà pleine (3 max), auquel cas on
      // laisse volontairement la fiche ouverte plutôt que de perdre le panier en silence.
      const outcome = (typeof pauseCurrentCartIfAny === 'function') ? pauseCurrentCartIfAny() : 'none';
      if(outcome !== 'blocked' && typeof closeSellSheet === 'function'){
        closeSellSheet();
      } else if(outcome === 'blocked'){
        try{ history.pushState({ mombongoBuffer: true }, ''); }catch(e){}
        return;
      }
    } else {
      document.querySelectorAll('.sheet-overlay.open').forEach(el=>el.classList.remove('open'));
    }
    readyToExitApp = false;
    clearTimeout(exitArmTimeout);
    try{ history.pushState({ mombongoBuffer: true }, ''); }catch(e){}
    return;
  }
  if(!readyToExitApp){
    readyToExitApp = true;
    showToast(dict[currentLang].tapBackAgainToExit, 2000);
    exitArmTimeout = setTimeout(()=>{
      readyToExitApp = false;
      try{ history.pushState({ mombongoBuffer: true }, ''); }catch(e){}
    }, 2000);
    return;
  }
  // 2e appui retour depuis l'accueil, dans les 2s : on ne repousse rien, l'app se ferme réellement.
});
function formatDateTime(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR') + ' — ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
}

function setHistoryPeriod(period){
  // Simple gratuit (getMaxHistoryDays()===1, fenêtre du jour même) est le seul
  // palier qui n'a droit qu'à 'day' — tout le reste (payant Simple 32j, Business/Pro
  // illimité) a accès à semaine/mois/personnalisé. Voir plans.js.
  if(period !== 'day' && getMaxHistoryDays() <= 1){
    openLimitSheet('history');
    return;
  }
  historyPeriod = period;
  historyPage = 1; // Changer de période = repartir de la première page.
  document.querySelectorAll('.period-btn').forEach(b=>b.classList.toggle('active', b.dataset.period===period));
  document.getElementById('custom-range-fields').style.display = period==='custom' ? 'block' : 'none';
  if(period !== 'custom'){
    renderHistory();
  } else if(historyCustomFrom && historyCustomTo){
    renderHistory();
  }
}
function applyCustomRange(){
  const from = getDateValue('in-period-from');
  const to = getDateValue('in-period-to');
  if(!from || !to){
    showToast(currentLang==='fr' ? "Choisis les deux dates" : "Poná ba dates mibale");
    return;
  }
  const cutoff = getEffectiveHistoryCutoff();
  const fromTs = new Date(from + 'T00:00:00').getTime();
  if(fromTs < cutoff){
    showToast(dict[currentLang].dateTooOld);
    return;
  }
  historyCustomFrom = from;
  historyCustomTo = to;
  historyPage = 1; // Nouvelle période choisie = repartir de la première page.
  renderHistory();
}

function getPeriodRange(){
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  if(historyPeriod === 'day'){
    return { start: startOfToday.getTime(), end: endOfToday.getTime() };
  }
  if(historyPeriod === 'week'){
    const start = new Date(startOfToday);
    start.setDate(start.getDate() - 6);
    return { start: start.getTime(), end: endOfToday.getTime() };
  }
  if(historyPeriod === 'month'){
    const start = new Date(startOfToday);
    start.setDate(start.getDate() - 29);
    return { start: start.getTime(), end: endOfToday.getTime() };
  }
  if(historyPeriod === 'custom' && historyCustomFrom && historyCustomTo){
    const start = new Date(historyCustomFrom + 'T00:00:00');
    const end = new Date(historyCustomTo + 'T23:59:59');
    return { start: start.getTime(), end: end.getTime() };
  }
  return { start: startOfToday.getTime(), end: endOfToday.getTime() };
}

function computePeriodSummary(start, end){
  let revenue = 0, profit = 0, expensesTotal = 0;
  sales.forEach(s=>{
    if(s.isCredit) return;
    if(s.date <= historyClearedAt) return;
    if(s.date >= start && s.date <= end){ revenue += s.total; profit += s.profit; }
  });
  debts.forEach(d=>{
    (d.payments||[]).forEach(p=>{
      if(p.date <= historyClearedAt) return;
      if(p.date >= start && p.date <= end){
        revenue += p.amount;
        profit += (typeof p.profit === 'number') ? p.profit : 0;
      }
    });
  });
  expenses.forEach(e=>{
    if(e.date <= historyClearedAt) return;
    if(e.date >= start && e.date <= end) expensesTotal += e.amount;
  });
  return { revenue, expensesTotal, netGain: profit - expensesTotal };
}

function buildUnifiedHistory(){
  const t = dict[currentLang];
  const entries = [];
  sales.forEach(s=>{
    const product = products.find(p=>p.id===s.productId);
    // Le produit peut avoir été supprimé depuis — on garde son nom (enregistré sur la
    // vente elle-même) au lieu de perdre l'identité du produit dans l'historique.
    const pname = product ? product.name : (s.productName || t.historyDeletedProduct);
    entries.push({
      type:'sale', id:s.id, date:s.date,
      label: pname + ' × ' + formatQty(s.qty, s.unit) + (s.isCredit ? ' ('+t.creditTag+')' : ''),
      amount: s.total, sub: '+'+formatMoney(s.profit), deletable:true
    });
  });
  expenses.forEach(e=>{
    entries.push({
      type:'expense', id:e.id, date:e.date,
      label: e.desc, amount: -e.amount, sub:'', deletable:true
    });
  });
  debts.forEach(d=>{
    (d.payments||[]).forEach((p, idx)=>{
      entries.push({
        type:'repay', id: d.id+'_p'+idx, date:p.date,
        label: t.repayLabel + ' — ' + d.clientName,
        amount: p.amount, sub:'', deletable:true
      });
    });
  });
  if(isPatron()){
    (activityLog||[]).forEach(a=>{
      if(a.action === 'product_delete' && a.productName){
        entries.push({
          type:'activity', id:a.id, date:a.date,
          label: a.productName + ' (' + t.historyDeletedProduct + ')' + (a.qty ? ' × ' + formatQty(a.qty, a.unit) : ''),
          amount: 0, sub:'', deletable:true
        });
      } else {
        entries.push({
          type:'activity', id:a.id, date:a.date,
          label: '👁️ ' + a.label + ' — ' + a.who,
          amount: 0, sub:'', deletable:true
        });
      }
    });
  }
  return entries.filter(e => e.date > historyClearedAt).sort((a,b)=>b.date-a.date);
}

