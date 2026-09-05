// Alarm buzzer generated with the Web Audio API. No remote audio file needed,
// which keeps the alarm working offline and avoids dead/hotlinked assets.

let ctx = null;

function getContext() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') {
    // Browsers block audio until the user has interacted with the page once.
    ctx.resume().catch(() => {});
  }
  return ctx;
}

// Prime the audio context on the first interaction so alarms can play
// without requiring an extra click.
if (typeof window !== 'undefined') {
  const prime = () => {
    getContext();
  };
  window.addEventListener('pointerdown', prime, { once: true });
  window.addEventListener('keydown', prime, { once: true });
}

/**
 * Start the looping buzzer.
 * @returns {{ stop: () => void, blocked: boolean }}
 *   stop() silences the buzzer; blocked is true when the browser refused
 *   to play audio (user has not interacted with the page yet).
 */
export function playAlarm() {
  const context = getContext();
  if (!context || context.state !== 'running') {
    return { stop: () => {}, blocked: true };
  }

  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);

  const oscillator = context.createOscillator();
  oscillator.type = 'square';
  oscillator.frequency.value = 880;
  oscillator.connect(master);
  oscillator.start();

  let beepOn = false;
  const interval = setInterval(() => {
    beepOn = !beepOn;
    master.gain.setValueAtTime(beepOn ? 0.25 : 0, context.currentTime);
  }, 450);

  return {
    blocked: false,
    stop: () => {
      clearInterval(interval);
      try {
        oscillator.stop();
      } catch {
        // already stopped
      }
      oscillator.disconnect();
      master.disconnect();
    },
  };
}