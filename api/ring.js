// /api/ring — Web Push relay.
//
// Called by a member's device right after it triggers an alarm. It reads the
// room's push-device subscriptions via the Firestore REST API using the
// caller's own ID token (so the security rules still apply — only members can
// list devices), then sends a Web Push message to every other device.
//
// Environment (server-side only):
//   VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY  — Firestore REST
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY              — web-push signing keys
//   VAPID_SUBJECT (optional)                         — contact, e.g. mailto:
import webpush from 'web-push'

export const config = { maxDuration: 30 }

function decodeFields(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (value.stringValue !== undefined) out[key] = value.stringValue
    else if (value.integerValue !== undefined) out[key] = Number(value.integerValue)
    else if (value.booleanValue !== undefined) out[key] = value.booleanValue
    else if (value.doubleValue !== undefined) out[key] = Number(value.doubleValue)
    else if (value.timestampValue) out[key] = value.timestampValue
    else if (value.mapValue) out[key] = decodeFields(value.mapValue.fields)
    else if (value.arrayValue) out[key] = (value.arrayValue.values || []).map(decodeFields)
    else out[key] = null
  }
  return out
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { roomId, uid, idToken, title, body, url } = req.body || {}
  if (!roomId || !uid || !idToken) {
    return res.status(400).json({ error: 'roomId, uid and idToken are required' })
  }

  const projectId = process.env.VITE_FIREBASE_PROJECT_ID
  const apiKey = process.env.VITE_FIREBASE_API_KEY
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  if (!projectId || !apiKey || !vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'Push relay is not configured (missing VAPID/Firestore env vars)' })
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:alarm@example.com',
    vapidPublic,
    vapidPrivate,
  )

  // List the room's push devices as the caller. Firestore rules enforce that
  // only room members may read this collection.
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${roomId}/pushDevices`
  const resp = await fetch(`${base}?key=${apiKey}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    return res.status(resp.status).json({ error: 'Could not read room devices', detail: detail.slice(0, 300) })
  }

  const data = await resp.json()
  const devices = (data.documents || []).map((doc) => decodeFields(doc.fields))

  const targets = devices
    .filter((device) => device.uid && device.uid !== uid && device.subscription)
    .map((device) => JSON.parse(device.subscription))

  const results = await Promise.allSettled(
    targets.map((subscription) =>
      webpush.sendNotification(
        subscription,
        JSON.stringify({ title, body, url, roomId }),
      ),
    ),
  )

  return res.status(200).json({
    pushed: results.filter((r) => r.status === 'fulfilled').length,
    total: targets.length,
  })
}