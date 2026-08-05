/* ---------- Stockage local fiable (fonctionne une fois l'app hébergée, contrairement à l'ancien système) ---------- */
function localGet(key){
  try{
    const v = localStorage.getItem(key);
    return v === null ? null : { value: v };
  }catch(e){ console.error('Erreur lecture stockage', e); return null; }
}
function localSet(key, value){
  try{
    localStorage.setItem(key, value);
    return { value };
  }catch(e){ console.error('Erreur écriture stockage', e); return null; }
}

/* ---------- Mode nuit ---------- */
let darkMode = false;
function toggleTheme(){
  darkMode = !darkMode;
  document.body.classList.toggle('dark-mode', darkMode);
  document.getElementById('theme-btn-icon').textContent = darkMode ? '☀️' : '🌙';
  localSet('mombongo:theme', darkMode ? 'dark' : 'light');
}
(function applyThemeOnLoad(){
  try{
    const saved = localGet('mombongo:theme');
    if(saved && saved.value === 'dark'){
      darkMode = true;
      document.body.classList.add('dark-mode');
      document.getElementById('theme-btn-icon').textContent = '☀️';
    }
  }catch(e){}
})();

/* ---------- Installation PWA en un tap ---------- */
// Chrome propose nativement d'installer un site comme une app (icône sur l'écran d'accueil,
// ouverture en plein écran, sans barre d'adresse) sans passer par un fichier .apk à télécharger
// manuellement. Par défaut, Chrome ne montre cette option que discrètement (petite icône dans la
// barre d'adresse, selon son propre calendrier) — on capture l'événement pour l'offrir nous-mêmes
// via un vrai bouton, dès qu'il est disponible.
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('t-pwa-install-btn');
  if(btn) btn.style.display = 'block';
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('t-pwa-install-btn');
  if(btn) btn.style.display = 'none';
});
async function installPwa(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  const btn = document.getElementById('t-pwa-install-btn');
  if(btn) btn.style.display = 'none';
}

