/**
 * Dev-mode drive recorder.
 *
 * WHY IT EXISTS
 *   The owner reports judder in the car that does not appear when the sim
 *   slider is dragged on the same device — so the audio graph is not the
 *   difference, the input is. Every attempt to reproduce that input
 *   synthetically has failed: fed the same modelled GPS noise, CRANK measured
 *   SMOOTHER than classic-muscle (3.3 dB of level wobble against 7.7), which
 *   means the model is wrong, not that the judder is imaginary.
 *
 *   Guessing at the conditions is what has been costing time. This records
 *   what actually happens instead, so the next drive produces data.
 *
 * COST
 *   20 Hz, ten numbers a sample, into a pre-allocated ring. No allocation per
 *   sample, no DOM work, no audio-thread involvement. Dev mode only.
 *
 * USE
 *   It starts itself. After a drive, in the console:
 *       TAS.trace.summary()   // suspect moments, ranked
 *       TAS.trace.dump()      // the whole ring as JSON
 *       copy(TAS.trace.dump())
 */

const HZ = 20;
const SECONDS = 180;
const N = HZ * SECONDS;

export function startDevTrace(getAudio, state, physics) {
  const t = new Float64Array(N);
  const geoSpeed = new Float32Array(N);
  const active = new Float32Array(N);
  const accel = new Float32Array(N);
  const rpm = new Float32Array(N);
  const gear = new Int8Array(N);
  const dyn = new Float32Array(N);
  const pitch = new Float32Array(N);
  const fixHz = new Float32Array(N);
  const acc = new Float32Array(N);
  const st = new Uint8Array(N);
  const STATES = ['idle', 'cruise', 'pull', 'overrun', 'shift'];

  let i = 0;
  let wrapped = false;
  const t0 = performance.now();

  const played = (a) => {
    try {
      if (a._voices) return a._voices[a._active].oscL.frequency.value;
      if (a._layers && a._layers.low) return a._layers.low.src.playbackRate.value;
    } catch (_) { /* engine mid-swap */ }
    return 0;
  };

  const timer = setInterval(() => {
    const a = getAudio && getAudio();
    if (!a || !a.running) return;
    t[i] = performance.now() - t0;
    geoSpeed[i] = state.geoSpeed || 0;
    active[i] = state.activeSpeed || 0;
    accel[i] = state.accelKmhps || 0;
    rpm[i] = a.rpm || 0;
    gear[i] = a.gearIndex || a._gear || 0;
    dyn[i] = a._nodes && a._nodes.dynGain ? a._nodes.dynGain.gain.value
      : (a.dynGain ? a.dynGain.gain.value : 0);
    pitch[i] = played(a);
    fixHz[i] = state.fixHz || 0;
    acc[i] = state.geoAccuracy || 0;
    const s = STATES.indexOf(a._driveState || a.driveState || 'idle');
    st[i] = s < 0 ? 0 : s;
    i = (i + 1) % N;
    if (i === 0) wrapped = true;
  }, 1000 / HZ);

  /** Oldest-to-newest order over whatever the ring currently holds. */
  const order = () => {
    const n = wrapped ? N : i;
    const out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = wrapped ? (i + k) % N : k;
    return out;
  };

  const api = {
    stop() { clearInterval(timer); },

    dump() {
      const idx = order();
      return JSON.stringify({
        hz: HZ,
        profile: state.profileId,
        samples: idx.map((k) => ({
          t: +t[k].toFixed(0), gs: +geoSpeed[k].toFixed(2), v: +active[k].toFixed(2),
          a: +accel[k].toFixed(2), rpm: Math.round(rpm[k]), g: gear[k],
          dyn: +dyn[k].toFixed(3), hz: +pitch[k].toFixed(2),
          fix: +fixHz[k].toFixed(1), acc: Math.round(acc[k]), s: STATES[st[k]],
        })),
      });
    },

    /**
     * Rank the moments most likely to BE the judder, so a drive does not have
     * to be read sample by sample. Three separate things can produce it and
     * they need telling apart: the gain jumping, the pitch jumping, and the
     * acceleration signal changing sign while the car is doing no such thing.
     */
    summary() {
      const idx = order();
      if (idx.length < 10) return 'not enough samples yet — drive first';
      const ev = [];
      for (let k = 3; k < idx.length; k++) {
        const p = idx[k - 1], c = idx[k];
        const dDyn = dyn[p] > 1e-4 ? Math.abs(20 * Math.log10(dyn[c] / dyn[p])) : 0;
        const dPitch = pitch[p] > 1e-4 && pitch[c] > 1e-4
          ? Math.abs(12 * Math.log2(pitch[c] / pitch[p])) : 0;
        const signFlip = (accel[p] > 0.8 && accel[c] < -0.8) || (accel[p] < -0.8 && accel[c] > 0.8);
        const gearFlip = gear[c] !== gear[p];
        const stateFlip = st[c] !== st[p];
        if (dDyn > 1.5 || dPitch > 2.5 || signFlip || gearFlip) {
          ev.push({
            t: +(t[c] / 1000).toFixed(1), v: +active[c].toFixed(1), a: +accel[c].toFixed(1),
            gainJumpDb: +dDyn.toFixed(1), pitchJumpSt: +dPitch.toFixed(1),
            accelSignFlip: signFlip, gear: gearFlip ? `${gear[p]}->${gear[c]}` : gear[c],
            state: stateFlip ? `${STATES[st[p]]}->${STATES[st[c]]}` : STATES[st[c]],
            fixHz: +fixHz[c].toFixed(1), accM: Math.round(acc[c]),
          });
        }
      }
      const n = idx.length / HZ;
      const worst = ev.slice().sort((x, y) =>
        (y.gainJumpDb + y.pitchJumpSt) - (x.gainJumpDb + x.pitchJumpSt)).slice(0, 25);
      return {
        seconds: +n.toFixed(0),
        events: ev.length,
        perSecond: +(ev.length / n).toFixed(2),
        gainJumps: ev.filter((e) => e.gainJumpDb > 1.5).length,
        pitchJumps: ev.filter((e) => e.pitchJumpSt > 2.5).length,
        accelSignFlips: ev.filter((e) => e.accelSignFlip).length,
        gearChanges: ev.filter((e) => String(e.gear).includes('->')).length,
        worst,
      };
    },
  };
  return api;
}
