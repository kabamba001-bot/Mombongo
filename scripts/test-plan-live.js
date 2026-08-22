/**
 * test-plan-live.js — harnais de test isolé (Node, sans navigateur/Firebase) pour
 * vérifier RÉELLEMENT le comportement de checkPlanExpiryLive() / closeDowngradedActionSheets()
 * / updateEmployeeDowngradeBlock(), plutôt que de se fier à une relecture de code seule.
 *
 * Simule un DOM minimal (juste ce que plans.js touche : getElementById + classList) et
 * charge plans.js tel quel dans ce contexte via vm. N'a pas besoin de réseau (bash_tool
 * n'y a pas accès de toute façon) : tout le test est en mémoire.
 *
 * Usage : node test-plan-live.js
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function makeFakeElement(id){
  const classes = new Set();
  return {
    id,
    _open(){ return classes.has('open'); },
    classList: {
      add(c){ classes.add(c); },
      remove(c){ classes.delete(c); },
      contains(c){ return classes.has(c); },
      toggle(c, force){
        if(force === undefined){ classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if(force){ classes.add(c); }
        else { classes.delete(c); }
      }
    },
    style: {},
    textContent: ''
  };
}

// ------------- Registre des éléments DOM utilisés par les fenêtres testées -------------
const OVERLAY_IDS = [
  'voice-confirm-overlay','barcode-scan-overlay','barcode-confirm-overlay',
  'suppliers-overlay','supplier-form-overlay','record-purchase-overlay',
  'purchase-history-overlay','pay-supplier-overlay',
  'devices-overlay','generate-pin-overlay','join-with-code-overlay',
  'new-store-overlay','employee-plan-block-overlay',
  'plan-current-name','plan-current-status','plan-current-warning'
];
const elements = {};
OVERLAY_IDS.forEach(id => { elements[id] = makeFakeElement(id); });

const calls = []; // trace des vraies fonctions de fermeture appelées, pour vérifier qu'on
                   // coupe bien micro/caméra plutôt qu'un simple retrait de classe CSS

const sandbox = {
  document: { getElementById(id){ return elements[id] || null; } },
  console,
  Date,
  Math,
  showToast(){}, render(){},
  currentRole(){ return sandbox.__isEmployeeMode ? (sandbox.__employeeRole || 'patron') : 'patron'; },
  dict: { fr: { planJustDowngradedMsg: 'downgraded' } }, currentLang: 'fr',
  // Chaque fenêtre a normalement sa vraie fonction de fermeture (coupe micro/caméra pour
  // vente vocale / scan) — on les trace ici pour vérifier qu'elles sont bien appelées,
  // pas juste un classList.remove('open') générique.
  cancelVoiceSale(){ calls.push('cancelVoiceSale'); elements['voice-confirm-overlay'].classList.remove('open'); },
  closeBarcodeScanner(){ calls.push('closeBarcodeScanner'); elements['barcode-scan-overlay'].classList.remove('open'); },
  cancelBarcodeSale(){ calls.push('cancelBarcodeSale'); elements['barcode-confirm-overlay'].classList.remove('open'); },
  closeDevicesSheet(){ calls.push('closeDevicesSheet'); elements['devices-overlay'].classList.remove('open'); },
  closeGeneratePinSheet(){ calls.push('closeGeneratePinSheet'); elements['generate-pin-overlay'].classList.remove('open'); },
  closeJoinWithCodeSheet(){ calls.push('closeJoinWithCodeSheet'); elements['join-with-code-overlay'].classList.remove('open'); },
  closeNewStoreSheet(){ calls.push('closeNewStoreSheet'); elements['new-store-overlay'].classList.remove('open'); }
};
vm.createContext(sandbox);
const code = fs.readFileSync(__dirname + '/plans.js', 'utf8');
vm.runInContext(code, sandbox, { filename: 'plans.js' });
// IMPORTANT : plans.js déclare son état (userPlan, userPlanStatus, isEmployeeMode...) avec
// `let`/`const` au niveau supérieur du script. Dans une vraie page (comme dans un vm
// context Node), CES BINDINGS NE DEVIENNENT PAS DES PROPRIÉTÉS de l'objet global — on ne
// peut donc PAS les modifier depuis l'extérieur via `sandbox.userPlan = ...` (ça créerait
// une propriété à côté, sans aucun effet sur le vrai binding lexical que les fonctions de
// plans.js utilisent). Il faut passer par du code exécuté DANS LE MÊME CONTEXTE vm, d'où
// ces petites fonctions-pont, elles-mêmes déclarées comme des `function` (qui, elles,
// deviennent bien des propriétés globales et restent donc appelables depuis Node).
vm.runInContext(`
  function __setPlanState(p, s, trialEnd, expiresAt){
    userPlan = p; userPlanStatus = s; userPlanTrialEndsAt = trialEnd; userPlanExpiresAt = expiresAt;
  }
  function __setEmployee(on, role){ isEmployeeMode = on; employeeRole = role || null; }
  function __resetSignature(){ lastKnownEffectivePlanSignature = null; }
  planDataLoaded = true;
  // isEmployeeMode/employeeRole sont normalement déclarées dans stores-devices.js (pas
  // chargé ici, ce test isole plans.js) — updateEmployeeDowngradeBlock() les lit en tant
  // que bare identifiers : il leur faut une valeur initiale avant le tout premier appel.
  __setEmployee(false, null);
`, sandbox);
// currentRole() ci-dessus lit __isEmployeeMode/__employeeRole sur le sandbox lui-même
// (pas de conflit de scope possible pour un simple read côté Node) ; __setEmployee tient
// donc les deux copies synchronisées.
const _origSetEmployee = sandbox.__setEmployee;
sandbox.__setEmployee = function(on, role){ sandbox.__isEmployeeMode = on; sandbox.__employeeRole = role; _origSetEmployee(on, role); };


function openAll(ids){ ids.forEach(id => elements[id].classList.add('open')); }
function isOpen(id){ return elements[id]._open(); }
function setPlan(p, s, trialEnd, expiresAt){ sandbox.__setPlanState(p, s, trialEnd === undefined ? null : trialEnd, expiresAt === undefined ? null : expiresAt); }

// ============================= SCÉNARIO 1 =============================
// Patron sur Business (trial), avec fenêtre vente vocale + scan-code-barres ouvertes.
// Le trial expire pendant la session -> tout doit se fermer PROPREMENT (vraies fonctions),
// et un toast "downgraded" doit sortir.
console.log('--- Scénario 1 : downgrade Business trial -> Simple, fenêtres VIP ouvertes ---');
setPlan('business', 'trial', Date.now() + 10000, null); // pas encore expiré
sandbox.checkPlanExpiryLive(); // premier appel = juste l'amorçage (isFirstCheck), pas de fermeture
openAll(['voice-confirm-overlay','barcode-scan-overlay']);
assert.strictEqual(isOpen('voice-confirm-overlay'), true);
assert.strictEqual(isOpen('barcode-scan-overlay'), true);

setPlan('business', 'trial', Date.now() - 1000, null); // le trial vient d'expirer
sandbox.checkPlanExpiryLive();
assert.strictEqual(isOpen('voice-confirm-overlay'), false, 'vente vocale doit se fermer au downgrade');
assert.strictEqual(isOpen('barcode-scan-overlay'), false, 'scanner doit se fermer au downgrade');
assert.ok(calls.includes('cancelVoiceSale'), 'cancelVoiceSale() doit être appelée (coupe le micro)');
assert.ok(calls.includes('closeBarcodeScanner'), 'closeBarcodeScanner() doit être appelée (coupe la caméra)');
console.log('  OK — fenêtres fermées via leurs vraies fonctions :', calls.join(', '));

// ============================= SCÉNARIO 2 =============================
// Un UPGRADE COMPLET (Business -> Pro, qui ne fait QUE débloquer davantage) ne doit
// RIEN fermer. Business -> Simple(free) laisserait au contraire multiDevice/multiStore/
// supplierManagement toujours verrouillés (Pro uniquement) : ce n'est pas un bon test
// d'upgrade "pur", d'où Business -> Pro ici.
console.log('--- Scénario 2 : upgrade complet -> aucune fenêtre fermée ---');
setPlan('business', 'active', null, Date.now() + 999999);
sandbox.checkPlanExpiryLive();
calls.length = 0;
openAll(['voice-confirm-overlay']);
setPlan('pro', 'active', null, Date.now() + 999999);
sandbox.checkPlanExpiryLive();
assert.strictEqual(isOpen('voice-confirm-overlay'), true, 'un upgrade ne doit jamais fermer une fenêtre déjà légitime');
assert.strictEqual(calls.length, 0, 'un upgrade complet (Business -> Pro) ne doit déclencher aucune fermeture');
console.log('  OK — rien fermé sur un upgrade complet.');

// ============================= SCÉNARIO 3 =============================
// Appareil employé (caissier) : le Pro du patron expire pendant la session -> blocage
// immédiat. Puis un renouvellement est détecté -> déblocage automatique.
console.log('--- Scénario 3 : blocage employé au downgrade, déblocage au renouvellement ---');
sandbox.__setEmployee(true, 'caissier');
setPlan('pro', 'active', null, Date.now() + 999999);
sandbox.__resetSignature(); // simule un nouveau boot de l'appareil employé
sandbox.checkPlanExpiryLive(); // premier appel : doit déjà refléter l'état réel (pas seulement sur "changement")
assert.strictEqual(isOpen('employee-plan-block-overlay'), false, 'Pro actif : employé pas bloqué dès le premier check');

setPlan('pro', 'active', null, Date.now() - 1000); // le Pro du patron vient d'expirer
sandbox.checkPlanExpiryLive();
assert.strictEqual(isOpen('employee-plan-block-overlay'), true, 'employé doit être bloqué au moment précis du downgrade');
console.log('  OK — appareil employé bloqué à l\'expiration du Pro.');

setPlan('pro', 'active', null, Date.now() + 999999); // renouvellement détecté (nouvel abonnement)
sandbox.checkPlanExpiryLive();
assert.strictEqual(isOpen('employee-plan-block-overlay'), false, 'le blocage doit se lever dès le renouvellement détecté');
console.log('  OK — blocage levé automatiquement au renouvellement.');

// ============================= SCÉNARIO 4 =============================
// Le PATRON lui-même, même en "mode employé" (compte patron secondaire), n'est jamais
// bloqué par ce mécanisme.
console.log('--- Scénario 4 : le patron (même en mode employé) n\'est jamais bloqué ---');
sandbox.__setEmployee(true, 'patron');
setPlan('pro', 'active', null, Date.now() - 1000); // Pro expiré
sandbox.checkPlanExpiryLive();
assert.strictEqual(isOpen('employee-plan-block-overlay'), false, 'un rôle patron ne doit jamais être bloqué par ce mécanisme');
console.log('  OK — patron jamais bloqué.');

// ============================= SCÉNARIO 5 =============================
// Un seul minuteur : setInterval(checkPlanExpiryLive, ...) ne doit apparaître qu'UNE
// fois en code exécutable dans tout le dépôt (vérifié statiquement, pas via ce sandbox
// qui ne charge pas stores-devices.js). Exclut ce fichier de test lui-même (qui en PARLE
// dans ses commentaires/chaînes) et les .md (documentation, pas du code).
console.log('--- Scénario 5 : un seul minuteur dans le dépôt (vérif statique) ---');
const { execSync } = require('child_process');
const grepRaw = execSync(
  `grep -rn "setInterval(checkPlanExpiryLive, 60000);" --include="*.js" ${__dirname} | grep -v test-plan-live.js`
).toString().trim();
const realCodeLines = grepRaw.split('\n').filter(Boolean);
assert.strictEqual(realCodeLines.length, 1, 'un seul setInterval(checkPlanExpiryLive...) doit exister en code réel dans tout le dépôt');
console.log('  OK — un seul minuteur trouvé :', realCodeLines[0]);

console.log('\n✅ TOUS LES SCÉNARIOS PASSENT.');
