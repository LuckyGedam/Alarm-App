// Front-camera utilities for the live-to-Telegram feed.
//
// While the room page is open (and the member consented), the app captures a
// front-camera JPEG roughly every 5 seconds and posts it to /api/telegram,
// which relays it to the room's Telegram chat. Frames go straight to
// Telegram — nothing is written to Firebase Storage or Firestore.
//
// Capture is gated by explicit per-(user, room) consent stored as
// `memberProfiles.<uid>.cameraConsent`; the browser-level camera permission
// is asked once and then respected (granted → capture silently, denied →
// never prompt again).

const FRAME_QUALITY = 0.7

/** True when this browser exposes getUserMedia (camera API). */
export function cameraSupported() {
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia,
  )
}

/**
 * Current OS/browser camera permission for this origin, when the Permissions
 * API exposes it (Chrome/Edge/Android; Safari returns 'unknown').
 *
 * @returns {Promise<'granted'|'denied'|'prompt'|'unknown'>}
 */
export async function cameraPermissionState() {
  try {
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'camera' })
      return status.state
    }
  } catch {
    // Permissions API does not expose camera (e.g. Safari) — unknown.
  }
  return 'unknown'
}

/** Draw the current frame of a playing <video> element to a JPEG blob. */
export function snapVideoFrame(video) {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      const width = video.videoWidth || 640
      const height = video.videoHeight || 480
      canvas.width = width
      canvas.height = height
      context.drawImage(video, 0, 0, width, height)
      canvas.toBlob(resolve, 'image/jpeg', FRAME_QUALITY)
    } catch {
      resolve(null)
    }
  })
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Upload one JPEG frame to the room's Telegram feed via /api/telegram.
 * Throws on relay errors so the caller can decide how loudly to complain.
 */
export async function sendFrameToTelegram(blob, { roomId, idToken }) {
  const image = await blobToBase64(blob)
  const response = await fetch('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, roomId, idToken }),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160)
    throw new Error(`Telegram relay answered ${response.status} ${detail}`)
  }
  return response.json()
}

/**
 * Send a plain text message to the room's Telegram chat via /api/telegram
 * (alarm fallback channel — Web Push can be throttled for hours by browsers
 * when the app sits closed, Telegram is not). Throws on relay errors.
 */
export async function sendTelegramText({ text, roomId, idToken }) {
  const response = await fetch('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, roomId, idToken }),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160)
    throw new Error(`Telegram relay answered ${response.status} ${detail}`)
  }
  return response.json()
}

/**
 * Probe whether the room's Telegram relay is actually usable — validates the
 * bot token AND the chat id server-side (one getChat call) before any photo
 * is captured. Resolves to the server's health payload:
 *   { ok: true }                              → relay works
 *   { ok: false, configured, reason, error }  → notconfigured | badtoken |
 *                                               badchat | botblocked, with a
 *                                               human-readable fix in `error`
 * Throws only on network/server failures.
 */
export async function probeTelegramHealth({ roomId, idToken }) {
  const response = await fetch('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ health: true, roomId, idToken }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error || `Telegram health check failed (${response.status})`)
  }
  return body
}
