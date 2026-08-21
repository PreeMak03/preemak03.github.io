/**
 * Manual gearbox — the driver picks the gear.
 *
 * The gearbox was already a separate module, and resolveGear() is a STRATEGY
 * for choosing a gear rather than the gearbox itself. So this changes nothing
 * about the automatic path: it engages ahead of the choice and everything
 * downstream — tone bias per gear, the shift landing, dynamic volume, the
 * shift sound — carries on not caring who picked it.
 *
 * INPUT, three ways on purpose
 *   The plan is Tesla's steering-wheel scroll wheel, and nobody has yet
 *   confirmed those events reach a web page at all — the car may consume them
 *   for its own volume and mirror controls. So the wheel is ONE source, not
 *   the source: arrow keys work, and two on-screen paddles always work. If the
 *   wheel turns out to be silent, manual mode still ships; if it works, the
 *   paddles become the fallback.
 *
 * The readout says which source last moved a gear, which answers the question
 * about the wheel without a separate test page.
 */

import {
  engageManual, releaseManual, shiftManual, isManual, manualGear, gearSpeedSpan,
} from './gearbox.js';

const WHEEL_STEP = 40;      // accumulated deltaY that counts as one detent
const REPEAT_LOCK_MS = 180; // one gear per gesture, not per event

let ui = null;
let wheelAcc = 0;
let lastShiftAt = 0;
let lastSource = '—';
let onChange = null;

/**
 * SPACEBAR THROTTLE — a driving-game pedal, for testing manual gears at a
 * desk. Held means wide open, released means coasting.
 *
 * It exists because manual mode cannot be judged from the sim slider: the
 * slider names a speed, and a gearbox is about the ENGINE getting somewhere.
 * With a pedal you hold second, hear it climb, hit the limiter, and have to
 * shift — which is the thing being tested.
 *
 * And that limiter is enforced here, not just drawn: at the redline the car
 * stops gaining speed until an upshift. Without it the revs would sail past
 * the limiter and the gear choice would once again mean nothing.
 */
let pedal = false;
let pedalRaf = 0;
let pedalLast = 0;
let sim = null;          // { state, physics, getRpm, getRedline }
const COAST_KMH_PER_S = 9;
const SPEED_CAP = 260;

const now = () => performance.now();

function doShift(dir, source) {
  if (!isManual()) return;
  if (now() - lastShiftAt < REPEAT_LOCK_MS) return;
  const before = manualGear();
  const g = shiftManual(dir);
  if (g === before) {           // already at the end of the box
    flash(dir > 0 ? 'up' : 'down', true);
    return;
  }
  lastShiftAt = now();
  lastSource = source;
  flash(dir > 0 ? 'up' : 'down', false);
  render();
  if (onChange) onChange(g, source);
}

function flash(which, blocked) {
  if (!ui) return;
  const el = which === 'up' ? ui.up : ui.down;
  el.classList.add(blocked ? 'ms-blocked' : 'ms-hit');
  window.setTimeout(() => el.classList.remove('ms-blocked', 'ms-hit'), 160);
}

function pedalTick(now) {
  pedalRaf = requestAnimationFrame(pedalTick);
  if (!sim || !sim.state) return;
  const dt = pedalLast ? Math.min(0.1, (now - pedalLast) / 1000) : 0;
  pedalLast = now;
  if (!dt) return;
  if (sim.state.mode !== 'sim') return;      // GPS owns the speed when driving

  const rate = sim.rate || 33;
  let v = sim.state.targetSpeed || 0;
  if (pedal) {
    // The limiter is a SPEED in a given gear, so cap the speed — do not wait
    // for the revs to report it. The first version watched the smoothed rpm,
    // which lags behind by the glide and the damp: holding first ran the car
    // to 66.9 km/h before the reading caught up, in a gear that tops out at
    // 40. The ratio knows the answer with no lag at all.
    const cap = isManual()
      ? gearSpeedSpan(manualGear()).vmax
      : SPEED_CAP;
    const onLimiter = v >= cap - 0.05;
    if (ui) ui.root.classList.toggle('ms-limit', onLimiter);
    v = Math.min(Math.min(SPEED_CAP, cap), v + rate * dt);
  } else {
    if (ui) ui.root.classList.remove('ms-limit');
    v = Math.max(0, v - COAST_KMH_PER_S * dt);
  }
  if (v !== sim.state.targetSpeed) {
    sim.state.targetSpeed = v;
    const sl = document.querySelector('#sim-speed');
    if (sl) sl.value = String(Math.round(v));
  }
}

