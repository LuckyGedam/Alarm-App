// Foreground "check-in" photo capture.
//
// Scope: only runs while the app is open / foreground (a fresh page load, or
// brought to the foreground by tapping a notification). True background
// capture with the browser fully closed is blocked by iOS and Android at the
// OS level and is not attempted here.
//
// Capture is gated by explicit per-(user, room) consent stored as
// `memberProfiles.<uid>.cameraConsent` — nothing in this module runs before
// that flag is true. Frames are drawn to an offscreen <canvas>, uploaded to
// Firebase Storage under rooms/<roomId>/checkins/<uid>/, and a Firestore doc
// under rooms/<roomId>/checkins/ records the URLs so the whole room can see
// the confirmation trail.
import { addDoc, collection } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'

const FRAMES = 3
const FRAME_GAP_MS = 450

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

/** True when this browser can plausibly capture (camera API + Storage bucket). */
export function cameraCaptureSupported() {
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia &&
      storage,
  )
}

/**
 * Take 2–3 front-camera photos a few hundred ms apart, upload them to
 * Storage, and record one Firestore check-in doc with their URLs.
 *
 * Never throws — camera failures (denied/unavailable) return
 * { ok: false, reason } so the caller can skip silently. Callers must not
 * retry in a loop.
 *
 * @returns {Promise<{ok: boolean, photos?: number, reason?: string}>}
 */
export async function captureAndUploadCheckin({
  roomId,
  uid,
  triggeredByNotification = false,
}) {
  if (!cameraCaptureSupported()) return { ok: false, reason: 'unsupported' }

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    })
  } catch (error) {
    // Camera permission denied / no camera: skip quietly and keep the rest of
    // the app working. No retry here — the caller decides whether to retry.
    console.warn('Check-in camera unavailable:', error?.name || error?.message || error)
    return { ok: false, reason: 'denied' }
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('camera start timed out')), 8000)
      video.onloadedmetadata = () => {
        clearTimeout(timer)
        resolve()
      }
      video.onerror = () => {
        clearTimeout(timer)
        reject(new Error('video element error'))
      }
      video.play().catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    // Give the decoder a moment to produce an actual frame before drawing.
    await sleep(250)

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const snap = () =>
      new Promise((resolve) => {
        const width = video.videoWidth || 640
        const height = video.videoHeight || 480
        canvas.width = width
        canvas.height = height
        context.drawImage(video, 0, 0, width, height)
        canvas.toBlob(resolve, 'image/jpeg', 0.8)
      })

    const startedAt = Date.now()
    const urls = []
    for (let i = 0; i < FRAMES; i += 1) {
      if (i > 0) await sleep(FRAME_GAP_MS)
      const blob = await snap()
      if (!blob) continue
      const fileRef = storageRef(storage, `rooms/${roomId}/checkins/${uid}/${startedAt}-${i}.jpg`)
      await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' })
      urls.push(await getDownloadURL(fileRef))
    }

    if (!urls.length) return { ok: false, reason: 'no-frames' }

    await addDoc(collection(db, 'rooms', roomId, 'checkins'), {
      uid,
      timestamp: new Date(),
      photoUrls: urls,
      triggeredByNotification: Boolean(triggeredByNotification),
    })
    return { ok: true, photos: urls.length }
  } catch (error) {
    console.warn('Check-in capture failed:', error?.name || error?.message || error)
    return { ok: false, reason: 'error' }
  } finally {
    // Stop the camera immediately after capture — never leave it running.
    stopStream(stream)
  }
}
