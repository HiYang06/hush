import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/literata'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/noto-sans-sc'
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'
import './styles/app.css'
import { App } from './App'
import { MiniApp } from './MiniApp'
import { useAppStore } from './stores/appStore'
import { isWindows, rightPanelMinWidth } from './lib/platform'

// Lets CSS adjust for the platform, e.g. room for WindowControls on Windows.
document.documentElement.classList.add(`platform-${window.api.platform}`)
const isMini = new URLSearchParams(window.location.search).get('mode') === 'mini'
if (isWindows) useAppStore.setState({ rightPanelWidth: rightPanelMinWidth })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isMini ? <MiniApp /> : <App />}
  </React.StrictMode>
)
