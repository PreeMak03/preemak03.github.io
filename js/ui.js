/**
 * UI binding helpers — clean drive UI
 * Carousel profiles, push-to-start, GPS chip, tune sheet sync
 */

import { clamp } from './animations.js';
import { SOUND_PROFILES } from './profiles.js';

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function showToast(message, ms = 2600) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast is-in';
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => {
    el.classList.remove('is-in');
    el.classList.add('is-out');
    window.setTimeout(() => el.remove(), 340);
  }, ms);
}

export function finishBoot() {
  const boot = $('#boot-overlay');
  if (!boot) return;
  window.setTimeout(() => boot.classList.add('is-done'), 700);
}

/* --------------------------------------------------------------------------
   Signature car silhouettes — original SVG art (license-free, drawn in-house).
   Generic body shapes only: recognizable character, no trademarks.
   viewBox 0 0 220 70 · filled with currentColor at low opacity.
   -------------------------------------------------------------------------- */

const CAR_ART = {
  supercar:
    'M6 52 L8 46 C22 41 36 40 52 38 C68 26 94 20 124 22 C156 24 184 33 204 43 L212 48 L212 52 Z',
  jdm:
    'M6 52 L8 41 C20 37 42 36 72 35 C82 26 96 22 114 22 C130 22 142 26 152 33 C166 34 180 35 190 36 L204 30 L206 34 L195 40 C201 42 206 45 208 48 L208 52 Z',
  jdm2:
    'M6 52 L9 44 C22 39 40 37 62 36 C74 26 90 21 108 21 C126 21 140 26 150 34 C164 36 178 38 190 40 L202 36 L204 40 L194 44 L206 48 L206 52 Z',
  roadster:
    'M6 52 L9 42 C24 38 44 37 66 37 L82 30 L94 30 L99 36 C116 37 134 36 150 35 C168 35 186 38 200 43 L208 48 L208 52 Z',
  p911:
    'M6 52 L10 44 C20 39 34 37 54 36 C64 30 76 25 92 23 C106 21 118 22 128 26 C150 32 176 39 198 45 L208 49 L208 52 Z',
  sedan:
    'M6 52 L9 42 C24 38 46 36 70 35 C80 27 94 23 112 23 C128 23 140 27 150 33 C166 34 182 36 196 39 L206 44 L206 52 Z',
  sedanwing:
    'M6 52 L9 42 C24 38 46 36 68 35 C78 27 92 23 108 23 C124 23 136 27 146 33 C158 34 170 35 180 37 L182 29 L198 28 L198 32 L186 34 L190 38 L204 43 L204 52 Z',
  muscle:
    'M6 52 L8 40 C26 36 48 34 78 34 C90 27 104 24 120 24 C134 24 146 28 154 33 C172 36 190 40 202 45 L208 49 L208 52 Z',
  muscle2:
    'M6 52 L8 44 C28 39 52 37 80 36 C94 27 112 23 130 24 C146 25 158 30 166 35 C182 37 196 41 206 46 L212 50 L212 52 Z',
  hatch:
    'M12 52 L14 41 C24 37 36 36 52 35 C60 26 74 22 92 22 C108 22 122 23 134 25 L146 28 L154 34 L158 44 L160 48 L160 52 Z',
  rx7:
    'M6 52 L8 44 L14 40 L52 38 C68 27 88 22 108 23 C126 24 140 29 150 35 C168 38 186 42 200 46 L208 50 L208 52 Z',
  ev:
    'M8 52 C10 44 18 38 34 32 C58 24 86 21 116 22 C146 23 174 30 196 40 C204 44 208 47 210 50 L210 52 Z',
  classic:
    'M6 52 L8 38 L84 36 L90 27 L98 25 L146 25 L152 30 L154 36 L204 38 L206 44 L206 52 Z',
  coupe:
    'M6 52 L9 44 C22 39 38 37 58 37 C70 27 86 22 104 22 C120 22 134 27 144 34 C160 36 178 40 194 45 L206 49 L206 52 Z',
};

