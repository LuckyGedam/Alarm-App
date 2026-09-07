// Remembers the room each account last used, so opening the app (including
// the Home Screen PWA icon) drops the user straight back into their room
// instead of the "Create Alarm Room" landing page every time.
//
// Storage is keyed per uid because several Google accounts can share one
// browser. Rooms live under `rooms/<roomId>` server-side; this is only a
// client convenience for re-opening the right one.

const STORAGE_KEY = 'alarmLastRoom'

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable (private mode etc.) — resume simply won't work.
  }
}

/** Remember the room `uid` should return to on the next app open. */
export function rememberRoom(uid, roomId) {
  if (!uid || !roomId) return
  const all = readAll()
  if (all[uid] === roomId) return
  all[uid] = roomId
  writeAll(all)
}

/** The room `uid` last used, or null when they have none. */
export function lastRoomFor(uid) {
  if (!uid) return null
  return readAll()[uid] || null
}

/** Forget the room for `uid` (e.g. they left it or want to create a new one). */
export function forgetRoom(uid) {
  if (!uid) return
  const all = readAll()
  if (!(uid in all)) return
  delete all[uid]
  writeAll(all)
}
