/**
 * alert-utils.js
 * -------------------------------------------------------------------------
 * Fonctions partagées entre send-new-alerts.js (nouvelles alertes,
 * quasi-instantané) et send-daily-recap.js (rappel quotidien à 6h).
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

const EXPIRY_WARNING_DAYS = 10;
const DEBT_DUE_WARNING_DAYS = 3;
// Même seuil que dormant côté app (voir render.js, renderAlertsSheet() : "pas vendu
// depuis 14 jours") — les deux DOIVENT rester synchronisés si ce seuil change un jour.
const DORMANT_DAYS_THRESHOLD = 14;

function daysSinceServer(ts){ return Math.floor((Date.now() - ts) / 86400000); }

function initAdmin(){
  if(admin.apps.length) return; // évite une double initialisation
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw){
    console.error('FIREBASE_SERVICE_ACCOUNT manquant. Ajoute ce secret dans les paramètres du dépôt GitHub.');
    process.exit(1);
  }
  let serviceAccount;
  try{
    serviceAccount = JSON.parse(raw);
  }catch(e){
    console.error('FIREBASE_SERVICE_ACCOUNT invalide (JSON illisible) :', e.message);
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function daysUntilExpiry(expiryDate){
  if(!expiryDate) return Infinity;
  const exp = new Date(expiryDate + 'T00:00:00');
  const now = new Date();
  now.setHours(0,0,0,0);
  return Math.floor((exp - now) / 86400000);
}

// Recalcule les alertes d'une boutique, exactement comme render() côté client.
// "debts" est maintenant passé séparément (et non plus lu depuis storeData.debts) :
// les dettes vivent dans leur propre collection Firestore depuis debts-sync.js —
// voir les appelants dans send-new-alerts.js / send-daily-recap.js, qui la récupèrent
// avec le SDK Admin (qui contourne les règles de sécurité, donc peut lire directement).
function computeStoreAlerts(storeData, debts){
  const products = (storeData && storeData.products) || [];
  debts = debts || [];
  const todayStr = new Date().toISOString().slice(0,10);

  const lowStock = products.filter(p => typeof p.qty === 'number' && typeof p.threshold === 'number' && p.qty <= p.threshold);
  const expired = products.filter(p => p.expiryDate && p.expiryDate < todayStr);
  const expiringSoon = products.filter(p => p.expiryDate && p.expiryDate >= todayStr && daysUntilExpiry(p.expiryDate) <= EXPIRY_WARNING_DAYS);
  // Stock dormant : invendu depuis DORMANT_DAYS_THRESHOLD jours — même règle que
  // dormant côté app (render.js) : jamais vendu ET jamais réapprovisionné n'entre
  // pas en compte séparément, "lastSoldAt || createdAt" couvre déjà les deux cas.
  const dormant = products.filter(p => {
    const ref = p.lastSoldAt || p.createdAt;
    return ref && daysSinceServer(ref) >= DORMANT_DAYS_THRESHOLD;
  });

  // Dettes ouvertes dont l'échéance approche (ou est dépassée) — à partir de
  // DEBT_DUE_WARNING_DAYS jours avant, sans limite une fois l'échéance passée
  // (on continue de rappeler tant que la dette n'est pas réglée).
  const dueSoonDebts = debts.filter(d =>
    d.status === 'ouvert' && d.dueDate && (d.totalOwed - d.amountPaid) > 0.001 &&
    daysUntilExpiry(d.dueDate) <= DEBT_DUE_WARNING_DAYS
  );

  const alertKeys = new Set();
  lowStock.forEach(p => alertKeys.add(`low:${p.id}`));
  // La clé inclut le nombre de jours restants (ou de jours de retard, une fois périmé) :
  // comme ce nombre change chaque jour, l'alerte est vue comme "nouvelle" chaque jour par
  // send-new-alerts.js, au lieu de ne notifier qu'une seule fois.
  expired.forEach(p => alertKeys.add(`exp:${p.id}:${daysUntilExpiry(p.expiryDate)}`));
  expiringSoon.forEach(p => alertKeys.add(`soon:${p.id}:${daysUntilExpiry(p.expiryDate)}`));
  dueSoonDebts.forEach(d => alertKeys.add(`due:${d.id}:${daysUntilExpiry(d.dueDate)}`));
  // Bucket PAR SEMAINE (pas par jour comme les alertes ci-dessus) : un produit peut
  // rester dormant des mois — renotifier chaque jour serait vite envahissant. Ici,
  // l'alerte est vue comme "nouvelle" une fois par semaine de dormance continue.
  dormant.forEach(p => {
    const ref = p.lastSoldAt || p.createdAt;
    alertKeys.add(`dormant:${p.id}:${Math.floor(daysSinceServer(ref)/7)}`);
  });

  return { alertKeys, lowStock, expired, expiringSoon, dueSoonDebts, dormant };
}

const UNIT_LABELS_FR = { pc:'pièce(s)', kg:'kg', g:'g', l:'L', ml:'ml', m:'m', cm:'cm' };
function formatQtyFr(qty, unit){
  const label = UNIT_LABELS_FR[unit] || UNIT_LABELS_FR.pc;
  const n = (!unit || unit === 'pc') ? Math.round(qty) : (Math.round(qty * 100) / 100);
  return `${n} ${label}`;
}

// Détaille chaque alerte au lieu de se contenter d'un décompte ("3 produits en stock
// faible") : le patron doit savoir QUEL produit, QUELLE quantité, QUEL client, direct
// depuis la notification elle-même, sans devoir rouvrir l'app pour le découvrir.
// Limité à MAX_MESSAGE_LINES lignes pour rester lisible dans une notification — le
// reste (utile surtout pour le rappel quotidien, qui peut lister beaucoup d'alertes
// à la fois) est résumé en une dernière ligne "... et N autres".
const MAX_MESSAGE_LINES = 6;

function buildMessage(storeName, lowStock, expired, expiringSoon, dueSoonDebts, dormant, prefix){
  dueSoonDebts = dueSoonDebts || [];
  dormant = dormant || [];
  const lines = [];

  lowStock.forEach(p=>{
    lines.push(`📉 ${p.name} : stock faible (${formatQtyFr(p.qty, p.unit)} en stock)`);
  });
  expired.forEach(p=>{
    const lateDays = Math.abs(daysUntilExpiry(p.expiryDate));
    lines.push(lateDays <= 0
      ? `⛔ ${p.name} : périmé aujourd'hui`
      : `⛔ ${p.name} : périmé depuis ${lateDays} jour${lateDays>1?'s':''}`);
  });
  expiringSoon.forEach(p=>{
    const days = daysUntilExpiry(p.expiryDate);
    lines.push(days <= 0
      ? `⏳ ${p.name} : expire aujourd'hui`
      : `⏳ ${p.name} : expire dans ${days} jour${days>1?'s':''}`);
  });
  dueSoonDebts.forEach(d=>{
    const days = daysUntilExpiry(d.dueDate);
    lines.push(days < 0
      ? `💳 ${d.clientName} : dette en retard de ${Math.abs(days)} jour${Math.abs(days)>1?'s':''}`
      : days === 0
        ? `💳 ${d.clientName} : dette à échéance aujourd'hui`
        : `💳 ${d.clientName} : dette à échéance dans ${days} jour${days>1?'s':''}`);
  });
  // Même famille d'alerte que "stock faible" côté app (même onglet), mais le nombre
  // de jours réel remplace le texte fixe "14 jours" affiché en app — plus utile dans
  // une notification qu'on ne peut pas cliquer pour vérifier.
  dormant.forEach(p=>{
    const ref = p.lastSoldAt || p.createdAt;
    const days = ref ? daysSinceServer(ref) : DORMANT_DAYS_THRESHOLD;
    lines.push(`😴 ${p.name} : pas vendu depuis ${days} jour${days>1?'s':''}`);
  });

  let body;
  if(lines.length <= MAX_MESSAGE_LINES){
    body = lines.join('\n');
  } else {
    const shown = lines.slice(0, MAX_MESSAGE_LINES);
    const rest = lines.length - MAX_MESSAGE_LINES;
    body = shown.join('\n') + `\n… et ${rest} autre${rest>1?'s':''}`;
  }

  const title = `${prefix} ${storeName || 'Ta boutique'}`;
  return { title, body };
}

async function getTokensForUser(db, ownerUid){
  const tokensSnap = await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').get();
  return tokensSnap.docs.map(d => ({ id: d.id, token: d.data().token })).filter(t => t.token);
}

// Envoie la notification à tous les tokens d'un compte et nettoie les tokens invalides.
//
// Message "data-only" (pas de champ "notification" au niveau racine) : c'est volontaire.
// Quand un message contient à la fois "notification" ET "data", le téléphone affiche
// automatiquement une notification à partir du champ "notification" — en plus de celle
// que service-worker.js affiche lui-même via showNotification(). Résultat sur certains
// téléphones/versions : soit une notification en double, soit un comportement
// imprévisible selon le navigateur. En envoyant uniquement "data", c'est TOUJOURS notre
// propre code (dans service-worker.js et index.html) qui décide de l'affichage, une
// seule fois, de façon fiable partout.
async function sendAndCleanup(db, ownerUid, storeName, storeId, tokens, title, body){
  const message = {
    data: {
      title,
      body,
      storeId: String(storeId),
      tag: `mombongo-${storeId}`
    },
    tokens: tokens.map(t => t.token)
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Boutique "${storeName}" (${ownerUid}) : ${response.successCount}/${tokens.length} notifications envoyées.`);

  const invalidTokenDocIds = [];
  response.responses.forEach((r, i) => {
    if(!r.success){
      const code = r.error && r.error.code;
      if(code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'){
        invalidTokenDocIds.push(tokens[i].id);
      }
    }
  });
  for(const docId of invalidTokenDocIds){
    await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').doc(docId).delete();
  }

  return response.successCount;
}

module.exports = { initAdmin, computeStoreAlerts, buildMessage, getTokensForUser, sendAndCleanup };