const PROFILE_ART = {
  'na-v12': 'supercar',
  rb26: 'jdm',
  '2jz': 'jdm2',
  f20c: 'roadster',
  'flat6-911': 'p911',
  's58-s55': 'sedan',
  'coyote-v8': 'muscle',
  k20c: 'hatch',
  vr6: 'hatch',
  '4g63': 'sedanwing',
  'ls-v8': 'muscle2',
  b58: 'coupe',
  'rotary-rx7': 'rx7',
  'electric-hyper': 'ev',
  'classic-muscle': 'classic',
};

function artSvg(profileId) {
  const body = CAR_ART[PROFILE_ART[profileId]] || CAR_ART.sedan;
  // Wheel-less body silhouette; viewBox cropped to the body (y ≈ 20–52)
  return `<svg class="pcard-art" viewBox="0 18 220 36" aria-hidden="true"><path d="${body}" fill="currentColor"/></svg>`;
}

/* --------------------------------------------------------------------------
   Profile carousel — swipe, center zoom pop, auto-select the centered card
   -------------------------------------------------------------------------- */

export function renderProfiles(scroller, activeId, onSelect) {
  scroller.innerHTML = '';
  const cards = [];
  let currentId = activeId;

  SOUND_PROFILES.forEach((p) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pcard' + (p.id === activeId ? ' is-selected' : '');
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', p.id === activeId ? 'true' : 'false');
    card.dataset.profileId = p.id;
    card.style.setProperty('--profile-accent', p.accent);
    card.innerHTML = `
      ${artSvg(p.id)}
      <span class="pcard-name">${escapeHtml(p.name)}</span>
      <span class="pcard-car">${escapeHtml(p.car || p.tag)}</span>
    `;
    card.addEventListener('click', () => centerOn(card));
    scroller.appendChild(card);
    cards.push({ el: card, p });
  });

  // Edge spacers so first/last cards can reach dead center
  const addSpacer = (where) => {
    const sp = document.createElement('div');
    sp.className = 'pcard-spacer';
    sp.style.cssText = 'flex:0 0 auto;width:calc(50% - 92px);height:1px;';
    sp.setAttribute('aria-hidden', 'true');
    if (where === 'start') scroller.prepend(sp);
    else scroller.appendChild(sp);
  };
  addSpacer('start');
  addSpacer('end');

  const centerOn = (el, smooth = true) => {
    scroller.scrollTo({
      left: el.offsetLeft + el.offsetWidth / 2 - scroller.clientWidth / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  let zoomRaf = 0;
  const updateZoom = () => {
    zoomRaf = 0;
    const mid = scroller.scrollLeft + scroller.clientWidth / 2;
    for (const c of cards) {
      const center = c.el.offsetLeft + c.el.offsetWidth / 2;
      const d = Math.abs(center - mid) / c.el.offsetWidth;
      const s = 1.16 - Math.min(d, 1) * 0.24;
      c.el.style.transform = `scale(${s.toFixed(3)})`;
      c.el.style.opacity = String(Math.max(0.35, 1 - Math.min(d, 1.4) * 0.42));
      c.el.classList.toggle('is-center', d < 0.5);
    }
  };
  const queueZoom = () => {
    if (!zoomRaf) zoomRaf = requestAnimationFrame(updateZoom);
  };

  let settleTimer = 0;
  scroller.addEventListener(
    'scroll',
    () => {
      queueZoom();
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        const mid = scroller.scrollLeft + scroller.clientWidth / 2;
        let best = null;
        let bestDist = Infinity;
        for (const c of cards) {
          const d = Math.abs(c.el.offsetLeft + c.el.offsetWidth / 2 - mid);
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
        if (best && best.p.id !== currentId) {
          currentId = best.p.id;
          for (const c of cards) {
            const sel = c.p.id === currentId;
            c.el.classList.toggle('is-selected', sel);
            c.el.setAttribute('aria-selected', sel ? 'true' : 'false');
          }
          onSelect(best.p);
        }
      }, 170);
    },
    { passive: true }
  );

  // Initial position: center the active profile without animation
  requestAnimationFrame(() => {
    const active = cards.find((c) => c.p.id === activeId);
    if (active) centerOn(active.el, false);
    updateZoom();
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* --------------------------------------------------------------------------
   Speed display
   -------------------------------------------------------------------------- */

export class SpeedDisplay {
  constructor() {
    this.valueEl = $('#speed-value');
    this.ring = $('#ring-progress');
    this.teleAccuracy = $('#tele-accuracy');
    this.display = 0;
    this.target = 0;
    this.circumference = 2 * Math.PI * 104; // r=104
    if (this.ring) {
      this.ring.style.strokeDasharray = String(this.circumference);
    }
  }

  setTelemetry({ accuracy }) {
    if (this.teleAccuracy) {
      if (accuracy != null && !Number.isNaN(accuracy)) {
        this.teleAccuracy.textContent = `±${Math.round(accuracy)} m`;
      } else {
        this.teleAccuracy.textContent = '—';
      }
    }
  }

  /** Smooth the big number every frame */
  step(dt) {
    const lambda = 28;
    this.display += (this.target - this.display) * (1 - Math.exp(-lambda * dt));
    if (Math.abs(this.target - this.display) < 0.15) this.display = this.target;

    const shown = Math.round(this.display);
    if (this.valueEl) {
      this.valueEl.textContent = String(shown);
    }

    if (this.ring) {
      const norm = clamp(this.display / 200, 0, 1);
      const offset = this.circumference * (1 - norm);
      this.ring.style.strokeDashoffset = String(offset);
    }
  }
}

/* --------------------------------------------------------------------------
   Controls binding
   -------------------------------------------------------------------------- */

export function bindSliders(handlers) {
  const map = [
    { id: 'vol-master', fill: 'vol-master-fill', val: 'vol-master-val', key: 'master' },
    { id: 'vol-bass', fill: 'vol-bass-fill', val: 'vol-bass-val', key: 'bass' },
    { id: 'vol-edge', fill: 'vol-edge-fill', val: 'vol-edge-val', key: 'edge' },
  ];

  map.forEach(({ id, fill, val, key }) => {
    const input = document.getElementById(id);
    const fillEl = document.getElementById(fill);
    const valEl = document.getElementById(val);
    if (!input) return;

    const sync = () => {
      const v = Number(input.value);
      if (fillEl) fillEl.style.width = `${v}%`;
      if (valEl) valEl.textContent = `${v}%`;
      handlers[key]?.(v / 100);
    };

    input.addEventListener('input', sync);
    sync();
  });
}

export function setModeUI(mode) {
  const gps = $('#btn-gps');
  if (gps) {
    gps.classList.toggle('is-on', mode === 'geo');
    gps.setAttribute('aria-pressed', mode === 'geo' ? 'true' : 'false');
  }
  // Sim demand slider is inert while GPS drives the speed
  $('#sim-group')?.classList.toggle('is-inert', mode !== 'sim');
}

export function setAudioStatus(running) {
  const btn = $('#btn-engine');
  const label = $('#btn-engine-label');
  const status = $('#ps-status');
  if (btn) btn.classList.toggle('is-running', running);
  if (label) label.textContent = running ? 'Stop' : 'Start';
  if (status) status.textContent = running ? 'Engine Live' : 'Ready';
}

export function setGpsStatus(status) {
  const dot = $('#gps-status-dot');
  const label = $('#gps-status-label');
  if (!dot || !label) return;
  dot.classList.remove('is-live', 'is-warn', 'is-off');
  switch (status) {
    case 'live':
      dot.classList.add('is-live');
      label.textContent = 'GPS Live';
      break;
    case 'pending':
      dot.classList.add('is-warn');
      label.textContent = 'GPS Seeking…';
      break;
    case 'denied':
      dot.classList.add('is-warn');
      label.textContent = 'GPS Denied';
      break;
    case 'error':
      dot.classList.add('is-warn');
      label.textContent = 'GPS Error';
      break;
    default:
      dot.classList.add('is-off');
      label.textContent = 'GPS Off';
  }
}

export function bindToggles(map) {
  Object.entries(map).forEach(([id, handler]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const on = !btn.classList.contains('is-on');
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      handler(on);
    });
  });
}
