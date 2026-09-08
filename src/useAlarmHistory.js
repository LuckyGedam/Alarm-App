import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from './firebase'

function toMillis(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  return new Date(value).getTime() || 0
}

/**
 * Live list of the most recent triggered alarms for a room
 * (rooms/<roomId>/alarms, newest first). `active` gates the subscription —
 * pass `false` until the current user is a confirmed member so guests don't
 * trip the security rules. State is only ever updated from snapshot
 * callbacks (never synchronously inside the effect).
 */
export function useAlarmHistory(roomId, active, max = 8) {
  const [items, setItems] = useState([])

  useEffect(() => {
    if (!roomId || !active) return undefined
    let disposed = false
    const ref = collection(db, 'rooms', roomId, 'alarms')
    const q = query(ref, orderBy('at', 'desc'), limit(max))
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        if (disposed) return
        setItems(
          snap.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
            at: toMillis(doc.data().at),
          })),
        )
      },
      (error) => {
        if (error.code !== 'permission-denied') {
          console.error('Alarm history listener error:', error.code || error.message)
        }
      },
    )
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [roomId, active, max])

  return items
}