// Client-side Web Push helpers.
//
// The browser subscription is stored in Firestore (rooms/<roomId>/pushDevices)
// where the security rules let room members read it. When someone triggers an
// alarm, the client asks the `/api/ring` serverless function to send a push to
// every other subscribed device — so an alarm arrives even when the page is
// closed or the tab is in the background.
import { doc, setDoc, deleteDoc } from 'firebase/firestore'
import { db } from './firebase'
import { platform } from './platform'

const SW_PATH = '/sw.js'
const DEVICE_KEY = 'alarmPushDeviceId'
const OPT_OUT_KEY = 'alarmPushOptOutRooms'
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

// Rooms the user explicitly turned alerts OFF for. The silent restore path
// must respect this — otherwise disabling alerts would be undone silently on
// the next app open (the browser permission itself stays granted).
function optedOutRooms() {
  try {
    const value = JSON.parse(localStorage.getItem(OPT_OUT_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function setOptedOut(roomId, optedOut) {
  try {
    const rooms = optedOutRooms().filter((id) => id !== roomId)
    if (optedOut) rooms.push(roomId)
    localStorage.setItem(OPT_OUT_KEY, JSON.stringify(rooms))
  } catch {
    // Storage unavailable — restore may re-enable alerts later. Acceptable.
  }
}

/** True when the user explicitly disabled alerts for this room. */
export function isOptedOut(roomId) {
  return optedOutRooms().includes(roomId)
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    Boolean(VAPID_PUBLIC_KEY)
  )
}

/** True when a VAPID public key was baked into this build (needed to subscribe). */
export function vapidConfigured() {
  return Boolean(VAPID_PUBLIC_KEY)
}

/** The stable per-browser device id used for the Firestore doc, if any. */
export function storedDeviceId() {
  try {
    return localStorage.getItem(DEVICE_KEY)
  } catch {
    return null
  }
}

// Convert a base64url VAPID public key into the Uint8Array PushManager wants.
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

// A stable per-browser device id makes re-subscribes overwrite, not pile up.
function deviceId() {
  let id = storedDeviceId()
  if (!id) {
    id = crypto.randomUUID()
    try {
      localStorage.setItem(DEVICE_KEY, id)
    } catch {
      // ignore storage errors
    }
  }
  return id
}

/**
 * Write (or refresh) this browser's push subscription on the room's
 * pushDevices doc. Idempotent — safe to call on every room load so the doc
 * always matches what pushManager actually holds, even if the relay pruned
 * the doc as stale in the meantime.
 */
export async function storeSubscription(roomId, user, subscription) {
  await setDoc(doc(db, 'rooms', roomId, 'pushDevices', deviceId()), {
    uid: user.uid,
    subscription: JSON.stringify(subscription),
    platform: platform(),
    updatedAt: new Date(),
  })
}

/**
 * Register the service worker and make sure this browser holds a push
 * subscription. Never shows the permission prompt — callers decide when a
 * prompt is appropriate (explicit enable click) vs. a silent restore.
 */
async function ensureSubscription() {
  const registration = await navigator.serviceWorker.register(SW_PATH)
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      throw new Error('Notification permission not granted')
    }
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }
  return subscription
}

/**
 * Enable push alerts for the given room on this device (explicit user tap).
 *
 * @returns {Promise<{status: 'enabled'|'needs-permission'|'denied'|'unsupported'|'error', message?: string}>}
 */
export async function enablePush(roomId, user) {
  if (!pushSupported()) return { status: 'unsupported' }
  if (Notification.permission === 'denied') return { status: 'denied' }

  // Ask for permission BEFORE any await. Browsers only reliably show the
  // notification prompt while the click's user activation is still fresh;
  // once we await a promise the gesture is consumed and some browsers (e.g.
  // Chrome on Android) silently auto-deny instead of prompting.
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return { status: permission === 'denied' ? 'denied' : 'needs-permission' }
    }
  }

  try {
    const subscription = await ensureSubscription()
    // Persist this device's subscription in the room so the relay can reach it.
    await storeSubscription(roomId, user, subscription)
    setOptedOut(roomId, false)
    return { status: 'enabled' }
  } catch (error) {
    console.warn('Could not subscribe for push:', error?.message || error)
    return { status: 'error' }
  }
}

