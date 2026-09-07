import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from './firebase'

function toMillis(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  return new Date(value).getTime() || 0
}

/**
 * Live list of the most recent camera check-ins for a room
 * (rooms/<roomId>/checkins, newest first). `active` gates the subscription —
 * pass `false` until the current user is a confirmed member so guests don't
 * trip the security rules.
 */
export function useCheckins(roomId, active) {
  const [items, setItems] = useState([])

  useEffect(() => {
    if (!roomId || !active) {
      setItems([])
      return undefined
    }
    const ref = collection(db, 'rooms', roomId, 'checkins')
    const q = query(ref, orderBy('timestamp', 'desc'), limit(12))
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setItems(
          snap.docs.map((doc) => {
            const data = doc.data()
            return {
              id: doc.id,
              ...data,
              timestamp: toMillis(data.timestamp),
            }
          }),
        )
      },
      (error) => {
        if (error.code !== 'permission-denied') {
          console.error('Check-in listener error:', error.code || error.message)
        }
      },
    )
    return unsubscribe
  }, [roomId, active])

  return items
}
