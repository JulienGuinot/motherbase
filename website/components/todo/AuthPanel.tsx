'use client'

import { useState } from 'react'
import { useAuth, useMotherbaseClient, useUser } from '@motherbase/ui'
import styles from './todo.module.css'

type AuthMode = 'login' | 'register'
type ResetStep = 'closed' | 'request' | 'confirm'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Sign in/up, sign out, and forgot-password. Client and session come from `MotherbaseProvider`. */
export function AuthPanel() {
  const { user } = useAuth()
  return user ? <SignedIn /> : <SignedOut />
}

function SignedIn() {
  const { user, signOut } = useAuth()
  const client = useMotherbaseClient()


  const sessions = client.auth.listSessions()
  console.log(sessions)
  return (
    <div className={`${styles.authBar} ${styles.authBarSignedIn}`}>
      <span className={styles.sessionBadge}>{user?.email}</span>
      <button className={`${styles.button} ${styles.buttonGhost}`} onClick={signOut}>
        Sign out
      </button>
    </div>
  )
}

function SignedOut() {
  const { client } = useAuth()
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetStep, setResetStep] = useState<ResetStep>('closed')

  async function submit() {
    setError('')
    setLoading(true)
    try {
      const { error } =
        mode === 'login'
          ? await client.auth.signIn.email({ email, password })
          : await client.auth.signUp.email({ email, password, name: email })
      if (error) throw new Error(error.message)
      // onAuthStateChange (wired by the caller) picks up the new session.
    } catch (err) {
      setError(messageOf(err, 'Authentication failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.authBar}>
      <p className={styles.authPrompt}>
        {mode === 'login' ? 'Sign in to scope your own todos' : 'Create an account'}
        <button className={styles.authModeToggle} onClick={() => setMode(m => (m === 'login' ? 'register' : 'login'))}>
          {mode === 'login' ? 'Register →' : '← Sign in'}
        </button>
      </p>

      <div className={styles.row}>
        <input
          className={styles.input}
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="email"
        />
        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="password"
        />
        <button className={`${styles.button} ${styles.buttonPrimary}`} onClick={submit} disabled={loading}>
          {loading ? '…' : mode === 'login' ? 'Sign in' : 'Register'}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}

      {mode === 'login' && (
        <PasswordReset
          email={email}
          step={resetStep}
          onStepChange={setResetStep}
        />
      )}
    </div>
  )
}

function PasswordReset({
  email,
  step,
  onStepChange,
}: {
  email: string
  step: ResetStep
  onStepChange: (step: ResetStep) => void
}) {
  const { client } = useAuth()
  const [resetEmail, setResetEmail] = useState(email)
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [info, setInfo] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (step === 'closed') {
    return (
      <button className={styles.linkButton} onClick={() => onStepChange('request')}>
        Forgot password?
      </button>
    )
  }

  async function requestCode() {
    setError('')
    setLoading(true)
    try {
      const { error } = await client.auth.emailOtp.requestPasswordReset({ email: resetEmail })
      if (error) throw new Error(error.message)
      setInfo('Check your email for a reset code.')
      onStepChange('confirm')
    } catch (err) {
      setError(messageOf(err, 'Failed to request reset'))
    } finally {
      setLoading(false)
    }
  }

  async function confirmReset() {
    setError('')
    setLoading(true)
    try {
      const { error } = await client.auth.emailOtp.resetPassword({ email: resetEmail, otp, password: newPassword })
      if (error) throw new Error(error.message)
      onStepChange('closed')
      setOtp('')
      setNewPassword('')
      setInfo('')
    } catch (err) {
      setError(messageOf(err, 'Failed to reset password'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.resetStep}>
      {info && <p className={styles.info}>{info}</p>}

      {step === 'request' ? (
        <div className={styles.row}>
          <input
            className={styles.input}
            type="email"
            value={resetEmail}
            onChange={e => setResetEmail(e.target.value)}
            placeholder="email"
          />
          <button className={`${styles.button} ${styles.buttonPrimary}`} onClick={requestCode} disabled={loading || !resetEmail}>
            {loading ? '…' : 'Send code'}
          </button>
          <button className={`${styles.button} ${styles.buttonGhost}`} onClick={() => onStepChange('closed')}>
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <input className={styles.input} value={otp} onChange={e => setOtp(e.target.value)} placeholder="reset code" />
          <input
            className={styles.input}
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="new password"
          />
          <button
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={confirmReset}
            disabled={loading || !otp || !newPassword}
          >
            {loading ? '…' : 'Reset password'}
          </button>
          <button className={`${styles.button} ${styles.buttonGhost}`} onClick={() => onStepChange('closed')}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
