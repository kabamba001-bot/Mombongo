/**
 * reset-phone-code.js
 * -------------------------------------------------------------------------
 * Réinitialise le code de connexion (numéro de téléphone + code choisi par
 * l'utilisateur, voir phone-auth.js) d'un client qui l'a oublié et t'a
 * contacté sur WhatsApp — c'est ce que fait le lien "Code oublié ?" dans la
 * fenêtre de connexion de Mombongo : il n'y a pas de réinitialisation
 * automatique (pas de SMS, pas de vraie adresse email connue du client), donc
 * c'est TOI qui réinitialises à la main, une fois le client identifié par son
 * numéro sur WhatsApp.
 *
 * Utilise le même mécanisme d'authentification que grant-vip.js
 * (FIREBASE_SERVICE_ACCOUNT), donc rien de nouveau à configurer si ce script
 * tourne déjà.
 *
 * USAGE (en ligne de commande, depuis ce dossier) :
 *   FIREBASE_SERVICE_ACCOUNT='<json du compte de service>' \
 *   node reset-phone-code.js --phone=243812345678 --code=ab12
 *
 * Ou via le workflow GitHub Actions "Réinitialiser un code de connexion"
 * (.github/workflows/reset-phone-code.yml, déclenché manuellement depuis
 * l'onglet Actions du dépôt — aucune ligne de commande à taper).
 *
 * --phone=243812345678   (obligatoire — chiffres uniquement, indicatif du
 *                          pays inclus, exactement comme saisi dans Mombongo)
 * --code=ab12             (obligatoire — le NOUVEAU code à donner ensuite au
 *                          client de vive voix/WhatsApp — 4 à 8 caractères,
 *                          chiffres et/ou lettres)
 *
 * IMPORTANT : PHONE_AUTH_EMAIL_DOMAIN et PHONE_AUTH_PASSWORD_PREFIX
 * ci-dessous doivent rester identiques à celles de phone-auth.js — c'est ce
 * qui permet de retrouver le bon compte Firebase Auth à partir du seul
 * numéro de téléphone.
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');
const { initAdmin } = require('./alert-utils');

const PHONE_AUTH_EMAIL_DOMAIN = 'phone.mombongo.app';
const PHONE_AUTH_PASSWORD_PREFIX = 'Mombongo#';
const PHONE_DEFAULT_COUNTRY_CODE = '243'; // doit rester identique à phone-auth.js
const CODE_REGEX = /^[A-Za-z0-9]{4,8}$/;

// Même règle que normalizePhoneDigits() dans phone-auth.js : "0970989141"
// (format local) et "243970989141" (format international) doivent donner le
// MÊME résultat, sinon on ne retrouve pas le compte du client.
function normalizePhoneDigits(raw){
  let digits = String(raw || '').replace(/\D/g, '');
  if(digits.startsWith('00')) digits = digits.slice(2);
  if(digits.length === 10 && digits.startsWith('0')){
    digits = PHONE_DEFAULT_COUNTRY_CODE + digits.slice(1);
  }
  return digits;
}

function parseArgs(){
  const args = {};
  process.argv.slice(2).forEach(function(raw){
    const m = raw.match(/^--([a-zA-Z]+)=(.*)$/);
    if(m) args[m[1]] = m[2];
  });
  return args;
}

async function run(){
  const args = parseArgs();
  const phone = normalizePhoneDigits(args.phone || process.env.RESET_PHONE || '');
  const code = (args.code || process.env.RESET_CODE || '').trim();

  if(!phone || phone.length < 8){
    console.error('Manquant ou invalide : --phone=... (chiffres uniquement, indicatif du pays inclus, ex: 243812345678)');
    process.exit(1);
  }
  if(!CODE_REGEX.test(code)){
    console.error(`--code invalide ("${code}") — attendu : 4 à 8 caractères, chiffres et/ou lettres.`);
    process.exit(1);
  }

  initAdmin();

  const email = phone + '@' + PHONE_AUTH_EMAIL_DOMAIN;
  const newPassword = PHONE_AUTH_PASSWORD_PREFIX + code;

  let userRecord;
  try{
    userRecord = await admin.auth().getUserByEmail(email);
  }catch(e){
    console.error(`Aucun compte trouvé pour le numéro "${phone}". Le client doit s'être inscrit au moins une fois par numéro+code dans Mombongo (la connexion Google n'utilise pas ce système). Erreur : ${e.message}`);
    process.exit(1);
  }

  await admin.auth().updateUser(userRecord.uid, { password: newPassword });

  console.log('---------------------------------------------------------');
  console.log('✅ Code réinitialisé avec succès.');
  console.log(`Numéro       : ${phone}`);
  console.log(`UID          : ${userRecord.uid}`);
  console.log(`Nouveau code : ${code}`);
  console.log('---------------------------------------------------------');
  console.log("Donne ce nouveau code au client (WhatsApp/appel) — il doit se");
  console.log('connecter avec son numéro et CE code exactement, dans la fenêtre');
  console.log('de connexion de Mombongo.');
}

run().catch(function(e){
  console.error('Erreur fatale :', e);
  process.exit(1);
});
