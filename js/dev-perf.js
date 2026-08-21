/**
 * Dev-mode performance readout.
 *
 * Exists because of a real question that could not be answered from a desk: the
 * sound juddered in Firefox and not in Edge, and the browser that actually
 * matters is Tesla's — which is neither. Guessing about a device you cannot
 * profile is how the last few rounds went wrong, so this puts the numbers on
 * screen in the car instead.
 *
 * Dev mode only, loaded on demand, and every reading is optional: if a browser
 * does not expose something the line simply omits it rather than breaking.
 *
 * What each field answers:
 *   fps     is the UI keeping up (main thread)
 *   tick    is the engine's own clock keeping its interval (main thread)
 *   audio   is the AUDIO thread keeping up — the one that actually causes
 *           dropouts. Chromium exposes AudioContext.renderCapacity; where it is
 *           missing, `stall` below is the fallback signal.
 *   stall   times the audio clock fell behind the wall clock, which means the
 *           context could not render in real time
 *   tier    whether the engine dropped to its lite settings on this device
 */

const FMT = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '–');

/**
 * Count AudioContexts. The owner found the leak by ear — card reading 1JZ
 * while classic played — and asked the right follow-up: what about the dev
 * who does not notice? A leaked context is silent by construction, because
 * the old stop() faded its master to zero and left the graph rendering. It
 * cannot be heard, so it has to be counted.
 *
 * Chrome allows roughly six per page. Anything above two live at once means
 * something is not closing.
 */
let ctxOpen = 0;
let ctxMade = 0;
if (typeof window !== 'undefined' && window.AudioContext && !window.__tasCtxCounted) {
  window.__tasCtxCounted = true;
  const Real = window.AudioContext;
  const Patched = function (...args) {
    const c = new Real(...args);
    ctxOpen++; ctxMade++;
    const close = c.close.bind(c);
    c.close = function () { ctxOpen = Math.max(0, ctxOpen - 1); return close(); };
    return c;
  };
  Patched.prototype = Real.prototype;
  // Observable, so a leak can be checked rather than argued about.
  window.__tasCtx = () => ({ open: ctxOpen, made: ctxMade });
  window.AudioContext = Patched;
  if (window.webkitAudioContext === Real) window.webkitAudioContext = Patched;
}

export function startDevPerf(el, getAudio, getExpectedKind) {
  if (!el) return () => {};

  let frames = 0;
  let fps = 0;
  let lastFpsAt = performance.now();
  let raf = 0;

  // Audio-thread load, where the browser will tell us.
  let renderPct = null;
  let capacity = null;
  let capacityCtx = null;

  // Fallback: has the audio clock kept pace with the wall clock?
  let stalls = 0;
  let lastWall = performance.now();
  let lastAudio = 0;
  let lastCtx = null;

  // The engine's own tick interval, sampled through its rpm clock being alive.
  let tickJitter = null;

  const attachCapacity = (ctx) => {
    if (!ctx || ctx === capacityCtx) return;
    try {
      if (capacity) capacity.stop();
    } catch (_) {}
    capacity = null;
    capacityCtx = ctx;
    renderPct = null;
    const rc = ctx.renderCapacity;
    if (!rc || typeof rc.start !== 'function') return;   // not Chromium, or too old
    try {
      rc.onupdate = (e) => { renderPct = e.averageLoad * 100; };
      rc.start({ updateInterval: 1 });
      capacity = rc;
    } catch (_) { capacity = null; }
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    frames += 1;
    const now = performance.now();
    if (now - lastFpsAt < 500) return;

    fps = (frames * 1000) / (now - lastFpsAt);
    frames = 0;
    lastFpsAt = now;

    const a = typeof getAudio === 'function' ? getAudio() : null;
    const ctx = a && a.ctx;

    if (ctx && ctx !== lastCtx) {
      lastCtx = ctx;
      lastWall = now;
      lastAudio = ctx.currentTime;
      stalls = 0;
      attachCapacity(ctx);
    } else if (ctx && ctx.state === 'running') {
      const dWall = (now - lastWall) / 1000;
      const dAudio = ctx.currentTime - lastAudio;
      // The audio clock is driven by the device's own output. Falling this far
      // behind the wall clock means it could not render in real time.
      if (dWall > 0.3 && dAudio < dWall * 0.85) stalls += 1;
      lastWall = now;
      lastAudio = ctx.currentTime;
    }

    if (a && typeof a._tickJitterMs === 'number') tickJitter = a._tickJitterMs;

    const bits = [`${FMT(fps)}fps`];
    if (tickJitter != null) bits.push(`tick±${FMT(tickJitter, 1)}ms`);
    if (renderPct != null) bits.push(`audio ${FMT(renderPct)}%`);
    bits.push(`stall ${stalls}`);
    if (ctx) bits.push(`${FMT(ctx.sampleRate / 1000, 1)}k`);
    if (a && a._lite != null) bits.push(a._lite ? 'lite' : 'full');
    if (ctxOpen > 2) bits.push(`ctx ${ctxOpen}/${ctxMade}`);
    // The invariant the owner had to catch by ear. Say it loudly instead.
    if (typeof getExpectedKind === 'function') {
      try {
        const want = getExpectedKind();
        const got = a ? a.constructor.name : null;
        const ok = !want || !got
          || (want === 'crank' && got === 'CrankAudio')
          || (want === 'vessel' && got === 'VesselAudio')
          || (want === 'turbine' && got === 'TurbineAudio')
          || (want === 'classic' && got === 'AudioEngine');
        if (!ok) bits.push(`WRONG ENGINE ${want}!=${got}`);
      } catch (_) { /* diagnostic only */ }
    }
    el.textContent = bits.join(' · ');
  };

  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    try { if (capacity) capacity.stop(); } catch (_) {}
  };
}
