import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/literata'
import '@fontsource-variable/jetbrains-mono'
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'
import '@renderer/styles/app.css'
import './mobile.css'
import './bridge'
import './highlightsFromPoint'
import { Reader } from './Reader'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Reader />
  </React.StrictMode>
)
