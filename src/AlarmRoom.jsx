import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, updateDoc } from 'firebase/firestore'
import { auth, db } from './firebase'
import { useRoomAlarm } from './useRoomAlarm'
import { playAlarm } from './alarmSound'
import { avatarGradient, initialsOf, makeJoinCode } from './roomUtils'
import { enablePush, disablePush, pushSupported, sendPushAlert } from './push'
import IosInstallBanner from './IosInstallBanner'
import { isIOS, isStandalone } from './platform'

function Toast({ message }) {
  if (!message) return null
  return <div className="toast" role="status">{message}</div>
}

function MemberAvatar({ name, photoURL }) {
  return photoURL ? (
    <img className="member-avatar" src={photoURL} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="member-avatar member-avatar-fallback" style={{ background: avatarGradient(name) }}>
      {initialsOf(name)}
    </span>
  )
}

function MemberRow({ member, uid, isOwner, isSelf, onRemove }) {
  return (
    <li className="member-row">
      <MemberAvatar name={member.name} photoURL={member.photoURL} />
      <span className="member-name">
        {member.name}
        {isSelf && <span className="badge">You</span>}
        {isOwner && <span className="badge badge-owner">Owner</span>}
      </span>
      {isOwner && !isSelf && (
        <button
          className="btn btn-icon btn-danger"
          title={`Remove ${member.name}`}
          aria-label={`Remove ${member.name}`}
          onClick={() => onRemove(uid)}
        >
          ✕
        </button>
      )}
    </li>
  )
}

