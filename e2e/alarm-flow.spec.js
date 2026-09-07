// End-to-end alarm flow against the Firebase Auth + Firestore emulators.
//
// Two signed-in devices in one room:
//   1. Device A creates a private room (gets a join code)
//   2. Device B opens the invite link, signs in, joins with the code
//   3. Device A triggers → Device B rings → B acknowledges → A stops
// Plus access-control checks: a random signed-in user without the code
// cannot read or join the room.
//
// Run with: npm run test:e2e
// (starts the emulators via `firebase emulators:exec`, which also loads
//  firestore.rules, then boots the dev server in emulator mode)
import { test, expect } from '@playwright/test'

const AUTH_EMULATOR =
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp'

// Create a test user directly in the Auth emulator.
async function createUser(email, password) {
  const res = await fetch(`${AUTH_EMULATOR}?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`Could not create user ${email}: ${res.status}`)
}

// Sign in through the (emulator-only) email/password form.
async function signIn(page, email, password) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/$|\/alarm\?/)
}

const ALICE = { email: 'alice@test.dev', password: 'password123' }
const BOB = { email: 'bob@test.dev', password: 'password123' }
const CAROL = { email: 'carol@test.dev', password: 'password123' }

test.beforeAll(async () => {
  await Promise.all([createUser(ALICE.email, ALICE.password), createUser(BOB.email, BOB.password), createUser(CAROL.email, CAROL.password)])
})

test('two signed-in devices: trigger → ring → acknowledge → stop', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const deviceA = await ctxA.newPage()
  const deviceB = await ctxB.newPage()

  // ── Device A: sign in and create a private room ─────────────────
  await signIn(deviceA, ALICE.email, ALICE.password)
  await deviceA.getByRole('button', { name: /Create Alarm Room/i }).click()
  await deviceA.waitForURL(/\/alarm\?room=/)
  const inviteUrl = deviceA.url()
  expect(inviteUrl).toMatch(/code=/)
  await expect(deviceA.getByText(/Listening for alarms/i)).toBeVisible()

  // Owner sees their own member row.
  await expect(deviceA.getByText('alice')).toBeVisible()

  // ── Device B: open the invite link, sign in, join with the code ─
  await deviceB.goto(inviteUrl)
  await signIn(deviceB, BOB.email, BOB.password)
  // Sign-in redirects back to the invite link (next param), which shows
  // the private-room gate with the code pre-filled from the URL.
  await deviceB.waitForURL(/\/alarm\?room=/)
  await expect(deviceB.getByText('Private room')).toBeVisible()
  await deviceB.getByRole('button', { name: 'Join room' }).click()

  // B is now a member: sees the listening state and both members.
  await expect(deviceB.getByText(/Listening for alarms/i)).toBeVisible()
  await expect(deviceB.getByText('bob')).toBeVisible()

  // ── Trigger on A ────────────────────────────────────────────────
  await deviceA.getByRole('button', { name: /Alarm/i }).click()

  // B rings: full-screen alarm overlay + ringing status.
  await expect(deviceB.getByText('ALARM')).toBeVisible()
  await expect(deviceB.getByText(/Alarm ringing/i)).toBeVisible()

  // A reports the alarm is live on other devices.
  await expect(deviceA.getByText(/ringing on other devices/i)).toBeVisible()

  // ── B acknowledges: local silence only ──────────────────────────
  await deviceB.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(deviceB.getByText('ALARM')).toBeHidden()
  await expect(deviceB.getByText(/Listening for alarms/i)).toBeVisible()

  // A still sees the alarm as active.
  await expect(deviceA.getByText(/ringing on other devices/i)).toBeVisible()

  // ── A stops: alarm cleared for everyone ─────────────────────────
  await deviceA.getByRole('button', { name: /Stop Alarm/i }).click()
  await expect(deviceA.getByText(/ready to trigger/i)).toBeVisible()
  await expect(deviceB.getByText(/Listening for alarms/i)).toBeVisible()

  await ctxA.close()
  await ctxB.close()
})

test('a random signed-in user cannot read or join a room without the join code', async ({ browser }) => {
  // Set up a room owned by Alice.
  const ctxOwner = await browser.newContext()
  const owner = await ctxOwner.newPage()
  await signIn(owner, ALICE.email, ALICE.password)
  await owner.getByRole('button', { name: /Create Alarm Room/i }).click()
  await owner.waitForURL(/\/alarm\?room=/)
  const { roomId } = Object.fromEntries(new URL(owner.url()).searchParams)
  await ctxOwner.close()

  // Carol — a signed-in user with no invitation — opens the room link
  // WITHOUT the join code.
  const ctxCarol = await browser.newContext()
  const carol = await ctxCarol.newPage()
  await signIn(carol, CAROL.email, CAROL.password)
  await carol.goto(`/alarm?room=${roomId}`)

  // She only sees the join gate — never the room state.
  await expect(carol.getByText('Private room')).toBeVisible()
  await expect(carol.getByRole('button', { name: /Alarm/i })).toBeHidden()
  await expect(carol.getByText(/Listening for alarms/i)).toBeHidden()

  // Joining with a wrong code is rejected by the security rules.
  await carol.getByLabel('Join code').fill('WRONG1')
  await carol.getByRole('button', { name: 'Join room' }).click()
  await expect(carol.getByText(/Invalid join code/i)).toBeVisible()

  // Still locked out afterwards.
  await expect(carol.getByRole('button', { name: /Alarm/i })).toBeHidden()

  await ctxCarol.close()
})