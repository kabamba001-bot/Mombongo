/* =========================================================================
   CONNEXION PAR NUMÉRO DE TÉLÉPHONE + CODE (sans SMS)
   =========================================================================
   Firebase n'offre pas de "numéro + code choisi par l'utilisateur" nativement
   sans passer par un vrai SMS (payant, et nécessite un serveur). On détourne
   donc l'authentification Email/Mot de passe de Firebase : le numéro devient
   un email interne jamais montré à l'utilisateur (voir phoneToAuthEmail), et
   le code choisi devient le mot de passe (voir codeToAuthPassword — préfixé
   pour respecter le minimum de 6 caractères que Firebase impose, même si le
   client tape un code de seulement 4 caractères). Ça reste un VRAI compte
   Firebase Auth : il fonctionne instantanément depuis n'importe quel
   appareil, exactement comme la connexion Google, sans rien à héberger.

   Ce mécanisme S'AJOUTE à la connexion Google (account-cloud.js) — ce n'est
   pas un remplacement. Les deux types de compte utilisent le même
   `firebase.auth().currentUser` et donc exactement le même reste de l'app
   (stores-devices.js, pushToCloud, etc.) sans aucune distinction à faire
   ailleurs dans le code.

   IMPORTANT : PHONE_AUTH_EMAIL_DOMAIN et PHONE_AUTH_PASSWORD_PREFIX doivent
   rester identiques à celles de reset-phone-code.js (script de
   réinitialisation manuelle par l'admin) — sinon l'admin ne retrouvera plus
   le bon compte à partir du numéro de téléphone.
   ========================================================================= */
const PHONE_AUTH_EMAIL_DOMAIN = 'phone.mombongo.app';
const PHONE_AUTH_PASSWORD_PREFIX = 'Mombongo#';
const PHONE_AUTH_CODE_REGEX = /^[A-Za-z0-9]{4,8}$/;
const PHONE_DEFAULT_COUNTRY_CODE = '243'; // RD Congo — marché principal de Mombongo (voir DEV_WHATSAPP)

// Garde uniquement les chiffres (retire espaces, tirets, parenthèses, le "+"
// initial ou un éventuel "00" international) — le numéro affiché à
// l'utilisateur peut rester saisi librement, seule cette version normalisée
// sert à construire l'email interne.
// IMPORTANT : "0970989141" (format local, 10 chiffres) et "+243970989141"
// (même numéro en format international) doivent aboutir à EXACTEMENT le même
// résultat, sinon un client qui tape son numéro différemment à l'inscription
// et à la connexion se retrouve avec 2 comptes distincts sans le savoir.
function normalizePhoneDigits(raw){
  let digits = String(raw || '').replace(/\D/g, '');
  if(digits.startsWith('00')) digits = digits.slice(2);
  if(digits.length === 10 && digits.startsWith('0')){
    digits = PHONE_DEFAULT_COUNTRY_CODE + digits.slice(1);
  }
  return digits;
}
function isValidPhoneDigits(digits){
  return digits.length >= 8 && digits.length <= 15;
}
function isValidPhoneCode(code){
  return PHONE_AUTH_CODE_REGEX.test(String(code || ''));
}
function phoneToAuthEmail(digits){
  return digits + '@' + PHONE_AUTH_EMAIL_DOMAIN;
}
function codeToAuthPassword(code){
  return PHONE_AUTH_PASSWORD_PREFIX + code;
}

// En plus du toast (en haut de l'écran, disparaît vite), un message reste
// affiché DANS la carte tant que l'utilisateur n'a pas retenté — pour être
// sûr que l'erreur exacte reste visible et lisible, même si le toast est
// manqué. C'est ce message-là qu'il faut lire/renvoyer si ça bloque encore.
function showAuthGateError(view, msg){
  const el = document.getElementById('auth-gate-' + view + '-error');
  if(el){ el.textContent = msg; el.style.display = 'block'; }
}
function clearAuthGateError(view){
  const el = document.getElementById('auth-gate-' + view + '-error');
  if(el){ el.style.display = 'none'; el.textContent = ''; }
}