/**
 * Silent startup restore used whenever the room page opens. Never prompts:
 * if this account granted notifications in an earlier session, re-register
 * the service worker, re-create the subscription if the browser dropped it,
 * and refresh the room's pushDevices doc — so the relay can reach this
 * device even when the app is closed, on every future open.
 *
 * @returns {Promise<{status: 'enabled'|'needs-permission'|'denied'|'unsupported'|'skipped'|'error'}>}
 */
export async function autoRestorePush(roomId, user) {
  if (!pushSupported()) return { status: 'unsupported' }
  if (isOptedOut(roomId)) return { status: 'skipped' }
  const permission = typeof Notification === 'undefined' ? 'denied' : Notification.permission
  if (permission !== 'granted') {
    // Never prompt here: 'denied' is final, 'default' waits for the explicit
    // Enable button (a prompt needs a user gesture anyway).
    return { status: permission === 'denied' ? 'denied' : 'needs-permission' }
  }
  try {
    const subscription = await ensureSubscription()
    await storeSubscription(roomId, user, subscription)
    return { status: 'enabled' }
  } catch (error) {
    console.warn('Could not restore push alerts:', error?.message || error)
    return { status: 'error' }
  }
}

/** Disable push alerts for the room and unsubscribe the browser. */
export async function disablePush(roomId) {
  const deviceId = storedDeviceId()
  if (deviceId) {
    await deleteDoc(doc(db, 'rooms', roomId, 'pushDevices', deviceId)).catch(() => {})
    try {
      localStorage.removeItem(DEVICE_KEY)
    } catch {
      // ignore storage errors
    }
  }
  setOptedOut(roomId, true)
  const registration = await navigator.serviceWorker.getRegistration(SW_PATH)
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe().catch(() => {})
}

/**
 * Best-effort push relay: ask the serverless function to notify every other
 * device subscribed to this room. Never throws — push is an enhancement; the
 * Firestore listener is the source of truth for the alarm.
 *
 * `count` is how many separate notifications each recipient device gets
 * (server-clamped to 1–10, default 3).
 *
 * @returns {Promise<{pushed:number,total:number,notificationsSent:number,stale?:number}|null>}
 *   The relay's device counts when it answered, otherwise null.
 */
export async function sendPushAlert({ roomId, uid, idToken, title, body, url, test = false, count }) {
  try {
    const response = await fetch('/api/ring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, uid, idToken, title, body, url, test, count }),
    })
    if (!response.ok) {
      console.warn('Push relay answered with an error:', response.status, (await response.text()).slice(0, 200))
      return null
    }
    return await response.json()
  } catch (error) {
    console.warn('Push relay failed (alarm still fires in-app):', error.message || error)
    return null
  }
}

/**
 * Self-test: ask the relay to push to THIS device's stored subscription(s)
 * (`test: true` makes /api/ring target the caller's own devices instead of
 * everyone else's). Lets a member verify the full delivery chain — Firestore
 * subscription → /api/ring → push service → service worker — without needing
 * a second member to trigger a real alarm.
 *
 * @returns {Promise<{pushed:number,total:number,notificationsSent:number,stale?:number}|null>}
 */
export async function sendTestPush({ roomId, uid, idToken }) {
  return sendPushAlert({
    roomId,
    uid,
    idToken,
    title: '🔔 Test push',
    body: 'Push delivery works end to end on this device.',
    url: `${window.location.origin}/alarm?room=${roomId}`,
    test: true,
    // A self-test is a single ping — the repeated burst is for real alarms.
    count: 1,
  })
}