function AlarmRoom() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const roomId = searchParams.get('room') ?? ''
  const urlCode = searchParams.get('code') ?? ''
  const [authState, setAuthState] = useState({ checking: true, user: null })
  const [codeInput, setCodeInput] = useState(urlCode.toUpperCase())
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [toast, setToast] = useState('')
  const [pushState, setPushState] = useState('idle') // idle | working | enabled | needs-permission | denied | unsupported | error
  const [removing, setRemoving] = useState(false)
  const alarmRoomRef = useMemo(() => (roomId ? doc(db, 'rooms', roomId) : null), [roomId])
  const notificationTimer = useRef(null)

  const { room, access, roomActive, alarmActive, trigger, stop, acknowledge, joinRoom } =
    useRoomAlarm(roomId, authState.user)

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

  // Ring while the alarm is active; silence it when it stops.
  useEffect(() => {
    if (!alarmActive) return undefined
    const { stop: stopSound } = playAlarm()
    return stopSound
  }, [alarmActive])

  // Background-tab alert: Notification API when the tab is hidden AND this
  // device has no Web Push subscription. When push is subscribed, the service
  // worker shows the notification for background/closed pages itself, so an
  // in-tab notification would just duplicate it. Both share the same tag
  // (`alarm-${roomId}`), so even if they race the browser collapses them.
  useEffect(() => {
    if (!alarmActive || typeof Notification === 'undefined') return undefined
    if (Notification.permission !== 'granted') return undefined

    let disposed = false
    let pushSubscribed = false
    const findPush = async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        if (disposed) return
        pushSubscribed = Boolean(subscription)
      } catch {
        // Can't tell — fall back to the in-tab notification.
      }
    }
    findPush()

    const show = () => {
      if (disposed || pushSubscribed || !document.hidden) return
      const n = new Notification('🚨 ALARM', {
        body: 'An alarm is ringing in your room.',
        tag: `alarm-${roomId}`,
        renotify: true,
      })
      notificationTimer.current = setTimeout(() => n.close(), 20000)
    }
    show()
    const onVisibility = () => {
      if (!document.hidden) {
        clearTimeout(notificationTimer.current)
      } else if (alarmActive) {
        show()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(notificationTimer.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [alarmActive, roomId])

  const copyText = useCallback(
    (text, label = 'Copied!') => {
      navigator.clipboard?.writeText(text).catch(() => {})
      setToast(label)
      window.setTimeout(() => setToast(''), 1600)
    },
    [],
  )

  const handleJoin = async (e) => {
    e?.preventDefault()
    if (!codeInput.trim() || joining) return
    setJoining(true)
    setJoinError('')
    try {
      await joinRoom(codeInput)
      setToast('You joined the room!')
    } catch (err) {
      setJoinError(
        err.code === 'permission-denied'
          ? 'Invalid join code — the code is required to join this room.'
          : `Could not join: ${err.message}`,
      )
    } finally {
      setJoining(false)
    }
  }

  const handleTrigger = async () => {
    try {
      await trigger()
      // Best-effort push to every other subscribed device.
      if (roomId && authState.user && room?.joinCode) {
        const idToken = await authState.user.getIdToken()
        void sendPushAlert({
          roomId,
          uid: authState.user.uid,
          idToken,
          title: '🚨 ALARM',
          body: `${authState.user.displayName || 'Someone'} triggered the alarm in your room.`,
          url: `${window.location.origin}/alarm?room=${roomId}`,
        })
      }
    } catch (err) {
      console.error('Failed to trigger alarm:', err)
      setToast('Could not trigger the alarm')
    }
  }

  const handleStop = async () => {
    try {
      await stop()
      setToast('Alarm stopped')
    } catch (err) {
      console.error('Failed to stop alarm:', err)
      setToast('Could not stop the alarm')
    }
  }

  const handleTogglePush = async () => {
    if (pushState === 'enabled') {
      await disablePush(roomId)
      setPushState('idle')
      setToast('Device alerts disabled')
      return
    }
    setPushState('working')
    try {
      const result = await enablePush(roomId, authState.user)
      setPushState(result.status)
      if (result.status === 'enabled') setToast('Device alerts enabled')
    } catch (err) {
      console.error('Failed to enable push:', err)
      setPushState('error')
    }
  }

  const handleRegenerateCode = async () => {
    const nextCode = makeJoinCode()
    try {
      await updateDoc(alarmRoomRef, { joinCode: nextCode })
      setToast('New join code generated')
    } catch (err) {
      console.error('Failed to regenerate join code:', err)
      setToast('Could not regenerate the code')
    }
  }

  const handleRemoveMember = async (uid) => {
    if (!room) return
    setRemoving(true)
    try {
      await updateDoc(alarmRoomRef, {
        members: room.members.filter((m) => m !== uid),
        memberProfiles: Object.fromEntries(
          Object.entries(room.memberProfiles).filter(([key]) => key !== uid),
        ),
      })
      setToast('Member removed')
    } catch (err) {
      console.error('Failed to remove member:', err)
      setToast('Could not remove member')
    } finally {
      setRemoving(false)
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

  if (!roomId) {
    return (
      <div className="page fade-up">
        <div className="brand">
          <span className="brand-bell" aria-hidden="true">🔔</span>
          <span className="brand-name">Alarm App</span>
        </div>
        <div className="card">
          <h2>Missing room</h2>
          <p className="muted">This link doesn't include a room id. Create a room to get a shareable invite link.</p>
          <div className="controls">
            <button className="btn btn-primary" onClick={() => navigate('/')}>Create a room</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Not a member: gate behind the join code ─────────────────────────
  if (access === 'invited' || access === 'denied' || access === 'missing') {
    const denied = access === 'denied'
    const missing = access === 'missing'
    return (
      <div className="page fade-up">
        <div className="brand">
          <span className="brand-bell" aria-hidden="true">🔔</span>
          <span className="brand-name">Alarm App</span>
        </div>
        <div className="card join-card">
          {missing ? (
            <>
              <span className="join-icon" aria-hidden="true">🕳️</span>
              <h2>Room not found</h2>
              <p className="muted">This room doesn't exist or was removed. Ask the owner for a fresh invite link.</p>
            </>
          ) : denied ? (
            <>
              <span className="join-icon" aria-hidden="true">⚠️</span>
              <h2>Can't reach the room</h2>
              <p className="muted">Something went wrong reading this room. Check your connection and try again.</p>
            </>
          ) : (
            <>
              <span className="join-icon" aria-hidden="true">🔒</span>
              <h2>Private room</h2>
              <p className="muted">
                This room is restricted to invited members. Enter the join code from
                the invite link to join.
              </p>
            </>
          )}

          {!missing && !denied && (
            <form className="join-form" onSubmit={handleJoin}>
              <label htmlFor="join-code">Join code</label>
              <input
                id="join-code"
                className="code-input"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={10}
                autoComplete="off"
              />
              {joinError && <p className="error" role="alert">{joinError}</p>}
              <button className="btn btn-primary btn-lg" type="submit" disabled={joining || !codeInput.trim()}>
                {joining ? 'Joining…' : 'Join room'}
              </button>
            </form>
          )}

          {!missing && !denied && (
            <div className="controls">
              <button className="btn btn-ghost" onClick={() => navigate('/')}>Create my own room</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (access === 'loading' || !room) {
    return (
      <div className="page">
        <div className="spinner" aria-label="Loading room" />
        <p className="muted">Loading room…</p>
      </div>
    )
  }

  // ── Member view ─────────────────────────────────────────────────────
  const isOwner = room.ownerUid === authState.user.uid
  const isTriggerer = room.triggeredBy === authState.user.uid
  const inviteUrl = `${window.location.origin}/alarm?room=${roomId}&code=${room.joinCode}`

  let statusText
  let statusKind = 'listening'
  if (isTriggerer) {
    statusText = roomActive ? '🔔 Your alarm is ringing on other devices…' : 'Alarm stopped — ready to trigger again.'
    statusKind = roomActive ? 'ringing' : 'ready'
  } else if (alarmActive) {
    statusText = '🚨 Alarm ringing — another device triggered it.'
    statusKind = 'ringing'
  } else {
    statusText = 'Listening for alarms…'
  }

  const pushText =
    pushState === 'enabled' ? 'Device alerts are on' :
    pushState === 'needs-permission' ? 'Allow notifications to get alerts here' :
    pushState === 'denied' ? 'Notifications are blocked in browser settings' :
    pushState === 'unsupported' ? 'This browser does not support push alerts' :
    pushState === 'error' ? 'Could not enable alerts — try again' :
    pushState === 'working' ? 'Setting up…' :
    'Get an alert even when the page is closed'

  return (
    <div className="page fade-up">
      <div className="brand">
        <span className="brand-bell" aria-hidden="true">🔔</span>
        <span className="brand-name">Alarm App</span>
      </div>

      <div className="room-header">
        <div className="room-code-chip">
          <span className="chip-label">Room</span>
          <code>{roomId}</code>
          <button
            className="btn btn-icon"
            title="Copy room id"
            aria-label="Copy room id"
            onClick={() => copyText(roomId, 'Room id copied!')}
          >
            📋
          </button>
        </div>
        <div className="room-code-chip chip-code">
          <span className="chip-label">Join code</span>
          <code>{room.joinCode}</code>
          <button
            className="btn btn-icon"
            title="Copy join code"
            aria-label="Copy join code"
            onClick={() => copyText(room.joinCode, 'Join code copied!')}
          >
            📋
          </button>
        </div>
      </div>

      <div className="card invite-card">
        <h3>Invite members</h3>
        <p className="muted">
          Share this link — anyone with it can join the room. Only members can see or trigger alarms.
        </p>
        <div className="share-box">
          <input type="text" value={inviteUrl} readOnly aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button className="btn btn-primary" onClick={() => copyText(inviteUrl, 'Invite link copied!')}>Copy</button>
        </div>
        {isOwner && (
          <button className="btn btn-ghost btn-sm" onClick={handleRegenerateCode} disabled={removing}>
            ↻ Regenerate join code
          </button>
        )}
      </div>

      <div className="card members-card">
        <h3>Members <span className="member-count">{room.members.length}</span></h3>
        <ul className="member-list">
          {room.members.map((uid) => {
            const member = room.memberProfiles?.[uid] || { name: uid.slice(0, 6) }
            return (
              <MemberRow
                key={uid}
                member={member}
                uid={uid}
                isOwner={uid === room.ownerUid}
                isSelf={uid === authState.user.uid}
                onRemove={handleRemoveMember}
              />
            )
          })}
        </ul>
      </div>

      <div className="card alerts-card">
        <h3>Device alerts</h3>
        <p className="muted">{pushText}</p>
        {pushSupported() ? (
          <button
            className={`btn ${pushState === 'enabled' ? 'btn-ghost' : 'btn-primary'}`}
            onClick={handleTogglePush}
            disabled={pushState === 'working' || pushState === 'denied'}
          >
            {pushState === 'enabled' ? 'Disable device alerts' : 'Enable device alerts'}
          </button>
        ) : isIOS() && !isStandalone() ? (
          <IosInstallBanner />
        ) : (
          <p className="muted small">
            Web Push isn't available here — alarms still ring in the open tab, and the
            Notification API covers background tabs where the browser allows it.
          </p>
        )}
      </div>

      <div className="controls trigger-controls">
        {!roomActive && (
          <button className="btn btn-alarm btn-lg" onClick={handleTrigger} disabled={removing}>
            <span aria-hidden="true">🚨</span> Trigger Alarm
          </button>
        )}
        {isTriggerer && roomActive && (
          <button className="btn btn-stop btn-lg" onClick={handleStop}>
            <span aria-hidden="true">⏹</span> Stop Alarm
          </button>
        )}
      </div>

      <p className={`status-pill ${statusKind}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {statusText}
      </p>

      <Toast message={toast} />

      {alarmActive && (
        <div className="alarm-overlay" role="alertdialog" aria-label="Alarm ringing">
          <div className="alarm-bell" aria-hidden="true">🚨</div>
          <h1 className="alarm-title">ALARM</h1>
          <p>A member of this room triggered an alarm.</p>
          <p className="sound-hint">
            If you can't hear a sound, click anywhere on this page first — browsers block
            audio until you interact.
          </p>
          <button className="btn alarm-ack" onClick={acknowledge}>Acknowledge</button>
        </div>
      )}
    </div>
  )
}

export default AlarmRoom