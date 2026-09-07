// Unit tests for the /api/ring Web Push relay.
//
// No real FCM or VAPID secrets needed:
//   - Firestore is stubbed by mocking global fetch (ring.js reads rooms via
//     the Firestore REST API, web-push does its own TLS request and never
//     touches fetch).
//   - The push service is a local HTTPS server (tests/fixtures mock-push-*)
//     that web-push POSTs the encrypted payload to. The self-signed cert is
//     only trusted because NODE_TLS_REJECT_UNAUTHORIZED=0 is set below.
//
// Run with: npm run test:unit
import { test, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'
import ringHandler from '../api/ring.js'

// The relay's env vars are read per request, so they can live here.
const VAPID = webpush.generateVAPIDKeys()
const ENV = {
  VITE_FIREBASE_PROJECT_ID: 'demo-alarm-app',
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.com',
}

const ROOM_ID = 'room-123'
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// The fixture cert is self-signed, so disable TLS verification for the local
// mock push service only. web-push always speaks HTTPS, even to 127.0.0.1.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// ── Local mock push service ────────────────────────────────────────────
let pushServer
let pushPort
let received = []
let failingPaths = new Set()

before(async () => {
  const key = fs.readFileSync(path.join(FIXTURES, 'mock-push-key.pem'))
  const cert = fs.readFileSync(path.join(FIXTURES, 'mock-push-cert.pem'))
  pushServer = https.createServer({ key, cert }, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) })
      if (failingPaths.has(req.url)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('gone')
        return
      }
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => pushServer.listen(0, '127.0.0.1', resolve))
  pushPort = pushServer.address().port
})

after(() => new Promise((resolve) => pushServer.close(resolve)))

beforeEach(() => {
  received = []
  failingPaths = new Set()
})

afterEach(() => {
  mock.restoreAll()
})

