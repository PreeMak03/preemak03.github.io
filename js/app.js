/**
 * Tesla Active Sound — Application orchestrator
 * Simulation uses Model S Plaid-limited acceleration + Ioniq-style active sound.
 */

import { ticker, waapi, clamp } from './animations.js';
import { getProfileById, loadLiveSet, loadClassicStandards, getLiveProfileIds, getGlobalControl, getVisibleProfiles } from './profiles.js';
import { AudioEngine } from './audio-engine.js';
// hasRig is tiny; VesselAudio itself is dynamic-imported only for VESSEL cards
import { hasRig } from './vessel-rigs.js';
// same trick for CRANK — the id map is a few bytes, CrankAudio loads on demand
import { hasCrank } from './crank-rigs.js';
import { hasTurbine } from './turbine-rigs.js';
import { GeolocationService } from './geolocation.js';
import { VehiclePhysics, SIM_RATE } from './vehicle-physics.js';
import { startOnboarding } from './onboarding.js';
import {
  renderProfiles,
  SpeedDisplay,
  bindSliders,
  bindToggles,
  setModeUI,
  setAudioStatus,
  setGpsStatus,
  showToast,
  finishBoot,
  $,
} from './ui.js';

/** Accel tube scale — tied to the real sim rate limit, not a magic number */
const ACCEL_TUBE_MAX = SIM_RATE.maxDeltaKmhPerSec;

/** Coffee link (Ko-fi / Buy Me a Coffee / PromptPay page). Empty = hidden. */
const DONATE_URL = '';

const hud = {
  rpmEl: null,
  fillPos: null,
  fillNeg: null,
  readout: null,
  stateEl: null,
  _lastRpmKey: '',
  _lastAccelKey: '',
  _lastState: '',
};

function initHud() {
  hud.rpmEl = $('#speed-rpm');
  hud.fillPos = $('#accel-fill-pos');
  hud.fillNeg = $('#accel-fill-neg');
  hud.readout = $('#accel-readout');
  hud.stateEl = $('#drive-state');
  // Labels reflect the actual scale (no hard-coded ±40)
  const labels = document.querySelectorAll('.accel-tube-label');
  if (labels[0]) labels[0].textContent = `+${Math.round(ACCEL_TUBE_MAX)}`;
  if (labels[1]) labels[1].textContent = `−${Math.round(ACCEL_TUBE_MAX)}`;
}

/**
 * Vertical accel tube: 0 = middle, +max = top, −max = bottom.
 * Smoothed (GPS Δv/Δt is spiky) + a mild expansion curve so everyday
 * acceleration is clearly visible while a full launch still pegs the ends.
 * @param {number} accelKmhps
 */
function updateAccelTube(accelKmhps) {
  const max = ACCEL_TUBE_MAX;
  const target = clamp(accelKmhps, -max, max);
  // Smooth the needle so each per-second GPS value glides (and drops back to
  // 0 smoothly when acceleration ends) instead of snapping.
  hud._accelDisp = (hud._accelDisp || 0) + (target - (hud._accelDisp || 0)) * 0.15;
  const a = hud._accelDisp;

  // Honest linear scale: full tube = ±max, so a delta of 5 shows 5/max.
  const frac = Math.min(1, Math.abs(a) / max);
  if (hud.fillPos) hud.fillPos.style.height = `${a > 0 ? frac * 50 : 0}%`;
  if (hud.fillNeg) hud.fillNeg.style.height = `${a < 0 ? frac * 50 : 0}%`;
  if (hud.readout) {
    const sign = a > 0.05 ? '+' : '';
    hud.readout.textContent = `${sign}${Math.round(a)}`;
    hud.readout.style.color =
      a > 1 ? 'var(--accel-pos)' : a < -1 ? 'var(--accel-neg)' : 'var(--text-secondary)';
  }
}

function updateRpmLabel(rpm, gear, gearCount = 3) {
  const rpmI = Math.round(rpm || 0);
  const g = gear || 1;
  const key = `${rpmI}|${g}|${gearCount}`;
  if (key === hud._lastRpmKey) return;
  hud._lastRpmKey = key;
  if (hud.rpmEl) {
    hud.rpmEl.textContent =
      gearCount > 1
        ? `${rpmI.toLocaleString()} RPM · G${g}/${gearCount}`
        : `${rpmI.toLocaleString()} RPM · EV`;
  }
}

function updateDriveState(state) {
  if (!hud.stateEl || state === hud._lastState) return;
  hud._lastState = state;
  hud.stateEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  hud.stateEl.dataset.state = state;
}

