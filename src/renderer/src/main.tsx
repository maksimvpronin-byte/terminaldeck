import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// Without this, a file dropped anywhere outside a drop zone makes the window
// navigate to it, replacing the app.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
