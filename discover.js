/* =========================================================================
   ONGLET "💡 DÉCOUVRIR" — présente toutes les fonctionnalités de Mombongo aux
   nouveaux utilisateurs sous forme de FAQ à accordéon (titre + chevron qui se
   déplie). Volontairement, on n'y met PAS l'installation de l'app ni la
   promo "50 places par palier" : ce sont des évènements ponctuels propres à
   l'arrivée sur l'app (popup dédiée, badge dans le menu compte — voir
   debts-expenses-alerts.js), pas des choses que l'utilisateur "fait" au
   quotidien dans Mombongo — ce que cet onglet couvre. La première section
   ("plansOverview") explique en revanche le système des 3 catégories lui-même
   (Simple/Business/Pro), qui lui est bien permanent.

   Tout le texte (titres + explications) vient de dict[currentLang], donc cet
   onglet change de langue automatiquement avec le reste de l'app — voir
   renderDiscoverContent(), rappelée depuis applyTranslations() dans
   stores-devices.js à chaque changement de langue.
   ========================================================================= */
const DISCOVER_SECTIONS = [
  { icon:'🧭', key:'plansOverview' },
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
    // Section "Les 3 catégories Mombongo" : un bouton qui ouvre directement le
    // sélecteur de palier (déjà utilisé pour changer de palier depuis le compte), pour
    // pouvoir agir tout de suite après avoir lu l'explication — plus de lien WhatsApp
    // générique ici (Business et Pro ont chacun leur propre chemin d'activation, gérés
    // par ce sélecteur lui-même).
    if(sec.key === 'plansOverview'){
      const bodyDiv = item.querySelector('.discover-item-body');
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.style.cssText = 'display:block; width:100%; margin-top:4px;';
      btn.type = 'button';
      btn.textContent = t.planSwitchBtn || 'Changer de palier';
      btn.onclick = function(){
        closeDiscoverSheet();
        if(typeof openPlanPicker === 'function') openPlanPicker();
      };
      bodyDiv.appendChild(btn);
    }
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
