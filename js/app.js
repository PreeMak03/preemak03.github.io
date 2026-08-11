/**
 * Tesla Active Sound — Application orchestrator
 * Simulation uses Model S Plaid-limited acceleration + Ioniq-style active sound.
 */

import { ticker, waapi, clamp } from './animations.js';
import { getProfileById, loadLiveSet, loadClassicStandards, getLiveProfileIds, getGlobalControl, getVisibleProfiles } from './profiles.js';
import { AudioEngine } from './audio-engine.js';
// hasRig is tiny; VesselAudio itself is dynamic-imported only for VESSEL cards
import { hasRig } from './vessel-rigs.js';
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

/**
 * How far behind reality a GPS fix already is when it reaches us (receiver + browser
 * pipeline). Used to lead the displayed speed so it runs level with the car's speedometer
 * instead of trailing it. Raise if the app still reads low while accelerating; lower if it
 * overshoots the dash.
 */
const GPS_FIX_LATENCY_S = 0.45;

/** Coffee link (Ko-fi / Buy Me a Coffee / PromptPay page). Empty = hidden. */
const DONATE_URL = '';

/**
 * Feedback → developer email via Web3Forms (no backend, hides the address behind the key).
 * Get a free key at https://web3forms.com (enter markchsr@gmail.com → key is emailed).
 * Empty = the Feedback link stays hidden (nothing half-working ships).
 */
const FEEDBACK_ACCESS_KEY = 'b0c38acf-3953-4910-9fbb-290ad09af3a5';

/* ---- Phone-browser support (Safari iOS / Android Chrome) — the app only needs GPS speed +
   audio out, so it runs on the user's own phone (paired to the car over Bluetooth). Keep the
   screen awake while the engine runs, and best-effort unlock audio past the iOS ringer switch. ---- */
let _wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !_wakeLock) {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener?.('release', () => { _wakeLock = null; });
    }
  } catch (_) {}
}
function releaseWakeLock() {
  try { _wakeLock?.release(); } catch (_) {}
  _wakeLock = null;
}

