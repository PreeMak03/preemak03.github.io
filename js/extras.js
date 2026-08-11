/**
 * Donate + Feedback — everything that is NOT driving.
 *
 * Contract (deliberate, after a regression where these features cost the drive loop):
 *  · This module is `import()`-ed the first time the user taps one of the buttons. Until then
 *    it is not fetched, not parsed, not executed — the driving app never pays for it.
 *  · While a sheet is open it owns some DOM, one <style>, and a keydown listener.
 *  · On close EVERYTHING is destroyed: markup removed, style removed, listener detached,
 *    image references dropped. Closed means gone, not `hidden` — a hidden overlay is still a
 *    node the browser must consider on every layout/paint pass.
 *
 * So the cost profile is: never opened = 0. Opened = a one-off fetch (fine, it is a tap).
 * Closed again = back to 0.
 */

const FEEDBACK_ACCESS_KEY = 'b0c38acf-3953-4910-9fbb-290ad09af3a5';

const CATEGORIES = ['ประสบการณ์ขับขี่', 'แนะนำเพิ่มเติม', 'รายงานบัค'];
const CATEGORY_ICONS = ['🚗', '💡', '🐞'];

const CSS = `
.xt-back{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.72);opacity:0;
  transition:opacity .2s ease}
.xt-back.on{opacity:1}
.xt-sheet{position:fixed;z-index:61;left:50%;top:50%;
  transform:translate(-50%,-46%) scale(.96);width:min(340px,calc(100vw - 40px));
  max-height:88vh;overflow-y:auto;padding:22px 22px 18px;text-align:center;
  background:var(--bg-elevated);border:1px solid var(--border-glass);
  border-radius:var(--radius-lg);box-shadow:var(--shadow-panel);opacity:0;
  transition:opacity .2s ease,transform .25s cubic-bezier(.34,1.56,.64,1)}
.xt-sheet.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
.xt-x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;
  border:1px solid var(--border-subtle);background:rgba(127,127,127,.12);
  color:var(--text-secondary);font-size:13px;line-height:1;cursor:pointer}
.xt-eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;
  color:#d9a066}
.xt-h{font-size:18px;font-weight:700;color:var(--text-primary);margin-top:5px}
.xt-p{font-size:13px;line-height:1.55;color:var(--text-secondary);margin:8px 4px 16px}
.xt-qrcard{display:inline-flex;align-items:center;justify-content:center;padding:14px;
  background:#fff;border-radius:var(--radius-md);box-shadow:0 6px 20px rgba(0,0,0,.18)}
.xt-qrcard img{display:block;width:240px;max-width:62vw;height:auto;border-radius:6px}
.xt-badge{margin-top:14px;font-size:12px;color:var(--text-muted)}
.xt-hint{display:flex;align-items:center;gap:12px;padding:10px;margin-bottom:12px;
  background:rgba(127,127,127,.06);border:1px solid var(--border-subtle);
  border-radius:var(--radius-md);text-align:left}
.xt-hint img{flex:0 0 auto;width:92px;height:92px;padding:6px;background:#fff;border-radius:8px}
.xt-hint span{font-size:12.5px;line-height:1.5;color:var(--text-secondary)}
.xt-cats{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px}
.xt-cat{flex:1 1 auto;padding:8px 6px;border-radius:var(--radius-pill);
  background:rgba(127,127,127,.08);border:1px solid var(--border-subtle);
  color:var(--text-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.xt-cat.on{color:var(--text-primary);border-color:var(--border-accent);background:var(--accent-soft)}
.xt-form{display:flex;flex-direction:column;gap:10px;text-align:left}
.xt-in{width:100%;padding:10px 12px;border-radius:var(--radius-sm);background:var(--bg-deep);
  border:1px solid var(--border-glass);color:var(--text-primary);font:inherit;font-size:13px;
  resize:vertical}
.xt-in::placeholder{color:var(--text-muted)}
.xt-in:focus{outline:none;border-color:var(--border-accent)}
.xt-send{margin-top:2px;padding:11px;border-radius:var(--radius-pill);
  background:var(--accent-soft);border:1px solid var(--border-accent);color:var(--text-primary);
  font-weight:600;font-size:14px;cursor:pointer}
.xt-send:disabled{opacity:.5;cursor:default}
.xt-status{min-height:16px;font-size:12px;text-align:center;color:var(--text-secondary)}
.xt-status.ok{color:var(--success)}
.xt-status.err{color:var(--danger)}
`;

/** Live handle for whatever sheet is on screen; null whenever nothing is open. */
let live = null;