function initThemeToggle() {
  const root = document.documentElement;
  const btn = $('#btn-theme');
  const label = $('#theme-label');
  const icon = $('#theme-icon');

  const apply = (theme) => {
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('tas-theme', theme);
    } catch (_) {}
    if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Bright';
    if (icon) icon.textContent = theme === 'dark' ? '☾' : '☀';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#000000' : '#e8eaef');
  };

  let theme = 'dark';
  try {
    const saved = localStorage.getItem('tas-theme');
    if (saved === 'bright' || saved === 'dark') theme = saved;
  } catch (_) {}
  apply(theme);

  btn?.addEventListener('click', () => {
    theme = root.getAttribute('data-theme') === 'bright' ? 'dark' : 'bright';
    apply(theme);
    waapi(btn, [{ transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: 200 });
  });
}

const state = {
  mode: 'geo', // 'geo' | 'sim'
  profileId: 'camaro-restomod',
  /** Fader demand (simulation target) */
  targetSpeed: 0,
  geoSpeed: 0,
  geoAccuracy: null,
  /** Actual speed fed to audio/UI */
  activeSpeed: 0,
  /** Longitudinal accel km/h per second — primary audio load */
  accelKmhps: 0,
  throttle: 0,
  brake: 0,
  engineOn: false,
};

let audio = new AudioEngine();

/** Which of the three sound engines a profile id belongs to. */
/**
 * Rev counter ring.
 *
 * Colour does nothing for the first two thirds of the sweep and then means
 * something — accent while there is room, amber as the band comes up, red at
 * the limiter — because a tachometer that is dramatic everywhere is dramatic
 * nowhere. Interpolated in JS rather than stepped in CSS so the change reads
 * as the needle arriving, not as a state switch.
 *
 * The flash is driven by the engine's own cut flag, not a timer, so what the
 * eye sees is the same event the ear hears.
 */
// The jar runs from the bottom of the donut to the top, in the ring SVG's own
// 240-unit coordinates: outer radius 95 about a centre at 120.
const REV_TOP = 25;
const REV_BOTTOM = 215;
let revWater = null;
let revHost = null;
function drawRevRing() {
  if (!revWater) revWater = document.getElementById('rpm-water');
  if (!revHost) revHost = document.getElementById('speed-ring');
  if (!revWater || !revHost) return;
  const redline = (audio && audio._spec && audio._spec.redlineRpm)
    || (audio && audio.profile && audio.profile.engine && audio.profile.engine.redlineRpm)
    || 0;
  const running = !!(audio && audio.running) && redline > 0;
  revHost.classList.toggle('has-rpm', running);
  if (!running) return;

  const t = Math.max(0, Math.min(1, (audio.rpm || 0) / redline));
  const level = REV_BOTTOM - t * (REV_BOTTOM - REV_TOP);
  revWater.setAttribute('y', String(level));
  revWater.setAttribute('height', String(REV_BOTTOM - level));

  // Colour does nothing for the first two thirds and then means something —
  // accent while there is room, amber as the band comes up, red at the top.
  // A tachometer that is dramatic everywhere is dramatic nowhere.
  let col;
  if (t < 0.62) col = 'rgb(62, 207, 255)';
  else if (t < 0.88) {
    const k = (t - 0.62) / 0.26;
    col = `rgb(${Math.round(62 + k * 193)}, ${Math.round(207 - k * 33)}, ${Math.round(255 - k * 199)})`;
  } else {
    const k = Math.min(1, (t - 0.88) / 0.12);
    col = `rgb(255, ${Math.round(174 - k * 67)}, 56)`;
  }
  revWater.setAttribute('fill', col);
  // Flashed by the engine's own cut flag, not a timer, so what the eye sees is
  // the same event the ear hears.
  revHost.classList.toggle('at-redline', !!(audio && audio._onLimiter));
}

function engineKindFor(id) {
  if (hasRig(id)) return 'vessel';
  if (hasCrank(id)) return 'crank';
  if (hasTurbine(id)) return 'turbine';
  return 'classic';
}

/** What the live `audio` instance currently is. */
function currentEngineKind() {
  const n = audio?.constructor?.name;
  if (n === 'VesselAudio') return 'vessel';
  if (n === 'CrankAudio') return 'crank';
  if (n === 'TurbineAudio') return 'turbine';
  return 'classic';
}

/**
 * Pick the sound engine for a profile: VESSEL synthesis runtime for rigs with a
 * compiled .vsl, CRANK firing-order synthesis for compiled .crank.json cards,
 * the classic AudioEngine otherwise. Swaps the live `audio` instance (restarting
 * if running). Falls back to AudioEngine if the chosen runtime fails to load, so
 * the app never goes silent.
 */
