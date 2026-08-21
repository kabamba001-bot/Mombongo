/**
 * send-daily-sales-recap.js
 * -------------------------------------------------------------------------
 * Tourne UNE FOIS PAR JOUR à 6h (même planning que send-daily-recap.js, voir
 * .github/workflows/daily-recap.yml — un second step dans le MÊME workflow,
 * pas un nouveau cron) et envoie un récap des VENTES et BÉNÉFICES de la
 * veille — distinct du rappel d'alertes stock/dettes (send-daily-recap.js) :
 * ici on parle chiffre d'affaires, pas stock à surveiller.
 *
 * Réservé aux paliers BUSINESS et PRO (jamais Simple, gratuit ou payant —
 * voir getEffectivePlanServer ci-dessous, qui reproduit CÔTÉ SERVEUR
 * exactement la même logique que getEffectivePlan() dans plans.js côté app.
 * Les deux DOIVENT rester synchronisés si cette logique change un jour).
 *
 * Pro reçoit EN PLUS le détail boutique par boutique (voir buildRecapMessage)
 * — l'"amplification par boutique" demandée pour ce palier.
 *
 * ⚠️ LIMITE CONNUE : comme le reste des scripts de ce dossier (et comme
 * consolidated.js côté app), la somme des ventes d'hier relit la collection
 * /sales ENTIÈRE de chaque boutique puis filtre par date côté code, faute
 * d'un index composite (storeId + date) déjà en place côté Firestore. Pour un
 * compte avec un très gros historique, ça reste correct mais de moins en
 * moins efficace avec le temps. Si ça devient sensible, ajouter un index
 * composite sur /sales (storeId ASC, date ASC) permettrait de filtrer
 * directement via .where('date','>=',start).where('date','<=',end) côté
 * Firestore plutôt que de tout relire.
 *
 * Variable d'environnement attendue : FIREBASE_SERVICE_ACCOUNT
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');
const { initAdmin, getTokensForUser, sendAndCleanup } = require('./alert-utils');

// Reproduit EXACTEMENT getEffectivePlan() de plans.js côté app — voir ce
// fichier si la logique de palier change un jour, les deux doivent rester
// synchronisés (même traitement du trial Business, même relégation Simple
// si expiré).
function getEffectivePlanServer(data){
  const userPlan = data.userPlan || 'simple';
  const userPlanStatus = data.userPlanStatus || 'free';
  const userPlanTrialEndsAt = data.userPlanTrialEndsAt || null;
  const userPlanExpiresAt = data.userPlanExpiresAt || null;
  const now = Date.now();
  if(userPlan === 'business'){
    const trialExpired = userPlanStatus === 'trial' && userPlanTrialEndsAt && now > userPlanTrialEndsAt;
    const planExpired = userPlanStatus === 'active' && userPlanExpiresAt && now > userPlanExpiresAt;
    if(userPlanStatus === 'expired' || trialExpired || planExpired) return 'simple';
    return 'business'; // trial en cours (non expiré) OU payé — les deux comptent
  }
  if(userPlan === 'pro'){
    const planExpired = userPlanStatus === 'active' && userPlanExpiresAt && now > userPlanExpiresAt;
    if(userPlanStatus === 'expired' || planExpired) return 'simple';
    return 'pro';
  }
  return 'simple';
}

// "Hier" au sens d'Africa/Kinshasa (UTC+1, pas de changement d'heure) — même
// fuseau que le commentaire du planning dans daily-recap.yml.
function yesterdayRangeKinshasa(){
  const now = new Date();
  const kinNow = new Date(now.getTime() + 60*60*1000);
  const kinYesterdayMidnight = Date.UTC(kinNow.getUTCFullYear(), kinNow.getUTCMonth(), kinNow.getUTCDate() - 1, 0, 0, 0);
  const start = kinYesterdayMidnight - 60*60*1000; // reconverti en vrai timestamp UTC
  const end = start + 24*60*60*1000 - 1;
  const label = new Date(kinYesterdayMidnight).toISOString().slice(0,10);
  return { start, end, label };
}

// Le récap parle toujours en FC (voir l'exemple donné : "ventes : 36 000fc"),
// indépendamment de la devise d'affichage choisie côté app — les montants
// stockés dans /sales et storesData[].stats sont déjà dans l'unité "interne"
// du compte (jamais convertis avant l'enregistrement, voir toInternal côté app).
function formatMoneyFc(n){
  return Math.round(n).toLocaleString('fr-FR').replace(/\u202f/g, ' ') + ' FC';
}

async function sumSalesForStore(db, ownerUid, storeId, start, end){
  const snap = await db.collection('mombongo_users').doc(ownerUid).collection('sales')
    .where('storeId', '==', storeId).get();
  let revenue = 0, profit = 0;
  snap.forEach(doc=>{
    const d = doc.data();
    if(!d.date || d.date < start || d.date > end) return;
    revenue += (d.total || 0);
    profit += (d.profit || 0);
  });
  return { revenue, profit };
}

function buildRecapMessage(storeName, yesterday, totalProfit, perStore, includePerStore){
  const lines = [];
  lines.push(`💰 Ventes hier : ${formatMoneyFc(yesterday.revenue)}`);
  lines.push(`📈 Bénéfice hier : ${formatMoneyFc(yesterday.profit)}`);
  lines.push(`🏆 Bénéfice total : ${formatMoneyFc(totalProfit)}`);

  // "Amplification par boutique", réservée Pro : n'a de sens que si le compte a
  // effectivement plus d'une boutique (Business est de toute façon limité à une
  // seule, voir plans.js — multiStore est une fonctionnalité Pro uniquement).
  if(includePerStore && perStore.length > 1){
    lines.push('');
    perStore.forEach(s=>{
      lines.push(`• ${s.name} : ${formatMoneyFc(s.revenue)} (bénéfice ${formatMoneyFc(s.profit)})`);
    });
  }

  return { title: `☀️ Récap d'hier — ${storeName || 'Mombongo'}`, body: lines.join('\n') };
}

async function run(){
  initAdmin();
  const db = admin.firestore();
  const { start, end, label } = yesterdayRangeKinshasa();
  console.log(`Récap ventes pour la journée du ${label} (${new Date(start).toISOString()} → ${new Date(end).toISOString()})`);

  const usersSnap = await db.collection('mombongo_users').get();
  console.log(`Comptes à vérifier : ${usersSnap.size}`);

  let notificationsSent = 0;

  for(const userDoc of usersSnap.docs){
    const ownerUid = userDoc.id;
    const data = userDoc.data();
    const stores = data.stores || [];
    const storesData = data.storesData || {};
    if(stores.length === 0) continue;

    // Réservé Business et Pro — voir commentaire en tête de fichier.
    const planTier = getEffectivePlanServer(data);
    if(planTier !== 'business' && planTier !== 'pro') continue;

    const tokens = await getTokensForUser(db, ownerUid);
    if(tokens.length === 0) continue;

    const perStore = [];
    let globalRevenue = 0, globalProfit = 0, globalTotalProfit = 0;

    for(const store of stores){
      const storeId = store.id;
      const storeData = storesData[storeId];
      // Le bénéfice TOTAL (toutes périodes confondues) est déjà tenu à jour côté app
      // dans stats.totalProfit (storesData[storeId].stats, mis à jour à chaque vente
      // — voir data-catalog.js) : pas besoin de reparcourir tout l'historique des
      // ventes pour l'obtenir, contrairement au chiffre d'hier.
      const totalProfit = (storeData && storeData.stats && storeData.stats.totalProfit) || 0;
      globalTotalProfit += totalProfit;

      const { revenue, profit } = await sumSalesForStore(db, ownerUid, storeId, start, end);
      globalRevenue += revenue;
      globalProfit += profit;
      perStore.push({ name: store.name, revenue, profit });
    }

    // Rien à raconter (aucune vente hier, compte tout neuf, boutique en pause...) :
    // pas la peine d'envoyer un récap à zéro chaque matin.
    if(globalRevenue === 0 && globalProfit === 0) continue;

    const accountLabel = stores.length === 1 ? stores[0].name : (data.displayName || 'Mombongo');
    const { title, body } = buildRecapMessage(
      accountLabel,
      { revenue: globalRevenue, profit: globalProfit },
      globalTotalProfit,
      perStore,
      planTier === 'pro'
    );

    try{
      // Tag dédié ('daily-sales-recap', pas un storeId) : ce récap parle du compte
      // entier, pas d'une boutique en particulier — ne doit jamais entrer en
      // collision avec les notifications d'alerte, elles scopées par boutique.
      notificationsSent += await sendAndCleanup(db, ownerUid, accountLabel, 'daily-sales-recap', tokens, title, body);
    }catch(e){
      console.error(`Erreur envoi récap ventes pour ${ownerUid} :`, e.message);
    }
  }

  console.log(`Terminé. ${notificationsSent} récap(s) de ventes envoyé(s) au total.`);
}

run().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