/** Remove every trace: nodes, stylesheet, listener. */
function destroy() {
  if (!live) return;
  const { back, sheet, style, onKey } = live;
  live = null;
  document.removeEventListener('keydown', onKey);
  back.classList.remove('on');
  sheet.classList.remove('on');
  window.setTimeout(() => {
    back.remove();
    sheet.remove();
    style.remove();
  }, 220);
}

/** Build the backdrop + sheet shell, wire close, return the body element to fill. */
function present(innerHtml) {
  destroy();
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const back = document.createElement('div');
  back.className = 'xt-back';

  const sheet = document.createElement('div');
  sheet.className = 'xt-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.innerHTML = `<button type="button" class="xt-x" aria-label="ปิด">✕</button>${innerHtml}`;

  document.body.append(back, sheet);
  const onKey = (e) => { if (e.key === 'Escape') destroy(); };
  document.addEventListener('keydown', onKey);
  live = { back, sheet, style, onKey };

  back.addEventListener('click', destroy);
  sheet.querySelector('.xt-x').addEventListener('click', destroy);
  requestAnimationFrame(() => { back.classList.add('on'); sheet.classList.add('on'); });
  return sheet;
}

export function openDonate() {
  present(`
    <div class="xt-eyebrow">☕ Support</div>
    <div class="xt-h">เลี้ยงกาแฟผู้พัฒนา</div>
    <p class="xt-p">ถ้าชอบแอปนี้ เลี้ยงกาแฟสักแก้วเป็นกำลังใจให้กันได้ครับ 🙏</p>
    <div class="xt-qrcard"><img src="assets/donate-qr.png" alt="PromptPay QR" decoding="async" /></div>
    <div class="xt-badge">PromptPay · สแกนด้วยแอปธนาคาร</div>
  `);
}

export function openFeedback({ version = '', profile = '' } = {}) {
  const cats = CATEGORIES.map(
    (c, i) => `<button type="button" class="xt-cat${i === 0 ? ' on' : ''}" data-c="${c}">${CATEGORY_ICONS[i]} ${c}</button>`
  ).join('');
  const sheet = present(`
    <div class="xt-eyebrow">💬 Feedback</div>
    <div class="xt-h">บอกเราหน่อย</div>
    <p class="xt-p">เจอบั๊ก อยากได้เสียงเครื่องไหน หรือติชมอะไร พิมพ์มาได้เลย</p>
    <div class="xt-hint">
      <img src="assets/feedback-qr.svg" alt="QR เปิดในมือถือ" decoding="async" />
      <span>📱 พิมพ์ในรถยาก?<br />สแกนเปิดในมือถือ แล้วพิมพ์สบายกว่า</span>
    </div>
    <div class="xt-cats">${cats}</div>
    <form class="xt-form">
      <textarea class="xt-in" rows="4" maxlength="1500" required
        placeholder="ความคิดเห็น / ปัญหาที่เจอ / เสียงที่อยากได้…"></textarea>
      <input class="xt-in" type="text" maxlength="120"
        placeholder="อีเมล/ไลน์ (ถ้าอยากให้ตอบกลับ · ไม่บังคับ)" />
      <button type="submit" class="xt-send">ส่งความเห็น</button>
      <div class="xt-status" aria-live="polite"></div>
    </form>
  `);

  let category = CATEGORIES[0];
  const chips = [...sheet.querySelectorAll('.xt-cat')];
  chips.forEach((c) => c.addEventListener('click', () => {
    category = c.dataset.c;
    chips.forEach((x) => x.classList.toggle('on', x === c));
  }));

  const form = sheet.querySelector('.xt-form');
  const statusEl = sheet.querySelector('.xt-status');
  const sendBtn = sheet.querySelector('.xt-send');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = sheet.querySelector('textarea').value.trim();
    if (!message) return;
    sendBtn.disabled = true;
    statusEl.className = 'xt-status';
    statusEl.textContent = 'กำลังส่ง…';
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: FEEDBACK_ACCESS_KEY,
          subject: `[${category}] Tesla Active Sound Feedback`,
          from_name: 'Tesla Active Sound',
          category,
          message,
          contact: sheet.querySelector('input[type=text]').value.trim(),
          app_version: version,
          profile,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      statusEl.className = 'xt-status ok';
      statusEl.textContent = 'ส่งแล้ว ขอบคุณครับ 🙏';
      form.reset();
      window.setTimeout(destroy, 1400);
    } catch (_) {
      statusEl.className = 'xt-status err';
      statusEl.textContent = 'ส่งไม่สำเร็จ · ลองใหม่อีกครั้ง';
    } finally {
      sendBtn.disabled = false;
    }
  });
}