async function ensureEngineFor(id) {
  const want = engineKindFor(id);
  if (want === currentEngineKind()) return;
  const wasRunning = state.engineOn;
  try {
    if (wasRunning) audio.stop();
    if (want === 'vessel') {
      const { VesselAudio } = await import('./vessel-audio.js');
      audio = new VesselAudio();
    } else if (want === 'crank') {
      const { CrankAudio } = await import('./crank-audio.js');
      audio = new CrankAudio();
    } else if (want === 'turbine') {
      const { TurbineAudio } = await import('./turbine-audio.js');
      audio = new TurbineAudio();
    } else {
      audio = new AudioEngine();
    }
    audio.setProfile(getProfileById(id));
    if (wasRunning) await audio.start();
  } catch (e) {
    // Never silently. The card keeps showing the profile the driver picked
    // while a different engine plays, and a console.warn is invisible in a
    // car. Say it on screen.
    console.warn(`[app] ${want} engine unavailable, falling back`, e);
    try { showToast(`เสียง ${want} โหลดไม่ได้ · กลับไปใช้ classic`); } catch (_) {}
    if (audio) try { audio.stop(); } catch {}
    audio = new AudioEngine();
    audio.setProfile(getProfileById(id));
    if (wasRunning) await audio.start();
  }
}
const geo = new GeolocationService();
const physics = new VehiclePhysics(SIM_RATE);
const speedUI = new SpeedDisplay();

/**
 * Drive lock — in GPS mode the touch controls lock while the car is moving.
 * Exception: standing still (GPS speed ≈ 0) for over 3 s (red light, parked)
 * unlocks everything. Push-to-start is never locked so sound can always be
 * killed instantly.
 */
const driveLock = { stillSince: 0, engaged: null };

function updateDriveLock(now) {
  let shouldLock = false;
  if (state.mode === 'geo') {
    if (state.activeSpeed < 1) {
      if (!driveLock.stillSince) driveLock.stillSince = now;
    } else {
      driveLock.stillSince = 0;
    }
    const stoppedLong = driveLock.stillSince && now - driveLock.stillSince > 3000;
    shouldLock = !stoppedLong;
  } else {
    driveLock.stillSince = 0;
  }
  if (shouldLock !== driveLock.engaged) {
    driveLock.engaged = shouldLock;
    document.documentElement.classList.toggle('drive-lock', shouldLock);
    if (shouldLock) {
      $('#tune-sheet')?.classList.remove('is-open');
      $('#sheet-backdrop')?.classList.remove('is-open');
      $('#btn-tune')?.classList.remove('is-open');
    }
  }
}

/** Wall-clock for sim physics so low FPS still hits ±33 km/h/s in real time */
let lastPhysicsWall = 0;

/**
 * Measure the real rAF rate the car gives us (Tesla screens are 60 Hz, but
 * MCU2 browsers often deliver 20–40 fps). Below threshold → perf-lite:
 * drop backdrop-filter / glows so rendering can reach the display's max.
 */
const perf = { last: 0, acc: 0, frames: 0, done: false, fps: 0 };

function samplePerf() {
  if (perf.done) return;
  const now = performance.now();
  if (!perf.last) {
    perf.last = now;
    return;
  }
  perf.acc += now - perf.last;
  perf.last = now;
  perf.frames += 1;
  if (perf.acc >= 4000) {
    perf.fps = (perf.frames / perf.acc) * 1000;
    perf.done = true;
    if (perf.fps < 45) {
      document.documentElement.classList.add('perf-lite');
      showToast(`Display ~${Math.round(perf.fps)} fps — performance mode on`, 3200);
    }
  }
}

/** Apply a profile's default slider positions (if it defines a `mix`). */
function applyProfileMix(profile) {
  const mix = profile && profile.mix;
  if (!mix) return;
  const set = (id, v) => {
    if (v == null) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input'));
  };
  // Master is APP SYSTEM — only apply if profile explicitly sets it as a starting default.
  // control.global.masterTrim (CommandRoom System tab) scales every profile's starting master.
  const masterTrim = Number(getGlobalControl().masterTrim);
  const trim = Number.isFinite(masterTrim) && masterTrim > 0 ? masterTrim : 1;
  set('vol-master', mix.master == null ? null : Math.round(Math.min(100, mix.master * trim)));
  // Bass/Edge are SOUND PROFILE (cabin for VESSEL, tone for classic)
  set('vol-bass', mix.bass);
  set('vol-edge', mix.edge);
}

/**
 * Label the tune sheet so it's obvious whether you're on:
 *   Sound Profile (this car)  vs  App System (global webapp)
 *   + Classic tone engine     vs  VESSEL synthesis
 */
