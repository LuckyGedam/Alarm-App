// useHeartbeat — keeps `memberProfiles.<uid>.lastSeenAt` fresh while the
// user has the room open, so every other member can see when a device last
// opened the app. Writes are throttled (one per 60 s) and paused whenever
// the tab is hidden; a final best-effort write happens on page hide so
// "last seen" is as accurate as the browser allows.
import { useEffect, useRef } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'

const HEARTBEAT_MS = 60_000

export default function useHeartbeat({ roomId, uid, active }) {
  const lastWriteRef = useRef(0)

  useEffect(() => {
    if (!roomId || !uid || !active) return undefined
    let disposed = false

    const write = (force = false) => {
      if (disposed || document.hidden) return
      const now = Date.now()
      if (!force && now - lastWriteRef.current < HEARTBEAT_MS) return
      lastWriteRef.current = now
      updateDoc(doc(db, 'rooms', roomId), {
        [`memberProfiles.${uid}.lastSeenAt`]: new Date(),
      }).catch((error) => {
        // Allow a retry on the next tick (offline blip, rules deploy, etc.).
        console.warn('Could not update last-seen:', error?.message || error)
        lastWriteRef.current = 0
      })
    }

    // Fire once on open, then keep the timestamp fresh.
    write(true)
    const timer = setInterval(() => write(false), HEARTBEAT_MS)

    const onVisibility = () => {
      if (!document.hidden) write(true)
    }
    const onFocus = () => write(true)
    const onPageHide = () => {
      // Best-effort final timestamp when the tab/app closes.
      updateDoc(doc(db, 'rooms', roomId), {
        [`memberProfiles.${uid}.lastSeenAt`]: new Date(),
      }).catch(() => {})
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [roomId, uid, active])
}