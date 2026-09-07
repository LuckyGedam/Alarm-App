// /api/ring — Web Push relay.
//
// Called by a member's device right after it triggers an alarm. It reads the
// room's push-device subscriptions via the Firestore REST API using the
// caller's own ID token (so the security rules still apply — only members can
// list devices), then sends a Web Push message to every other device.
//
// With `test: true` in the body the relay instead targets the CALLER's own
// device(s) — the self-test mode used by the "Send test push" button — and
// logs the delivery as `[ring] SELF-TEST …` to keep it apart from real
// alarm deliveries in the runtime logs.
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

  const { roomId, uid, idToken, title, body, url, test } = req.body || {}
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
  const devices = (data.documents || []).map((doc) => {
    // The REST doc name ends with /pushDevices/<deviceId>.
    const fields = decodeFields(doc.fields)
    // src/push.js stores the subscription as a JSON string; web-push needs
    // the parsed object (endpoint + keys). Unparseable data is skipped.
    if (typeof fields.subscription === 'string') {
      try {
        fields.subscription = JSON.parse(fields.subscription)
      } catch {
        fields.subscription = null
      }
    }
    return { deviceId: decodeURIComponent(doc.name.split('/').pop()), ...fields }
  })

  // Normal alarms target every OTHER member's device. A self-test (`test`
  // flag) targets the caller's own device(s) instead, so a member can verify
  // end-to-end delivery — stored subscription → relay → push service —
  // without needing a second member to trigger an alarm.
  const targets = devices.filter(
    (device) =>
      device.subscription &&
      (test ? device.uid === uid : Boolean(device.uid) && device.uid !== uid),
  )

  // How many separate notifications each recipient gets. The sender picks
  // 1–10 in the UI (default 3); the client value is truncated and clamped
  // here so a modified/malicious request cannot spam a device hundreds of
  // times or ask for a fractional burst.
  const count = Math.min(Math.max(1, Math.trunc(Number(req.body?.count) || 3)), 10)

  // Unique per-push tag (roomId + trigger time + index) so Android/Chrome
  // STACK the burst as separate notifications instead of the newest silently
  // replacing the previous one (the default when `tag` is reused). The tag
  // travels inside the payload; public/sw.js reads data.tag.
  const tagBase = `${roomId}-${Date.now()}`

  // Note: the per-device callback must REJECT on failure (not resolve with a
  // status object) — Promise.allSettled wraps a resolved value as
  // { status: 'fulfilled', value }, so an inner { status: 'rejected' } object
  // would be counted as a successful push. Outer fulfilled == the push
  // service accepted at least one push for the device.
  const results = await Promise.allSettled(
    targets.map(async ({ deviceId, subscription }) => {
      // Back-to-back sends with no artificial delay: real-world delivery
      // timing across push services/OSes already spaces the burst out, and
      // staying loop-bound keeps total execution time well under the
      // serverless timeout (10 sends/device tops).
      let sent = 0
      let failure = null
      for (let i = 0; i < count && !failure; i += 1) {
        const message = JSON.stringify({
          title,
          body,
          url,
          roomId,
          tag: `${tagBase}-${i}`,
        })
        try {
          await webpush.sendNotification(subscription, message)
          sent += 1
        } catch (error) {
          failure = error
        }
      }
      if (failure) {
        const statusCode = failure?.statusCode
        console.error(
          `[ring] push to device ${deviceId} failed` +
            (statusCode ? ` (HTTP ${statusCode})` : ` (${failure?.message || failure})`) +
            (failure?.body ? `: ${String(failure.body).slice(0, 200)}` : ''),
        )
        // 404/410 means the endpoint is gone (subscription expired or the
        // device revoked it) — the rest of the burst would fail the same
        // way, so stop and prune the doc so it stops failing on every alarm.
        if (statusCode === 404 || statusCode === 410) {
          await deleteDevice(projectId, apiKey, roomId, deviceId, idToken)
        }
        throw failure
      }
      return sent
    }),
  )

  const pushed = results.filter((r) => r.status === 'fulfilled').length
  const notificationsSent = results.reduce(
    (sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0),
    0,
  )
  const stale = results.filter(
    (r) => r.status === 'rejected' && (r.reason?.statusCode === 404 || r.reason?.statusCode === 410),
  ).length

  // Per-platform breakdown (allSettled keeps result order aligned with targets).
  const platforms = {}
  targets.forEach((target, index) => {
    const key = target.platform || 'desktop'
    const entry = (platforms[key] ||= { total: 0, pushed: 0 })
    entry.total += 1
    if (results[index]?.status === 'fulfilled') entry.pushed += 1
  })

  const mode = test ? 'SELF-TEST' : 'ALARM'
  console.error(
    `[ring] ${mode} room ${roomId} by ${uid}: sent ${notificationsSent} notification(s) to ${pushed}/${targets.length} devices` +
      (stale ? ` (${stale} stale pruned)` : ''),
  )

  return res.status(200).json({
    pushed,
    total: targets.length,
    notificationsSent,
    stale,
    platforms,
  })
}