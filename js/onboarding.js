/**
 * First-run coach marks — spotlight + simple tooltips, tap to advance,
 * shown once (localStorage 'tas-onboarded'). Keeps the app approachable for
 * first-timers who open the shared link with zero instructions.
 */

const KEY = 'tas-onboarded';

const STEPS = [
  {
    sel: '#btn-engine',
    title: 'สตาร์ทเครื่อง',
    body: 'แตะปุ่มนี้เพื่อติดเครื่อง เริ่มได้ยินเสียงเดินเบา',
    pad: 10,
    radius: '50%',
  },
  {
    sel: '#profile-scroller',
    title: 'เลือกเสียงรถ',
    body: 'ปัดซ้าย–ขวาเลือกจาก 15 เครื่องยนต์ · การ์ดตรงกลางคือเสียงที่ใช้',
    pad: 8,
  },
  {
    sel: '#btn-launch',
    title: 'ลองเบิ้ลเครื่อง',
    body: 'กด REV ฟังเสียงลากรอบสับเกียร์แบบควอเตอร์ไมล์ (ติดเครื่องก่อน)',
    pad: 8,
    radius: '50%',
  },
  {
    sel: '#btn-gps',
    title: 'เปิด GPS ตอนขับจริง',
    body: 'เปิดให้เสียงวิ่งตามความเร็ว GPS จริง · ปิดไว้ = โหมด Sim ปรับเองในตั้งค่า',
    pad: 6,
  },
  {
    center: true,
    title: 'เปิดครั้งหน้าให้ง่าย',
    body: 'แตะไอคอน ☆ ในแถบที่อยู่เพื่อ Bookmark หน้านี้ไว้ · ครั้งต่อไปเปิดแตะเดียว ไม่ต้องพิมพ์ใหม่ และใช้ได้แม้เน็ตไม่ดี',
  },
];

const BOOKMARK_SVG =
  '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1Z"/></svg>';

export function startOnboarding({ force = false } = {}) {
  try {
    if (!force && localStorage.getItem(KEY)) return;
  } catch (_) {}

  const steps = STEPS.filter((s) => !s.sel || document.querySelector(s.sel));
  if (!steps.length) return;

  // Never stack overlays (e.g. replay while one is still fading)
  document.querySelectorAll('.onb').forEach((n) => n.remove());

  const root = document.createElement('div');
  root.className = 'onb';
  root.innerHTML = `
    <div class="onb-hole" id="onb-hole"></div>
    <div class="onb-tip" id="onb-tip">
      <div class="onb-tip-icon" id="onb-icon" aria-hidden="true"></div>
      <div class="onb-tip-title" id="onb-title"></div>
      <div class="onb-tip-body" id="onb-body"></div>
      <div class="onb-tip-foot">
        <span class="onb-step" id="onb-step"></span>
        <span class="onb-next" id="onb-next"></span>
      </div>
    </div>
    <button type="button" class="onb-skip" id="onb-skip">ข้าม</button>
  `;
  document.body.appendChild(root);

  const hole = root.querySelector('#onb-hole');
  const tip = root.querySelector('#onb-tip');
  const iconEl = root.querySelector('#onb-icon');
  const titleEl = root.querySelector('#onb-title');
  const bodyEl = root.querySelector('#onb-body');
  const stepEl = root.querySelector('#onb-step');
  const nextEl = root.querySelector('#onb-next');

  let i = 0;

  const done = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch (_) {}
    // Stop intercepting taps immediately, even before the fade finishes
    root.style.pointerEvents = 'none';
    root.classList.add('is-out');
    window.setTimeout(() => root.remove(), 300);
  };

  const render = () => {
    const step = steps[i];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let rect = null;
    if (step.center) {
      // No target: collapse the spotlight to a point so the dim fills the
      // screen, and show a centered card with a bookmark icon.
      hole.style.left = `${vw / 2}px`;
      hole.style.top = `${vh / 2}px`;
      hole.style.width = '0px';
      hole.style.height = '0px';
      iconEl.innerHTML = BOOKMARK_SVG;
      iconEl.hidden = false;
      tip.classList.add('is-center');
    } else {
      const el = document.querySelector(step.sel);
      if (!el) {
        i += 1;
        if (i >= steps.length) return done();
        return render();
      }
      rect = el.getBoundingClientRect();
      const pad = step.pad ?? 8;
      hole.style.left = `${rect.left - pad}px`;
      hole.style.top = `${rect.top - pad}px`;
      hole.style.width = `${rect.width + pad * 2}px`;
      hole.style.height = `${rect.height + pad * 2}px`;
      hole.style.borderRadius = step.radius || '16px';
      iconEl.hidden = true;
      tip.classList.remove('is-center');
    }

    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    stepEl.textContent = `${i + 1} / ${steps.length}`;
    nextEl.textContent = i === steps.length - 1 ? 'เริ่มใช้งาน ✓' : 'แตะเพื่อไปต่อ ›';

    // Place tooltip synchronously (works even when rAF is throttled).
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (step.center) {
      tip.style.left = `${(vw - tw) / 2}px`;
      tip.style.top = `${(vh - th) / 2}px`;
    } else {
      const pad = step.pad ?? 8;
      let tx = rect.left + rect.width / 2 - tw / 2;
      tx = Math.max(12, Math.min(tx, vw - tw - 12));
      const above = rect.top - pad - th - 14;
      const below = rect.bottom + pad + 14;
      const ty = above > 12 ? above : Math.min(below, vh - th - 12);
      tip.style.left = `${tx}px`;
      tip.style.top = `${ty}px`;
    }
    tip.style.visibility = 'visible';
  };

  root.addEventListener('click', (e) => {
    if (e.target.closest('#onb-skip')) {
      done();
      return;
    }
    i += 1;
    if (i >= steps.length) return done();
    render();
  });

  render();
}
