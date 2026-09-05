import React, { useState, useEffect } from 'react'
import { auth, db } from './firebase'
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider } from 'firebase/auth'
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import { useNavigate, useLocation } from 'react-router-dom'
import './App.css'

function App() {
  const navigate = useNavigate()
  const _location = useLocation()
  const [user, setUser] = useState(null)
  const [_alarmActive, setAlarmActive] = useState(false)
  const [isHosting, setIsHosting] = useState(false)
  const alarmRef = doc(db, 'alarms', 'global')

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user)
      if (!user) navigate('/login')
    })
    return () => unsubscribe()
  }, [navigate])

  useEffect(() => {
    if (!user) return
    const alarmUnsubscribe = onSnapshot(alarmRef, (doc) => {
      if (doc.exists()) {
        const data = doc.data()
        // Check for new alarm trigger
        if (data.lastTriggered && data.triggeredBy !== user.uid) {
          const lastTime = new Date(data.lastTriggered).getTime()
          const now = new Date().getTime()
          // If alarm triggered within last 30 seconds and from different device
          if (now - lastTime < 30000) {
            setAlarmActive(true)
          }
        }
      }
    })
    return () => alarmUnsubscribe()
  }, [user, alarmRef])

  useEffect(() => {
    // Google sign-in
    const googleSignIn = () => {
      signInWithPopup(auth, new GoogleAuthProvider())
        .then((result) => {
          const _uid = result.user.uid
          // Initialize alarm document for this user if not exists
          setDoc(alarmRef, {
            lastTriggered: null,
            triggeredBy: _uid
          }, { merge: true })
        })
        .catch((error) => {
          console.error('Sign in error:', error)
        })
    }
    googleSignIn()
  }, [user, alarmRef])

  const joinRoom = (roomId) => {
    localStorage.setItem('deviceId', roomId)
    setIsHosting(true)
    navigate(`/alarm?room=${roomId}`)
  }

  const _triggerAlarm = () => {
    if (!user) return
    const now = new Date().toISOString()
    updateDoc(alarmRef, {
      lastTriggered: now,
      triggeredBy: user.uid
    })
  }

  return (
    <div className="App">
      {user ? (
        <>
          {isHosting ? (
            <AlarmRoom user={user} setAlarmActive={setAlarmActive} />
          ) : (
            <div>
              <h2>Alarm Notification System</h2>
              <p>
                Share this link with another device:{' '}
                <code>{window.location.href}</code>
              </p>
              <button
                onClick={() => joinRoom(Math.random().toString(36).substring(2, 15))}
                style={{
                  padding: '10px 20px',
                  fontSize: '16px',
                  marginBottom: '10px'
                }}
              >
                Connect as Receiver Device
              </button>
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '20px' }}>
          <h3>Please log in to use the alarm system</h3>
        </div>
      )}
    </div>
  )
}

function AlarmRoom({ user, setAlarmActive }) {
  const location = useLocation()
  const _roomId = location.query.room || ''

  useEffect(() => {
    // Listen for alarm events from Firebase
    const alarmRef = doc(db, 'alarms', 'global')
    const unsubscribe = onSnapshot(alarmRef, (doc) => {
      if (doc.exists()) {
        const data = doc.data()
        // Check for alarm trigger from different device
        if (data.lastTriggered && data.triggeredBy !== user.uid) {
          const lastTime = new Date(data.lastTriggered).getTime()
          const now = new Date().getTime()
          // If alarm triggered within last 30 seconds and from different device
          if (now - lastTime < 30000) {
            setAlarmActive(true)
            // Reset after handling so it doesn't persist
            setTimeout(() => setAlarmActive(false), 100)
          }
        }
      }
    })

    return () => unsubscribe()
  }, [user, setAlarmActive])

  useEffect(() => {
    if (_alarmActive) {
      // Play alarm sound
      const audio = new Audio()
      audio.src = 'https://assets.mixkit.co/active_storage_audio/mixkit-alarm-buzzer-beep-931.mp3'
      audio.loop = true
      audio.play().catch(() => {})

      // Show visual alert overlay
      const alertDiv = document.createElement('div')
      alertDiv.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.8); color: white; display: flex;
        flex-direction: column; align-items: center; justify-content: center;
        z-index: 9999; font-family: sans-serif;
      `
      alertDiv.innerHTML = `
        <h2>ALERT: Device is ONLINE</h2>
        <p>Alarm triggered from another device</p>
        <button 
          onClick="this.parentElement.parentElement.style.display='none'"
          style={{ padding: '10px 20px', marginTop: '20px', fontSize: '16px' }}
        >
          Acknowledge
        </button>
      `
      document.body.appendChild(alertDiv)
    }
  }, [])

  return (
    <div className="App">
      <h2>Alarm Controller</h2>
      <button
        onClick={_triggerAlarm}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          marginBottom: '10px'
        }}
      >
        Trigger Alarm on Other Device
      </button>
      {_alarmActive && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
          background: 'rgba(0,0,0,0.8)', color: 'white', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999
        }}>
          <h2>ALERT: Device is ONLINE</h2>
          <p>Alarm triggered from another device</p>
          <button
            onClick={() => setAlarmActive(false)}
            style={{
              padding: '10px 20px',
              marginTop: '20px',
              fontSize: '16px'
            }}
          >
            Stop Alarm
          </button>
        </div>
      )}
    </div>
  )
}

export default App