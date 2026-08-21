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
// The pedal only OWNS the speed while it is doing something. Without this it
// coasts targetSpeed toward zero on every frame it is mounted, which quietly
// makes the sim slider useless for anyone in dev mode — set 40, watch it sink
// straight back to 0. It takes ownership on press, keeps it while coasting,
// and hands it back the moment it reaches a stop or the slider is touched.
let owns = false;
// How long the throttle revs the engine WITHOUT moving the car from a stop.
// A blip is a stab at the pedal with the clutch out; a launch is the same
// stab held until the clutch bites. One timer covers both, so a tap revs and
// nothing else, and holding flares first and then pulls away — which is what
// a standing start actually feels like.
const CLUTCH_BITE_S = 0.7;
let pressedAt = 0;
let pedalRaf = 0;
let pedalLast = 0;
let sim = null;          // { state, physics, getRpm, getRedline }
// 9 read as freewheeling downhill. A car off the throttle in gear slows on
// engine braking and drag, and the owner wants to get back to a standstill
// quickly enough to blip and try again.
const COAST_KMH_PER_S = 22;
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
  // Scheduled only while the pedal is doing something. It used to run every
  // animation frame for the life of the page and return immediately — cheap
  // per call and 180 calls a second for nothing, which is a cost a phone or a
  // car MCU feels and a desktop does not.
  if (!owns) { pedalRaf = 0; return; }
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
    // Power falls off past peak power, so the top of a gear does not arrive —
    // it is approached. Freezing the speed dead on the cap was clinically
    // correct and felt like a wall: the ratio does lock wheel speed to engine
    // speed with the clutch in, but what a driver FEELS is the pull draining
    // away while the engine hammers the cut, not a barrier.
    //
    // Full pull to 82% of the gear, then it bleeds to almost nothing, so the
    // last stretch takes far longer than the first and shifting up is
    // something you WANT rather than something a rule makes you do.
    // Clutch still out: rev, do not roll.
    const ph = sim.physics;
    const stopped = ph ? ph.vehicleSpeed < 3 : v < 3;
    if (isManual() && stopped && (performance.now() - pressedAt) / 1000 < CLUTCH_BITE_S) {
      if (ui) ui.root.classList.add('ms-blip');
      return;
    }
    if (ui) ui.root.classList.remove('ms-blip');

    const through = cap > 0 ? v / cap : 0;
    const KNEE = 0.82;
    const power = through < KNEE
      ? 1
      : Math.max(0.05, 1 - ((through - KNEE) / (1 - KNEE)) ** 0.7 * 0.95);
    const onLimiter = through >= 0.985;
    if (ui) {
      ui.hud.classList.toggle('ms-limit', onLimiter);
      ui.root.classList.toggle('ms-limit', onLimiter);   // tints the upshift paddle
    }
    // NOT capped at the gear's top speed any more.
    //
    // In the car the app has no vote: the driver presses the pedal and the car
    // goes, whatever gear this thinks it is in. A desk that behaves differently
    // from the car is a desk that tests the wrong thing, so the pedal keeps
    // pushing here too and the over-rev protection in crank-audio decides what
    // happens next — the same code path either way.
    //
    // The falloff still bites, so past the top of a gear it crawls rather than
    // pulls, which is what a driver would feel.
    v = Math.min(SPEED_CAP, v + rate * power * dt);
  } else {
    if (ui) { ui.hud.classList.remove('ms-limit'); ui.root.classList.remove('ms-limit'); }
    v = Math.max(0, v - COAST_KMH_PER_S * dt);
    if (v <= 0) owns = false;          // rolled to a stop — the slider is free again
  }
  if (v !== sim.state.targetSpeed) {
    sim.state.targetSpeed = v;
    const sl = document.querySelector('#sim-speed');
    if (sl) sl.value = String(Math.round(v));
  }
}

function pressPedal() {
  if (pedal) return;
  pedal = true;
  owns = true;
  if (!pedalRaf) { pedalLast = 0; pedalRaf = requestAnimationFrame(pedalTick); }
  pressedAt = performance.now();
  pedalLast = 0;
  if (ui) { ui.hud.classList.add('ms-pedal'); ui.gas.classList.add('ms-gas-on'); }
}

function releasePedal() {
  if (!pedal) return;
  pedal = false;
  if (ui) {
    ui.hud.classList.remove('ms-pedal', 'ms-limit', 'ms-blip');
    ui.root.classList.remove('ms-limit');
    ui.gas.classList.remove('ms-gas-on');
  }
}

