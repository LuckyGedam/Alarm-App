import { useState } from 'react'
import { isIOS, isStandalone } from './platform'

const HIDDEN_KEY = 'alarmIosBannerHidden'

/**
 * iOS Safari has no background Web Push until the site is added to the Home
 * Screen as a PWA. Show a short instruction banner only on iOS, outside
 * standalone mode, unless the user dismissed it before.
 */
export default function IosInstallBanner() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })

  if (!isIOS() || isStandalone() || hidden) return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(HIDDEN_KEY, '1')
    } catch {
      // ignore storage errors
    }
  }

  return (
    <div className="ios-banner" role="note">
      <span className="ios-banner-icon" aria-hidden="true">📲</span>
      <div className="ios-banner-text">
        <strong>Enable alerts on this iPhone</strong>
        <p>
          Safari only delivers notifications to installed web apps. Tap{' '}
          <b>Share</b> → <b>Add to Home Screen</b>, then open Alarm App from
          your Home Screen.
        </p>
      </div>
      <button className="btn btn-icon ios-banner-close" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}
