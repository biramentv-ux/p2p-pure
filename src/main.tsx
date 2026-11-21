import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-serif/400.css'
import '@fontsource/ibm-plex-serif/400-italic.css'
import '@fontsource/ibm-plex-serif/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'
import App from './App.tsx'
import './post.css'
import './loud.css'
import { I18nProvider } from './i18n'

// Optional "loud" look: ?look=loud (remembered in localStorage "p2p-look"); any other value turns it off.
try {
  const look = new URLSearchParams(location.search).get('look')
  if (look) localStorage.setItem('p2p-look', look)
  if ((look ?? localStorage.getItem('p2p-look')) === 'loud') document.documentElement.dataset.theme = 'loud'
} catch {
  /* storage blocked or unavailable: the default look stays */
}

// NAT lab build only (scripts/natlab, VITE_NATLAB=1): lets the lab read the app's own QR codes.
// The condition is a build-time constant, so release builds drop this branch entirely.
if (import.meta.env.VITE_NATLAB === '1') {
  void import('./p2p/qrDecode').then((m) => {
    ;(window as unknown as { __natlab: unknown }).__natlab = { decodeQr: m.decodeQrFromPixels }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
