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
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    Boolean(VAPID_PUBLIC_KEY)
  )
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

/**
 * Enable push alerts for the given room on this device.
 *
 * When `silent` is true the browser permission prompt is never shown — used
 * for the automatic resubscribe-on-load path, where permission was already
 * granted in an earlier session.
 *
 * @returns {Promise<{status: 'enabled'|'needs-permission'|'denied'|'unsupported'|'error', message?: string}>}
 */
export async function enablePush(roomId, user, { silent = false } = {}) {
  if (!pushSupported()) return { status: 'unsupported' }
  if (Notification.permission === 'denied') return { status: 'denied' }

  const registration = await navigator.serviceWorker.register(SW_PATH)
  let subscription = await registration.pushManager.getSubscription()

  if (!subscription) {
    if (Notification.permission !== 'granted') {
      if (silent) {
        return { status: Notification.permission === 'denied' ? 'denied' : 'needs-permission' }
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        return { status: permission === 'denied' ? 'denied' : 'needs-permission' }
      }
    }
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  // Persist this device's subscription in the room so the relay can reach it.
  // A stable per-browser device id makes re-subscribes overwrite, not pile up.
  let deviceId = storedDeviceId()
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    try {
      localStorage.setItem(DEVICE_KEY, deviceId)
    } catch {
      // ignore storage errors
    }
  }
  await setDoc(doc(db, 'rooms', roomId, 'pushDevices', deviceId), {
    uid: user.uid,
    subscription: JSON.stringify(subscription),
    platform: platform(),
    updatedAt: new Date(),
  })
  return { status: 'enabled' }
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
  const registration = await navigator.serviceWorker.getRegistration(SW_PATH)
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe().catch(() => {})
}

/**
 * Best-effort push relay: ask the serverless function to notify every other
 * device subscribed to this room. Never throws — push is an enhancement; the
 * Firestore listener is the source of truth for the alarm.
 *
 * @returns {Promise<{pushed:number,total:number,stale?:number}|null>}
 *   The relay's device counts when it answered, otherwise null.
 */
export async function sendPushAlert({ roomId, uid, idToken, title, body, url }) {
  try {
    const response = await fetch('/api/ring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, uid, idToken, title, body, url }),
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
