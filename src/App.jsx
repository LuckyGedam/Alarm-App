import { useEffect, useState } from 'react'
import { doc, setDoc } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'
import { auth, db } from './firebase'
import { makeJoinCode } from './roomUtils'
import { displayName } from './useRoomAlarm'

function App() {
  const navigate = useNavigate()
  const [authState, setAuthState] = useState({ checking: true, user: null })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        navigate('/login?next=' + encodeURIComponent(window.location.pathname + window.location.search))
        return
      }
      setAuthState({ checking: false, user })
    })
    return unsubscribe
  }, [navigate])

  const createRoom = async () => {
    if (!authState.user || creating) return
    setCreating(true)
    setError('')
    try {
      const roomId = Math.random().toString(36).substring(2, 12)
      const joinCode = makeJoinCode()
      await setDoc(doc(db, 'rooms', roomId), {
        ownerUid: authState.user.uid,
        joinCode,
        members: [authState.user.uid],
        memberProfiles: {
          [authState.user.uid]: {
            name: displayName(authState.user),
            photoURL: authState.user.photoURL || null,
            joinedAt: new Date(),
          },
        },
        createdAt: new Date(),
        activeUntil: null,
        lastTriggered: null,
        triggeredBy: null,
      })
      navigate(`/alarm?room=${roomId}&code=${joinCode}`)
    } catch (err) {
      console.error('Failed to create room:', err)
      setError(`Failed to create room: ${err.message}`)
      setCreating(false)
    }
  }

  if (authState.checking) {
    return (
      <div className="page">
        <div className="spinner" aria-label="Checking sign-in" />
        <p className="muted">Checking sign-in…</p>
      </div>
    )
  }

  return (
    <div className="page fade-up">
      <div className="brand">
        <span className="brand-bell" aria-hidden="true">🔔</span>
        <span className="brand-name">Alarm App</span>
      </div>
      <h2>Alert every device in your room</h2>
      <p className="muted">
        Create a private room, share the invite link with your team, and anyone in
        the room can trigger an alarm that rings on every other device — even when
        their tab is in the background or their page is closed.
      </p>

      <div className="card feature-card fade-up delay-1">
        <div className="feature-grid">
          <div className="feature">
            <span className="feature-icon" aria-hidden="true">🔒</span>
            <span className="feature-title">Private rooms</span>
            <span className="feature-desc">Members-only access with a short join code</span>
          </div>
          <div className="feature">
            <span className="feature-icon" aria-hidden="true">📲</span>
            <span className="feature-title">Push alerts</span>
            <span className="feature-desc">Rings even when the page is closed</span>
          </div>
          <div className="feature">
            <span className="feature-icon" aria-hidden="true">🔔</span>
            <span className="feature-title">One-tap alarms</span>
            <span className="feature-desc">Trigger, acknowledge, stop</span>
          </div>
        </div>
      </div>

      <div className="controls">
        <button className="btn btn-primary btn-lg" onClick={createRoom} disabled={creating}>
          <span aria-hidden="true">{creating ? '⏳' : '＋'}</span>
          {creating ? 'Creating room…' : 'Create Alarm Room'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

export default App