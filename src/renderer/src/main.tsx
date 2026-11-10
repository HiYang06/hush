import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/literata'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/noto-sans-sc'
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'
import './styles/app.css'
import { useAppStore } from './stores/appStore'
import { isWindows, rightPanelMinWidth } from './lib/platform'

const App = React.lazy(() => import('./App').then((m) => ({ default: m.App })))
const MiniApp = React.lazy(() => import('./MiniApp').then((m) => ({ default: m.MiniApp })))

// Lets CSS adjust for the platform, e.g. room for WindowControls on Windows.
document.documentElement.classList.add(`platform-${window.api.platform}`)
const isMini = new URLSearchParams(window.location.search).get('mode') === 'mini'
if (isWindows) useAppStore.setState({ rightPanelWidth: rightPanelMinWidth })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <React.Suspense fallback={<div style={{ height: '100%', background: 'var(--bg-paper-base)' }} />}>
      {isMini ? <MiniApp /> : <App />}
    </React.Suspense>
  </React.StrictMode>
)