// A browser-like subscription pointing at the local mock push service. The
// p256dh key must be a real P-256 point — web-push derives the encryption
// secret from it via ECDH.
function makeSubscription(deviceId) {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    endpoint: `https://127.0.0.1:${pushPort}/push/${deviceId}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  }
}

// Stub the Firestore REST API with the exact shape the real one returns,
// including subscriptions stored as JSON strings (as src/push.js writes them).
function installFirestoreStub({ devices }) {
  const calls = { list: [], deletes: [] }
  const documents = devices.map(({ deviceId, uid, subscription }) => ({
    name: `projects/${ENV.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents/rooms/${ROOM_ID}/pushDevices/${deviceId}`,
    fields: {
      uid: { stringValue: uid },
      subscription: { stringValue: JSON.stringify(subscription) },
      platform: { stringValue: 'desktop' },
    },
  }))
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(url)
    const auth = options.headers?.Authorization
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (options.method === 'DELETE') {
      const deviceId = decodeURIComponent(segments[segments.length - 1])
      calls.deletes.push({ deviceId, auth })
      return new Response(null, { status: 200 })
    }
    calls.list.push({ auth, url: parsed.href })
    return new Response(JSON.stringify({ documents }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return calls
}

// Drive the serverless handler with a bare req/res pair.
async function callRing(body) {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.payload = data
      return this
    },
  }
  await ringHandler({ method: 'POST', body }, res)
  return { status: res.statusCode, body: res.payload }
}

const alarmBody = {
  roomId: ROOM_ID,
  uid: 'uid-a',
  idToken: 'token-a',
  title: '🚨 ALARM',
  body: 'Someone triggered the alarm.',
  url: `https://app.example/alarm?room=${ROOM_ID}`,
}

test('a normal alarm pushes only to OTHER members, using the caller token', async () => {
  Object.assign(process.env, ENV)
  const firestore = installFirestoreStub({
    devices: [
      { deviceId: 'deviceA', uid: 'uid-a', subscription: makeSubscription('deviceA') },
      { deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') },
    ],
  })

  const { status, body } = await callRing(alarmBody)

  assert.equal(status, 200)
  assert.deepEqual(body, {
    pushed: 1,
    total: 1,
    notificationsSent: 3,
    stale: 0,
    platforms: { desktop: { total: 1, pushed: 1 } },
  })
  // The default burst is 3 back-to-back pushes, all to the other member.
  assert.equal(received.length, 3)
  assert.ok(received.every((r) => r.path === '/push/deviceB'))
  // The device list was read with the triggerer's ID token (rules apply).
  assert.equal(firestore.list.length, 1)
  assert.equal(firestore.list[0].auth, 'Bearer token-a')
})

test('a self-test (test:true) pushes to the CALLER\'s own devices only', async () => {
  Object.assign(process.env, ENV)
  const firestore = installFirestoreStub({
    devices: [
      { deviceId: 'deviceA', uid: 'uid-a', subscription: makeSubscription('deviceA') },
      { deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') },
    ],
  })

  const { status, body } = await callRing({ ...alarmBody, test: true, count: 1 })

  assert.equal(status, 200)
  assert.deepEqual(body, {
    pushed: 1,
    total: 1,
    notificationsSent: 1,
    stale: 0,
    platforms: { desktop: { total: 1, pushed: 1 } },
  })
  // The push went to the caller's own device, not the other member's.
  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/push/deviceA')
  assert.equal(firestore.deletes.length, 0)
})

test('a self-test with no stored subscription for the caller reports total 0', async () => {
  Object.assign(process.env, ENV)
  installFirestoreStub({
    devices: [{ deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') }],
  })

  const { status, body } = await callRing({ ...alarmBody, test: true })

  assert.equal(status, 200)
  assert.deepEqual(body, { pushed: 0, total: 0, notificationsSent: 0, stale: 0, platforms: {} })
  assert.equal(received.length, 0)
})

test('a 404 from the push service is counted stale and the device doc is pruned', async () => {
  Object.assign(process.env, ENV)
  const firestore = installFirestoreStub({
    devices: [
      { deviceId: 'deviceA', uid: 'uid-a', subscription: makeSubscription('deviceA') },
      { deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') },
    ],
  })
  failingPaths.add('/push/deviceB')

  const { status, body } = await callRing(alarmBody)

  assert.equal(status, 200)
  assert.deepEqual(body, {
    pushed: 0,
    total: 1,
    notificationsSent: 0,
    stale: 1,
    platforms: { desktop: { total: 1, pushed: 0 } },
  })
  // The burst stops at the first failure: exactly ONE push was attempted and
  // the expired device was pruned via Firestore REST with the caller's token.
  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/push/deviceB')
  assert.equal(firestore.deletes.length, 1)
  assert.equal(firestore.deletes[0].deviceId, 'deviceB')
  assert.equal(firestore.deletes[0].auth, 'Bearer token-a')
})

test('an explicit count of 1 sends a single notification per device', async () => {
  Object.assign(process.env, ENV)
  installFirestoreStub({
    devices: [{ deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') }],
  })

  const { status, body } = await callRing({ ...alarmBody, count: 1 })

  assert.equal(status, 200)
  assert.equal(body.pushed, 1)
  assert.equal(body.notificationsSent, 1)
  assert.equal(received.length, 1)
})

test('the burst count is clamped server-side (99 → 10, junk → 3)', async () => {
  Object.assign(process.env, ENV)
  installFirestoreStub({
    devices: [{ deviceId: 'deviceB', uid: 'uid-b', subscription: makeSubscription('deviceB') }],
  })

  // A malicious/edited request cannot spam a device hundreds of times.
  const huge = await callRing({ ...alarmBody, count: 99 })
  assert.equal(huge.status, 200)
  assert.equal(huge.body.notificationsSent, 10)
  assert.equal(received.length, 10)

  received = []
  const junk = await callRing({ ...alarmBody, count: 'definitely-not-a-number' })
  assert.equal(junk.status, 200)
  assert.equal(junk.body.notificationsSent, 3)
  assert.equal(received.length, 3)
})

test('missing required fields are rejected with 400', async () => {
  Object.assign(process.env, ENV)
  const { status, body } = await callRing({ roomId: ROOM_ID })
  assert.equal(status, 400)
  assert.ok(body.error)
})

test('web-push really delivers an encrypted POST to the local mock endpoint', async () => {
  Object.assign(process.env, ENV)
  webpush.setVapidDetails(ENV.VAPID_SUBJECT, ENV.VAPID_PUBLIC_KEY, ENV.VAPID_PRIVATE_KEY)

  await webpush.sendNotification(makeSubscription('plumbing'), JSON.stringify({ ping: true }))

  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/push/plumbing')
  assert.equal(received[0].headers['content-encoding'], 'aes128gcm')
  assert.equal(received[0].headers['content-type'], 'application/octet-stream')
  assert.ok(received[0].body.length > 100, 'payload should be the encrypted message')
})