function render() {
  if (!ui) return;
  const on = isManual();
  ui.root.classList.toggle('ms-on', on);
  ui.paddles.classList.toggle('ms-on', on);
  ui.gear.textContent = on ? String(manualGear()) : 'A';
  ui.src.textContent = on ? lastSource : '';
  ui.toggle.textContent = on ? 'MANUAL' : 'AUTO';
  ui.toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function build(getGear, withPedal) {
  // The readout belongs with the other instruments, not floating over the
  // profile carousel and the rev button — which is where a fixed, centred
  // overlay inevitably lands. The accel column already IS the instrument
  // column, and the space above its tube was empty, so the gear goes there
  // and shares its visual language.
  // Three parts, each where the hand or the eye already is.
  //
  //   paddles   flanking the speed dial, where a real car puts them: behind
  //             the wheel, left down and right up, thumbs already there.
  //             Brushed grey rather than accent — a paddle is a piece of
  //             hardware, not a readout, and it should sit back.
  //   readout   head of the accel column, with the other instruments.
  //   throttle  above REV in the start dock, big, because it is a pedal being
  //             pressed by a finger in a moving car.
  // Mounted on the DIAL, not the section around it. Anchored to the section
  // the paddles drifted out to the screen edges — which is not 'flanking the
  // gauge', and on a narrow screen the right one landed on the accel tube.
  // PADDLES — arcs that follow the rim of the dial.
  //
  // A real paddle is a curved blade behind the wheel, thickest in the middle
  // and tapering to its ends, and a rounded rectangle beside a circle never
  // reads as one. Drawn instead as an annulus sector in the dial's OWN
  // coordinates — same viewBox as the speed ring, so it tracks the gauge at
  // every screen size with no arithmetic — and given the taper by sweeping the
  // outer edge through a wider angle than the inner one, which points both
  // ends without any extra geometry.
  //
  // overflow:visible lets the blades sit OUTSIDE the ring's box while keeping
  // that box's coordinate system.
  const arc = (fromDeg, toDeg, ri, ro) => {
    const p = (deg, r) => {
      const a2 = (deg * Math.PI) / 180;
      return [120 + r * Math.cos(a2), 120 + r * Math.sin(a2)];
    };
    const taper = 7;                       // degrees the outer edge runs on for
    const [ox1, oy1] = p(fromDeg - taper, ro);
    const [ox2, oy2] = p(toDeg + taper, ro);
    const [ix2, iy2] = p(toDeg, ri);
    const [ix1, iy1] = p(fromDeg, ri);
    return `M ${ox1} ${oy1} A ${ro} ${ro} 0 0 1 ${ox2} ${oy2}`
      + ` L ${ix2} ${iy2} A ${ri} ${ri} 0 0 0 ${ix1} ${iy1} Z`;
  };

  const centre = document.querySelector('.speed-ring');
  const paddles = document.createElement('div');
  paddles.className = 'ms-paddles';
  paddles.innerHTML = `
    <svg class="ms-paddle-svg" viewBox="0 0 240 240" aria-hidden="true">
      <path class="ms-pad ms-down" d="${arc(151, 209, 111, 130)}"/>
      <path class="ms-pad ms-up" d="${arc(-29, 29, 111, 130)}"/>
      <!-- Centred on the blade: mid-radius is (111+130)/2, so 120 +- 120.5. -->
      <text class="ms-pad-glyph" x="-0.5" y="119">−</text>
      <text class="ms-pad-glyph" x="240.5" y="119">+</text>
      <text class="ms-pad-tag" x="-0.5" y="133">DN</text>
      <text class="ms-pad-tag" x="240.5" y="133">UP</text>
    </svg>
  `;
  if (centre) centre.appendChild(paddles);

  // A full rectangle to press, not the blade.
  //
  // The visible shape is a thin curved sliver, and hitting a sliver is not
  // something to ask of a thumb in a moving car. Each blade gets a transparent
  // rectangle over it.
  //
  // Measured from the SAME arc numbers that drew the blade rather than from
  // getBBox(), because the paddles are display:none until manual is engaged
  // and a box that is not laid out has no box to get.
  const svg = paddles.querySelector('.ms-paddle-svg');
  const hitBox = (fromDeg, toDeg, ri, ro, taper = 7) => {
    const xs = [];
    const ys = [];
    for (const [deg, r] of [[fromDeg - taper, ro], [toDeg + taper, ro],
                            [fromDeg, ri], [toDeg, ri],
                            [(fromDeg + toDeg) / 2, ro], [(fromDeg + toDeg) / 2, ri]]) {
      const a2 = (deg * Math.PI) / 180;
      xs.push(120 + r * Math.cos(a2));
      ys.push(120 + r * Math.sin(a2));
    }
    const pad = 8;
    return {
      x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    };
  };
  for (const [cls, from, to] of [['ms-down', 151, 209], ['ms-up', -29, 29]]) {
    const b = hitBox(from, to, 111, 130);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('x', b.x.toFixed(1));
    hit.setAttribute('y', b.y.toFixed(1));
    hit.setAttribute('width', b.w.toFixed(1));
    hit.setAttribute('height', b.h.toFixed(1));
    hit.setAttribute('class', 'ms-hit-area');
    hit.dataset.for = cls;
    svg.appendChild(hit);          // on top, so it catches the gaps too
  }
  const side = document.querySelector('.accel-side');
  const root = document.createElement('div');
  root.className = 'ms-root';
  root.innerHTML = `
    <span class="ms-gear">A</span>
    <button type="button" class="ms-toggle" aria-pressed="false">AUTO</button>
    <span class="ms-src"></span>
  `;
  if (side) side.prepend(root); else document.body.appendChild(root);

  const dock = withPedal ? document.querySelector('.start-dock') : null;
  const gas = document.createElement('button');
  gas.type = 'button';
  gas.className = 'ms-gas';
  gas.setAttribute('aria-label', 'คันเร่ง (กดค้าง)');
  gas.innerHTML = '<span class="ms-gas-eyebrow">Throttle</span><span class="ms-gas-main">GAS</span>';
  if (dock) dock.prepend(gas);   // otherwise it is never in the document

  ui = {
    root,
    hud: root,
    paddles,
    gas,
    up: paddles.querySelector('.ms-up'),
    down: paddles.querySelector('.ms-down'),
    gear: root.querySelector('.ms-gear'),
    src: root.querySelector('.ms-src'),
    toggle: root.querySelector('.ms-toggle'),
  };

  // The on-screen pedal is the same pedal as the spacebar, so it goes through
  // the same press/release path rather than growing a second one.
  const gasDown = (e) => { e.preventDefault(); pressPedal(); };
  const gasUp = (e) => { e.preventDefault(); releasePedal(); };
  gas.addEventListener('pointerdown', gasDown);
  gas.addEventListener('pointerup', gasUp);
  gas.addEventListener('pointercancel', gasUp);
  gas.addEventListener('pointerleave', gasUp);
  const bindPad = (cls, dir) => {
    const target = paddles.querySelector(`.ms-hit-area[data-for="${cls}"]`)
      || paddles.querySelector('.' + cls);
    if (target) target.addEventListener('click', () => doShift(dir, 'paddle'));
  };
  bindPad('ms-up', 1);
  bindPad('ms-down', -1);
  ui.toggle.addEventListener('click', () => {
    if (isManual()) releaseManual();
    else engageManual(getGear ? getGear() : 1);
    wheelAcc = 0;
    render();
  });
  render();
}

/**
 * @param {object}  o
 * @param {boolean} o.pedal  build the on-screen throttle. Dev only: it drives
 *   the SIMULATOR, so in a real car it would be a button that lies.
 */
export function startManualShift({ getGear, onGearChange, sim: simRefs, pedal: withPedal = false } = {}) {
  if (ui) return { destroy() {} };
  onChange = onGearChange || null;
  sim = simRefs || null;
  build(getGear, withPedal);

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
    if (e.code === 'Space' && !e.repeat) { pressPedal(); e.preventDefault(); return; }
    if (!isManual()) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { doShift(1, 'key'); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') { doShift(-1, 'key'); e.preventDefault(); }
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  const onKeyUp = (e) => {
    if (e.code === 'Space') { releasePedal(); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  // Losing focus mid-throttle must not leave the pedal stuck down.
  const onBlur = () => releasePedal();
  window.addEventListener('blur', onBlur);
  // Touching the slider is the driver taking the speed back by hand.
  const slider = document.querySelector('#sim-speed');
  const onSlider = () => { owns = false; releasePedal(); };
  if (slider) slider.addEventListener('input', onSlider);

  return {
    render,
    /**
     * What the pedal is asking for, or null when it is not asking.
     *
     * physics derives throttle from how fast the speed is CHANGING, so a car
     * standing still reports zero throttle however hard the pedal is held —
     * and a blip is precisely the case where the pedal is open and the speed
     * is not moving. The app applies this over the derived value.
     */
    throttleOverride: () => (pedal ? 1 : null),
    destroy() {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (slider) slider.removeEventListener('input', onSlider);
      cancelAnimationFrame(pedalRaf);
      owns = false;
      pedal = false;
      if (ui) { ui.root.remove(); ui.paddles.remove(); ui.gas.remove(); }
      ui = null;
      releaseManual();
    },
  };
}