function render() {
  if (!ui) return;
  const on = isManual();
  ui.root.classList.toggle('ms-on', on);
  ui.gear.textContent = on ? String(manualGear()) : 'A';
  ui.src.textContent = on ? lastSource : '';
  ui.toggle.textContent = on ? 'MANUAL' : 'AUTO';
  ui.toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function build(getGear) {
  const root = document.createElement('div');
  root.className = 'ms-root';
  root.innerHTML = `
    <button type="button" class="ms-pad ms-down" aria-label="เกียร์ลง">−</button>
    <div class="ms-mid">
      <button type="button" class="ms-toggle" aria-pressed="false">AUTO</button>
      <span class="ms-gear">A</span>
      <span class="ms-src"></span>
    </div>
    <button type="button" class="ms-pad ms-up" aria-label="เกียร์ขึ้น">+</button>
  `;
  document.body.appendChild(root);
  ui = {
    root,
    up: root.querySelector('.ms-up'),
    down: root.querySelector('.ms-down'),
    gear: root.querySelector('.ms-gear'),
    src: root.querySelector('.ms-src'),
    toggle: root.querySelector('.ms-toggle'),
  };
  ui.up.addEventListener('click', () => doShift(1, 'paddle'));
  ui.down.addEventListener('click', () => doShift(-1, 'paddle'));
  ui.toggle.addEventListener('click', () => {
    if (isManual()) releaseManual();
    else engageManual(getGear ? getGear() : 1);
    wheelAcc = 0;
    render();
  });
  render();
}

export function startManualShift({ getGear, onGearChange, sim: simRefs } = {}) {
  if (ui) return { destroy() {} };
  onChange = onGearChange || null;
  sim = simRefs || null;
  build(getGear);

  // The scroll wheel. Accumulated, because a detent can arrive as several
  // events and a trackpad as a continuous stream.
  const onWheel = (e) => {
    if (!isManual()) return;
    // Leave the profile carousel alone — that is a horizontal scroller.
    if (e.target && e.target.closest && e.target.closest('#profile-scroller')) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= WHEEL_STEP) {
      // Wheel DOWN (positive deltaY) shifts DOWN, which matches every paddle
      // convention: pull toward you for a lower gear.
      doShift(wheelAcc > 0 ? -1 : 1, 'wheel');
      wheelAcc = 0;
      e.preventDefault();
    }
  };
  const onKey = (e) => {
    // The pedal works whenever the harness is mounted — it is how you drive
    // the sim at a desk, manual or not.
    if (e.code === 'Space' && !e.repeat) {
      pedal = true;
      if (ui) ui.root.classList.add('ms-pedal');
      e.preventDefault();
      return;
    }
    if (!isManual()) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { doShift(1, 'key'); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') { doShift(-1, 'key'); e.preventDefault(); }
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  const onKeyUp = (e) => {
    if (e.code === 'Space') {
      pedal = false;
      if (ui) { ui.root.classList.remove('ms-pedal', 'ms-limit'); }
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  // Losing focus mid-throttle must not leave the pedal stuck down.
  const onBlur = () => { pedal = false; if (ui) ui.root.classList.remove('ms-pedal', 'ms-limit'); };
  window.addEventListener('blur', onBlur);
  pedalLast = 0;
  pedalRaf = requestAnimationFrame(pedalTick);

  return {
    render,
    destroy() {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(pedalRaf);
      pedal = false;
      if (ui) ui.root.remove();
      ui = null;
      releaseManual();
    },
  };
}