/* ---------- Inscription ---------- */
function signUpWithPhoneCode(){
  const t = dict[currentLang];
  clearAuthGateError('signup');
  if(typeof fbq === 'function') fbq('trackCustom', 'ClicInscriptionTelephone');
  if(!cloudEnabled){
    showToast("La connexion n'est pas encore configurée (voir la note du développeur dans le code)");
    return;
  }
  const phoneRaw = document.getElementById('auth-gate-signup-phone').value;
  const code = document.getElementById('auth-gate-signup-code').value;
  const code2 = document.getElementById('auth-gate-signup-code2').value;
  const digits = normalizePhoneDigits(phoneRaw);

  if(!isValidPhoneDigits(digits)){
    showToast(t.authGateInvalidPhone, 4000);
    showAuthGateError('signup', t.authGateInvalidPhone);
    return;
  }
  if(!isValidPhoneCode(code)){
    showToast(t.authGateInvalidCode, 4500);
    showAuthGateError('signup', t.authGateInvalidCode);
    return;
  }
  if(code !== code2){
    showToast(t.authGateCodeMismatch, 4000);
    showAuthGateError('signup', t.authGateCodeMismatch);
    return;
  }

  const btn = document.getElementById('t-authgate-signup-btn');
  if(btn){ btn.disabled = true; btn.textContent = '…'; }

  const email = phoneToAuthEmail(digits);
  const password = codeToAuthPassword(code);

  firebase.auth().createUserWithEmailAndPassword(email, password).then(function(){
    if(typeof fbq === 'function') fbq('track', 'CompleteRegistration');
    showToast(t.authGateSignupSuccess);
    // Même geste qu'à l'inscription Google (voir account-cloud.js,
    // signInWithGoogle) : demander le métier dès le premier compte créé,
    // jamais re-sollicité ensuite.
    if(!myStoreType && typeof openCategoryPromptSheet === 'function'){
      openCategoryPromptSheet(function(cat){ setMyStoreType(cat); }, 'myStoreTypeTitle', 'myStoreTypeDesc');
    }
    if(typeof updateBackupBanner === 'function') updateBackupBanner();
    closeAuthGate();
  }).catch(function(e){
    if(btn){ btn.disabled = false; btn.textContent = t.authGateSignupBtn; }
    if(e.code === 'auth/email-already-in-use'){
      showToast(t.authGateAlreadyRegistered, 5000);
      showAuthGateLoginView();
      document.getElementById('auth-gate-login-phone').value = phoneRaw;
      return;
    }
    console.error('Erreur inscription téléphone', e);
    const msg = t.authGateGenericError + ' ' + (e.code || e.message || e);
    showToast(msg, 6000);
    showAuthGateError('signup', msg);
  });
}

/* ---------- Connexion ---------- */
function signInWithPhoneCode(){
  const t = dict[currentLang];
  clearAuthGateError('login');
  if(typeof fbq === 'function') fbq('trackCustom', 'ClicConnexionTelephone');
  if(!cloudEnabled){
    showToast("La connexion n'est pas encore configurée (voir la note du développeur dans le code)");
    return;
  }
  const phoneRaw = document.getElementById('auth-gate-login-phone').value;
  const code = document.getElementById('auth-gate-login-code').value;
  const digits = normalizePhoneDigits(phoneRaw);

  if(!isValidPhoneDigits(digits)){
    showToast(t.authGateInvalidPhone, 4000);
    showAuthGateError('login', t.authGateInvalidPhone);
    return;
  }
  if(!code){
    showToast(t.authGateInvalidCode, 4500);
    showAuthGateError('login', t.authGateInvalidCode);
    return;
  }

  const btn = document.getElementById('t-authgate-login-btn');
  if(btn){ btn.disabled = true; btn.textContent = '…'; }

  const email = phoneToAuthEmail(digits);
  const password = codeToAuthPassword(code);

  firebase.auth().signInWithEmailAndPassword(email, password).then(function(){
    showToast(t.authGateLoginSuccess);
    if(typeof updateBackupBanner === 'function') updateBackupBanner();
    closeAuthGate();
  }).catch(function(e){
    if(btn){ btn.disabled = false; btn.textContent = t.authGateLoginBtn; }
    if(e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential' || e.code === 'auth/invalid-email'){
      showToast(t.authGateLoginFailed, 4500);
      showAuthGateError('login', t.authGateLoginFailed);
      return;
    }
    console.error('Erreur connexion téléphone', e);
    const msg = t.authGateGenericError + ' ' + (e.code || e.message || e);
    showToast(msg, 6000);
    showAuthGateError('login', msg);
  });
}

