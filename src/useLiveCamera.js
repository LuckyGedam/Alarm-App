// useLiveCamera — while the room page is open (and consent granted), keep
// the front camera rolling and send a JPEG frame to /api/telegram roughly
// every 5 seconds. The camera only runs while this hook is active (the room
// is open and visible); it is stopped on unmount, when the room is left, or
// when consent is withdrawn.
//
// The browser camera permission is asked only when it is still undecided:
// granted → silent capture, denied → never re-prompt. iOS only shows the
// prompt from a user gesture, so if a non-gesture start is refused we retry
// once on the next tap.
import { useEffect } from 'react'
import { cameraPermissionState, sendFrameToTelegram, snapVideoFrame } from './checkin'

const LIVE_INTERVAL_MS = 5000

export default function useLiveCamera({ roomId, active, getIdToken }) {
  useEffect(() => {
    if (!active || !roomId) return undefined

    let disposed = false
    let stream = null
    let video = null
    let timer = null
    let gestureRetryListener = null
    let lastErrorLog = 0

    const cleanup = () => {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      if (gestureRetryListener) {
        window.removeEventListener('pointerdown', gestureRetryListener)
        gestureRetryListener = null
      }
      if (video) video.srcObject = null
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
    }

    const logThrottled = (message) => {
      const now = Date.now()
      if (now - lastErrorLog > 30000) {
        console.warn(message)
        lastErrorLog = now
      }
    }

    // Send one frame now (no-op while the tab is hidden — the OS may pause
    // the camera anyway, and we do not want frames taken while the user is
    // not actually looking at the app).
    const sendNow = async () => {
      if (disposed || !video || document.hidden) return
      const blob = await snapVideoFrame(video)
      if (!blob) return
      try {
        const idToken = await getIdToken?.()
        if (!idToken) return
        await sendFrameToTelegram(blob, { roomId, idToken })
      } catch (error) {
        // Keep the loop alive on transient errors, but don't spam the
        // console every 5 seconds (e.g. relay not configured yet).
        logThrottled(`Live camera send failed: ${error?.message || error}`)
      }
    }

    const start = async (fromGesture = false) => {
      if (disposed) return

      let permission = 'unknown'
      if (!fromGesture) {
        permission = await cameraPermissionState()
        if (permission === 'denied') {
          // Blocked at the OS/browser level — never prompt again.
          logThrottled('Live camera permission is blocked — enable the camera in site settings to resume.')
          return
        }
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
      } catch (error) {
        // iOS/Safari only shows the camera prompt from a user gesture: wait
        // for one tap and try exactly once more.
        if (!fromGesture && error?.name === 'NotAllowedError' && permission === 'unknown') {
          gestureRetryListener = () => start(true)
          window.addEventListener('pointerdown', gestureRetryListener, { once: true })
          return
        }
        logThrottled(`Live camera could not start (${error?.name || error?.message || error})`)
        return
      }
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('camera start timed out')), 8000)
          video.onloadedmetadata = () => {
            clearTimeout(t)
            resolve()
          }
          video.onerror = () => {
            clearTimeout(t)
            reject(new Error('video element error'))
          }
          video.play().catch((err) => {
            clearTimeout(t)
            reject(err)
          })
        })
      } catch (error) {
        logThrottled(`Live camera start failed: ${error?.message || error}`)
        stream.getTracks().forEach((track) => track.stop())
        video = null
        return
      }

      // First frame immediately, then one every ~5 s.
      sendNow()
      timer = setInterval(sendNow, LIVE_INTERVAL_MS)
    }

    const onVisibility = () => {
      if (!document.hidden && video) sendNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    start()

    return cleanup
  }, [roomId, active, getIdToken])
}
