/**
 * A short two-tone chime for a new kitchen ticket, made with Web Audio (no sound file to ship).
 * Browsers only allow sound after the screen was touched once; picking the station counts.
 */
let ctx: AudioContext | null = null;

export function chime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    }
  } catch {
    // No audio device or blocked: the flash still shows the new ticket.
  }
}

const KEY = 'onepos.kds.sound';
export const soundPreference = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  },
  set(on: boolean): void {
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // Private window: the choice lasts for this screen only.
    }
  },
};
