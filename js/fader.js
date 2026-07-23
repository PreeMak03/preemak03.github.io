/**
 * Premium Vertical Dynamic Fader
 * Pointer-driven + spring settle on release + rAF rendering
 */

import { Spring, clamp, ticker } from './animations.js';

export class VerticalFader {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.fill = root.querySelector('#fader-fill') || root.querySelector('.fader-fill');
    this.thumb = root.querySelector('#fader-thumb') || root.querySelector('.fader-thumb');
    this.valueEl = root.querySelector('#fader-value') || root.querySelector('.thumb-value');

    this.min = opts.min ?? 0;
    this.max = opts.max ?? 200;
    this.value = opts.value ?? 0;
    this.displayValue = this.value;
    this.disabled = false;
    this.dragging = false;

    this._trackTop = 0;
    this._trackHeight = 1;
    this._onChange = opts.onChange || (() => {});

    this.spring = new Spring({
      value: this._valueToNorm(this.value),
      stiffness: 220,
      damping: 24,
      mass: 1,
    });

    this._pointerId = null;
    this._unbindTicker = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKey = this._onKey.bind(this);

    this._bind();
    this._measure();
    this._render(true);
    this._unbindTicker = ticker.add((dt) => this._tick(dt));

    window.addEventListener('resize', () => {
      this._measure();
      this._render(true);
    });
  }

  _bind() {
    this.root.addEventListener('pointerdown', this._onPointerDown);
    this.root.addEventListener('keydown', this._onKey);
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    this.root.classList.toggle('is-disabled', disabled);
    this.root.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  setValue(v, { animate = true } = {}) {
    const next = clamp(v, this.min, this.max);
    this.value = next;
    const norm = this._valueToNorm(next);
    if (animate && !this.dragging) {
      this.spring.setTarget(norm);
    } else {
      this.spring.setValue(norm);
      this.displayValue = next;
      this._render(true);
    }
    this.root.setAttribute('aria-valuenow', String(Math.round(next)));
  }

  getValue() {
    return this.value;
  }

  _valueToNorm(v) {
    return (v - this.min) / (this.max - this.min);
  }

  _normToValue(n) {
    return this.min + clamp(n, 0, 1) * (this.max - this.min);
  }

  _measure() {
    const track = this.root.querySelector('.fader-track');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    this._trackTop = rect.top;
    this._trackHeight = rect.height || 1;
    this._rootRect = this.root.getBoundingClientRect();
  }

  _clientYToNorm(clientY) {
    // Track: top = max value, bottom = min value
    const track = this.root.querySelector('.fader-track');
    const rect = track.getBoundingClientRect();
    const y = clientY - rect.top;
    const n = 1 - clamp(y / rect.height, 0, 1);
    return n;
  }

  _onPointerDown(e) {
    if (this.disabled) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    this._measure();
    this.dragging = true;
    this._pointerId = e.pointerId;
    this.root.classList.add('is-dragging');
    this.thumb?.classList.add('is-pressed', 'is-active');
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch (_) {}

    this.root.addEventListener('pointermove', this._onPointerMove);
    this.root.addEventListener('pointerup', this._onPointerUp);
    this.root.addEventListener('pointercancel', this._onPointerUp);

    this._applyPointer(e.clientY, true);
  }

  _onPointerMove(e) {
    if (!this.dragging || e.pointerId !== this._pointerId) return;
    e.preventDefault();
    this._applyPointer(e.clientY, true);
  }

  _onPointerUp(e) {
    if (e.pointerId !== this._pointerId) return;
    this.dragging = false;
    this._pointerId = null;
    this.root.classList.remove('is-dragging');
    this.thumb?.classList.remove('is-pressed');

    // Spring settle to exact value (already set)
    this.spring.setTarget(this._valueToNorm(this.value));

    // Soft release pulse on inner thumb (avoids fighting translateY transform)
    const inner = this.thumb?.querySelector('.thumb-inner');
    if (inner?.animate) {
      inner.animate(
        [
          { transform: 'scale(1.1)' },
          { transform: 'scale(1)' },
        ],
        { duration: 360, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
    }

    window.setTimeout(() => this.thumb?.classList.remove('is-active'), 200);

    this.root.removeEventListener('pointermove', this._onPointerMove);
    this.root.removeEventListener('pointerup', this._onPointerUp);
    this.root.removeEventListener('pointercancel', this._onPointerUp);
  }

  _applyPointer(clientY, immediate) {
    const norm = this._clientYToNorm(clientY);
    const val = this._normToValue(norm);
    this.value = val;
    if (immediate) {
      this.spring.setValue(norm);
      this.displayValue = val;
      this._render(true);
    } else {
      this.spring.setTarget(norm);
    }
    this.root.setAttribute('aria-valuenow', String(Math.round(val)));
    this._onChange(val);
  }

  _onKey(e) {
    if (this.disabled) return;
    const step = e.shiftKey ? 10 : 2;
    let next = this.value;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next += step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next -= step;
    else if (e.key === 'PageUp') next += 20;
    else if (e.key === 'PageDown') next -= 20;
    else if (e.key === 'Home') next = this.max;
    else if (e.key === 'End') next = this.min;
    else return;
    e.preventDefault();
    this.setValue(next, { animate: true });
    this._onChange(this.value);
  }

  _tick(dt) {
    if (this.dragging) return;
    this.spring.step(dt);
    this.displayValue = this._normToValue(this.spring.value);
    this._render(false);
  }

  _render(force) {
    const norm = this.dragging ? this._valueToNorm(this.value) : this.spring.value;
    const pct = clamp(norm, 0, 1) * 100;

    if (this.fill) {
      this.fill.style.height = `${pct}%`;
      // Color shift with intensity
      const hue = 195 - pct * 0.35;
      const sat = 80 + pct * 0.15;
      this.fill.style.background = `linear-gradient(180deg,
        hsl(${hue + 20}, ${sat}%, 72%) 0%,
        hsl(${hue}, ${sat}%, 58%) 40%,
        hsl(${hue - 10}, ${sat + 5}%, 48%) 100%)`;
      this.fill.style.boxShadow = `0 0 ${12 + pct * 0.2}px hsla(${hue}, 90%, 60%, ${0.25 + pct * 0.004})`;
    }

    // Thumb position: top of track + inverted norm
    const track = this.root.querySelector('.fader-track');
    if (track && this.thumb) {
      const trackH = track.offsetHeight || 1;
      // thumb center at fill top
      const y = (1 - clamp(norm, 0, 1)) * trackH + track.offsetTop;
      this.thumb.style.transform = `translateY(${y}px)`;
    }

    if (this.valueEl) {
      const shown = Math.round(this.dragging ? this.value : this.displayValue);
      this.valueEl.textContent = String(shown);
    }
  }

  destroy() {
    this._unbindTicker?.();
  }
}
