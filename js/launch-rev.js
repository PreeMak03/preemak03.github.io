/**
 * Launch Rev — shared scripted G1→G2→G3 drag pull (TAS main + Vessel Lab bench).
 * Pure functions: no WebAudio.
 *
 * v3 multi-bus: returns transmission/bus cues (tipIn, overrun, txScale, loadBus)
 * so VesselAudio can drive gear AudioParam + parallel sum without lagging state.
 */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function damp(cur, target, lambda, dt) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

/**
 * Drag-run schedule: full-throttle pulls to redline, torque-cut shifts, lift-off.
 * @param {number} total seconds (typically 5)
 * @param {boolean} [isEv=false]
 * @returns {Array<object>}
 */
export function buildRevScript(total = 5, isEv = false) {
  const T = clamp(total, 2, 10);
  const release = Math.min(0.9, T * 0.18);
  const pullTotal = T - release;
  const segs = [];
  if (isEv) {
    segs.push({ type: 'pull', t0: 0, t1: pullTotal, from: 0.12, to: 0.86, gear: 1 });
  } else {
    // Slightly longer shift gap so multi-bus gear scale + pulse torque-cut are audible
    const shiftGap = 0.14;
    const weights = [0.3, 0.33, 0.37];
    // Landing norms: clear RPM drop on upshift (multi-bus sub re-locks cleanly)
    const froms = [0.16, 0.38, 0.42];
    const pullTime = pullTotal - shiftGap * 2;
    let t = 0;
    for (let i = 0; i < 3; i++) {
      const dur = pullTime * weights[i];
      segs.push({
        type: 'pull',
        t0: t,
        t1: t + dur,
        from: froms[i],
        to: 1.0,
        gear: i + 1,
      });
      t += dur;
      if (i < 2) {
        segs.push({
          type: 'shift',
          t0: t,
          t1: t + shiftGap,
          gear: i + 2,
          land: froms[i + 1],
          fired: false,
        });
        t += shiftGap;
      }
    }
  }
  segs.push({ type: 'release', t0: T - release, t1: T, from: 1.0, gear: 3 });
  return segs;
}

/**
 * Step one frame of Launch Rev.
 *
 * @param {object} ctx
 * @param {number} ctx.elapsed  seconds since launch start
 * @param {Array}  ctx.script   from buildRevScript
 * @param {number} ctx.rpm      current rpm (smoothed)
 * @param {number} ctx.idle
 * @param {number} ctx.redline
 * @param {number} ctx.dt
 * @param {(down:boolean)=>void} [ctx.onShiftClick]
 * @returns {{
 *   rpm:number, load:number, loadBus:number, gear:number,
 *   state:string, shifting:boolean, done:boolean, seg:object|null,
 *   tipIn:number, overrun:number, txScale:number, gearSnap:boolean,
 *   target?:number, n?:number
 * }}
 */
export function stepRevScript(ctx) {
  const {
    elapsed,
    script,
    rpm: rpmIn,
    idle,
    redline,
    dt = 0.02,
    onShiftClick,
  } = ctx;
  const span = Math.max(500, redline - idle);
  const segs = script || [];
  if (!segs.length) {
    return {
      rpm: idle,
      load: 0.05,
      loadBus: 0.05,
      gear: 1,
      state: 'idle',
      shifting: false,
      done: true,
      seg: null,
      tipIn: 0,
      overrun: 0,
      txScale: 1,
      gearSnap: true,
    };
  }

  const total = segs[segs.length - 1].t1;
  if (elapsed >= total) {
    return {
      rpm: damp(rpmIn, idle, 8, dt),
      load: 0.08,
      loadBus: 0.08,
      gear: segs[segs.length - 1].gear || 3,
      state: 'done',
      shifting: false,
      done: true,
      seg: null,
      tipIn: 0,
      overrun: 0.15,
      txScale: 0.9,
      gearSnap: false,
    };
  }

  const seg =
    segs.find((s) => elapsed >= s.t0 && elapsed < s.t1) || segs[segs.length - 1];

  let n = 0.15;
  let load = 0.2;
  let loadBus = 0.2;
  let lambda = 12;
  let gear = 1;
  let state = 'launch';
  let shifting = false;
  let tipIn = 0;
  let overrun = 0;
  let txScale = 1;
  let gearSnap = false;

  if (seg.type === 'pull') {
    const prog = clamp((elapsed - seg.t0) / Math.max(0.05, seg.t1 - seg.t0), 0, 1);
    // Fast off the line, strain near redline
    n = seg.from + (seg.to - seg.from) * Math.pow(prog, 0.85);
    load = 1;
    // Multi-bus: keep body/pulse fed hard through the pull (sub + pulse buses)
    loadBus = 1;
    lambda = 18;
    gear = seg.gear;
    state = 'pull';
    // Punch at each gear pull start (helps bodyLift / tip drive on v3 worklet)
    const punch = Math.exp(-prog * 5.5);
    tipIn = 0.14 + 0.62 * punch + (gear === 1 ? 0.08 * punch : 0);
    // G1 slightly hotter master; taller gears ease via host gearVolumeScale too
    txScale = gear === 1 ? 1.12 : gear === 2 ? 1.04 : 0.98;
    gearSnap = prog < 0.02;
  } else if (seg.type === 'shift') {
    if (!seg.fired) {
      seg.fired = true;
      if (typeof onShiftClick === 'function') onShiftClick(false);
    }
    n = seg.land;
    // Deeper torque cut so pulse bus collapses cleanly (not a noisy partial duck)
    load = 0.12;
    loadBus = 0.1;
    lambda = 26;
    gear = seg.gear;
    shifting = true;
    state = 'shift';
    tipIn = 0;
    overrun = 0.05;
    txScale = 0.48;
    gearSnap = true; // snap transmission gear for v3 AudioParam
  } else if (seg.type === 'release') {
    const prog = clamp((elapsed - seg.t0) / Math.max(0.05, seg.t1 - seg.t0), 0, 1);
    n = seg.from * (1 - prog) + 0.08 * prog;
    load = 0.08;
    loadBus = 0.06;
    lambda = 8;
    gear = seg.gear != null ? seg.gear : 3;
    state = 'overrun';
    tipIn = 0;
    overrun = 0.75 * (1 - prog) + 0.08;
    txScale = 0.86;
    gearSnap = false;
  }

  const target = idle + span * clamp(n, 0, 1);
  const rpm = damp(rpmIn, target, lambda, dt);

  return {
    rpm,
    load,
    loadBus,
    gear,
    state,
    shifting,
    done: false,
    seg,
    tipIn: clamp(tipIn, 0, 1),
    overrun: clamp(overrun, 0, 1),
    txScale: clamp(txScale, 0.2, 1.25),
    gearSnap,
    target,
    n,
  };
}

export function revScriptDuration(script) {
  if (!script || !script.length) return 0;
  return script[script.length - 1].t1;
}
