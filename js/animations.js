/**
 * Code-based animation utilities
 * requestAnimationFrame + spring/lerp helpers for premium motion
 */

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function damp(current, target, lambda, dt) {
  // Frame-rate independent exponential smoothing
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Spring toward a target (critical-ish damping style)
 */
export class Spring {
  constructor({ value = 0, stiffness = 180, damping = 22, mass = 1 } = {}) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  setTarget(t) {
    this.target = t;
  }

  setValue(v, resetVelocity = true) {
    this.value = v;
    this.target = v;
    if (resetVelocity) this.velocity = 0;
  }

  step(dt) {
    // Semi-implicit Euler
    const force = -this.stiffness * (this.value - this.target);
    const accel = (force - this.damping * this.velocity) / this.mass;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  get settled() {
    return Math.abs(this.value - this.target) < 0.01 && Math.abs(this.velocity) < 0.01;
  }
}

/**
 * Global rAF ticker — single loop for all subsystems
 */
export class Ticker {
  constructor() {
    this.callbacks = new Set();
    this.running = false;
    this._last = 0;
    this._raf = 0;
    this._bound = this._frame.bind(this);
  }

  add(fn) {
    this.callbacks.add(fn);
    if (!this.running) this.start();
    return () => this.callbacks.delete(fn);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._bound);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    for (const fn of this.callbacks) {
      try {
        fn(dt, now);
      } catch (e) {
        console.error('[Ticker]', e);
      }
    }
    this._raf = requestAnimationFrame(this._bound);
  }
}

export const ticker = new Ticker();

/**
 * Animate a numeric value with rAF
 */
export function animateValue({
  from,
  to,
  duration = 400,
  easing = easeOutCubic,
  onUpdate,
  onComplete,
}) {
  const start = performance.now();
  let cancelled = false;

  function frame(now) {
    if (cancelled) return;
    const t = clamp((now - start) / duration, 0, 1);
    const v = lerp(from, to, easing(t));
    onUpdate?.(v, t);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onComplete?.(to);
    }
  }

  requestAnimationFrame(frame);
  return () => {
    cancelled = true;
  };
}

/**
 * Web Animations API helper with fallback
 */
export function waapi(el, keyframes, options = {}) {
  if (!el || !el.animate) {
    return { finished: Promise.resolve(), cancel() {} };
  }
  const anim = el.animate(keyframes, {
    duration: 400,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both',
    ...options,
  });
  return anim;
}

/**
 * Subtle ambient particle field (canvas)
 */
export class ParticleField {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._count = 28;
    this.resize();
    this._init();
  }

  resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect() || {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _init() {
    this.particles = Array.from({ length: this._count }, () => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      r: 0.6 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 6,
      a: 0.15 + Math.random() * 0.35,
    }));
  }

  step(dt) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -4) p.x = this.w + 4;
      if (p.x > this.w + 4) p.x = -4;
      if (p.y < -4) p.y = this.h + 4;
      if (p.y > this.h + 4) p.y = -4;

      ctx.beginPath();
      ctx.fillStyle = `rgba(110, 231, 255, ${p.a})`;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Waveform + frequency bars visualizer
 */
export class WaveformVisualizer {
  constructor(canvas, barsHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.barsHost = barsHost;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.phase = 0;
    this.energy = 0;
    this.speedNorm = 0;
    this.running = false;
    this.analyser = null;
    this._freqData = null;
    this._timeData = null;
    this._bars = [];
    this._barCount = 32;
    this._buildBars();
    this.resize();
  }

  _buildBars() {
    if (!this.barsHost) return;
    this.barsHost.innerHTML = '';
    this._bars = [];
    for (let i = 0; i < this._barCount; i++) {
      const el = document.createElement('div');
      el.className = 'freq-bar';
      this.barsHost.appendChild(el);
      this._bars.push(el);
    }
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    if (analyser) {
      this._freqData = new Uint8Array(analyser.frequencyBinCount);
      this._timeData = new Uint8Array(analyser.fftSize);
    }
  }

  setEnergy(energy, speedNorm) {
    this.energy = energy;
    this.speedNorm = speedNorm;
  }

  setRunning(v) {
    this.running = v;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  step(dt) {
    this.phase += dt * (1.2 + this.speedNorm * 4);
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);

    // Soft grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    let points = [];

    if (this.running && this.analyser && this._timeData) {
      this.analyser.getByteTimeDomainData(this._timeData);
      this.analyser.getByteFrequencyData(this._freqData);
      const step = Math.floor(this._timeData.length / Math.min(w, 240));
      for (let x = 0; x < w; x++) {
        const idx = Math.min(this._timeData.length - 1, x * step);
        const v = (this._timeData[idx] - 128) / 128;
        const y = h * 0.5 + v * h * 0.38;
        points.push({ x, y });
      }
      // Freq bars
      if (this._bars.length && this._freqData) {
        const binStep = Math.floor(this._freqData.length / this._barCount);
        for (let i = 0; i < this._barCount; i++) {
          let sum = 0;
          for (let j = 0; j < binStep; j++) sum += this._freqData[i * binStep + j] || 0;
          const n = sum / (binStep * 255);
          const scale = 0.12 + n * 0.88;
          this._bars[i].style.transform = `scaleY(${scale})`;
          this._bars[i].style.opacity = String(0.35 + n * 0.65);
        }
      }
    } else {
      // Idle synthetic wave
      const amp = 8 + this.energy * 40 + this.speedNorm * 28;
      const segs = Math.floor(w);
      for (let x = 0; x < segs; x++) {
        const t = x / w;
        const y =
          h * 0.5 +
          Math.sin(t * Math.PI * 4 + this.phase) * amp * 0.55 +
          Math.sin(t * Math.PI * 9 + this.phase * 1.4) * amp * 0.25 +
          Math.sin(t * Math.PI * 2.2 - this.phase * 0.7) * amp * 0.2;
        points.push({ x, y });
      }
      if (this._bars.length) {
        for (let i = 0; i < this._barCount; i++) {
          const n =
            0.15 +
            0.25 * Math.abs(Math.sin(this.phase * 1.5 + i * 0.35)) +
            this.speedNorm * 0.35 * Math.abs(Math.sin(this.phase + i * 0.5));
          this._bars[i].style.transform = `scaleY(${n})`;
          this._bars[i].style.opacity = String(0.3 + n * 0.5);
        }
      }
    }

    // Glow stroke
    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.strokeStyle = 'rgba(62, 207, 255, 0.25)';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'rgba(110, 231, 255, 0.15)');
      grad.addColorStop(0.5, 'rgba(62, 207, 255, 0.95)');
      grad.addColorStop(1, 'rgba(167, 139, 250, 0.7)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.75;
      ctx.stroke();

      // Under fill
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, 'rgba(62, 207, 255, 0.12)');
      fill.addColorStop(1, 'rgba(62, 207, 255, 0)');
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }
}
