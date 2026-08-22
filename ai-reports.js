/* =========================================================================
   RAPPORTS IA HEBDOMADAIRES — PALIER PRO UNIQUEMENT
   ---------------------------------------------------------------------------
   Écran de LECTURE SEULE : les rapports sont générés côté serveur chaque
   dimanche soir (send-weekly-ai-reports.js, via GitHub Actions) et stockés
   dans /mombongo_users/{ownerUid}/aiReports/{weekId}. Cet écran ne fait
   qu'aller chercher ces documents déjà prêts — AUCUN appel à une IA n'est
   jamais fait depuis le téléphone, et la clé Gemini ne doit JAMAIS vivre
   côté client (elle serait extractible par n'importe qui via le code
   source de la page — voir la discussion qui a mené à cette architecture).

   Réservé au PATRON (jamais un caissier/magasinier, voir
   canManageStoresAndDevices()) et au palier PRO (isFeatureUnlocked
   ('aiReports')) — mêmes deux garde-fous que consolidated.js.

   Montants : les documents stockent les valeurs BRUTES non converties
   (même unité interne que /sales.total — voir toInternal() dans
   products.js), donc TOUJOURS passer par formatMoney() ici, jamais
   afficher report.totalRevenue tel quel — exactement comme le reste de
   l'app affiche déjà tout le reste (voir la note dans
   send-weekly-ai-reports.js sur le bug équivalent repéré dans
   send-daily-sales-recap.js).

   Les conseils affichés (résumé + "tips") sont TOUJOURS présentés comme des
   suggestions, jamais des ordres — déjà appliqué dans le prompt côté
   serveur, mais on le rappelle aussi visuellement ici ("💡 Conseils
   suggérés", jamais "Instructions").
   ========================================================================= */

let aiReportsList = []; // derniers rapports chargés, du plus récent au plus ancien
let aiReportsChartInstance = null;

function isChartLibraryReady(){
  return typeof Chart !== 'undefined';
}

async function openAiReportsSheet(){
  if(!isFeatureUnlocked('aiReports')){ openLimitSheet('aiReports'); return; }
  if(!canManageStoresAndDevices()){ showToast(dict[currentLang].restrictedFeature); return; }
  closeAccountSheet();
  document.getElementById('ai-reports-overlay').classList.add('open');
  await loadAiReports();
}
function closeAiReportsSheet(){
  document.getElementById('ai-reports-overlay').classList.remove('open');
}

async function loadAiReports(){
  const t = dict[currentLang];
  const ownerUid = getDataOwnerUid();
  const sel = document.getElementById('in-ai-reports-week');
  sel.innerHTML = '';
  document.getElementById('ai-reports-content').style.display = 'none';
  const emptyEl = document.getElementById('ai-reports-empty');
  emptyEl.style.display = 'none';

  if(!cloudEnabled || !db || !ownerUid){
    emptyEl.textContent = t.aiReportsNeedsConnection || "Les rapports IA nécessitent une connexion internet.";
    emptyEl.style.display = 'block';
    return;
  }
  try{
    // Lecture unique (.get(), pas onSnapshot) — même principe que consolidated.js : un
    // rapport une fois généré ne bouge plus jamais (send-weekly-ai-reports.js ne
    // régénère jamais un weekId déjà existant), inutile d'écouter en temps réel.
    const snap = await db.collection('mombongo_users').doc(ownerUid)
      .collection('aiReports').orderBy('weekId', 'desc').limit(12).get();
    aiReportsList = snap.docs.map(d => d.data());
    if(aiReportsList.length === 0){
      emptyEl.textContent = t.aiReportsEmpty || "Aucun rapport pour l'instant — reviens dimanche soir après ta première semaine complète sur Mombongo.";
      emptyEl.style.display = 'block';
      return;
    }
    sel.innerHTML = aiReportsList.map((r,i)=>`<option value="${i}">${escapeHtml(formatAiReportWeekLabel(r.weekId))}</option>`).join('');
    sel.value = '0';
    renderSelectedAiReport();
    markAiReportsAsViewed();
  }catch(e){
    console.error('Erreur chargement rapports IA', e);
    emptyEl.textContent = (t.aiReportsLoadError || 'Erreur : ') + (e.code || e.message || String(e));
    emptyEl.style.display = 'block';
  }
}

