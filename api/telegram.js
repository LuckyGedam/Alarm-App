// /api/telegram — live camera-to-Telegram relay.
//
// The room page captures a front-camera JPEG every ~5 seconds and POSTs it
// here (base64 JSON). This function verifies the caller is a room member
// (via Firestore REST with their own ID token, exactly like /api/ring), then
// uploads the frame to a fixed Telegram chat via the Bot API. Photos never
// touch Firebase Storage.
//
// Environment (server-side only):
//   TELEGRAM_BOT_TOKEN                — from @BotFather (/newbot)
//   TELEGRAM_CHAT_ID                  — the chat that receives the frames
//   VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY — Firestore REST check
export const config = { maxDuration: 10 }

const MAX_IMAGE_BYTES = 1_500_000 // client frames are ~100 KB; keep a hard cap

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
}

/** Confirm the caller is a member of the room (Firestore rules enforce it). */
async function isRoomMember(projectId, apiKey, roomId, idToken) {
  const url = `${firestoreBase(projectId)}/rooms/${roomId}?key=${apiKey}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  return response.ok
}

/**
 * Map a Telegram Bot API failure to a user-facing reason + fix hint. Shared
 * by the photo relay and the health probe so the phone always shows the
 * same, actionable message.
 */
function telegramFailureHint(status, description, token, chatId) {
  const chatHint = /^-?\d+$/.test(String(chatId)) ? `id ${chatId}` : `username/chat '${chatId}'`
  const desc = String(description || '')
  if (status === 404 || /^not found$/i.test(desc)) {
    return {
      reason: 'badtoken',
      hint:
        "Telegram can't find this bot (404): the TELEGRAM_BOT_TOKEN in Vercel is invalid or stale — " +
        'generate a fresh token in @BotFather with /token and paste it exactly',
    }
  }
  if (/chat not found/i.test(desc)) {
    return {
      reason: 'badchat',
      hint:
        `Telegram can't find the chat (400): check TELEGRAM_CHAT_ID (${chatHint}) and ` +
        'add the bot to the chat and message it once first',
    }
  }
  if (/forbidden/i.test(desc)) {
    return {
      reason: 'botblocked',
      hint: 'Telegram blocked this send (403): add the bot to the chat and message it once first',
    }
  }
  return {
    reason: 'relayerror',
    hint: desc ? `Telegram rejected the request: ${desc.slice(0, 160)}` : `Telegram answered HTTP ${status}`,
  }
}

/**
 * Health probe (POST with { health: true, roomId, idToken }). Validates the
 * whole relay in one Bot API call — getChat resolves the chat id, so an
 * unknown token (404), unknown chat (400), or blocked bot (403) is caught
 * before a single photo is captured or sent.
 */
async function handleHealth(res, token, chatId) {
  if (!token || !chatId) {
    return res.status(200).json({ ok: false, configured: false, reason: 'notconfigured' })
  }
  try {
    const chatResponse = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
    )
    const chatPayload = await chatResponse.json().catch(() => ({}))
    if (!chatResponse.ok || chatPayload.ok !== true) {
      const { reason, hint } = telegramFailureHint(chatResponse.status, chatPayload?.description, token, chatId)
      return res.status(200).json({ ok: false, configured: true, reason, error: hint })
    }
    const bot = chatPayload.result?.username || ''
    console.log(`[telegram] health ok: bot @${bot}, relay ready`)
    return res.status(200).json({
      ok: true,
      configured: true,
      chatOk: true,
      bot,
    })
  } catch (error) {
    console.error('[telegram] health probe error:', error?.message || error)
    return res.status(502).json({ error: 'Telegram health probe failed' })
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { image, roomId, idToken, health } = req.body || {}
  if (!roomId || !idToken) {
    return res.status(400).json({ error: 'roomId and idToken are required' })
  }
  if (!health && !image) {
    return res.status(400).json({ error: 'image, roomId and idToken are required' })
  }

  // Trim: a stray newline/space from pasting the token into Vercel's env
  // field makes Telegram answer 404 "Not Found" for an otherwise valid bot.
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim()
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID
  const apiKey = process.env.VITE_FIREBASE_API_KEY
  if (!projectId || !apiKey) {
    console.error('[telegram] Firestore env vars missing — cannot verify room membership')
    return res.status(500).json({ error: 'Membership check not configured' })
  }

  // Only room members may push frames to the room's feed (or probe it).
  if (!(await isRoomMember(projectId, apiKey, roomId, idToken))) {
    return res.status(403).json({ error: 'Not a member of this room' })
  }

  if (health) {
    return handleHealth(res, token, chatId)
  }

  if (!token || !chatId) {
    console.error('[telegram] relay not configured (missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)')
    return res.status(500).json({ error: 'Telegram relay is not configured' })
  }

  const clean = String(image).replace(/^data:image\/[a-z+]+;base64,/i, '')
  // Validate strictly — Node's Buffer is lenient and would silently decode
  // garbage, so reject anything that is not real base64.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    return res.status(400).json({ error: 'image did not decode' })
  }
  const bytes = Buffer.from(clean, 'base64')
  if (!bytes.length) return res.status(400).json({ error: 'image did not decode' })
  if (bytes.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'image too large' })
  }

  try {
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'frame.jpg')
    form.append('caption', `📸 Room ${roomId} · ${new Date().toLocaleTimeString()}`)

    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    })
    const payload = await telegramResponse.json().catch(() => ({}))
    if (!telegramResponse.ok || payload.ok !== true) {
      // Mask the token (first 6 + last 4 chars) so a wrong/stale token is
      // diagnosable from the logs without leaking it. A 404 "Not Found"
      // means Telegram does not know this bot token at all.
      const tokenHint = token ? `${token.slice(0, 6)}…${token.slice(-4)} (len ${token.length})` : '(missing)'
      const { hint } = telegramFailureHint(telegramResponse.status, payload?.description, token, chatId)
      console.error(
        `[telegram] sendPhoto failed: HTTP ${telegramResponse.status} ${JSON.stringify(payload).slice(0, 300)} ` +
          `(token ${tokenHint}, chat ${chatId})`,
      )
      return res.status(502).json({ error: hint })
    }
    console.log(`[telegram] photo sent to room ${roomId}`)
    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[telegram] relay error:', error?.message || error)
    return res.status(500).json({ error: 'Telegram relay failed' })
  }
}
