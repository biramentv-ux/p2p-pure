import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import App from './App.tsx'
import './hybrid.css'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
