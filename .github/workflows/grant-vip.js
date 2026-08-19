/**
 * grant-vip.js
 * -------------------------------------------------------------------------
 * Accorde un palier payant (Simple payant / Business / Pro) à un compte, à
 * partir de son EMAIL, sans passer par la console Firebase. Remplace le
 * geste manuel décrit en §5 de PALIERS.md (modifier userPlan/userPlanStatus/
 * userPlanExpiresAt à la main sur mombongo_users/{uid}).
 *
 * Utilise le même mécanisme d'authentification que send-daily-recap.js et
 * send-new-alerts.js (FIREBASE_SERVICE_ACCOUNT), donc rien de nouveau à
 * configurer si ces deux scripts tournent déjà.
 *
 * USAGE (en ligne de commande, depuis ce dossier) :
 *   FIREBASE_SERVICE_ACCOUNT='<json du compte de service>' \
 *   node grant-vip.js --email=client@example.com --plan=business --duration=1m
 *
 * Ou via le workflow GitHub Actions "Accorder un palier VIP"
 * (.github/workflows/grant-vip.yml, déclenché manuellement depuis l'onglet
 * Actions du dépôt — aucune ligne de commande à taper) : voir ce fichier
 * pour la version formulaire.
 *
 * --plan=simple|business|pro         (obligatoire)
 * --duration=1w|2w|1m|2m|3m|6m|1y    (obligatoire — semaines/mois/année)
 *   ou --days=45                     (alternative libre, nombre de jours)
 * --email=quelqu.un@gmail.com        (obligatoire — l'email du compte Google
 *                                      Mombongo du client, PAS un uid)
 *
 * Ce que le script fait concrètement sur mombongo_users/{uid} :
 *   userPlan: <plan demandé>
 *   userPlanStatus: 'active'
 *   userPlanExpiresAt: maintenant + durée demandée (ms epoch)
 *   userPlanTrialEndsAt: null   (on accorde un abonnement payé, pas un essai)
 * — exactement les champs listés en §5 de PALIERS.md, jamais
 *   userHasUsedBusinessTrial (réservé à l'essai gratuit, jamais touché ici).
 *
 * Si le compte n'a pas encore de document mombongo_users/{uid} (client payé
 * avant sa toute première ouverture de l'app), le document est créé avec ces
 * seuls champs — l'app complète le reste à sa première synchronisation.
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');
const { initAdmin } = require('./alert-utils');

const VALID_PLANS = ['simple', 'business', 'pro'];

const DURATION_MS = {
  '1w': 7 * 24 * 60 * 60 * 1000,
  '2w': 14 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '2m': 60 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000,
  '6m': 182 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000
};

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
  const email = (args.email || process.env.VIP_EMAIL || '').trim().toLowerCase();
  const plan = (args.plan || process.env.VIP_PLAN || '').trim().toLowerCase();
  const duration = (args.duration || process.env.VIP_DURATION || '').trim().toLowerCase();
  const daysArg = args.days || process.env.VIP_DAYS;

  if(!email){
    console.error('Manquant : --email=... (l\'email du compte Google du client)');
    process.exit(1);
  }
  if(!VALID_PLANS.includes(plan)){
    console.error(`--plan invalide ("${plan}") — attendu : ${VALID_PLANS.join(' | ')}`);
    process.exit(1);
  }
  let durationMs;
  if(daysArg){
    durationMs = parseFloat(daysArg) * 24 * 60 * 60 * 1000;
    if(!(durationMs > 0)){
      console.error(`--days invalide ("${daysArg}")`);
      process.exit(1);
    }
  } else {
    durationMs = DURATION_MS[duration];
    if(!durationMs){
      console.error(`--duration invalide ("${duration}") — attendu : ${Object.keys(DURATION_MS).join(' | ')} (ou --days=N)`);
      process.exit(1);
    }
  }

  initAdmin();
  const db = admin.firestore();

  let userRecord;
  try{
    userRecord = await admin.auth().getUserByEmail(email);
  }catch(e){
    console.error(`Aucun compte Firebase Auth trouvé pour "${email}". Le client doit s'être connecté au moins une fois avec Google dans Mombongo avant de pouvoir recevoir un palier. Erreur : ${e.message}`);
    process.exit(1);
  }

  const uid = userRecord.uid;
  const expiresAt = Date.now() + durationMs;

  await db.collection('mombongo_users').doc(uid).set({
    userPlan: plan,
    userPlanStatus: 'active',
    userPlanExpiresAt: expiresAt,
    userPlanTrialEndsAt: null
  }, { merge: true });

  console.log('---------------------------------------------------------');
  console.log(`✅ Palier accordé avec succès.`);
  console.log(`Email        : ${email}`);
  console.log(`UID          : ${uid}`);
  console.log(`Palier       : ${plan}`);
  console.log(`Expire le    : ${new Date(expiresAt).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa' })} (heure de Kinshasa)`);
  console.log('---------------------------------------------------------');
  console.log('Le client verra son nouveau palier dès sa prochaine ouverture de');
  console.log('l\'app connectée (ou dans les ~60s s\'il a déjà l\'app ouverte,');
  console.log('via checkPlanExpiryLive()).');
}

run().catch(function(e){
  console.error('Erreur fatale :', e);
  process.exit(1);
});
