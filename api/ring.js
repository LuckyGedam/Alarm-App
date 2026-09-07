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

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
}

/** Delete a pushDevices doc whose subscription the push service reports as gone. */
async function deleteDevice(projectId, apiKey, roomId, deviceId, idToken) {
  const url = `${firestoreBase(projectId)}/rooms/${roomId}/pushDevices/${deviceId}?key=${apiKey}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!response.ok) {
    console.error(
      `[ring] failed to delete stale device ${deviceId}: ${response.status} ${(await response.text()).slice(0, 200)}`,
    )
  } else {
    console.error(`[ring] pruned stale push device ${deviceId} (subscription no longer valid)`)
  }
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
  const listUrl = `${firestoreBase(projectId)}/rooms/${roomId}/pushDevices?key=${apiKey}`
  const resp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    console.error(`[ring] could not list devices for room ${roomId}: ${resp.status} ${detail.slice(0, 200)}`)
    return res.status(resp.status).json({ error: 'Could not read room devices', detail: detail.slice(0, 300) })
  }

  const data = await resp.json()
  const devices = (data.documents || []).map((doc) => ({
    // The REST doc name ends with /pushDevices/<deviceId>.
    deviceId: decodeURIComponent(doc.name.split('/').pop()),
    ...decodeFields(doc.fields),
  }))

  const targets = devices.filter(
    (device) => device.uid && device.uid !== uid && device.subscription,
  )

  const message = JSON.stringify({ title, body, url, roomId })
  const results = await Promise.allSettled(
    targets.map(async ({ deviceId, subscription }) => {
      try {
        await webpush.sendNotification(subscription, message)
        return { status: 'fulfilled' }
      } catch (error) {
        const statusCode = error?.statusCode
        console.error(
          `[ring] push to device ${deviceId} failed` +
            (statusCode ? ` (HTTP ${statusCode})` : ` (${error?.message || error})`) +
            (error?.body ? `: ${String(error.body).slice(0, 200)}` : ''),
        )
        // 404/410 means the endpoint is gone (subscription expired or the
        // device revoked it). Prune it so it stops failing on every alarm.
        if (statusCode === 404 || statusCode === 410) {
          await deleteDevice(projectId, apiKey, roomId, deviceId, idToken)
        }
        return { status: 'rejected', reason: statusCode }
      }
    }),
  )

  const pushed = results.filter((r) => r.status === 'fulfilled').length
  const stale = results.filter((r) => r.status === 'rejected' && (r.reason === 404 || r.reason === 410)).length

  // Per-platform breakdown (allSettled keeps result order aligned with targets).
  const platforms = {}
  targets.forEach((target, index) => {
    const key = target.platform || 'desktop'
    const entry = (platforms[key] ||= { total: 0, pushed: 0 })
    entry.total += 1
    if (results[index]?.status === 'fulfilled') entry.pushed += 1
  })

  console.error(
    `[ring] room ${roomId} by ${uid}: pushed ${pushed}/${targets.length} devices` +
      (stale ? ` (${stale} stale pruned)` : ''),
  )

  return res.status(200).json({
    pushed,
    total: targets.length,
    stale,
    platforms,
  })
}