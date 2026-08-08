/* =========================================================================
   DÉTECTION NAVIGATEUR INTÉGRÉ (Facebook / Instagram / Messenger)
   ---------------------------------------------------------------------------
   Pourquoi ce fichier existe : quand quelqu'un clique sur un lien depuis
   l'app Facebook ou Instagram, le site s'ouvre dans LEUR navigateur intégré
   (WebView), pas dans Chrome. Google bloque volontairement la connexion
   Google (OAuth) dans ces navigateurs intégrés pour des raisons de sécurité
   — l'utilisateur ne peut PAS se connecter, quoi qu'il fasse, tant qu'il
   reste dans cette WebView. Ce script détecte la situation et propose une
   sortie claire.
   À inclure tôt dans <head>, juste après le Meta Pixel — il n'a besoin de
   rien d'autre que window/document.
   ========================================================================= */
(function(){
  function isInAppBrowser(){
    const ua = navigator.userAgent || '';
    // FBAN/FBAV/FB_IAB/FBIOS = app Facebook (Android/iOS) ; Instagram = app Instagram ;
    // Messenger a aussi son propre WebView.
    return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger/i.test(ua);
  }
  function isAndroid(){
    return /Android/i.test(navigator.userAgent || '');
  }
  function isIOS(){
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  const DISMISS_KEY = 'mombongo:webviewBannerDismissedAt';
  const SNOOZE_MS = 24*60*60*1000; // on ne réaffiche pas plus d'une fois par jour si l'utilisateur ferme le bandeau

  function wasDismissedRecently(){
    const dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY)) || 0;
    return (Date.now() - dismissedAt) < SNOOZE_MS;
  }

  function openInChromeAndroid(){
    // Construit un lien "intent://" qui force Android à ouvrir Chrome avec l'URL actuelle,
    // en sortant complètement de la WebView de Facebook/Instagram.
    const strippedUrl = location.href.replace(/^https?:\/\//, '');
    const intentUrl = 'intent://' + strippedUrl + '#Intent;scheme=https;package=com.android.chrome;end';
    window.location.href = intentUrl;
  }

  function copyLink(btn){
    navigator.clipboard.writeText(location.href).then(()=>{
      const original = btn.textContent;
      btn.textContent = '✓ Lien copié';
      setTimeout(()=>{ btn.textContent = original; }, 2000);
    }).catch(()=>{});
  }

  function buildBanner(){
    const isFr = (navigator.language || 'fr').toLowerCase().startsWith('fr') || true; // le site est FR par défaut
    const style = document.createElement('style');
    style.textContent = `
      #webview-guard-banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;
        background:#1a1a2e;color:#fff;padding:14px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.3);
        font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.4;}
      #webview-guard-banner .wg-title{font-weight:700;margin-bottom:4px;font-size:15px;}
      #webview-guard-banner .wg-text{opacity:.85;margin-bottom:10px;}
      #webview-guard-banner .wg-actions{display:flex;gap:8px;flex-wrap:wrap;}
      #webview-guard-banner button{border:none;border-radius:8px;padding:10px 14px;
        font-size:14px;font-weight:600;cursor:pointer;}
      #webview-guard-banner .wg-primary{background:#146356;color:#fff;flex:1;min-width:140px;}
      #webview-guard-banner .wg-secondary{background:rgba(255,255,255,.12);color:#fff;}
      #webview-guard-banner .wg-close{position:absolute;top:8px;right:10px;background:transparent;
        color:#fff;font-size:18px;opacity:.6;padding:4px 8px;}
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = 'webview-guard-banner';

    const androidBtn = isAndroid()
      ? `<button class="wg-primary" id="wg-open-chrome">🌐 Ouvrir dans Chrome</button>`
      : '';
    const iosHint = isIOS()
      ? `<div class="wg-text">Sur iPhone : touche <strong>•••</strong> (ou l'icône de partage) en haut à droite, puis <strong>« Ouvrir dans Safari »</strong>.</div>`
      : '';

    banner.innerHTML = `
      <button class="wg-close" id="wg-close-btn" aria-label="Fermer">×</button>
      <div class="wg-title">⚠️ La connexion Google ne marche pas ici</div>
      <div class="wg-text">Tu es dans le navigateur intégré de Facebook/Instagram. Pour te connecter et sauvegarder tes données, ouvre ce lien dans Chrome ou ton navigateur habituel.</div>
      ${iosHint}
      <div class="wg-actions">
        ${androidBtn}
        <button class="wg-secondary" id="wg-copy-btn">📋 Copier le lien</button>
      </div>
    `;
    document.body.appendChild(banner);

    if(isAndroid()){
      document.getElementById('wg-open-chrome').addEventListener('click', openInChromeAndroid);
    }
    document.getElementById('wg-copy-btn').addEventListener('click', function(){ copyLink(this); });
    document.getElementById('wg-close-btn').addEventListener('click', function(){
      localStorage.setItem(DISMISS_KEY, Date.now().toString());
      banner.remove();
    });
  }

  function init(){
    if(!isInAppBrowser()) return;
    if(wasDismissedRecently()) return;
    buildBanner();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
