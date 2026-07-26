/**
 * Tesla Active Sound — Application orchestrator
 * Simulation uses Model S Plaid-limited acceleration + Ioniq-style active sound.
 */

import { ticker, waapi, clamp } from './animations.js';
import { getProfileById, loadLiveSet, loadClassicStandards, getLiveProfileIds } from './profiles.js';
import { AudioEngine } from './audio-engine.js';
import { VesselAudio, hasRig } from './vessel-audio.js';
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

/**
 * Pick the sound engine for a profile: VESSEL synthesis runtime for rigs that
 * have a compiled .vsl, the classic AudioEngine otherwise. Swaps the live
 * `audio` instance (restarting if running). Falls back to AudioEngine if the
 * VESSEL runtime fails to load, so the app never goes silent.
 */
async function ensureEngineFor(id) {
  const wantVessel = hasRig(id);
  const isVessel = audio instanceof VesselAudio;
  if (wantVessel === isVessel) return;
  const wasRunning = state.engineOn;
  try {
    if (wasRunning) audio.stop();
    audio = wantVessel ? new VesselAudio() : new AudioEngine();
    audio.setProfile(getProfileById(id));
    if (wasRunning) await audio.start();
  } catch (e) {
    console.warn('[app] VESSEL engine unavailable, falling back', e);
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
  // Master is APP SYSTEM — only apply if profile explicitly sets it as a starting default
  set('vol-master', mix.master);
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
  const vessel = hasRig(profileId);
  const chip = $('#engine-scope-chip');
  const hint = $('#tune-scope-hint');
  const note = $('#sound-profile-note');
  if (chip) {
    chip.textContent = vessel ? 'VESSEL · synthesis' : 'Classic · tone';
    chip.classList.toggle('is-vessel', vessel);
  }
  if (hint) {
    hint.textContent = vessel
      ? 'Sound = cabin/DNA of this card · App = Master/GPS (global)'
      : 'Bass/Edge = this card · Master/GPS = app-wide';
  }
  if (note) {
    note.textContent = vessel
      ? 'Bass/Edge = cabin path. Engine DNA = vessel/presets/*.engine.json (bench). Vehicle RPM = camaro.deploy.json → vehicle{}.'
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

  const scroller = $('#profile-scroller');
  if (scroller) {
    renderProfiles(scroller, state.profileId, async (profile) => {
      await selectProfile(profile.id);
      showToast(
        hasRig(profile.id)
          ? `${profile.name} · Sound Profile (VESSEL)`
          : `${profile.name} · ${profile.car || profile.tag}`
      );
    });
  }

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
        showToast('Engine online · idle active at 0 km/h');
      } else {
        audio.stop();
        state.engineOn = false;
        setAudioStatus(false);
        $('#btn-launch')?.classList.remove('is-armed', 'is-active');
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
  tuneBtn?.addEventListener('click', () => {
    setTuneOpen(!tuneSheet?.classList.contains('is-open'));
  });
  tuneBackdrop?.addEventListener('click', () => setTuneOpen(false));

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
    // Real acceleration = Δspeed over the actual GPS sample interval (~1 s),
    // NOT per render frame. Computing per-frame made a +1 km/h fix spike to
    // ~60 km/h/s and peg the tube.
    const nowMs = performance.now();
    const gdt = state.lastGeoMs ? (nowMs - state.lastGeoMs) / 1000 : 0;
    if (gdt > 0.1 && gdt < 5) {
      state.geoAccel = (newSpeed - state.geoSpeed) / gdt;
    }
    state.lastGeoMs = nowMs;
    state.geoSpeed = newSpeed;
    state.geoAccuracy = payload.accuracy;
    setGpsStatus(payload.status);
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

function setMode(mode, { silent = false } = {}) {
  state.mode = mode;
  setModeUI(mode);
  lastPhysicsWall = 0; // reset wall clock on mode change

  if (mode === 'geo') {
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
    // Follow GPS speed smoothly (avoid single-frame jumps between fixes)
    state.activeSpeed += (state.geoSpeed - state.activeSpeed) * Math.min(1, dt * 5);
    // Accel comes from the real GPS interval (set in onUpdate). Fade it toward
    // 0 if fixes stall so a stale value doesn't stick.
    const staleSec = (now - (state.lastGeoMs || 0)) / 1000;
    if (staleSec > 1.5) state.geoAccel = (state.geoAccel || 0) * Math.max(0, 1 - dt * 2);
    state.accelKmhps += ((state.geoAccel || 0) - state.accelKmhps) * Math.min(1, dt * 4);
    const aN = state.accelKmhps / SIM_RATE.maxDeltaKmhPerSec;
    state.throttle = clamp(aN, 0, 1);
    state.brake = aN < -0.03 ? clamp(-aN, 0, 1) : 0;
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
  updateDriveState(audio.driveState || 'idle');
  updateAccelTube(state.accelKmhps || 0);
  updateDriveLock(now);
}

// Debug handle for in-car console / testing (harmless in production)
window.TAS = {
  get audio() { return audio; },   // live — the instance swaps between AudioEngine / VesselAudio
  get engine() { return audio instanceof VesselAudio ? 'vessel' : 'classic'; },
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
