/* =========================================================================
   ONGLET "💡 DÉCOUVRIR" — présente toutes les fonctionnalités de Mombongo aux
   nouveaux utilisateurs sous forme de FAQ à accordéon (titre + chevron qui se
   déplie). Volontairement, on n'y met PAS l'installation de l'app ni le
   cadeau "50 premiers utilisateurs" : ce sont des évènements ponctuels
   propres à l'arrivée sur l'app, pas des choses que l'utilisateur "fait"
   au quotidien dans Mombongo — ce que cet onglet couvre.

   Tout le texte (titres + explications) vient de dict[currentLang], donc cet
   onglet change de langue automatiquement avec le reste de l'app — voir
   renderDiscoverContent(), rappelée depuis applyTranslations() dans
   stores-devices.js à chaque changement de langue.
   ========================================================================= */
const DISCOVER_SECTIONS = [
  { icon:'🚚', key:'suppliers' },
  { icon:'➕', key:'addSimple' },
  { icon:'📦', key:'addCarton' },
  { icon:'🌾', key:'addSac' },
  { icon:'📋', key:'addBulkCatalog' },
  { icon:'🧮', key:'gridAdd' },
  { icon:'📷', key:'addBarcode' },
  { icon:'📄', key:'duplicateProduct' },
  { icon:'✏️', key:'editDeleteProduct' },
  { icon:'⏳', key:'expiryDate' },
  { icon:'🛒', key:'sellSimple' },
  { icon:'🧺', key:'sellMulti' },
  { icon:'🤝', key:'sellCredit' },
  { icon:'➗', key:'sellPartialDebt' },
  { icon:'🎤', key:'sellVoice' },
  { icon:'📷', key:'sellBarcode' },
  { icon:'🌍', key:'communityCatalog' },
  { icon:'📃', key:'receipt' },
  { icon:'📊', key:'dashboard' },
  { icon:'🧾', key:'history' },
  { icon:'🗑️', key:'deleteSale' },
  { icon:'🧹', key:'clearHistory' },
  { icon:'📤', key:'exportPdfExcel' },
  { icon:'💳', key:'debts' },
  { icon:'💸', key:'expenses' },
  { icon:'🔔', key:'alerts' },
  { icon:'🏬', key:'multiStore' },
  { icon:'🧑‍🤝‍🧑', key:'roles' },
  { icon:'🔗', key:'connectDevice' },
  { icon:'👁️', key:'activityLog' },
  { icon:'💱', key:'currency' },
  { icon:'🔑', key:'googleAccount' },
  { icon:'🎁', key:'referral' },
  { icon:'🔕', key:'notifications' },
  { icon:'📡', key:'offlineMode' },
  { icon:'🌙', key:'darkMode' },
  { icon:'◀️', key:'androidBack' },
];

function renderDiscoverContent(){
  const wrap = document.getElementById('discover-list');
  if(!wrap) return;
  const t = dict[currentLang];
  // On garde ouverts les items déjà dépliés (ex : la personne change de langue pendant
  // qu'elle est en train de lire une section) au lieu de tout refermer à chaque rendu.
  const openKeys = new Set();
  wrap.querySelectorAll('.discover-item.open').forEach(el=>openKeys.add(el.dataset.key));
  wrap.innerHTML = '';
  DISCOVER_SECTIONS.forEach(sec=>{
    const title = t['discoverTitle_'+sec.key] || sec.key;
    const body = t['discoverBody_'+sec.key] || '';
    const item = document.createElement('div');
    item.className = 'discover-item' + (openKeys.has(sec.key) ? ' open' : '');
    item.dataset.key = sec.key;
    item.innerHTML =
      '<button type="button" class="discover-item-header" onclick="toggleDiscoverItem(this)">' +
        '<span class="discover-item-icon">' + sec.icon + '</span>' +
        '<span class="discover-item-title">' + escapeHtml(title) + '</span>' +
        '<span class="discover-chevron">›</span>' +
      '</button>' +
      '<div class="discover-item-body"><p>' + escapeHtml(body).replace(/\n/g,'<br>') + '</p></div>';
    wrap.appendChild(item);
  });
}
function toggleDiscoverItem(headerBtn){
  const item = headerBtn.closest('.discover-item');
  if(!item) return;
  item.classList.toggle('open');
}
function openDiscoverSheet(){
  renderDiscoverContent();
  document.getElementById('discover-overlay').classList.add('open');
}
function closeDiscoverSheet(){
  document.getElementById('discover-overlay').classList.remove('open');
}
