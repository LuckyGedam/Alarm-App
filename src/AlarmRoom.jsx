import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { addDoc, collection, doc, updateDoc } from 'firebase/firestore'
import { auth, db } from './firebase'
import { useRoomAlarm } from './useRoomAlarm'
import { usePushHistory } from './usePushHistory'
import { useCheckins } from './useCheckins'
import { playAlarm } from './alarmSound'
import { avatarGradient, initialsOf, makeJoinCode } from './roomUtils'
import { enablePush, disablePush, pushSupported, sendPushAlert, sendTestPush, storedDeviceId, storeSubscription, vapidConfigured } from './push'
import { captureAndUploadCheckin, cameraCaptureSupported } from './checkin'
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

const PLATFORM_LABELS = { android: 'Android', ios: 'iOS', desktop: 'Desktop' }

function timeAgo(at) {
  if (!at) return ''
  const seconds = Math.max(1, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function platformBreakdown(platforms = {}) {
  const parts = Object.entries(platforms)
    .filter(([, value]) => value && value.total > 0)
    .map(([key, value]) => `${value.pushed}/${value.total} ${PLATFORM_LABELS[key] || key}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
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
  const [diag, setDiag] = useState(null)
  const [diagRunning, setDiagRunning] = useState(false)
  const [testingPush, setTestingPush] = useState(false)
  const [pushState, setPushState] = useState('idle') // idle | working | enabled | needs-permission | denied | unsupported | error
  const [removing, setRemoving] = useState(false)
  const [burstCount, setBurstCount] = useState(3) // repeats per recipient device: 1 | 3 | 5 | 10
  const [consentDismissed, setConsentDismissed] = useState(false)
  const [consentSaving, setConsentSaving] = useState(false)
  const alarmRoomRef = useMemo(() => (roomId ? doc(db, 'rooms', roomId) : null), [roomId])
  const notificationTimer = useRef(null)
  const checkinDoneRef = useRef(false)

  const { room, access, roomActive, alarmActive, trigger, stop, acknowledge, joinRoom } =
    useRoomAlarm(roomId, authState.user)
  const pushes = usePushHistory(roomId, access === 'member')
  const checkins = useCheckins(roomId, access === 'member')

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
  // worker shows the burst notifications for background/closed pages itself,
  // so an in-tab notification would just duplicate them. We wait for the
  // push check to settle before showing anything, so the two paths never
  // race into a duplicate.
  useEffect(() => {
    if (!alarmActive || typeof Notification === 'undefined') return undefined
    if (Notification.permission !== 'granted') return undefined

    let disposed = false
    let hasPush = false
    let settled = false
    let shown = false

    const show = () => {
      if (disposed || !settled || hasPush || shown || !document.hidden) return
      shown = true
      const n = new Notification('🚨 ALARM', {
        body: 'An alarm is ringing in your room.',
        tag: `alarm-${roomId}`,
        renotify: true,
      })
      notificationTimer.current = setTimeout(() => n.close(), 20000)
    }

    ;(async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        hasPush = Boolean(subscription)
      } catch {
        // Can't tell — treat as no push and use the in-tab fallback.
      } finally {
        settled = true
        show()
      }
    })()

    const onVisibility = () => {
      if (document.hidden) {
        show()
      } else {
        clearTimeout(notificationTimer.current)
        shown = false
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(notificationTimer.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [alarmActive, roomId])

  const isMember = Boolean(room && access === 'member')

  // Restore the push state for this room on load. If alerts were enabled
  // before (a device id is on file), refresh the stored subscription in
  // Firestore so it always matches what pushManager actually holds — the
  // relay may have pruned the doc as stale, or the browser may have swapped
  // the endpoint. If the browser invalidated the subscription entirely,
  // silently re-subscribe (no permission prompt — it was granted earlier).
  useEffect(() => {
    if (!roomId || !authState.user || !isMember) return undefined
    if (!pushSupported() || !storedDeviceId()) return undefined
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return undefined
    let cancelled = false
    ;(async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        if (subscription) {
          // Subscription alive: make sure the room's pushDevices doc points
          // at it (idempotent), then report the device as enabled.
          await storeSubscription(roomId, authState.user, subscription)
          if (!cancelled) setPushState('enabled')
          return
        }
        const result = await enablePush(roomId, authState.user, { silent: true })
        if (!cancelled && result.status === 'enabled') setPushState('enabled')
      } catch (error) {
        console.warn('Could not restore push alerts:', error?.message || error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [roomId, authState.user, isMember])

  // ── Camera check-in consent ────────────────────────────────────────
  // Consent lives on the member profile (memberProfiles.<uid>.cameraConsent)
  // so it survives relay pruning of pushDevices docs and disable/enable
  // toggles. Shown when this device has alerts on but the member has not
  // consented yet; nothing about the camera runs before consent is true.
  const cameraConsent = Boolean(room?.memberProfiles?.[authState.user?.uid]?.cameraConsent)
  const showConsentDialog = isMember && pushState === 'enabled' && !consentDismissed && !cameraConsent

  // Capture once per page session when this device has alerts enabled and
  // the member consented. Runs on load (a notification tap loads the room
  // with ?via=notification, which marks the check-in as such). Camera
  // failures (denied/unavailable) are skipped inside captureAndUploadCheckin
  // and never retried in a loop.
  useEffect(() => {
    if (!roomId || !authState.user || !isMember) return undefined
    if (pushState !== 'enabled' || !cameraConsent) return undefined
    if (checkinDoneRef.current) return undefined
    checkinDoneRef.current = true
    const triggeredByNotification = searchParams.get('via') === 'notification'
    if (triggeredByNotification) {
      // Keep the URL clean for reloads/shares.
      navigate(`/alarm?room=${roomId}`, { replace: true })
    }
    captureAndUploadCheckin({
      roomId,
      uid: authState.user.uid,
      triggeredByNotification,
    })
    return undefined
  }, [roomId, authState.user, isMember, pushState, cameraConsent, searchParams, navigate])

  const handleCameraConsent = async (allow) => {
    if (!allow) {
      setConsentDismissed(true)
      return
    }
    setConsentSaving(true)
    try {
      await updateDoc(alarmRoomRef, {
        [`memberProfiles.${authState.user.uid}.cameraConsent`]: true,
      })
      flashToast('Camera check-ins enabled — opening the app will capture a few photos for the room')
    } catch (err) {
      console.error('Failed to save camera consent:', err)
      flashToast('Could not save camera consent — try again')
    } finally {
      setConsentSaving(false)
      setConsentDismissed(true)
    }
  }

  const copyText = useCallback(
    (text, label = 'Copied!') => {
      navigator.clipboard?.writeText(text).catch(() => {})
      setToast(label)
      window.setTimeout(() => setToast(''), 1600)
    },
    [],
  )

  const flashToast = (message, ms = 2400) => {
    setToast(message)
    window.setTimeout(() => setToast(''), ms)
  }


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

  // Auto-join: an invite link carries the join code, so a signed-in invitee
  // lands directly in the room without tapping "Join room". The code is then
  // stripped from the URL. A wrong/expired code falls back to the join form
  // with the error shown (no retry loop).
  const autoJoinAttempted = useRef(false)
  useEffect(() => {
    if (access !== 'invited' || !authState.user) return undefined
    if (!urlCode || autoJoinAttempted.current) return undefined
    autoJoinAttempted.current = true
    setJoining(true)
    setJoinError('')
    joinRoom(urlCode)
      .then(() => {
        navigate(`/alarm?room=${roomId}`, { replace: true })
        setToast('You joined the room!')
      })
      .catch((err) => {
        setJoinError(
          err.code === 'permission-denied'
            ? 'The join code in this link is no longer valid — ask the owner for a fresh invite link.'
            : `Could not join: ${err.message}`,
        )
      })
      .finally(() => setJoining(false))
    return undefined
  }, [access, urlCode, roomId, authState.user, joinRoom, navigate])

  const handleTrigger = async () => {
    try {
      await trigger()
      // Best-effort push to every other subscribed device, then tell the
      // triggerer how many devices actually got the push.
      let message = 'Alarm triggered'
      if (roomId && authState.user && room?.joinCode) {
        const idToken = await authState.user.getIdToken()
        const result = await sendPushAlert({
          roomId,
          uid: authState.user.uid,
          idToken,
          title: '🚨 ALARM',
          body: `${authState.user.displayName || 'Someone'} triggered the alarm in your room.`,
          url: `${window.location.origin}/alarm?room=${roomId}`,
          count: burstCount,
        })
        if (result) {
          // Record the delivery outcome so every member can see it.
          addDoc(collection(db, 'rooms', roomId, 'pushes'), {
            at: new Date(),
            byUid: authState.user.uid,
            byName: authState.user.displayName || authState.user.email?.split('@')[0] || 'Member',
            pushed: result.pushed,
            total: result.total,
            notificationsSent: result.notificationsSent || 0,
            stale: result.stale || 0,
            platforms: result.platforms || {},
          }).catch((error) => console.warn('Could not record push history:', error?.message || error))
          message =
            result.total === 0
              ? 'Alarm triggered — no other devices have alerts enabled'
              : `Sent ${result.notificationsSent || 0} alert${result.notificationsSent === 1 ? '' : 's'} to ${result.pushed} of ${result.total} device${result.total === 1 ? '' : 's'}`
        }
      }
      flashToast(message, 3600)
    } catch (err) {
      console.error('Failed to trigger alarm:', err)
      flashToast('Could not trigger the alarm', 3200)
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

  // One-tap diagnostics: prints the browser's exact push state so failures
  // (blocked permission, missing SW, invalid VAPID, subscribe errors) can be
  // identified without Vercel logs or DevTools.
  const runDiagnostics = async () => {
    setDiagRunning(true)
    const out = {}
    try {
      out.userAgent = navigator.userAgent.slice(0, 140)
      out.notificationPermission =
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
      out.serviceWorkerApi = 'serviceWorker' in navigator
      out.pushManagerApi = 'PushManager' in window
      out.vapidKeyPresent = vapidConfigured()
      out.pushSupported = pushSupported()
      try {
        const registration = await navigator.serviceWorker.getRegistration()
        out.swRegistered = Boolean(registration)
        out.swScope = registration?.scope || null
        const subscription = await registration?.pushManager.getSubscription()
        out.subscription = subscription
          ? { endpoint: subscription.endpoint.slice(0, 90), expirationTime: subscription.expirationTime || null }
          : null
      } catch (error) {
        out.swError = `${error?.name}: ${error?.message}`
      }
      if (out.notificationPermission === 'granted' && !out.subscription && pushSupported()) {
        try {
          const result = await enablePush(roomId, authState.user, { silent: true })
          out.silentResubscribeResult = result.status
          const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
          out.subscription = subscription
            ? { endpoint: subscription.endpoint.slice(0, 90), expirationTime: subscription.expirationTime || null }
            : null
        } catch (error) {
          out.subscribeError = `${error?.name}: ${error?.message}`
        }
      }
    } catch (error) {
      out.unexpectedError = `${error?.name}: ${error?.message}`
    }
    setDiag(out)
    setDiagRunning(false)
  }

  const handleTogglePush = async () => {
    if (pushState === 'enabled') {
      await disablePush(roomId)
      setPushState('idle')
      // A later re-enable asks for camera consent again (if not yet given).
      setConsentDismissed(false)
      setToast('Device alerts disabled')
      return
    }
    setPushState('working')
    try {
      const result = await enablePush(roomId, authState.user)
      setPushState(result.status)
      if (result.status === 'enabled') {
        setToast('Device alerts enabled')
        // First-time enable: if the member has not consented to camera
        // check-ins yet, the consent dialog shows next.
      }
    } catch (err) {
      console.error('Failed to enable push:', err)
      setPushState('error')
    }
  }

  // Self-test: push to THIS device's own stored subscription so end-to-end
  // delivery can be verified without a second member triggering a real alarm.
  // `total === 0` means no pushDevices doc is on file for this user in this
  // room — the one thing the browser diagnostics cannot see.
  const handleTestPush = async () => {
    if (!roomId || !authState.user || testingPush) return
    setTestingPush(true)
    try {
      const idToken = await authState.user.getIdToken()
      const result = await sendTestPush({ roomId, uid: authState.user.uid, idToken })
      if (!result) {
        flashToast('Test push failed — check the Vercel runtime logs for /api/ring', 3600)
        return
      }
      if (result.total === 0) {
        flashToast('No stored subscription for this device — disable and re-enable device alerts', 3600)
        return
      }
      flashToast(
        `Test push sent to ${result.pushed} of ${result.total} device${result.total === 1 ? '' : 's'} — check your notification`,
        3600,
      )
    } catch (err) {
      console.error('Test push failed:', err)
      flashToast('Could not send the test push', 3200)
    } finally {
      setTestingPush(false)
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
    pushState === 'denied' ? 'Notifications are blocked — tap the lock/ℹ️ icon in the address bar → Site settings → Notifications → Allow' :
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

        {pushState === 'enabled' && (
          <button className="btn btn-ghost btn-sm" onClick={handleTestPush} disabled={testingPush}>
            {testingPush ? 'Sending…' : '🔔 Send test push'}
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={runDiagnostics} disabled={diagRunning}>
          {diagRunning ? 'Running…' : '🔍 Run diagnostics'}
        </button>
        {diag && (
          <pre className="diag-output">{JSON.stringify(diag, null, 2)}</pre>
        )}
      </div>

      {pushes.length > 0 && (
        <div className="card pushes-card">
          <h3>Recent pushes <span className="member-count">{pushes.length}</span></h3>
          <ul className="push-list">
            {pushes.map((p) => (
              <li className="push-row" key={p.id}>
                <div className="push-main">
                  <span className="push-who">{p.byName || 'A member'}</span>
                  <span className="push-time">{timeAgo(p.at)}</span>
                </div>
                <span className="push-result">
                  {p.notificationsSent
                    ? `Sent ${p.notificationsSent} alert${p.notificationsSent === 1 ? '' : 's'} to ${p.pushed} of ${p.total} device${p.total === 1 ? '' : 's'}`
                    : `Sent to ${p.pushed} of ${p.total} device${p.total === 1 ? '' : 's'}`}
                  {platformBreakdown(p.platforms)}
                  {p.stale > 0 ? ` · ${p.stale} stale pruned` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Counts reflect push services that accepted the delivery — the receiving device
            must be online with device alerts enabled.
          </p>
        </div>
      )}

      {checkins.length > 0 && (
        <div className="card checkins-card">
          <h3>Recent check-ins <span className="member-count">{checkins.length}</span></h3>
          <ul className="checkin-list">
            {checkins.map((c) => {
              const member = room.memberProfiles?.[c.uid]
              const name = member?.name || c.uid.slice(0, 6)
              return (
                <li className="checkin-row" key={c.id}>
                  <MemberAvatar name={name} photoURL={member?.photoURL} />
                  <div className="checkin-main">
                    <div className="checkin-head">
                      <span className="checkin-who">
                        {name}
                        {c.triggeredByNotification && <span className="badge">via notification</span>}
                      </span>
                      <span className="checkin-time">{timeAgo(c.timestamp)}</span>
                    </div>
                    <div className="checkin-photos">
                      {(c.photoUrls || []).map((url, i) => (
                        <a key={`${url}-${i}`} href={url} target="_blank" rel="noreferrer">
                          <img
                            src={url}
                            alt={`${name}'s check-in photo ${i + 1}`}
                            loading="lazy"
                            className="checkin-thumb"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="muted small">
            Front-camera photos captured when a consenting member opened the app.
          </p>
        </div>
      )}

      <div className="controls trigger-controls">
        {!roomActive && (
          <div className="burst-wrap">
            <div className="burst-row">
              <span className="burst-label">Repeats per device</span>
              <div className="burst-opts" role="radiogroup" aria-label="Repeats per device">
                {[1, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    className={`burst-opt${burstCount === n ? ' active' : ''}`}
                    aria-pressed={burstCount === n}
                    onClick={() => setBurstCount(n)}
                    type="button"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-alarm btn-lg" onClick={handleTrigger} disabled={removing}>
              <span aria-hidden="true">🚨</span> Trigger Alarm
            </button>
          </div>
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

      {showConsentDialog && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title">
          <div className="card consent-card">
            <span className="consent-icon" aria-hidden="true">📷</span>
            <h3 id="consent-title">Camera check-ins</h3>
            <p className="muted">
              You enabled device alerts for this room. To leave a visible confirmation trail, opening this
              app — including by tapping an alarm notification — will take a few photos with the front
              camera and upload them so other room members can see them as your check-in.
            </p>
            {!cameraCaptureSupported() && (
              <p className="muted small">
                This device has no camera access available right now; consent is still recorded for when it does.
              </p>
            )}
            <div className="controls">
              <button
                className="btn btn-primary"
                onClick={() => handleCameraConsent(true)}
                disabled={consentSaving}
              >
                {consentSaving ? 'Saving…' : 'I agree'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => handleCameraConsent(false)}
                disabled={consentSaving}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

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