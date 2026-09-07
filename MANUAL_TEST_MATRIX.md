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

> Receiver-side state per row is set *before* Device A taps **Trigger Alarm**.

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
| 8 | Repeat rows 2–3 with **2 receivers** | Triggerer's toast: "Alarm sent to 2 of 2 devices" | ☐ |

After every trigger, **Device A's room page** gains a **"Recent pushes"** entry
showing who pushed, when, and the per-platform counts (row 8 check).

## Checking Vercel Runtime Logs (row 8)

1. Vercel dashboard → your account (**luckys** team) → project **alarm-app** →
   **Deployments** → the **Production** deployment → **Logs** (Runtime Logs).
2. Filter by `ring`. Each alarm shows:
   `[ring] room <id> by <uid>: pushed 2/2 devices` and any per-device
   `[ring] push to device … failed (HTTP …)` lines. A successful row 8 shows
   `pushed 2/2` with **no** failure lines.
3. Triggerer's toast count should match the log count exactly.

## If a row fails — what to capture

- **Receiving device**: DevTools is unavailable once the page is closed; instead
  re-open the site and check the room page — "Recent pushes" shows whether the
  push service accepted delivery (`pushed 1/1` = relay worked, so the failure is
  device-side: permission, Doze/battery saver, or iOS not-standalone). For
  background-tab rows 1–2 keep DevTools open and copy any console errors from
  the receiving device.
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
