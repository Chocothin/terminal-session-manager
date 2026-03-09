import '@xterm/xterm/css/xterm.css';
import './styles/main.css';
import { App } from './app.js';

const appContainer = document.getElementById('app');
if (!appContainer) {
  throw new Error('App container not found');
}

try {
  new App(appContainer);
} catch (err) {
  // Show visible error on mobile instead of blank screen
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'color:#f55;background:#111;padding:24px;font-family:monospace;white-space:pre-wrap;word-break:break-all;position:fixed;inset:0;overflow:auto;z-index:99999;font-size:14px;';
  errDiv.textContent = `[TSM Boot Error]\n${err instanceof Error ? err.stack || err.message : String(err)}`;
  document.body.appendChild(errDiv);
}

// Unregister any stale service workers — vite-plugin-pwa handles SW via registerSW.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      // Keep the vite-plugin-pwa worker (/sw.js), nuke everything else
      if (reg.active?.scriptURL && !reg.active.scriptURL.endsWith('/sw.js')) {
        reg.unregister().then(() => console.log('Unregistered stale SW:', reg.active?.scriptURL));
      }
    }
  });
}
