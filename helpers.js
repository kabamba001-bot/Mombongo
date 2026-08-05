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

