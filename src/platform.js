// Small UA / display-mode helpers shared by the install banner and push code.

/** True on iPhone/iPad/iPod (incl. iPadOS 13+, which hides iPad in the UA). */
export function isIOS() {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports as macOS on iPads — detect via touch capability.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/** True when running as an installed PWA (Home Screen / standalone window). */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.navigator.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  )
}

/** Push-platform tag stored on each pushDevices doc: 'android' | 'ios' | 'desktop'. */
export function platform() {
  if (typeof navigator === 'undefined') return 'desktop'
  if (/android/i.test(navigator.userAgent)) return 'android'
  if (isIOS()) return 'ios'
  return 'desktop'
}
