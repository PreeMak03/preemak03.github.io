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

import { engageManual, releaseManual, shiftManual, isManual, manualGear } from './gearbox.js';

const WHEEL_STEP = 40;      // accumulated deltaY that counts as one detent
const REPEAT_LOCK_MS = 180; // one gear per gesture, not per event

let ui = null;
let wheelAcc = 0;
let lastShiftAt = 0;
let lastSource = '—';
let onChange = null;

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

export function startManualShift({ getGear, onGearChange } = {}) {
  if (ui) return { destroy() {} };
  onChange = onGearChange || null;
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
    if (!isManual()) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { doShift(1, 'key'); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') { doShift(-1, 'key'); e.preventDefault(); }
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);

  return {
    render,
    destroy() {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      if (ui) ui.root.remove();
      ui = null;
      releaseManual();
    },
  };
}
