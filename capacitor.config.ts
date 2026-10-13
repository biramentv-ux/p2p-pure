import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor wraps the production web build (dist/). No live-reload server URL
// is set here; native projects are not generated yet and no native plugins
// are enabled in the MVP.
const config: CapacitorConfig = {
  appId: 'bg.p2pmessenger.app',
  appName: 'P2P Messenger',
  webDir: 'dist',
  plugins: {},
}

export default config
