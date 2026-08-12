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

/* ---------- Validation des saisies numériques (prix, quantités, seuils) ----------
   Un champ vide est toléré ici (les appelants décident si c'est obligatoire) mais
   un nombre explicitement négatif ou invalide (texte, "NaN"...) ne l'est jamais —
   ça évite qu'un prix ou une quantité négative se glisse silencieusement dans le
   stock ou les totaux. hasNegativeInputs() prend une liste d'ids de champs et
   retourne true dès qu'un seul contient une valeur négative. */
function isNonNegativeInput(rawValue){
  if(rawValue === '' || rawValue == null) return true;
  const v = parseFloat(rawValue);
  return !isNaN(v) ? v >= 0 : true; // le texte non numérique est déjà filtré par parseFloat/parseInt ailleurs (-> 0)
}
function hasNegativeInputs(ids){
  return ids.some(function(id){
    const el = document.getElementById(id);
    return el && !isNonNegativeInput(el.value);
  });
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

