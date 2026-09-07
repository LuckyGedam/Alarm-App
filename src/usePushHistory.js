import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from './firebase'

function toMillis(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  return new Date(value).getTime() || 0
}

/**
 * Live list of the most recent push-delivery attempts for a room
 * (rooms/<roomId>/pushes, newest first). `active` gates the subscription —
 * pass `false` until the current user is a confirmed member so guests don't
 * trip the security rules.
 */
export function usePushHistory(roomId, active) {
  const [items, setItems] = useState([])

  useEffect(() => {
    if (!roomId || !active) {
      setItems([])
      return undefined
    }
    const ref = collection(db, 'rooms', roomId, 'pushes')
    const q = query(ref, orderBy('at', 'desc'), limit(10))
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
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
          console.error('Push history listener error:', error.code || error.message)
        }
      },
    )
    return unsubscribe
  }, [roomId, active])

  return items
}
