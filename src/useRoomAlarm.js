import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { doc, onSnapshot, updateDoc, arrayUnion } from 'firebase/firestore'
import { db } from './firebase'

// How long an alarm keeps ringing on receiving devices before it expires.
// firestore.rules caps activeUntil at 10 minutes, so this stays well within it.
export const ALARM_DURATION_MS = 2 * 60 * 1000

// Normalize a Firestore timestamp (or ISO string) to epoch millis.
function toMillis(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  return new Date(value).getTime() || 0
}

// Display name used in the member list when the profile has none.
export function displayName(user) {
  if (!user) return ''
  return user.displayName || (user.email ? user.email.split('@')[0] : 'User')
}

/**
 * Shared alarm state for one room, backed by the `rooms/<roomId>` document.
 *
 * Security: rooms are private. `access` reports whether this signed-in user
 * may read the room:
 *   - 'member'  — can read/trigger/stop (snapshot is live)
 *   - 'invited' — not a member yet; needs the join code (from the invite
 *                 link or typed in) to join
 *   - 'missing' — the room document does not exist
 *   - 'denied'  — some other read error (e.g. offline)
 *
 * joinRoom(code) adds the current user to the room when the code matches.
 *
 * @returns {{ room, access, roomActive, alarmActive, trigger, stop,
 *   acknowledge, joinRoom }}
 *   roomActive is true while any alarm window is open (regardless of who
 *   triggered it); alarmActive is true when THIS device should be ringing.
 */
export function useRoomAlarm(roomId, user) {
  const [room, setRoom] = useState(null)
  const [access, setAccess] = useState('loading')
  const [roomActive, setRoomActive] = useState(false)
  const [alarmActive, setAlarmActive] = useState(false)
  const acknowledgedTriggerRef = useRef(null)

  const alarmRef = useMemo(() => (roomId ? doc(db, 'rooms', roomId) : null), [roomId])

  // Keep the latest room state in sync via Firestore snapshots and decide
  // whether this device should ring. Because the decision is made from the
  // latest snapshot, a device that was offline when the alarm fired will
  // ring as soon as it reconnects (as long as the alarm is still active).
  useEffect(() => {
    if (!alarmRef || !user) return undefined
    const unsubscribe = onSnapshot(
      alarmRef,
      (snap) => {
        if (!snap.exists()) {
          setRoom(null)
          setAccess('missing')
          setRoomActive(false)
          setAlarmActive(false)
          return
        }
        const data = snap.data()
        setRoom(data)
        setAccess('member')
        const now = Date.now()
        const active = Boolean(data.triggeredBy) && toMillis(data.activeUntil) > now
        setRoomActive(active)
        setAlarmActive(
          active &&
            data.triggeredBy !== user.uid &&
            toMillis(data.lastTriggered) !== acknowledgedTriggerRef.current,
        )
      },
      (error) => {
        // A permission-denied error here means "not a member (yet)" —
        // the room exists but is private. Everything else is unexpected.
        console.error('Alarm room listener error:', error.code || error.message)
        setRoom(null)
        setRoomActive(false)
        setAlarmActive(false)
        setAccess(error.code === 'permission-denied' ? 'invited' : 'denied')
      },
    )
    return unsubscribe
  }, [alarmRef, user])

  // Auto-expire the alarm when its active window passes without a stop.
  useEffect(() => {
    if (!roomActive || !room) return undefined
    const remaining = Math.max(0, toMillis(room.activeUntil) - Date.now())
    const timer = setTimeout(() => {
      setRoomActive(false)
      setAlarmActive(false)
    }, remaining + 100)
    return () => clearTimeout(timer)
  }, [roomActive, room])

  const trigger = useCallback(async () => {
    if (!user || !alarmRef) return
    await updateDoc(alarmRef, {
      lastTriggered: new Date(),
      activeUntil: new Date(Date.now() + ALARM_DURATION_MS),
      triggeredBy: user.uid,
    })
  }, [user, alarmRef])

  const stop = useCallback(async () => {
    if (!alarmRef) return
    await updateDoc(alarmRef, {
      activeUntil: null,
      triggeredBy: null,
    })
  }, [alarmRef])

  // Silence the alarm on this device only; other devices keep ringing.
  const acknowledge = useCallback(() => {
    if (room?.lastTriggered) {
      acknowledgedTriggerRef.current = toMillis(room.lastTriggered)
    }
    setAlarmActive(false)
  }, [room])

  // Join this room as a member by presenting the invite code. The update
  // is rejected by the security rules when the code is wrong, so a wrong
  // code surfaces as a permission-denied error here.
  const joinRoom = useCallback(
    async (code) => {
      if (!user || !alarmRef) throw new Error('You must be signed in to join a room')
      const profile = {
        name: displayName(user),
        photoURL: user.photoURL || null,
        joinedAt: new Date(),
      }
      await updateDoc(alarmRef, {
        members: arrayUnion(user.uid),
        memberProfiles: { [user.uid]: profile },
        joinCode: String(code).trim().toUpperCase(),
      })
      // The snapshot listener flips `access` to 'member' automatically.
    },
    [user, alarmRef],
  )

  return { room, access, roomActive, alarmActive, trigger, stop, acknowledge, joinRoom }
}