// Unit tests for the /api/telegram live-frame relay.
//
// Firestore membership is stubbed by mocking global fetch; the Telegram Bot
// API call is captured (and answered) by the same mock, so no real bot token
// or network is involved.
//
// Run with: npm run test:unit
import { test, before, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import telegramHandler from '../api/telegram.js'

const ENV = {
  TELEGRAM_BOT_TOKEN: '123:test-token',
  TELEGRAM_CHAT_ID: 'chat-42',
  VITE_FIREBASE_PROJECT_ID: 'demo-alarm-app',
  VITE_FIREBASE_API_KEY: 'test-api-key',
}

const ROOM_ID = 'room-123'
// 'hello' in base64, plus a data-URI prefix to prove stripping works.
const IMAGE_B64 = 'data:image/jpeg;base64,aGVsbG8='

let member = true
let telegramCalls = []
let telegramResponse = { ok: true, result: { message_id: 1 } }
let telegramStatus = 200

before(() => {
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url)
    if (href.includes('firestore.googleapis.com')) {
      return new Response(member ? JSON.stringify({}) : 'denied', { status: member ? 200 : 403 })
    }
    if (href.includes('api.telegram.org')) {
      telegramCalls.push({ url: href, ...options })
      return new Response(JSON.stringify(telegramResponse), {
        status: telegramStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected URL: ${href}`)
  })
})

afterEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key]
  member = true
  telegramCalls = []
  telegramResponse = { ok: true, result: { message_id: 1 } }
  telegramStatus = 200
})

async function callTelegram(body) {
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
  await telegramHandler({ method: 'POST', body }, res)
  return { status: res.statusCode, body: res.payload }
}

const validBody = () => ({ image: IMAGE_B64, roomId: ROOM_ID, idToken: 'token-1' })

test('rejects non-POST requests', async () => {
  Object.assign(process.env, ENV)
  const r = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this },
    json() { return this },
  }
  await telegramHandler({ method: 'GET' }, r)
  assert.equal(r.statusCode, 405)
})

test('requires image, roomId and idToken', async () => {
  Object.assign(process.env, ENV)
  const { status } = await callTelegram({ roomId: ROOM_ID })
  assert.equal(status, 400)
})

test('returns 500 when the bot token/chat id are not configured', async () => {
  Object.assign(process.env, { VITE_FIREBASE_PROJECT_ID: ENV.VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY: ENV.VITE_FIREBASE_API_KEY })
  const { status } = await callTelegram(validBody())
  assert.equal(status, 500)
  assert.equal(telegramCalls.length, 0)
})

test('rejects non-members before touching Telegram', async () => {
  Object.assign(process.env, ENV)
  member = false
  const { status } = await callTelegram(validBody())
  assert.equal(status, 403)
  assert.equal(telegramCalls.length, 0)
})

test('relays a member frame to the bot as a multipart photo upload', async () => {
  Object.assign(process.env, ENV)
  const { status } = await callTelegram(validBody())
  assert.equal(status, 200)
  assert.equal(telegramCalls.length, 1)

  const options = telegramCalls[0]
  assert.equal(String(options.method).toUpperCase(), 'POST')
  assert.ok(String(options.url).includes('/bot123:test-token/sendPhoto'))
  assert.ok(options.body instanceof FormData)

  const form = options.body
  assert.equal(form.get('chat_id'), 'chat-42')
  const caption = form.get('caption')
  assert.ok(String(caption).includes(`Room ${ROOM_ID}`))
  const photo = form.get('photo')
  assert.ok(photo instanceof Blob)
  assert.equal(await photo.text(), 'hello')
})

test('rejects undecodable and oversized images', async () => {
  Object.assign(process.env, ENV)
  const { status: bad } = await callTelegram({ ...validBody(), image: '!!!not-base64!!!' })
  assert.equal(bad, 400)

  const big = Buffer.alloc(1_600_000, 0x61).toString('base64')
  const { status: huge } = await callTelegram({ ...validBody(), image: big })
  assert.equal(huge, 413)
  assert.equal(telegramCalls.length, 0)
})

test('surfaces a Telegram rejection as 502', async () => {
  Object.assign(process.env, ENV)
  telegramStatus = 400
  telegramResponse = { ok: false, description: 'chat not found' }
  const { status } = await callTelegram(validBody())
  assert.equal(status, 502)
})
