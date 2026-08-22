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
 *   It starts itself and needs nothing while driving. The Tesla browser has no
 *   console — asking for one was a mistake — so the readout in the top bar
 *   turns into a SEND button once it has caught something, and one tap posts
 *   the evidence through the same Web3Forms pipe the feedback button already
 *   uses. That pipe is the only channel proven to work from the car: the
 *   CommandRoom server lives on localhost, the car cannot reach it while
 *   driving, and an HTTPS page may not POST to it even parked on the same
 *   wifi.
 */

const HZ = 50;   // 25 Hz Nyquist: enough to SEE a flutter, not just a lurch
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
  const rms = new Float32Array(N);      // the audio itself, not a control value
  const rough = new Float32Array(N);    // dB of level modulation over the last 0.5 s
  const tick = new Float32Array(N);      // worst engine tick interval, ms
  const stall = new Uint16Array(N);      // running count of late ticks
  const STATES = ['idle', 'cruise', 'pull', 'overrun', 'shift'];

  // The owner cannot watch numbers: driving takes 80-85% of his attention, so
  // a design that needs him to notice the fault AND tap within two seconds is
  // a design that asks the wrong person to do the work. The recorder keeps the
  // worst moments of the whole drive by itself. Nothing to press, nothing to
  // watch, nothing to remember — park, tap once, and it is all there.
  //
  // No threshold, deliberately. We do not yet know what the judder looks like,
  // and a threshold can only catch what someone already guessed. Keeping the
  // top few by score catches it whatever shape it turns out to be.
  const KEEP = 8;
  const CAPTURE_S = 1.5;
  const COOLDOWN_S = 4;
  const worstKept = [];
  let coolUntil = 0;
  let buf = null;
  let pendingCapture = null;
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
    // The control values are what the engine INTENDED. This is what came out.
    // Judder that lives between control ticks is invisible to everything else
    // here — the owner's three traces came back with 0 gain jumps while he was
    // hearing it, which is the instrument failing, not the car behaving.
    let r = 0;
    try {
      const an = a.getAnalyser();
      if (an) {
        if (!buf || buf.length !== an.fftSize) buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        let acc2 = 0;
        for (let q = 0; q < buf.length; q += 4) acc2 += buf[q] * buf[q];
        r = Math.sqrt(acc2 / (buf.length / 4));
      }
    } catch (_) { /* engine mid-swap */ }
    // Is the main thread starving the parameter updates? The owner noticed
    // that VESSEL's waveguide juddered badly too — different synthesis, same
    // symptom — and what those two share, and classic does not, is a single
    // source whose parameter IS the pitch. A late tick lands there directly.
    tick[i] = a._tickWorstMs || 0;
    stall[i] = Math.min(65535, a._tickStalls || 0);
    if (a._tickWorstMs != null) a._tickWorstMs = 0;   // peak-hold, read and reset
    rms[i] = r;
    // modulation depth over the last half second
    const back = Math.min(HZ >> 1, wrapped ? N : i);
    let lo = Infinity, hi = 0;
    for (let q = 1; q <= back; q++) {
      const k2 = (i - q + N) % N;
      const x = rms[k2];
      if (x > 1e-5) { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    rough[i] = (hi > 0 && lo < Infinity && lo > 0) ? 20 * Math.log10(hi / lo) : 0;
    // Score this instant. Level modulation, a late tick, and a pitch jump are
    // the three things that can BE the judder, so any of them can nominate a
    // moment; they are kept separate in the payload because they need
    // different fixes.
    const prevK = (i - 1 + N) % N;
    const dPitchNow = (pitch[i] > 1e-4 && pitch[prevK] > 1e-4)
      ? Math.abs(12 * Math.log2(pitch[i] / pitch[prevK])) : 0;
    const score = rough[i] + dPitchNow * 3 + Math.max(0, (tick[i] - 40) / 10);
    const nowS = t[i] / 1000;
    // The engine start outscores everything that follows — the first run of
    // this filled the top two slots with it and squeezed the actual drive out.
    // Nothing before the car has moved is what he is asking about.
    const warm = nowS > 8 && (active[i] > 2 || wrapped);
    // A pinned moment must survive to be captured. Clearing the cooldown in
    // mark() let the scorer overwrite it on the very next tick, so the window
    // was taken but arrived unflagged.
    if (warm && nowS > coolUntil && !(pendingCapture && pendingCapture.marked)) {
      const weakest = worstKept.length < KEEP
        ? -1
        : worstKept.reduce((lo, w, n2, arr) => {
          if (w.marked) return lo;                    // a human said this one matters
          if (arr[lo].marked) return n2;
          return w.score < arr[lo].score ? n2 : lo;
        }, 0);
      if (worstKept.length < KEEP || score > worstKept[weakest].score) {
        pendingCapture = { at: i, atS: nowS, score, slot: weakest };
        coolUntil = nowS + COOLDOWN_S;
      }
    }
    // A capture needs the samples AFTER the moment too, so it is taken half a
    // window later rather than on the spot.
    if (pendingCapture && nowS >= pendingCapture.atS + CAPTURE_S) {
      const c2 = pendingCapture; pendingCapture = null;
      const half = Math.round(CAPTURE_S * HZ);
      const rowsOut = [];
      for (let q = -half; q <= half; q++) {
        const k2 = (c2.at + q + N) % N;
        if (!wrapped && (c2.at + q < 0 || c2.at + q > i)) continue;
        rowsOut.push({
          t: +(t[k2] / 1000).toFixed(2), v: +active[k2].toFixed(1),
          a: +accel[k2].toFixed(2), rpm: Math.round(rpm[k2]), g: gear[k2],
          dyn: +dyn[k2].toFixed(3), hz: +pitch[k2].toFixed(2),
          s: STATES[st[k2]], rough: +rough[k2].toFixed(1), tick: +tick[k2].toFixed(0),
        });
      }
      const entry = { atS: +c2.atS.toFixed(1), score: +c2.score.toFixed(1), rows: rowsOut };
      if (c2.marked) entry.marked = c2.marked;
      if (c2.slot < 0) worstKept.push(entry); else worstKept[c2.slot] = entry;
    }
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
        if (dDyn > 1.5 || dPitch > 2.5 || signFlip || gearFlip || rough[c] > 6) {
          ev.push({
            t: +(t[c] / 1000).toFixed(1), v: +active[c].toFixed(1), a: +accel[c].toFixed(1),
            gainJumpDb: +dDyn.toFixed(1), pitchJumpSt: +dPitch.toFixed(1),
            accelSignFlip: signFlip, gear: gearFlip ? `${gear[p]}->${gear[c]}` : gear[c],
            state: stateFlip ? `${STATES[st[p]]}->${STATES[st[c]]}` : STATES[st[c]],
            fixHz: +fixHz[c].toFixed(1), accM: Math.round(acc[c]),
            roughDb: +rough[c].toFixed(1),
          });
        }
      }
      const rs = idx.map((k) => rough[k]).filter((x) => x > 0).sort((x, y) => x - y);
      const rp = (q) => (rs.length ? +rs[Math.floor(rs.length * q)].toFixed(1) : 0);
      const n = idx.length / HZ;
      const worst = ev.slice().sort((x, y) =>
        (y.gainJumpDb + y.pitchJumpSt + y.roughDb) - (x.gainJumpDb + x.pitchJumpSt + x.roughDb)).slice(0, 25);
      return {
        seconds: +n.toFixed(0),
        events: ev.length,
        perSecond: +(ev.length / n).toFixed(2),
        gainJumps: ev.filter((e) => e.gainJumpDb > 1.5).length,
        pitchJumps: ev.filter((e) => e.pitchJumpSt > 2.5).length,
        accelSignFlips: ev.filter((e) => e.accelSignFlip).length,
        gearChanges: ev.filter((e) => String(e.gear).includes('->')).length,
        roughP50: rp(0.5), roughP95: rp(0.95), roughMax: rs.length ? +rs[rs.length - 1].toFixed(1) : 0,
        worst,
      };
    },
    /**
     * Post the evidence. The full ring is ~360 KB, far too big for a form
     * field and mostly uneventful anyway, so this sends the ranked summary
     * plus the raw samples immediately around the two worst moments — which is
     * what actually has to be read to tell the causes apart.
     */
    async send(note) {
      const s = api.summary();
      if (typeof s === 'string') return { ok: false, why: s };
      const idx = order();
      const around = [];
      for (const w of s.worst.slice(0, 2)) {
        const centre = idx.findIndex((k) => Math.abs(t[k] / 1000 - w.t) < 0.06);
        if (centre < 0) continue;
        const from = Math.max(0, centre - HZ * 1.5);
        const to = Math.min(idx.length, centre + HZ * 1.5);
        around.push({
          at: w.t,
          rows: idx.slice(from, to).map((k) => ({
            t: +(t[k] / 1000).toFixed(2), v: +active[k].toFixed(1),
            a: +accel[k].toFixed(2), rpm: Math.round(rpm[k]), g: gear[k],
            dyn: +dyn[k].toFixed(3), hz: +pitch[k].toFixed(2),
            s: STATES[st[k]], fix: +fixHz[k].toFixed(1), rough: +rough[k].toFixed(1),
          })),
        });
      }
      // What machine produced these numbers. Without it every claim about the
      // car's performance is a guess, and any attempt to reproduce it on a
      // desktop is emulating an unmeasured target. Cheap, and it only ships in
      // the trace payload.
      const au = getAudio && getAudio();
      const ac = au && au.ctx;
      const rig = {
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency || null,
        memGb: navigator.deviceMemory || null,
        screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
        sampleRate: ac ? ac.sampleRate : null,
        baseLatencyMs: ac && ac.baseLatency != null ? +(ac.baseLatency * 1000).toFixed(1) : null,
        outputLatencyMs: ac && ac.outputLatency != null ? +(ac.outputLatency * 1000).toFixed(1) : null,
        // #app-build, not '.build-stamp' — the first guess matched nothing, so
        // five drives came back with build: null and no way to tell which code
        // produced them. #app-ver is the release, #app-build the commit.
        build: ((document.querySelector('#app-build') || {}).textContent || '').trim() || null,
        ver: ((document.querySelector('#app-ver') || {}).textContent || '').trim() || null,
      };
      const body = {
        access_key: 'b0c38acf-3953-4910-9fbb-290ad09af3a5',
        subject: 'TAS drive trace — ' + (state.profileId || '?'),
        from_name: 'Tesla Active Sound',
        category: 'drive-trace',
        message: note || 'drive trace',
        profile: state.profileId,
        summary: JSON.stringify({ ...s, worst: s.worst.slice(0, 8) }),
        rig: JSON.stringify(rig),
        // What every control in the car actually emits. matched:false is the
        // interesting half — a control the gearbox is ignoring.
        inputs: JSON.stringify(
          (window.TAS && window.TAS.manual && window.TAS.manual.inputLog)
            ? window.TAS.manual.inputLog() : []),
        // Always. He taps just after hearing it, so this is the evidence;
        // the ranked list is context.
        tail: JSON.stringify(api.tail(6)),
        // Caught unattended — this is the part that does not depend on him
        // noticing anything.
        auto: JSON.stringify(api.worst().slice(0, 5)),
        windows: JSON.stringify(around),
      };
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        ok: res.ok, events: s.events, seconds: s.seconds,
        gain: s.gainJumps, pitch: s.pitchJumps, rough: s.roughP95,
        caught: api.worst().length,
        flip: s.accelSignFlips, gear: s.gearChanges,
      };
    },
    /**
     * The last few seconds, whatever they contain.
     *
     * The owner taps within about 2 s of hearing it, so the evidence is
     * always at the END of the ring — and ranking by magnitude buried that
     * under the engine start, which is louder than anything and happens at
     * t=9. Across three real traces the detector found nothing at all in the
     * final 23, 6 and 55 seconds, exactly where the judder was. A threshold
     * that has to be crossed cannot report the thing it is failing to see;
     * this reports it regardless.
     */
    /**
     * Pin this moment. He asked to keep a button for the times he can watch —
     * and he is right that it should stay: a tap is a human saying THIS one,
     * which no score can infer. Marked windows are never evicted by scoring.
     */
    mark(why) {
      const nowS = t[i === 0 ? N - 1 : i - 1] / 1000;
      pendingCapture = { at: (i - 1 + N) % N, atS: nowS, score: 1e6, slot: -1, marked: why || 'tapped' };
      coolUntil = 0;
      return +nowS.toFixed(1);
    },

    /** The worst moments of the drive, caught without anyone watching. */
    worst() {
      return worstKept.slice().sort((x, y) => y.score - x.score);
    },

    tail(seconds = 6) {
      const idx = order();
      const take = Math.min(idx.length, Math.round(seconds * HZ));
      const slice = idx.slice(idx.length - take);
      if (!slice.length) return null;
      const rs = slice.map((k) => rough[k]).filter((x) => x > 0).sort((a, b) => a - b);
      const rows = slice.map((k) => ({
        t: +(t[k] / 1000).toFixed(2), v: +active[k].toFixed(1), a: +accel[k].toFixed(2),
        rpm: Math.round(rpm[k]), g: gear[k], dyn: +dyn[k].toFixed(3),
        hz: +pitch[k].toFixed(2), s: STATES[st[k]], rough: +rough[k].toFixed(1),
        tick: +tick[k].toFixed(0),
        fix: +fixHz[k].toFixed(1),
      }));
      return {
        seconds,
        roughP50: rs.length ? +rs[Math.floor(rs.length * 0.5)].toFixed(1) : 0,
        roughP95: rs.length ? +rs[Math.floor(rs.length * 0.95)].toFixed(1) : 0,
        roughMax: rs.length ? +rs[rs.length - 1].toFixed(1) : 0,
        tickWorstMs: +Math.max(...slice.map((k) => tick[k])).toFixed(0),
        tickStalls: slice.length ? stall[slice[slice.length - 1]] - stall[slice[0]] : 0,
        speedFrom: rows[0].v, speedTo: rows[rows.length - 1].v,
        gears: [...new Set(rows.map((r) => r.g))],
        states: [...new Set(rows.map((r) => r.s))],
        rows,
      };
    },

    /**
     * The one line the owner can actually read off a car screen and say out
     * loud. Sending the trace was worth building, but it goes to HIS inbox —
     * which I cannot read, so on its own it moved nothing. These four counts
     * separate the causes, and each one points somewhere different:
     *   gain  -> the level is jumping (dynamic volume / duck / drive state)
     *   pitch -> the revs are jumping (rpm target, rate caps, glide)
     *   flip  -> the app is inventing acceleration that reverses sign
     *   gear  -> the gearbox is changing its mind
     */
    verdict() {
      const s = api.summary();
      if (typeof s === 'string') return s;
      // Lead with what was caught unattended. The tail only matters if he
      // happened to tap at the right moment, and he cannot — driving takes
      // 80-85% of his attention.
      const w = api.worst();
      const top = w.length ? w[0] : null;
      const caught = top
        ? `caught ${w.length} · worst ${top.score} @${top.atS}s · `
        : 'caught 0 · ';
      const tl = api.tail(6);
      const tail = tl ? `tick ${tl.tickWorstMs}ms/${tl.tickStalls} · ` : '';
      return caught + tail + `${s.seconds}s · rough ${s.roughP95}/${s.roughMax}dB · gain ${s.gainJumps} · ` +
             `pitch ${s.pitchJumps} · flip ${s.accelSignFlips} · gear ${s.gearChanges}`;
    },
  };
  return api;
}
