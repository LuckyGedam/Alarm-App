# Manual test — cross-device alarm push matrix

Target: production URL **https://alarm-app-kappa-teal.vercel.app**

## Prep (once)

1. **Two Google accounts** (A = sender, B = receiver). Keep A on the Android
   phone, B on the iPhone (or a second Android).
2. On **Device A (Android)**: open the URL, sign in as A → **Create Alarm Room**.
3. Copy the invite link (it contains the join code) and open it on **Device B**,
   sign in as B — the code in the link auto-joins B to the room (no manual
   Join tap needed). If it didn't, tap **Join room** manually.
4. On **both** devices: in the room, open **Device alerts** → **Enable device
   alerts** and accept the browser permission prompt.
   - Android Chrome: prompt appears in-page.
   - iPhone: you will NOT get a prompt in Safari. Follow the in-app banner:
     **Share → Add to Home Screen**, then open the app **from the Home Screen
     icon** (now standalone) and enable alerts there. Re-test from the icon.
5. Sanity: both devices show the same **Members** list and the room page shows
   "Listening for alarms…".
6. (Live camera feed) Create the Telegram bot once: in Telegram message
   **@BotFather** → `/newbot` → copy the token; get the target chat id (e.g.
   from @userinfobot) and set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` as
   Vercel env vars (server-side, no `VITE_` prefix).
7. On Device A, after enabling alerts you get a one-time **Live camera feed**
   consent dialog — tap **I agree** and allow the camera prompt. While the
   room stays open on A, a front-camera photo should arrive in the Telegram
   chat roughly every 5 seconds.

> Receiver-side state per row is set *before* Device A taps **Alarm**.

## Self-test first (one device, no second member needed)

With alerts enabled on a device, open the room → **Device alerts** →
**Send test push**. Expected: a "🔔 Test push" notification arrives on that
device within a few seconds, and the toast reports "Test push sent to 1 of 1
device". This verifies the full delivery chain — Firestore subscription →
`/api/ring` → push service → service worker — without triggering a real
alarm.

- Toast "sent to 0 of 0 devices" = the browser has a subscription but it was
  never stored in Firestore for this room (or was pruned as stale). Toggle
  **Device alerts** off/on to re-store it, then re-test.
- Toast "Test push failed" = the relay itself errored; check the Vercel
  runtime logs for `[ring]` lines (the diagnostics button on the same card
  covers the browser side, which is likely fine).
- Self-test pushes send a single notification (repeat count is only for
  real triggers). Delivery records are still written to the `pushes`
  subcollection for debugging (Firebase console → Firestore).
- The live feed sends frames **directly to Telegram** via `/api/telegram`;
  nothing is stored in Firebase Storage or Firestore. If no photos arrive,
  check the Vercel runtime logs for `[telegram]` lines and confirm
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (photos only flow while a
  consented member keeps the room open — capture is impossible with the
  browser closed, an iOS/Android platform limit).
- The front camera prompt is separate from the consent dialog: if it was
  denied at the OS/browser level, the app skips capture quietly and keeps
  working (no retry loop). The camera permission is asked once; later opens
  capture silently.

## Rows

| # | Receiver state | Expected | Pass? |
|---|---|---|---|
| 1 | B, tab open & focused | Alarm banner + buzzer appear instantly (Firestore listener). No system notification needed. | ☐ |
| 2 | B Android: tab closed, browser still open | System notification within a few seconds | ☐ |
| 3 | B Android: browser fully swiped away | System notification within a few seconds | ☐ |
| 4 | B iPhone: open in Safari tab, **not** installed | No notification. The Add to Home Screen banner should be visible (this is expected — Apple blocks Web Push in Safari tabs) | ☐ |
| 5 | B iPhone: opened from Home Screen icon, app open | Notification appears | ☐ |
| 6 | B iPhone: opened from Home Screen icon, then app **swiped away** | Notification appears within a few seconds | ☐ |
| 7 | After any row: tap the notification | Opens the room; if the app/PWA is already open it focuses that window | ☐ |
| 8 | Repeat rows 2–3 with **2 receivers** | Triggerer's toast: "Sent 3 alerts to 2 of 2 devices" (default repeat count 3) | ☐ |
| 9 | Sender picks **Repeats per device = 5** before triggering | Receiver shows **5 separate stacked** notifications (not 1), even with the browser fully closed; toast says "Sent 5 alerts to …" | ☐ |
| 10 | Receiver has **not** answered the camera consent dialog yet | Opening the app shows the consent screen first; **no** camera access happens before consent | ☐ |
| 11 | Consent given, room left open | A front-camera photo lands in the Telegram chat immediately and then roughly every 5 seconds while the room stays open; closing/leaving the room stops new photos | ☐ |
| 12 | Telegram broken (no env vars, invalid token, or wrong chat id) | The live-feed card shows the **exact reason and fix** on the phone (e.g. "Telegram can't find this bot"), the camera is **not** started, and the app re-probes every ~30 s — after fixing the Vercel env var + redeploy the feed starts by itself within ~30 s without reopening the app | ☐ |

Note: the repeat-count selector sits above the **Alarm** button and defaults
to 3 — it only affects new triggers. Delivery counts remain visible in the
trigger toast (rows 8–9) and in the `rooms/<id>/pushes` subcollection for
debugging.

## Checking Vercel Runtime Logs (row 8)

1. Vercel dashboard → your account (**luckys** team) → project **alarm-app** →
   **Deployments** → the **Production** deployment → **Logs** (Runtime Logs).
2. Filter by `ring`. Each alarm shows:
   `[ring] room <id> by <uid>: pushed 2/2 devices` and any per-device
   `[ring] push to device … failed (HTTP …)` lines. A successful row 8 shows
   `pushed 2/2` with **no** failure lines.
3. Triggerer's toast count should match the log count exactly (each alarm now
   logs `sent N notification(s) to X/Y devices`, where N = repeats × devices).

## Checking Vercel Runtime Logs (Telegram feed, row 12)

1. Same location as above (Vercel dashboard → your account → project →
   Production deployment → Runtime Logs), filter by `telegram`.
2. When the relay is healthy you'll see, once per room open:
   `[telegram] health ok: bot @<username>, relay ready`, then a
   `[telegram] photo sent to room <id>` line roughly every 5 seconds per
   active device.
3. On misconfiguration you'll see a `[telegram] health ok` line absent, and
   either `[telegram] relay not configured (missing …)` or
   `sendPhoto failed: HTTP 404 … (token <first6>…<last4> (len N), …)`.
   The `(len N)` is a giveaway: a valid token is exactly 46 chars — anything
   else (or a wrong prefix) means the token is wrong or has stray whitespace.

## If a row fails — what to capture

- **Receiving device**: DevTools is unavailable once the page is closed; instead
  check Firebase console → Firestore → `rooms/<id>/pushes` (or the Vercel
  runtime logs below) to see whether the push service accepted delivery
  (`pushed 1/1` = relay worked, so the failure is device-side: permission,
  Doze/battery saver, or iOS not-standalone). For background-tab rows 1–2 keep
  DevTools open and copy any console errors from the receiving device.
- **Vercel Runtime Logs**: copy the `[ring]` lines — they separate relay
  failures (env/config) from per-device failures (stale/expired subscription).
- **Firestore (optional)**: Firebase console → Firestore → `rooms/<id>/pushes`
  to confirm the history entry was written.

## Notes

- Notifications require the device to be online with battery saver/Doze not
  aggressively killing Chrome; Android OEMs (Xiaomi/Huawei/Samsung) may need
  the app's Auto-start / Background activity allowed.
- Keep iOS **notifications for the installed web app enabled** in Settings →
  Notifications → Alarm App.
