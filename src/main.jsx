import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import './index.css'
import './App.css'
import App from './App.jsx'
import Login from './Login.jsx'
import AlarmRoom from './AlarmRoom.jsx'

// Register the service worker as early as possible so push notifications
// keep working (and the SW stays up to date) even before the user reaches
// the room's "Enable device alerts" step. Idempotent and silent on failure.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<App />} />
        <Route path="/alarm" element={<AlarmRoom />} />
      </Routes>
    </Router>
  </StrictMode>,
)