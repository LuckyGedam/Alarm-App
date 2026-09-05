import React, { useState, useEffect } from 'react'
import { auth, db } from './firebase'
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'

function Login() {
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    // Check if already signed in
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        // Initialize alarm document for this user
        const alarmRef = doc(db, 'alarms', user.uid)
        setDoc(alarmRef, {
          lastTriggered: null,
          triggeredBy: null
        }, { merge: true }).then(() => {
          navigate('/')
        })
      }
    })
    return () => unsubscribe()
  }, [navigate])

  const googleSignIn = async () => {
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider())
      const uid = result.user.uid
      const alarmRef = doc(db, 'alarms', uid)
      setDoc(alarmRef, {
        lastTriggered: null,
        triggeredBy: null
      }, { merge: true }).then(() => {
        navigate('/')
      })
    } catch (error) {
      setError(`Sign in failed: ${error.message}`)
    }
  }

  return (
    <div style={{ padding: '40px', textAlign: 'center', maxWidth: '400px', margin: '0 auto' }}>
      <h2>Alarm App - Device Notifier</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button 
        onClick={googleSignIn}
        style={{
          padding: '12px 24px', 
          fontSize: '16px', 
          margin: '10px 0',
          cursor: 'pointer'
        }}
      >
        Continue with Google
      </button>
      <p style={{ marginTop: '20px', fontSize: '14px' }}>
        After signing in, share the link below with another device to receive alarms
      </p>
      <input 
        type="text" 
        id="room-link"
        value={window.location.href}
        readOnly
        style={{
          width: '100%', 
          padding: '10px', 
          fontSize: '14px',
          marginBottom: '10px'
        }}
      />
      <button 
        onClick={() => navigator.clipboard && navigator.clipboard.writeText(window.location.href)}
        style={{
          padding: '8px 16px', 
          fontSize: '14px', 
          cursor: 'pointer'
        }}
      >
        Copy Link
      </button>
      <p style={{ marginTop: '10px', fontSize: '12px' }}>
        Share this link with another device to receive alarms
      </p>
    </div>
  )
}

export default Login