/* ---------- Code oublié → contacter l'admin sur WhatsApp ----------
   Pas de réinitialisation automatique (pas d'email réel connu du client) :
   l'admin réinitialise à la main via reset-phone-code.js (voir ce fichier),
   après avoir identifié le client par son numéro sur WhatsApp. */
function openAuthGateForgotPassword(){
  const t = dict[currentLang];
  const phoneRaw = document.getElementById('auth-gate-login-phone').value
    || document.getElementById('auth-gate-signup-phone').value
    || '';
  const msg = (t.authGateForgotMessage || '').replace('{phone}', phoneRaw.trim() || '???');
  window.open('https://wa.me/' + DEV_WHATSAPP + '?text=' + encodeURIComponent(msg), '_blank');
}

/* =========================================================================
   FENÊTRE OBLIGATOIRE D'INSCRIPTION/CONNEXION
   =========================================================================
   Apparaît entre 0 et 5 secondes après l'arrivée sur Mombongo, tant que
   personne n'est connecté (ni Google, ni téléphone) — impossible à fermer
   sans se connecter, volontairement en dehors du système .sheet-overlay
   habituel (donc jamais fermée par le bouton retour Android, voir
   navigation.js) : c'est le seul moyen de savoir combien de vrais
   utilisateurs utilisent Mombongo.
   Ne concerne jamais un appareil employé (caissier/magasinier) : son
   "authentification" est déjà le code de jumelage donné par le patron.
   ========================================================================= */
let authGateTimer = null;

function maybeScheduleAuthGate(){
  if(!cloudEnabled) return;
  if(isEmployeeMode) return;
  if(currentUser){ closeAuthGate(); return; }
  if(authGateTimer) return; // déjà programmée, ne pas relancer un 2e délai
  const delay = Math.floor(Math.random() * 5000); // 0 à 5 secondes
  authGateTimer = setTimeout(function(){
    authGateTimer = null;
    if(!currentUser && !isEmployeeMode) openAuthGate();
  }, delay);
}

function openAuthGate(){
  showAuthGateLoginView();
  const el = document.getElementById('auth-gate-overlay');
  if(el) el.classList.add('open');
  if(typeof fbq === 'function') fbq('trackCustom', 'AuthGateShown');
}

function closeAuthGate(){
  const el = document.getElementById('auth-gate-overlay');
  if(el) el.classList.remove('open');
  if(authGateTimer){ clearTimeout(authGateTimer); authGateTimer = null; }
}

function showAuthGateLoginView(){
  document.getElementById('auth-gate-login-view').style.display = 'block';
  document.getElementById('auth-gate-signup-view').style.display = 'none';
  clearAuthGateError('signup');
}
function showAuthGateSignupView(){
  document.getElementById('auth-gate-login-view').style.display = 'none';
  document.getElementById('auth-gate-signup-view').style.display = 'block';
  clearAuthGateError('login');
}

// Bouton 👁 à côté des champs code : masqué par défaut (comme un mot de passe,
// puisque c'est un secret personnel), révélable en un tap pour vérifier ce
// qu'on vient de taper — surtout utile à l'inscription vu qu'il faut le
// retaper une 2e fois sans erreur.
function toggleAuthGateCodeVisibility(inputId, btn){
  const el = document.getElementById(inputId);
  if(!el) return;
  if(el.type === 'password'){
    el.type = 'text';
    btn.textContent = '🙈';
  } else {
    el.type = 'password';
    btn.textContent = '👁';
  }
}
