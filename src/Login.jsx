import { useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
} from 'firebase/auth'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { auth } from './firebase'

const EMULATOR_MODE = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'

function Login() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') || '/'

  useEffect(() => {
    // Redirect straight to the intended destination when already signed in.
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) navigate(next.startsWith('/login') ? '/' : next)
    })
    return unsubscribe
  }, [navigate, next])

  const googleSignIn = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      await signInWithPopup(auth, new GoogleAuthProvider())
      // onAuthStateChanged redirects to `next`
    } catch (err) {
      setError(`Sign in failed: ${err.message}`)
      setLoading(false)
    }
  }

  const emailSignIn = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError('')
    try {
      await signInWithEmailAndPassword(auth, email, password)
      // onAuthStateChanged redirects to `next`
    } catch (err) {
      setError(`Sign in failed: ${err.message}`)
      setLoading(false)
    }
  }

  return (
    <div className="page fade-up">
      <div className="brand">
        <span className="brand-bell" aria-hidden="true">🔔</span>
        <span className="brand-name">Alarm App</span>
      </div>
      <div className="card login-card">
        <h2>Welcome back</h2>
        <p className="muted">Sign in to create and join private alarm rooms.</p>

        <button className="btn btn-google" onClick={googleSignIn} disabled={loading}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.2 5.2C37.1 40.2 44 35 44 24c0-1.3-.1-2.6-.4-3.9z"/>
          </svg>
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>

        {EMULATOR_MODE && (
          <>
            <div className="divider"><span>or use a test account</span></div>
            <form className="login-form" onSubmit={emailSignIn}>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

export default Login