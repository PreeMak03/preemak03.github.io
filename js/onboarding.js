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
];

export function startOnboarding({ force = false } = {}) {
  try {
    if (!force && localStorage.getItem(KEY)) return;
  } catch (_) {}

  const steps = STEPS.filter((s) => document.querySelector(s.sel));
  if (!steps.length) return;

  // Never stack overlays (e.g. replay while one is still fading)
  document.querySelectorAll('.onb').forEach((n) => n.remove());

  const root = document.createElement('div');
  root.className = 'onb';
  root.innerHTML = `
    <div class="onb-hole" id="onb-hole"></div>
    <div class="onb-tip" id="onb-tip">
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
    const el = document.querySelector(step.sel);
    if (!el) {
      i += 1;
      if (i >= steps.length) return done();
      return render();
    }
    const r = el.getBoundingClientRect();
    const pad = step.pad ?? 8;
    const x = r.left - pad;
    const y = r.top - pad;
    const w = r.width + pad * 2;
    const h = r.height + pad * 2;
    hole.style.left = `${x}px`;
    hole.style.top = `${y}px`;
    hole.style.width = `${w}px`;
    hole.style.height = `${h}px`;
    hole.style.borderRadius = step.radius || '16px';

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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let tx = r.left + r.width / 2 - tw / 2;
    tx = Math.max(12, Math.min(tx, vw - tw - 12));
    const above = y - th - 14;
    const below = y + h + 14;
    const ty = above > 12 ? above : Math.min(below, vh - th - 12);
    tip.style.left = `${tx}px`;
    tip.style.top = `${ty}px`;
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
