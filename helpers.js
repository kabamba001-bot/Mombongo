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

/* ---------- Unités de mesure ----------
   'pc' (pièce) est l'unité par défaut et reproduit exactement le comportement
   historique : quantités entières, pas de décimales. Les autres unités
   couvrent la vente au poids/volume/longueur (vrac, quincaillerie...) et
   acceptent des décimales — jusqu'à 2 chiffres après la virgule pour
   kg/l/m, aucune pour g/ml/cm (déjà l'unité la plus fine dans la pratique
   d'un petit commerce, pas besoin de fractions dessous).
   Les modes "carton" et "mesurette/sac" restent en pièces (unit:'pc',
   stocké explicitement) : ce ne sont pas des quantités au poids/volume,
   juste une autre façon d'ACHETER des pièces (par lot). */
const UNIT_DEFS = {
  pc: { decimals: 0, step: 1 },
  kg: { decimals: 2, step: 0.01 },
  g:  { decimals: 0, step: 1 },
  l:  { decimals: 2, step: 0.01 },
  ml: { decimals: 0, step: 1 },
  m:  { decimals: 2, step: 0.01 },
  cm: { decimals: 0, step: 1 }
};
function isDecimalUnit(unit){
  return (UNIT_DEFS[unit] || UNIT_DEFS.pc).decimals > 0;
}
function unitStep(unit){
  return (UNIT_DEFS[unit] || UNIT_DEFS.pc).step;
}
function unitInputMode(unit){
  return isDecimalUnit(unit) ? 'decimal' : 'numeric';
}
// Parse une saisie de quantité selon l'unité : entier pour pc/g/ml/cm, arrondi à 2
// décimales pour kg/l/m (évite les 0.1+0.2=0.30000000000000004 de l'IEEE 754 qui
// finiraient par s'accumuler dans le stock au fil des ventes).
function parseQtyForUnit(rawValue, unit){
  const def = UNIT_DEFS[unit] || UNIT_DEFS.pc;
  const v = parseFloat(rawValue);
  if(isNaN(v)) return 0;
  if(def.decimals === 0) return Math.round(v);
  const factor = Math.pow(10, def.decimals);
  return Math.round(v * factor) / factor;
}
function unitLabel(unit){
  const t = dict[currentLang];
  const labels = t && t.unitLabels;
  return (labels && labels[unit]) || (labels && labels.pc) || unit || '';
}
// Affichage d'une quantité avec son unité, ex: "3.5 kg", "12 pièce(s)".
function formatQty(qty, unit){
  const def = UNIT_DEFS[unit] || UNIT_DEFS.pc;
  const factor = Math.pow(10, def.decimals);
  const n = Math.round((qty || 0) * factor) / factor;
  return n + ' ' + unitLabel(unit);
}

/* ---------- Nettoyage définitif des champs "legacy" (sales/products/debts/...) ----------
   Chaque *-sync.js a migré sa donnée vers sa propre collection Firestore protégée par
   rôle, mais l'ANCIEN champ (storesData.{storeId}.sales, .products, etc., sur le gros
   document mombongo_users/{ownerUid}) n'a jamais été explicitement supprimé côté
   Firestore — juste abandonné. pushToCloud() ne l'inclut plus dans ses écritures, mais un
   merge n'efface jamais un champ qu'on n'inclut simplement pas : il reste donc physiquement
   présent pour toujours, et réapparaît à chaque chargement frais (applyDocData()) dans
   storesDataCache[storeId]. Résultat : le jour où la VRAIE collection devient légitimement
   vide (l'utilisateur supprime tout son stock, par exemple), chaque attachXxxListener()
   retombe sur ce vieux champ fantôme et RESSUSCITE les données supprimées — bug réel
   observé en usage. Cette fonction supprime le champ, une fois pour toutes, dès qu'on est
   sûr que la nouvelle collection est bien la source de vérité (voir chaque attachXxxListener()
   dans *-sync.js). Best-effort et silencieuse : un appareil employé n'a de toute façon pas
   le droit de toucher aux champs les plus sensibles (sales/debts/expenses/suppliers/
   purchases/activityLog — voir firestore.rules), le patron s'en chargera à la prochaine
   ouverture de son propre appareil.
   ⚠️ N'écrit RIEN localement (storesDataCache reste inchangé ici) — chaque attachXxxListener()
   se charge lui-même de nettoyer sa propre entrée locale pour éviter toute résurrection
   dans la MÊME session, avant même que cette écriture Firestore n'ait pu aboutir. */
function cleanupLegacyField(ownerUid, storeId, fieldName){
  if(!cloudEnabled || !db || !ownerUid || !storeId) return;
  db.collection('mombongo_users').doc(ownerUid).update({
    ['storesData.' + storeId + '.' + fieldName]: firebase.firestore.FieldValue.delete()
  }).catch(()=>{ /* silencieux — voir commentaire ci-dessus */ });
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