function updateTuneScope(profileId) {
  const kind = engineKindFor(profileId);
  const vessel = kind === 'vessel';
  const chip = $('#engine-scope-chip');
  const hint = $('#tune-scope-hint');
  const note = $('#sound-profile-note');
  if (chip) {
    chip.textContent =
      kind === 'vessel' ? 'VESSEL · synthesis'
        : kind === 'crank' ? 'CRANK · firing order'
          : kind === 'turbine' ? 'TURBINE · gearless'
            : 'Classic · tone';
    chip.classList.toggle('is-vessel', vessel);
    chip.classList.toggle('is-crank', kind === 'crank');
  }
  if (hint) {
    hint.textContent = kind === 'classic'
      ? 'Bass/Edge = this card · Master/GPS = app-wide'
      : 'Sound = cabin/DNA of this card · App = Master/GPS (global)';
  }
  if (note) {
    note.textContent =
      kind === 'vessel'
        ? 'Bass/Edge = cabin path. Engine DNA = vessel/presets/*.engine.json (bench). Vehicle RPM = camaro.deploy.json → vehicle{}.'
        : kind === 'crank'
          ? 'Bass/Edge = cabin shelves (neutral at 50). Engine character = firing order + resonances compiled into assets/crank/*.crank.json.'
          : kind === 'turbine'
            ? 'Bass/Edge = cabin shelves. No gearbox — shaft speed follows road speed. Character lives in assets/turbine/*.turbine.json.'
            : 'Bass/Edge follow this card’s tone mix. Engine character is the classic procedural profile.';
  }
}

async function selectProfile(profileId) {
  const profile = getProfileById(profileId);
  if (!profile) return;
  state.profileId = profile.id;
  await ensureEngineFor(profile.id);
  audio.setProfile(profile);
  applyProfileMix(profile);
  updateTuneScope(profile.id);
  const nameEl = $('#active-profile-name');
  if (nameEl) nameEl.textContent = profile.name;
}

