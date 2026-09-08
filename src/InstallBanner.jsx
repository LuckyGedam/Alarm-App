// InstallBanner — offers to install this site as a PWA when the browser
// fires `beforeinstallprompt` (Chrome on Android/desktop). Installed apps
// get dramatically more reliable push delivery than bare browser tabs
// (Chrome throttles/queues push for low-engagement, non-installed sites),
// so this directly hardens the "no notification after 2 hours" case.
import { useEffect, useState } from 'react'

export default function InstallBanner() {
  const [deferred, setDeferred] = useState(null)

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      // Prevent the browser's default mini-infobar so we can show our own
      // button inside the room page instead.
      event.preventDefault()
      setDeferred(event)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  if (!deferred) return null

  return (
    <div className="card install-banner" role="note">
      <span className="install-banner-icon" aria-hidden="true">📲</span>
      <div className="install-banner-text">
        <strong>Install the app</strong>
        <p>Installed apps receive alarms reliably even when the tab has been closed for hours.</p>
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={async () => {
          deferred.prompt()
          await deferred.userChoice.catch(() => {})
          setDeferred(null)
        }}
      >
        Install
      </button>
    </div>
  )
}