function formatAiReportWeekLabel(weekId){
  const start = new Date(weekId + 'T00:00:00');
  const end = new Date(start.getTime() + 6*24*60*60*1000);
  const fmt = (d)=>d.toLocaleDateString('fr-FR', { day:'2-digit', month:'short' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function renderSelectedAiReport(){
  const idx = parseInt(document.getElementById('in-ai-reports-week').value, 10) || 0;
  const report = aiReportsList[idx];
  if(!report) return;
  const t = dict[currentLang];
  document.getElementById('ai-reports-content').style.display = 'block';
  document.getElementById('ai-reports-empty').style.display = 'none';

  document.getElementById('ai-reports-total-revenue').textContent = formatMoney(report.totalRevenue || 0);
  document.getElementById('ai-reports-total-profit').textContent = formatMoney(report.totalProfit || 0);

  const adviceBlock = document.getElementById('ai-reports-advice-block');
  if(report.advice || (report.tips && report.tips.length)){
    adviceBlock.style.display = 'block';
    document.getElementById('ai-reports-advice-summary').textContent = report.advice || '';
    const tipsList = document.getElementById('ai-reports-advice-tips');
    tipsList.innerHTML = (report.tips || []).map(tip=>`<li>${escapeHtml(tip)}</li>`).join('');
  } else {
    // Rapport enregistré sans conseils (échec Gemini ce dimanche-là — voir
    // send-weekly-ai-reports.js) : les chiffres/graphiques restent affichés quand
    // même juste au-dessus, seul ce bloc-ci disparaît.
    adviceBlock.style.display = 'none';
  }

  renderAiReportChart(report);
  renderAiReportStoresList(report);
}

function renderAiReportChart(report){
  const canvas = document.getElementById('ai-reports-chart');
  if(!canvas) return;
  if(aiReportsChartInstance){ aiReportsChartInstance.destroy(); aiReportsChartInstance = null; }
  if(!isChartLibraryReady()) return; // pas de réseau au chargement de la page : pas de graphique, sans planter le reste de l'écran

  // Un seul compte, potentiellement plusieurs boutiques : on trace la somme des ventes
  // journalières de TOUTES les boutiques (la vue "par boutique" détaillée, elle, est
  // juste en dessous — voir renderAiReportStoresList), pour rester lisible même pour
  // un patron qui gère plusieurs boutiques à la fois.
  const storesData = report.stores || [];
  const days = 7;
  const totalsUsd = new Array(days).fill(0);
  storesData.forEach(s=>{
    (s.revenueByDay || []).forEach((v,i)=>{ if(i < days) totalsUsd[i] += v; });
  });
  // Chart.js reçoit des montants déjà convertis dans la devise d'affichage courante
  // (comme formatMoney le fait ailleurs) — jamais les valeurs brutes stockées.
  const totalsDisplay = totalsUsd.map(v => currentCurrency === 'usd' ? v : v * exchangeRate);

  const weekStart = new Date(report.weekStart || Date.now());
  const labels = totalsDisplay.map((_,i)=>{
    const d = new Date(weekStart.getTime() + i*24*60*60*1000);
    return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  });

  const t = dict[currentLang];
  aiReportsChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: t.aiReportsChartLabel || 'Ventes par jour',
        data: totalsDisplay,
        borderColor: '#1f8a5f',
        backgroundColor: 'rgba(31,138,95,0.12)',
        tension: 0.3, fill: true, pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });
}

function renderAiReportStoresList(report){
  const t = dict[currentLang];
  const container = document.getElementById('ai-reports-stores-list');
  const storesData = report.stores || [];
  // Le détail par boutique n'a d'intérêt que s'il y en a plus d'une — pour un compte
  // Pro à une seule boutique, la carte résumé du haut suffit déjà (voir la demande
  // d'origine : "amplifier par boutique" ne concerne que le cas multi-boutiques).
  if(storesData.length <= 1){ container.innerHTML = ''; return; }

  container.innerHTML = storesData.map(s=>{
    const bestSellers = (s.bestSellers || []).slice(0,3).map(b=>escapeHtml(b.name)).join(', ');
    const deadStock = (s.deadStock || []).slice(0,3).map(d=>escapeHtml(d.name)).join(', ');
    return `
      <div class="debt-item" style="display:block; padding:12px 14px; margin-bottom:8px;">
        <div style="font-weight:700; font-size:13.5px; margin-bottom:4px;">${escapeHtml(s.storeName || '')}</div>
        <div style="font-size:12.5px; color:var(--charcoal-soft);">
          ${t.aiReportsStoreRevenueLabel || 'Ventes'} : ${formatMoney(s.revenue || 0)} · ${t.aiReportsStoreProfitLabel || 'Bénéfice'} : ${formatMoney(s.profit || 0)}
        </div>
        ${bestSellers ? `<div style="font-size:12px; color:var(--charcoal-soft); margin-top:4px;">🏆 ${bestSellers}</div>` : ''}
        ${deadStock ? `<div style="font-size:12px; color:var(--charcoal-soft); margin-top:2px;">💤 ${deadStock}</div>` : ''}
      </div>
    `;
  }).join('');
}

/* ---------- Badge "nouveau rapport" sur le bouton du compte ---------- */
function markAiReportsAsViewed(){
  if(aiReportsList.length === 0) return;
  localStorage.setItem('mombongo:lastViewedAiReportWeekId', aiReportsList[0].weekId);
  const dot = document.getElementById('ai-reports-badge-dot');
  if(dot) dot.style.display = 'none';
}

// Vérifie s'il existe un rapport plus récent que le dernier consulté — lecture légère
// (juste le tout dernier document, pas toute la liste) pour ne pas alourdir l'ouverture
// du menu Compte. Appelée depuis openAccountSheet() (account-cloud.js).
async function updateAiReportsBadge(){
  const dot = document.getElementById('ai-reports-badge-dot');
  if(!dot) return;
  dot.style.display = 'none';
  if(!isFeatureUnlocked('aiReports') || !canManageStoresAndDevices()) return;
  const ownerUid = getDataOwnerUid();
  if(!cloudEnabled || !db || !ownerUid) return;
  try{
    const snap = await db.collection('mombongo_users').doc(ownerUid)
      .collection('aiReports').orderBy('weekId', 'desc').limit(1).get();
    if(snap.empty) return;
    const latestWeekId = snap.docs[0].data().weekId;
    const lastViewed = localStorage.getItem('mombongo:lastViewedAiReportWeekId');
    if(latestWeekId && latestWeekId !== lastViewed) dot.style.display = 'block';
  }catch(e){
    console.error('Erreur vérification badge rapports IA', e);
  }
}