let _audioUnlocked = false;
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function unlockPhoneAudio() {
  // iOS-ONLY and ONE-SHOT. Never add a persistent audio stream on the Tesla MCU (a looping
  // silent element there stole the audio thread → delay/stutter). A 0-length silent WAV played
  // once inside the tap gesture is enough to route iOS WebAudio past the ringer switch.
  if (_audioUnlocked || !_isIOS) return;
  _audioUnlocked = true;
  try {
    const el = document.createElement('audio');
    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    el.volume = 0;
    el.setAttribute('playsinline', '');
    const p = el.play();
    if (p) p.then(() => { el.pause(); el.src = ''; }).catch(() => {});
  } catch (_) {}
}

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
  const isVessel = audio?.constructor?.name === 'VesselAudio';
  if (wantVessel === isVessel) return;
  const wasRunning = state.engineOn;
  try {
    if (wasRunning) audio.stop();
    if (wantVessel) {
      const { VesselAudio } = await import('./vessel-audio.js');
      audio = new VesselAudio();
    } else {
      audio = new AudioEngine();
    }
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
        hasRig(profile.id)
          ? `${profile.name} · Sound Profile (VESSEL)`
          : `${profile.name} · ${profile.car || profile.tag}`
      );
    });
  };
  renderCarousel();

  // GPS chip toggles between real GPS speed (geo) and the sim fader
  $('#btn-gps')?.addEventListener('click', () => {
    setMode(state.mode === 'geo' ? 'sim' : 'geo');
  });

  $('#btn-engine')?.addEventListener('click', async () => {
    const btn = $('#btn-engine');
    unlockPhoneAudio(); // must run inside the tap gesture (iOS audio through the ringer switch)
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
        acquireWakeLock(); // keep the phone screen on while driving
      } else {
        audio.stop();
        state.engineOn = false;
        setAudioStatus(false);
        $('#btn-launch')?.classList.remove('is-armed', 'is-active');
        showToast('Engine offline');
        releaseWakeLock();
      }
    } catch (err) {
      console.error(err);
      showToast('Audio blocked — tap again after interaction');
    }
  });

  // Wake Lock releases itself when the tab is backgrounded — re-take it on return if driving.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.engineOn) acquireWakeLock();
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
    } catch (_) {}
  })();

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
    if (gdt > 0.12 && gdt < 4) {
      let a = (newSpeed - state.geoSpeed) / gdt;
      a = Math.max(-30, Math.min(30, a));
      state.geoAccel = (state.geoAccel || 0) * 0.35 + a * 0.65;
    }
    state.lastGeoMs = nowMs;
    state.geoSpeed = newSpeed;
    state.geoAccuracy = payload.accuracy;
    setGpsStatus(payload.status);
    if (payload.status === 'denied') {
      openGpsHelp();
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

  // Donate — coffee chip opens a PromptPay QR sheet (backdrop / ✕ / Esc close it).
  {
    const back = $('#donate-backdrop');
    const sheet = $('#donate-sheet');
    const setDonate = (open) => {
      for (const el of [back, sheet]) {
        if (!el) continue;
        if (open) {
          el.hidden = false;
          requestAnimationFrame(() => el.classList.add('is-open'));
        } else {
          el.classList.remove('is-open');
          window.setTimeout(() => { el.hidden = true; }, 300);
        }
      }
      sheet?.setAttribute('aria-hidden', open ? 'false' : 'true');
    };
    $('#btn-donate')?.addEventListener('click', () => {
      const im = $('#donate-qr-img'); // fetch/decode the 153KB QR on demand, never at boot
      if (im && !im.src && im.dataset.src) im.src = im.dataset.src;
      setDonate(true);
    });
    $('#donate-x')?.addEventListener('click', () => setDonate(false));
    back?.addEventListener('click', () => setDonate(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheet && !sheet.hidden) setDonate(false);
    });
    // Graceful state until the QR image is added at assets/donate-qr.png
    const qr = $('#donate-qr-img');
    qr?.addEventListener('error', () => {
      qr.hidden = true;
      const fb = $('#donate-qr-fallback');
      if (fb) fb.hidden = false;
    });
  }

  // Feedback — in-app form → Web3Forms → developer email. Entry point stays hidden until
  // a key is configured, so nothing half-working ships.
  if (FEEDBACK_ACCESS_KEY) {
    const link = $('#btn-feedback');
    const back = $('#fb-backdrop');
    const sheet = $('#fb-sheet');
    const form = $('#fb-form');
    const statusEl = $('#fb-status');
    const submit = $('#fb-submit');
    if (link) link.hidden = false;
    const setFb = (open) => {
      for (const el of [back, sheet]) {
        if (!el) continue;
        if (open) {
          el.hidden = false;
          requestAnimationFrame(() => el.classList.add('is-open'));
        } else {
          el.classList.remove('is-open');
          window.setTimeout(() => { el.hidden = true; }, 300);
        }
      }
      sheet?.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) window.setTimeout(() => $('#fb-msg')?.focus(), 80);
    };
    link?.addEventListener('click', () => setFb(true));
    $('#fb-x')?.addEventListener('click', () => setFb(false));
    back?.addEventListener('click', () => setFb(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheet && !sheet.hidden) setFb(false);
    });
    // Category chips (single-select) — so feedback can be sorted at a glance in the inbox.
    let fbCategory = 'ประสบการณ์ขับขี่';
    const cats = [...(document.querySelectorAll('.fb-cat') || [])];
    cats.forEach((c) => c.addEventListener('click', () => {
      fbCategory = c.dataset.cat;
      cats.forEach((x) => {
        const on = x === c;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }));
    // Scanned the in-modal QR on a phone → land straight on the feedback form.
    if (new URLSearchParams(location.search).get('fb') === '1') {
      window.setTimeout(() => setFb(true), 1500);
    }
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#fb-msg')?.value.trim();
      if (!msg) return;
      const contact = $('#fb-contact')?.value.trim() || '';
      submit.disabled = true;
      statusEl.className = 'fb-status';
      statusEl.textContent = 'กำลังส่ง…';
      try {
        const res = await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            access_key: FEEDBACK_ACCESS_KEY,
            subject: `[${fbCategory}] Tesla Active Sound Feedback`,
            from_name: 'Tesla Active Sound',
            category: fbCategory,
            message: msg,
            contact,
            app_version: $('#app-ver')?.textContent || '',
            profile: state.profileId,
          }),
        });
        if (!res.ok) throw new Error(String(res.status));
        statusEl.className = 'fb-status ok';
        statusEl.textContent = 'ส่งแล้ว ขอบคุณครับ 🙏';
        form.reset();
        window.setTimeout(() => setFb(false), 1500);
      } catch (_) {
        statusEl.className = 'fb-status err';
        statusEl.textContent = 'ส่งไม่สำเร็จ · ลองใหม่อีกครั้ง';
      } finally {
        submit.disabled = false;
      }
    });
  }

  // GPS help sheet — opened when the browser DENIES location (in-app browser, or permission off).
  // The denial is an environment/permission issue, not a bug — so guide the user to fix it.
  function openGpsHelp() {
    const back = $('#gps-help-backdrop');
    const sheet = $('#gps-help-sheet');
    if (!sheet || !sheet.hidden) return; // already open / missing
    const ua = navigator.userAgent || '';
    if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/i.test(ua)) {
      const warn = $('#gps-inapp-warn');
      if (warn) warn.hidden = false;
    }
    for (const el of [back, sheet]) {
      if (!el) continue;
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('is-open'));
    }
    sheet.setAttribute('aria-hidden', 'false');
  }
  const closeGpsHelp = () => {
    for (const el of [$('#gps-help-backdrop'), $('#gps-help-sheet')]) {
      if (!el) continue;
      el.classList.remove('is-open');
      window.setTimeout(() => { el.hidden = true; }, 300);
    }
    $('#gps-help-sheet')?.setAttribute('aria-hidden', 'true');
  };
  $('#gps-help-x')?.addEventListener('click', closeGpsHelp);
  $('#gps-help-backdrop')?.addEventListener('click', closeGpsHelp);
  $('#gps-retry')?.addEventListener('click', () => { closeGpsHelp(); geo.start(); });

  ticker.add((dt) => tick(dt));
  setMode('sim', { silent: true }); // default sim so idle is easy to hear
  finishBoot();

  // First-run coach marks, after the boot overlay clears
  // Skip the coach marks when the user arrived via the feedback QR (?fb=1 opens the feedback
  // sheet instead) — otherwise both fight for the screen.
  if (new URLSearchParams(location.search).get('fb') !== '1') {
    window.setTimeout(() => startOnboarding(), 1400);
  }

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
    // The car's speedo reads the wheels instantly; a GPS fix arrives ~1 Hz AND already
    // describes a moment that has passed. Showing the raw fix therefore always trails the
    // dash. So PREDICT: carry the last fix forward with the last known acceleration, over
    // (age of the fix + the fix's own latency). Between fixes the number keeps moving with
    // the car instead of stair-stepping, and it lands on the next fix already in sync.
    const fixAge = Math.min(1.5, Math.max(0, (now - (state.lastGeoMs || now)) / 1000));
    const lead = fixAge + GPS_FIX_LATENCY_S;
    // Cap the extrapolation so a bad accel estimate can never run the number away.
    const predict = clamp((state.geoAccel || 0) * lead, -18, 18);
    const targetSpeed = Math.max(0, state.geoSpeed + predict);
    state.activeSpeed += (targetSpeed - state.activeSpeed) * Math.min(1, dt * 14);
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

  // UNIFIED acceleration — ONE system (user's model): accel comes from the ACTUAL speed
  // change, computed identically for GPS and sim. Sim just supplies the speed via its ramp;
  // GPS supplies the real car speed. This replaces the separate GPS geoAccel path (which had
  // a gdt>0.12 guard + decay that could produce ~0 accel = "GPS won't rev") and the x3 patch.
  const dv = state.activeSpeed - (state.prevActiveSpeed ?? state.activeSpeed);
  state.prevActiveSpeed = state.activeSpeed;
  const instAccel = clamp(dv / Math.max(0.001, dt), -40, 40);
  state.accelUni = (state.accelUni ?? 0) * 0.7 + instAccel * 0.3; // light smooth
  audio.setSpeed(state.activeSpeed, {
    throttle: state.throttle,
    brake: state.brake,
    accelKmhps: state.accelUni,
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
