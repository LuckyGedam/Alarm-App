// useLiveCamera — while the room page is open (and consent granted), keep
// the front camera rolling and send a JPEG frame to /api/telegram roughly
// every 5 seconds. The camera only runs while this hook is active (the room
// is open and visible); it is stopped on unmount, when the room is left, or
// when consent is withdrawn.
//
// While streaming, the hook requests a screen wake lock so the phone does
// not fall asleep and silently stop the feed — the app must stay visible for
// the camera to run (background/closed-app camera capture is blocked by iOS
// and Android at the OS level).
//
// The browser camera permission is asked only when it is still undecided:
// granted → silent capture, denied → never re-prompt. iOS only shows the
// prompt from a user gesture, so if a non-gesture start is refused we retry
// once on the next tap.
import { useEffect, useRef } from 'react'
import { cameraPermissionState, sendFrameToTelegram, snapVideoFrame } from './checkin'

const LIVE_INTERVAL_MS = 5000

export default function useLiveCamera({ roomId, active, getIdToken, onStatus }) {
  // Keep the latest reporter in a ref so an inline callback never restarts
  // the camera (the effect depends on `active`, not on `onStatus`).
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  })
  const report = (status) => onStatusRef.current?.(status)

  useEffect(() => {
    if (!active || !roomId) return undefined

    let disposed = false
    let stream = null
    let video = null
    let timer = null
    let gestureRetryListener = null
    let wakeLock = null
    let lastErrorLog = 0

    const releaseWakeLock = () => {
      if (wakeLock) {
        wakeLock.release?.().catch?.(() => {})
        wakeLock = null
      }
    }

    // Keep the screen on while the feed is live, so the phone doesn't sleep.
    const keepAwake = async () => {
      try {
        if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
          wakeLock = await navigator.wakeLock.request('screen')
        }
      } catch {
        wakeLock = null
      }
    }

    const cleanup = () => {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      if (gestureRetryListener) {
        window.removeEventListener('pointerdown', gestureRetryListener)
        gestureRetryListener = null
      }
      releaseWakeLock()
      document.removeEventListener('visibilitychange', onVisibility)
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

    // Map a relay failure to a user-facing category. "Not configured" is
    // final until the Vercel env vars exist (report once, stop hammering);
    // a bad bot token or chat id needs a Vercel env fix (kept retrying so the
    // feed resumes automatically once the user redeploys); other server /
    // network errors are transient and retried on the next tick.
    const classifySendError = (error) => {
      const message = String(error?.message || error)
      if (/not configured/i.test(message)) return 'notconfigured'
      if (/can't find this bot|not found/i.test(message)) return 'badtoken'
      if (/can't find the chat|chat not found/i.test(message)) return 'badchat'
      return 'relayerror'
    }

    const sendNow = async () => {
      if (disposed || !video || document.hidden) return
      const blob = await snapVideoFrame(video)
      if (!blob || disposed) return
      try {
        const idToken = await getIdToken?.()
        if (!idToken || disposed) return
        await sendFrameToTelegram(blob, { roomId, idToken })
        report({ kind: 'streaming', lastSentAt: Date.now() })
      } catch (error) {
        const kind = classifySendError(error)
        if (kind === 'notconfigured') {
          report({ kind })
          return
        }
        logThrottled(`Live camera send failed: ${error?.message || error}`)
        report({ kind, message: String(error?.message || error).slice(0, 120) })
      }
    }

    const start = async (fromGesture = false) => {
      if (disposed) return
      report({ kind: 'starting' })

      const permission = await cameraPermissionState()
      if (permission === 'denied') {
        // Blocked at the OS/browser level — never prompt again.
        report({ kind: 'blocked' })
        logThrottled('Live camera permission is blocked — enable the camera in site settings to resume.')
        return
      }

      let gotStream = null
      try {
        gotStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
      } catch (error) {
        // iOS/Safari only shows the camera prompt from a user gesture: wait
        // for one tap and try exactly once more. Any other failure (or a
        // second failure after the tap) means the camera is blocked.
        if (!fromGesture && error?.name === 'NotAllowedError') {
          report({ kind: 'waiting' })
          gestureRetryListener = () => {
            gestureRetryListener = null
            start(true)
          }
          window.addEventListener('pointerdown', gestureRetryListener, { once: true })
          return
        }
        report({ kind: 'blocked' })
        logThrottled(`Live camera could not start (${error?.name || error?.message || error})`)
        return
      }
      if (disposed) {
        gotStream.getTracks().forEach((track) => track.stop())
        return
      }

      stream = gotStream
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
        report({ kind: 'error' })
        stream.getTracks().forEach((track) => track.stop())
        stream = null
        video = null
        return
      }

      keepAwake()
      // First frame immediately, then one every ~5 s.
      sendNow()
      timer = setInterval(sendNow, LIVE_INTERVAL_MS)
    }

    const onVisibility = () => {
      if (document.hidden) {
        releaseWakeLock()
        if (video) report({ kind: 'paused' })
      } else {
        keepAwake()
        if (video) sendNow()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    start()

    return cleanup
  }, [roomId, active, getIdToken])
}