async function init() {
  initHud();
  initThemeToggle();

  // Online carousel = assets/vessel/live-set.json (CommandRoom Apply → GitHub)
  await loadLiveSet();
  // Classic standard JSON (assets/classic/*.classic.json) — merge into profiles
  await loadClassicStandards();
  {
    const live = getLiveProfileIds();
    if (live.length && !live.includes(state.profileId)) state.profileId = live[0];
  }

  // Sim demand slider (in the tune sheet)
  const simSlider = $('#sim-speed');
  const simVal = $('#sim-speed-val');
  const simFill = $('#sim-speed-fill');
  if (simSlider) {
    const syncSim = () => {
      const v = Number(simSlider.value);
      state.targetSpeed = v;
      physics.setTarget(v);
      if (simVal) simVal.textContent = `${v} km/h`;
      if (simFill) simFill.style.width = `${v / 2}%`;
    };
    simSlider.addEventListener('input', syncSim);
    syncSim();
  }

  // Launch-control rev test — works parked, no sim mode needed
  $('#btn-launch')?.addEventListener('click', () => {
    if (!state.engineOn) {
      showToast('Start the engine first');
      return;
    }
    if (audio.startRevTest(5)) {
      const b = $('#btn-launch');
      b?.classList.add('is-active');
      window.setTimeout(() => b?.classList.remove('is-active'), 5000);
      showToast('Launch · flat-out G1→G3, 5s');
    }
  });

  // Restore persisted Dev mode BEFORE the first carousel render so dev-only profiles
  // (the not-yet-released lineup) appear immediately for a returning dev — and stay
  // hidden for normal users. getVisibleProfiles() keys off the body.dev-mode class.
  if (localStorage.getItem('tas-dev-mode') === '1') document.body.classList.add('dev-mode');

  const scroller = $('#profile-scroller');
  const renderCarousel = () => {
    if (!scroller) return;
    renderProfiles(scroller, state.profileId, async (profile) => {
      await selectProfile(profile.id);
      showToast(
        engineKindFor(profile.id) !== 'classic'
          ? `${profile.name} · Sound Profile (${engineKindFor(profile.id).toUpperCase()})`
          : `${profile.name} · ${profile.car || profile.tag}`
      );
    });
  };
  renderCarousel();

  // Donate / Feedback: the module is fetched on the FIRST tap and tears itself down on close,
  // so nothing about these features exists while you are driving. See js/extras.js.
  $('#btn-donate')?.addEventListener('click', async () => {
    try {
      const x = await import('./extras.js');
      x.openDonate();
    } catch (_) {
      showToast('เปิดไม่สำเร็จ · ตรวจอินเทอร์เน็ต');
    }
  });
  $('#btn-feedback')?.addEventListener('click', async () => {
    try {
      const x = await import('./extras.js');
      x.openFeedback({
        version: $('#app-ver')?.textContent || '',
        profile: state.profileId,
      });
    } catch (_) {
      showToast('เปิดไม่สำเร็จ · ตรวจอินเทอร์เน็ต');
    }
  });

  // GPS chip toggles between real GPS speed (geo) and the sim fader
  $('#btn-gps')?.addEventListener('click', () => {
    setMode(state.mode === 'geo' ? 'sim' : 'geo');
  });

  $('#btn-engine')?.addEventListener('click', async () => {
    const btn = $('#btn-engine');
    btn?.classList.remove('anim-pressed');
    // force reflow so the press animation can replay
    void btn?.offsetWidth;
    btn?.classList.add('anim-pressed');
    try {
      if (!state.engineOn) {
        await ensureEngineFor(state.profileId);
        await audio.start();
        state.engineOn = true;
        setAudioStatus(true);
        $('#btn-launch')?.classList.add('is-armed');
        if (state.mode === 'geo') {
          showToast('Engine online · idle active at 0 km/h');
        } else {
          // No real speed source yet: say what to press, and light up the chip that does it.
          showToast('แตะ GPS ให้เสียงวิ่งตามความเร็วรถ · หรือกด REV ฟังเสียงลากรอบ', 5200);
          startGpsNudge();
        }
      } else {
        audio.stop();
        state.engineOn = false;
        setAudioStatus(false);
        $('#btn-launch')?.classList.remove('is-armed', 'is-active');
        stopGpsNudge();
        showToast('Engine offline');
      }
    } catch (err) {
      console.error(err);
      showToast('Audio blocked — tap again after interaction');
    }
  });

  // Tune sheet open/close
  const tuneSheet = $('#tune-sheet');
  const tuneBackdrop = $('#sheet-backdrop');
  const tuneBtn = $('#btn-tune');
  const setTuneOpen = (open) => {
    tuneSheet?.classList.toggle('is-open', open);
    tuneBackdrop?.classList.toggle('is-open', open);
    tuneBtn?.classList.toggle('is-open', open);
    tuneBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
    tuneSheet?.setAttribute('aria-hidden', open ? 'false' : 'true');
  };
  // Developer mode: normal users get a clean sheet (Sound + Master). TRIPLE-TAP the
  // settings button (3 quick taps within 700ms) to reveal sim / GPS / behaviour
  // controls; a single tap just opens the sheet. Uses plain `click` so it survives the
  // Tesla browser (no pointer/contextmenu gesture to fight). Persisted per browser.
  const DEV_KEY = 'tas-dev-mode';
  if (localStorage.getItem(DEV_KEY) === '1') document.body.classList.add('dev-mode');
  const toggleDev = () => {
    const on = document.body.classList.toggle('dev-mode');
    localStorage.setItem(DEV_KEY, on ? '1' : '0');
    showToast(on ? 'Developer mode ON' : 'Developer mode OFF');
    // Leaving dev while parked on a not-yet-released profile → fall back to a public one.
    if (!on) {
      const vis = getVisibleProfiles();
      if (vis.length && !vis.some((p) => p.id === state.profileId)) selectProfile(vis[0].id);
    }
    renderCarousel(); // dev-only cards appear / disappear immediately
  };

  // Debounce the sheet-open by 1s with a spinner ring around the button, so it reads as
  // a deliberate "opening…" for normal users (not lag) — AND a rapid triple-tap never
  // opens the sheet mid-sequence (which would slide up and cover the button, blocking
  // taps 2-3). Reaching 3 taps within the window fires dev immediately.
  let devTaps = [];
  let settleTimer = null;
  tuneBtn?.addEventListener('click', () => {
    const now = Date.now();
    devTaps = devTaps.filter((t) => now - t < 1000);
    devTaps.push(now);
    clearTimeout(settleTimer);
    tuneBtn.classList.add('is-waiting'); // spinner ring during the 1s wait
    if (devTaps.length >= 3) {
      devTaps = [];
      tuneBtn.classList.remove('is-waiting');
      toggleDev();
      setTuneOpen(true); // reveal the sheet so the (un)locked controls are visible
      return;
    }
    settleTimer = setTimeout(() => {
      devTaps = [];
      tuneBtn.classList.remove('is-waiting');
      setTuneOpen(!tuneSheet?.classList.contains('is-open'));
    }, 1000);
  });
  tuneBackdrop?.addEventListener('click', () => setTuneOpen(false));

  // App version badge (top-left) — from assets/version.json, stamped at each deploy so
  // a refresh clearly shows which build loaded. Silent if the file is missing.
  (async () => {
    const el = $('#app-ver');
    if (!el) return;
    try {
      const r = await fetch('assets/version.json', { cache: 'no-store' });
      if (!r.ok) return;
      const v = await r.json();
      if (v && v.v) el.textContent = 'v' + v.v;

      // Build line under it, Dev mode only (.dev-only hides it otherwise). The
      // version number changes per release; this changes per commit, which is
      // what you need when you are checking whether the browser is running the
      // code you just wrote. A trailing + means the tree had uncommitted edits
      // when it was stamped, so the files on disk are NOT that commit.
      const b = $('#app-build');
      if (b && v && v.build) {
        b.textContent = `build ${v.build} · ${v.builtAt || ''}`.trim();
        b.title = v.build.endsWith('+')
          ? 'uncommitted changes were present at stamp time'
          : 'clean tree at stamp time';
      }
    } catch (_) {}
  })();

  // Dev perf readout — only in Dev mode, loaded on demand. If it fails to load
  // the app is unaffected; it is a diagnostic, not a feature.
  // Manual gearbox. Dev-mode only until it has been driven — it changes where
  // the revs come from, and LAW 7 says a drive decides that, not a bench.
  if (document.body.classList.contains('dev-mode')) {
    import('./manual-shift.js')
      .then((m) => {
        window.TAS.manual = m.startManualShift({
          getGear: () => (audio && (audio.gearIndex || audio._gear)) || 1,
          onGearChange: (g, src) => showToast(`เกียร์ ${g} · ${src}`),
          // The spacebar pedal drives the sim directly, and needs the redline
          // to know when to stop buying speed.
          sim: {
            state,
            physics,
            rate: SIM_RATE.maxDeltaKmhPerSec,
            getRpm: () => (audio && audio.rpm) || 0,
            getRedline: () => (audio && audio._spec && audio._spec.redlineRpm)
              || (audio && audio.profile && audio.profile.engine && audio.profile.engine.redlineRpm)
              || 7000,
          },
        });
      })
      .catch(() => {});
  }

  if (document.body.classList.contains('dev-mode')) {
    import('./dev-perf.js')
      .then((m) => m.startDevPerf($('#app-perf'), () => audio, () => engineKindFor(state.profileId)))
      .catch(() => {});
    // Drive recorder. Same deal as the perf readout: dev mode only, loaded on
    // demand, and a failure to load must never touch the app. It exists
    // because judder that only happens in the car cannot be fixed by guessing
    // at what the car is feeding us.
    import('./dev-trace.js')
      .then((m) => {
        window.TAS.trace = m.startDevTrace(() => audio, state, physics);
        // Tapping the readout sends the trace. The car has no console, and
        // nothing here may need typing: the whole point is that the driver
        // parks, taps once, and the evidence arrives.
        // Its OWN element. dev-perf.js rewrites #app-perf every animation
        // frame, so anything written there is gone before it can be read —
        // two writers, one node, exactly the failure docs/FANOUT.md is about.
        const host = $('#app-perf');
        if (!host || !host.parentNode) return;
        const el = document.createElement('span');
        el.id = 'app-trace';
        el.className = 'brand-build dev-only';
        el.textContent = 'trace';
        host.parentNode.insertBefore(el, host.nextSibling);
        // A finger in a car needs a real target, not a 10 px line of text.
        el.style.cursor = 'pointer';
        el.style.padding = '6px 10px';
        el.style.margin = '-6px -10px';
        el.style.borderRadius = '8px';
        el.style.border = '1px solid currentColor';
        el.style.opacity = '0.85';
        el.title = 'แตะเพื่อส่ง trace การขับ';
        let busy = false;
        el.addEventListener('click', async () => {
          if (busy) return;
          busy = true;
          el.textContent = 'ส่ง trace…';
          try {
            // Show the counts on screen regardless. The mail goes to the
            // owner's inbox, which I cannot read — so the screen has to be
            // able to answer the question on its own.
            // Pin the moment first. He keeps this button for the times he can
            // actually watch, and a tap is a human saying THIS one — worth more
            // than any score, so it is marked and never evicted.
            try { window.TAS.trace.mark('tapped'); } catch (_) {}
            const v = window.TAS.trace.verdict();
            const r = await window.TAS.trace.send('tapped from the car').catch(() => ({ ok: false }));
            el.textContent = (r.ok ? '✓ ' : '✗ ') + v;
          } catch (_) {
            el.textContent = 'ส่งไม่สำเร็จ';
          }
          // 25 s, not 4: this is meant to be read and repeated back.
          window.setTimeout(() => { el.textContent = 'trace'; busy = false; }, 25000);
        });
      })
      .catch(() => {});
  }

  bindSliders({
    master: (v) => audio.setMasterVolume(v),
    bass: (v) => audio.setBass(v),
    edge: (v) => audio.setEdge(v),
  });

  bindToggles({
    'btn-reactive': (on) => {
      audio.speedReactive = on;
      showToast(on ? 'Speed reactive on' : 'Speed reactive off');
    },
    'btn-smooth': (on) => {
      audio.smoothFilter = on;
      showToast(on ? 'Smooth filter on' : 'Direct response');
    },
  });

  geo.onUpdate((payload) => {
    const newSpeed = payload.speedKmh || 0;
    // Accel from real GPS interval (not per-frame). Light clamp only.
    const nowMs = performance.now();
    const gdt = state.lastGeoMs ? (nowMs - state.lastGeoMs) / 1000 : 0;
    // 0.06 s, not 0.12: the booster can now land fixes ~200 ms apart (and faster on a good
    // receiver), and at 0.12 those intervals were discarded — the very fixes we added to be
    // more responsive would have contributed no acceleration at all. Still wide enough to
    // reject a sub-60 ms burst, and `a` stays clamped either way.
    if (gdt > 0.06 && gdt < 4) {
      let a = (newSpeed - state.geoSpeed) / gdt;
      a = Math.max(-30, Math.min(30, a));
      state.geoAccel = (state.geoAccel || 0) * 0.35 + a * 0.65;
    }
    state.lastGeoMs = nowMs;
    state.geoSpeed = newSpeed;
    state.geoAccuracy = payload.accuracy;
    state.fixHz = payload.fixHz;          // recorded by the drive trace: gdt is the suspect
    setGpsStatus(payload.status);
    // What the receiver actually gives us — the ceiling on how live the readout can be.
    const summary = `${payload.speedSource || '—'} · ${
      payload.fixHz ? `${payload.fixHz.toFixed(1)} Hz` : '—'
    }`;
    const srcEl = $('#tele-gps-src');
    if (srcEl) srcEl.textContent = summary;
    // Same figures on the drive screen, where they can be read while actually driving
    const diagEl = $('#gps-diag');
    if (diagEl) {
      const acc = payload.accuracy != null ? ` · ±${Math.round(payload.accuracy)}m` : '';
      diagEl.textContent = `${summary}${acc}`;
    }
    if (payload.status === 'denied') {
      showToast('Location permission denied — use Simulation');
    }
  });

  await selectProfile(state.profileId);
  const initName = $('#active-profile-name');
  if (initName) initName.textContent = getProfileById(state.profileId).name;

  const donate = $('#donate-link');
  if (donate && DONATE_URL) {
    donate.href = DONATE_URL;
    donate.hidden = false;
  }

  ticker.add((dt) => tick(dt));
  setMode('sim', { silent: true }); // default sim so idle is easy to hear
  finishBoot();

  // First-run coach marks, after the boot overlay clears
  window.setTimeout(() => startOnboarding(), 1400);

  // Offline cache — skip on localhost so dev never serves stale files
  if (
    'serviceWorker' in navigator &&
    !['localhost', '127.0.0.1'].includes(location.hostname)
  ) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  showToast(`0→100 ≈ ${(100 / SIM_RATE.maxDeltaKmhPerSec).toFixed(1)}s (±${SIM_RATE.maxDeltaKmhPerSec} km/h/s)`, 2600);
}

