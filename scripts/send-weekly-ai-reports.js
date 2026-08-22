/**
 * send-weekly-ai-reports.js
 * -------------------------------------------------------------------------
 * Tourne UNE FOIS PAR SEMAINE, le dimanche soir (voir weekly-ai-reports.yml)
 * — jamais côté client, jamais dans le code livré au téléphone du
 * commerçant : la clé Gemini (GEMINI_API_KEY) vit UNIQUEMENT en secret
 * GitHub, exactement comme FIREBASE_SERVICE_ACCOUNT pour les autres scripts
 * de ce dossier. Une clé IA collée dans un fichier JS/HTML servi au
 * navigateur serait extractible par n'importe qui en un clic droit
 * "Afficher le code source" — voir la discussion qui a mené à ce fichier.
 *
 * Réservé au palier PRO uniquement (jamais Business, jamais Simple — voir
 * getEffectivePlanServer, qui reproduit getEffectivePlan() de plans.js
 * côté serveur, comme send-daily-sales-recap.js le fait déjà).
 *
 * Principe central : L'IA NE CALCULE JAMAIS AUCUN CHIFFRE. Tous les
 * indicateurs (ventes, bénéfice, meilleures ventes, produits qui dorment,
 * dettes) sont calculés ICI en JS pur, à partir des données réelles
 * (/sales, /products, /debts) — l'IA reçoit ces chiffres déjà exacts et se
 * contente de les mettre en mots, sous forme de conseils SUGGÉRÉS (jamais
 * d'ordre catégorique "fais X" — voir buildGeminiPrompt). Si l'appel à
 * Gemini échoue pour une raison quelconque (quota, réseau, clé expirée...),
 * le rapport est quand même enregistré et notifié, seulement SANS la partie
 * conseils textuels — les graphiques et chiffres, eux, ne dépendent jamais
 * de l'IA et restent donc toujours fiables.
 *
 * Stocké dans /mombongo_users/{ownerUid}/aiReports/{weekId} — jamais
 * écrasé une fois créé (weekId = lundi de la semaine couverte, format
 * YYYY-MM-DD), donc l'historique complet reste consultable dans l'écran
 * "Rapports IA/semaine" (ai-reports.js côté app) à tout moment, pas
 * seulement la semaine en cours.
 *
 * Variables d'environnement attendues : FIREBASE_SERVICE_ACCOUNT, GEMINI_API_KEY
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');
const { initAdmin, getTokensForUser, sendAndCleanup } = require('./alert-utils');

const DEAD_STOCK_DAYS = 14; // aucune vente depuis N jours ET qty > 0 → "produit qui dort"
const DEFAULT_EXCHANGE_RATE = 2300; // même valeur par défaut que exchangeRate dans config.js (client)

// Reproduit EXACTEMENT getEffectivePlan() de plans.js côté app (voir aussi
// send-daily-sales-recap.js, qui a la même fonction) — Pro UNIQUEMENT ici, contrairement
// au récap quotidien qui inclut Business.
function getEffectivePlanServer(data){
  const userPlan = data.userPlan || 'simple';
  const userPlanStatus = data.userPlanStatus || 'free';
  const userPlanExpiresAt = data.userPlanExpiresAt || null;
  const now = Date.now();
  if(userPlan === 'pro'){
    const planExpired = userPlanStatus === 'active' && userPlanExpiresAt && now > userPlanExpiresAt;
    if(userPlanStatus === 'expired' || planExpired) return 'simple';
    return 'pro';
  }
  return userPlan === 'business' ? 'business' : 'simple';
}

// Semaine "glissante" des 7 derniers jours pleins (hier inclus), en heure de
// Kinshasa (UTC+1, pas de changement d'heure — même fuseau que les autres scripts de
// ce dossier). weekId = lundi de cette fenêtre, sert d'identifiant unique du rapport.
function weekRangeKinshasa(){
  const now = new Date();
  const kinNow = new Date(now.getTime() + 60*60*1000);
  const kinTodayMidnight = Date.UTC(kinNow.getUTCFullYear(), kinNow.getUTCMonth(), kinNow.getUTCDate(), 0, 0, 0);
  const end = kinTodayMidnight - 60*60*1000; // minuit Kinshasa de ce soir, en vrai timestamp UTC
  const start = end - 7*24*60*60*1000;
  const weekId = new Date(start).toISOString().slice(0,10);
  return { start, end, weekId };
}

async function fetchStoreProducts(db, ownerUid, storeId){
  const snap = await db.collection('mombongo_users').doc(ownerUid).collection('products')
    .where('storeId', '==', storeId).get();
  return snap.docs.map(d => d.data());
}

async function fetchStoreSalesInRange(db, ownerUid, storeId, start, end){
  // Même limite connue que send-daily-sales-recap.js : relit toute la collection
  // /sales de la boutique puis filtre la plage en mémoire, faute d'index composite
  // (storeId + date) déjà en place — voir ce fichier pour le détail du compromis.
  const snap = await db.collection('mombongo_users').doc(ownerUid).collection('sales')
    .where('storeId', '==', storeId).get();
  const sales = [];
  snap.forEach(doc=>{
    const s = doc.data();
    if(typeof s.date === 'number' && s.date >= start && s.date < end) sales.push(s);
  });
  return sales;
}

async function fetchOpenDebts(db, ownerUid, storeId){
  const snap = await db.collection('mombongo_users').doc(ownerUid).collection('debts')
    .where('storeId', '==', storeId).get();
  const debts = [];
  snap.forEach(doc=>{
    const d = doc.data();
    if(d.status === 'ouvert' && (d.totalOwed - (d.amountPaid || 0)) > 0.001) debts.push(d);
  });
  return debts;
}

// Un point de chiffre d'affaires par jour de la semaine (pour le graphique de
// tendance côté app, voir ai-reports.js) — toujours 7 points, même à 0, pour que la
// courbe garde la même largeur d'une semaine à l'autre.
function buildDailySeries(sales, start){
  const days = [0,0,0,0,0,0,0];
  const profitDays = [0,0,0,0,0,0,0];
  sales.forEach(s=>{
    const dayIndex = Math.floor((s.date - start) / (24*60*60*1000));
    if(dayIndex >= 0 && dayIndex < 7){
      days[dayIndex] += s.total || 0;
      profitDays[dayIndex] += s.profit || 0;
    }
  });
  return { revenueByDay: days, profitByDay: profitDays };
}

function computeStoreMetrics(store, products, sales, debts){
  let revenue = 0, profit = 0;
  const perProduct = {}; // productName -> { qty, revenue, profit }
  sales.forEach(s=>{
    revenue += s.total || 0;
    profit += s.profit || 0;
    const key = s.productName || '(sans nom)';
    if(!perProduct[key]) perProduct[key] = { name: key, qty: 0, revenue: 0, profit: 0 };
    perProduct[key].qty += s.qty || 0;
    perProduct[key].revenue += s.total || 0;
    perProduct[key].profit += s.profit || 0;
  });
  const bestSellers = Object.values(perProduct).sort((a,b)=>b.revenue - a.revenue).slice(0, 5);

  const now = Date.now();
  const deadStock = products.filter(p=>{
    if(!(typeof p.qty === 'number' && p.qty > 0)) return false;
    const lastSold = p.lastSoldAt || p.createdAt || 0;
    return (now - lastSold) >= DEAD_STOCK_DAYS*24*60*60*1000;
  }).map(p=>({ name: p.name, qty: p.qty })).slice(0, 8);

  const lowStock = products.filter(p=>
    typeof p.qty === 'number' && typeof p.threshold === 'number' && p.qty <= p.threshold
  ).length;

  const debtsOwed = debts.reduce((sum,d)=>sum + (d.totalOwed - (d.amountPaid || 0)), 0);

  const { revenueByDay, profitByDay } = buildDailySeries(sales, weekRangeKinshasa().start);

  return {
    storeId: store.id, storeName: store.name,
    revenue, profit, bestSellers, deadStock, lowStockCount: lowStock,
    openDebtsCount: debts.length, openDebtsAmount: debtsOwed,
    revenueByDay, profitByDay
  };
}

// Le prompt insiste explicitement sur le ton "conseil suggéré" — voir la contrainte
// posée dès la discussion d'origine : jamais "fais X, fais Y" à l'impératif, toujours
// une suggestion ("tu pourrais...", "pense à..."). Répond en JSON strict pour rester
// facile à afficher côté app sans avoir à parser du texte libre.
//
// IMPORTANT sur les montants : /sales.total et .profit sont stockés dans l'unité
// INTERNE du compte, qui est TOUJOURS l'équivalent USD (voir toInternal() dans
// products.js côté app — un montant saisi en FC est divisé par le taux avant
// enregistrement). Le prompt ci-dessous doit donc reconvertir en FC avec le taux du
// compte (rate) avant de les citer à l'IA, sous peine de lui faire écrire des chiffres
// ~2300x trop petits dans son résumé — même bug que celui repéré dans
// send-daily-sales-recap.js (voir la note à ce sujet). Le DOCUMENT enregistré dans
// Firestore, lui, garde les valeurs brutes non converties (voir computeStoreMetrics) :
// c'est le client qui les affichera via formatMoney(), avec le taux à jour au moment de
// la consultation plutôt qu'un taux figé au moment de la génération du rapport.
function buildGeminiPrompt(accountLabel, storesMetrics, rate){
  const fc = (usdAmount)=>Math.round(usdAmount * rate).toLocaleString('fr-FR') + ' FC';
  const storesText = storesMetrics.map(s=>{
    const bestSellersText = s.bestSellers.length
      ? s.bestSellers.map(b=>`${b.name} (${fc(b.revenue)} de ventes)`).join(', ')
      : 'aucune vente cette semaine';
    const deadStockText = s.deadStock.length
      ? s.deadStock.map(d=>d.name).join(', ')
      : 'aucun';
    return [
      `Boutique "${s.storeName}" :`,
      `- Chiffre d'affaires 7 derniers jours : ${fc(s.revenue)}`,
      `- Bénéfice 7 derniers jours : ${fc(s.profit)}`,
      `- Meilleures ventes : ${bestSellersText}`,
      `- Produits qui n'ont pas bougé depuis ${DEAD_STOCK_DAYS}+ jours : ${deadStockText}`,
      `- Produits en stock bas (sous le seuil) : ${s.lowStockCount}`,
      `- Dettes clients ouvertes : ${s.openDebtsCount} (total ${fc(s.openDebtsAmount)})`
    ].join('\n');
  }).join('\n\n');

  return `Tu es un assistant qui aide un petit commerçant en République Démocratique du Congo (compte "${accountLabel}") à comprendre sa semaine de ventes sur l'application Mombongo.

Voici les chiffres RÉELS et déjà calculés de sa semaine (ne les recalcule pas, ne les invente pas, utilise-les tels quels) :

${storesText}

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, de cette forme exacte :
{"summary": "un court paragraphe (2-3 phrases) qui résume la semaine simplement, sans jargon", "tips": ["conseil 1", "conseil 2", "conseil 3"]}

Règles impératives :
- Langage simple, direct, chaleureux, en français courant (pas de jargon financier/marketing).
- 3 à 5 conseils maximum dans "tips", chacun une phrase courte.
- TOUJOURS formuler les conseils comme des SUGGESTIONS, jamais des ordres. Utilise "tu pourrais", "pense à", "envisage de" — JAMAIS l'impératif direct comme "fais", "baisse", "commande". Par exemple écris "tu pourrais envisager une petite promotion sur..." et jamais "fais une promotion sur...".
- Ne mentionne aucun chiffre que tu n'as pas reçu ci-dessus. N'invente rien.
- Si aucune vente cette semaine, dis-le simplement et propose une piste generale, sans dramatiser.`;
}

async function callGemini(apiKey, prompt){
  // Modèle gratuit au moment de l'écriture de ce fichier — vérifie sur
  // https://ai.google.dev/gemini-api/docs/models si ce nom a changé côté Google avant
  // de dépanner un échec qui ne serait pas lié au code lui-même.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
    })
  });
  if(!res.ok){
    const errText = await res.text().catch(()=> '');
    throw new Error(`Gemini HTTP ${res.status} : ${errText.slice(0,300)}`);
  }
  const json = await res.json();
  const text = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;
  if(!text) throw new Error('Réponse Gemini vide/inattendue : ' + JSON.stringify(json).slice(0,300));
  const parsed = JSON.parse(text); // laissé remonter tel quel si le JSON est malformé
  if(!parsed.summary || !Array.isArray(parsed.tips)) throw new Error('JSON Gemini incomplet : ' + text.slice(0,300));
  return { summary: String(parsed.summary), tips: parsed.tips.map(String).slice(0, 5) };
}

async function run(){
  initAdmin();
  const db = admin.firestore();
  const apiKey = process.env.GEMINI_API_KEY;
  if(!apiKey){
    console.error('GEMINI_API_KEY manquant. Ajoute ce secret dans les paramètres du dépôt GitHub.');
    process.exit(1);
  }

  const { start, end, weekId } = weekRangeKinshasa();
  console.log(`Rapports IA hebdomadaires pour la semaine du ${weekId} (${new Date(start).toISOString()} → ${new Date(end).toISOString()})`);

  const usersSnap = await db.collection('mombongo_users').get();
  console.log(`Comptes à vérifier : ${usersSnap.size}`);

  let reportsGenerated = 0, notificationsSent = 0, aiFailures = 0;

  for(const userDoc of usersSnap.docs){
    const ownerUid = userDoc.id;
    const data = userDoc.data();
    const stores = data.stores || [];
    if(stores.length === 0) continue;

    // Réservé Pro uniquement — voir en-tête de fichier.
    if(getEffectivePlanServer(data) !== 'pro') continue;

    // Un rapport déjà généré cette semaine pour ce compte ? On ne le regénère pas
    // (évite un doublon si le workflow est relancé manuellement/retente après échec).
    const existing = await db.collection('mombongo_users').doc(ownerUid)
      .collection('aiReports').doc(weekId).get();
    if(existing.exists){
      console.log(`Compte ${ownerUid} : rapport ${weekId} déjà généré, ignoré.`);
      continue;
    }

    try{
      const storesMetrics = [];
      for(const store of stores){
        const [products, sales, debts] = await Promise.all([
          fetchStoreProducts(db, ownerUid, store.id),
          fetchStoreSalesInRange(db, ownerUid, store.id, start, end),
          fetchOpenDebts(db, ownerUid, store.id)
        ]);
        storesMetrics.push(computeStoreMetrics(store, products, sales, debts));
      }

      const totalRevenue = storesMetrics.reduce((s,m)=>s + m.revenue, 0);
      const totalProfit = storesMetrics.reduce((s,m)=>s + m.profit, 0);
      const accountLabel = stores.length === 1 ? stores[0].name : (data.displayName || 'Mombongo');
      const rate = (data.rate && parseFloat(data.rate) > 0) ? parseFloat(data.rate) : DEFAULT_EXCHANGE_RATE;

      let advice = null;
      try{
        advice = await callGemini(apiKey, buildGeminiPrompt(accountLabel, storesMetrics, rate));
      }catch(e){
        // Voir la note en tête de fichier : un échec IA n'empêche jamais l'enregistrement
        // des chiffres/graphiques, seulement la partie conseils textuels.
        aiFailures++;
        console.error(`Gemini indisponible pour ${ownerUid} (rapport enregistré sans conseils) :`, e.message);
      }

      const reportDoc = {
        weekId, weekStart: start, weekEnd: end, generatedAt: Date.now(),
        totalRevenue, totalProfit,
        stores: storesMetrics,
        advice: advice ? advice.summary : null,
        tips: advice ? advice.tips : []
      };
      await db.collection('mombongo_users').doc(ownerUid).collection('aiReports').doc(weekId).set(reportDoc);
      reportsGenerated++;

      const tokens = await getTokensForUser(db, ownerUid);
      if(tokens.length > 0){
        const title = '📊 Ton rapport de la semaine est prêt';
        const body = 'Tes ventes, tes bénéfices et des conseils pour la semaine prochaine — Mombongo.';
        notificationsSent += await sendAndCleanup(db, ownerUid, accountLabel, 'weekly-ai-report', tokens, title, body);
      }
    }catch(e){
      console.error(`Erreur génération du rapport IA pour ${ownerUid} :`, e.message);
    }
  }

  console.log(`Terminé. ${reportsGenerated} rapport(s) généré(s), ${notificationsSent} notification(s) envoyée(s), ${aiFailures} échec(s) Gemini (chiffres quand même enregistrés).`);
}

run().catch(e => {
  console.error('Erreur fatale :', e);
  process.exit(1);
});