/**
 * GPS nudge — breathe a ring on the GPS chip when the engine is running but no real speed
 * source is on, because a first-timer otherwise hears idle only and thinks that is the app.
 * Self-terminating: stops on tap, on engine off, and on its own after NUDGE_MS. Stopping
 * REMOVES the class, so the animation is gone rather than merely invisible.
 */
const NUDGE_MS = 15000;
let nudgeTimer = null;

function stopGpsNudge() {
  if (nudgeTimer) {
    window.clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  $('#btn-gps')?.classList.remove('gps-nudge');
}

function startGpsNudge() {
  // Dev mode drives the sim slider on purpose — never nag there.
  if (document.body.classList.contains('dev-mode')) return;
  stopGpsNudge();
  $('#btn-gps')?.classList.add('gps-nudge');
  nudgeTimer = window.setTimeout(stopGpsNudge, NUDGE_MS);
}

function setMode(mode, { silent = false } = {}) {
  state.mode = mode;
  setModeUI(mode);
  lastPhysicsWall = 0; // reset wall clock on mode change

  if (mode === 'geo') {
    stopGpsNudge(); // they found it
    if (geo.supported) {
      geo.start();
      if (!silent) showToast('Geolocation · real GPS speed');
    } else {
      setGpsStatus('error');
      if (!silent) showToast('GPS unavailable — use Simulation');
    }
  } else {
    geo.stop();
    setGpsStatus('off');
    // Keep vehicle speed; sheet slider is the demand target
    physics.setTarget(state.targetSpeed);
    if (!silent) {
      showToast(`Simulation · ±${SIM_RATE.maxDeltaKmhPerSec} km/h/s toward slider`);
    }
  }
}

function tick(dt) {
  const now = performance.now();

  if (state.mode === 'geo') {
    // Ramp to the newest fix fast. Fixes land ~1 Hz, so this only exists to turn each step
    // into a short glide instead of a jump — at lambda 6 it was still catching up when the
    // NEXT fix arrived, which is latency we were adding on top of the GPS's own.
    state.activeSpeed += (state.geoSpeed - state.activeSpeed) * Math.min(1, dt * 12);
    const staleSec = (now - (state.lastGeoMs || 0)) / 1000;
    if (staleSec > 1.5) state.geoAccel = (state.geoAccel || 0) * Math.max(0, 1 - dt * 2);
    state.accelKmhps += ((state.geoAccel || 0) - state.accelKmhps) * Math.min(1, dt * 5);
    // Small deadband only (not wide — that made load feel sticky/laggy)
    let aRaw = state.accelKmhps || 0;
    if (Math.abs(aRaw) < 1.2) aRaw = 0;
    const aN = aRaw / SIM_RATE.maxDeltaKmhPerSec;
    state.throttle = clamp(aN, 0, 1);
    state.brake = aN < -0.04 ? clamp(-aN, 0, 1) : 0;
    physics.vehicleSpeed = state.activeSpeed;
  } else {
    // Simulation: always use wall-clock so 0→100 ≈ 100/33 ≈ 3.0s even if FPS is low
    if (!lastPhysicsWall) lastPhysicsWall = now;
    let wallDt = (now - lastPhysicsWall) / 1000;
    lastPhysicsWall = now;
    if (!(wallDt > 0) || wallDt > 0.25) wallDt = 1 / 60; // tab resume / first frame
    wallDt = Math.min(0.1, wallDt);

    physics.setTarget(state.targetSpeed);
    const p = physics.update(wallDt);
    state.activeSpeed = p.speed;
    state.accelKmhps = p.accelKmhps;
    state.throttle = p.throttle;
    state.brake = p.brake;
  }

  // Acceleration is measured over the interval in which the speed actually changed — the gap
  // between two GPS fixes (geo) or the physics step (sim) — NOT as a per-frame derivative of
  // the displayed speed. That derivative looked equivalent but is not: fixes land ~1 Hz, so
  // activeSpeed ramps to each one and then sits flat, making d/dt a brief spike followed by
  // ~zero. Load then swung 0.14<->0.80 every second, i.e. the engine surged and sagged instead
  // of pulling. Measured over the fix interval the value persists, as it physically should.
  // (The reason this path once read ~0 was maximumAge:500 replaying the same fix; that is gone
  // now — maximumAge is 0 and identical timestamps are deduped before they ever reach here.)
  // The dev pedal, when it is open, outranks the throttle physics inferred
  // from the speed trace — see throttleOverride().
  const pedalWants = window.TAS.manual && window.TAS.manual.throttleOverride
    ? window.TAS.manual.throttleOverride()
    : null;
  if (pedalWants != null) {
    state.throttle = Math.max(state.throttle, pedalWants);
    state.brake = 0;
  }
  audio.setSpeed(state.activeSpeed, {
    throttle: state.throttle,
    brake: state.brake,
    accelKmhps: state.accelKmhps,
  });
  // Audio params update on the engine's own 50 Hz clock (see AudioEngine),
  // so sound stays smooth even when Tesla Browser rAF drops to 20–30 fps.

  samplePerf();

  speedUI.setTelemetry({
    accuracy: state.mode === 'geo' ? state.geoAccuracy : null,
  });
  // Big number follows actual vehicle speed (not fader yank)
  speedUI.target = state.activeSpeed;
  speedUI.step(dt);

  updateRpmLabel(audio.rpm || 0, audio.gearIndex || 1, audio.gearCount || 3);
  drawRevRing();
  updateDriveState(audio.driveState || 'idle');
  updateAccelTube(state.accelKmhps || 0);
  updateDriveLock(now);
}

// Debug handle for in-car console / testing (harmless in production)
window.TAS = {
  get audio() { return audio; },   // live — swaps between AudioEngine / VesselAudio / CrankAudio
  get engine() { return currentEngineKind(); },
  state,
  physics,
  perf,
  driveLock,
  updateDriveLock,
  onboard: () => startOnboarding({ force: true }),
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
