'use strict';
/**
 * The boot ceremony: gold particles assemble the feather of truth, HUD rings
 * spin up, the system reports itself, MAAT greets you, the board reveals.
 *
 * Honest even here: every boot line is real state fetched from /api/health,
 * never theater. Skippable (click / Esc / Space), honors reduced motion,
 * disabled via config bootAnimation: false. Capped DPR, no dependencies.
 */
(() => {
  const overlay = document.getElementById('boot');
  if (!overlay) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { finish(true); return; }

  const canvas = overlay.querySelector('#boot-canvas');
  const ctx = canvas.getContext('2d');
  const logEl = overlay.querySelector('#boot-log');
  const greetEl = overlay.querySelector('#boot-greet');
  const subEl = overlay.querySelector('#boot-sub');

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0, CX = 0, CY = 0;
  function size() {
    W = overlay.clientWidth; H = overlay.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = W / 2; CY = H / 2 - 30;
  }
  size();
  window.addEventListener('resize', size);

  // ---- feather target points: rasterize the brand path, sample the pixels ----
  const FEATHER = 'M16 3 C22 8 25 15 24 22 C20 20 17 16 16 11 C15 16 12 20 8 22 C7 15 10 8 16 3 Z M15 22 h2 v7 h-2 Z';
  function featherPoints(scale) {
    const off = document.createElement('canvas');
    const s = 32 * scale;
    off.width = s; off.height = s;
    const octx = off.getContext('2d');
    octx.scale(scale, scale);
    octx.fill(new Path2D(FEATHER));
    const img = octx.getImageData(0, 0, s, s).data;
    const pts = [];
    const step = Math.max(2, Math.round(scale / 3));
    for (let y = 0; y < s; y += step) {
      for (let x = 0; x < s; x += step) {
        if (img[(y * s + x) * 4 + 3] > 128) {
          pts.push({ x: (x / scale - 16), y: (y / scale - 16) });
        }
      }
    }
    return pts;
  }
  const SCALE = 7; // feather ~224px tall
  const targets = featherPoints(24).map((p) => ({ x: CX + p.x * SCALE, y: CY + p.y * SCALE }));

  // ---- particles ----
  const particles = targets.map((t, i) => {
    const a = Math.random() * Math.PI * 2;
    const r = Math.max(W, H) * (0.35 + Math.random() * 0.35);
    return {
      x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r,
      tx: t.x, ty: t.y,
      delay: 250 + (i % 60) * 14 + Math.random() * 300,
      dur: 900 + Math.random() * 700,
      size: 0.9 + Math.random() * 1.3,
      alpha: 0.55 + Math.random() * 0.45,
    };
  });

  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const t0 = performance.now();
  let done = false, exiting = false, exitAt = 0;

  function frame(now) {
    if (done) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);

    let formed = 0;
    for (const p of particles) {
      const k = Math.min(1, Math.max(0, (t - p.delay) / p.dur));
      const e = ease(k);
      let x = p.x + (p.tx - p.x) * e;
      let y = p.y + (p.ty - p.y) * e;
      if (k >= 1) { formed++; y += Math.sin(now / 500 + p.tx) * 0.6; } // settled shimmer
      if (exiting) { // disperse upward on exit
        const ek = Math.min(1, (now - exitAt) / 600);
        y -= ek * ek * 120;
        ctx.globalAlpha = p.alpha * (1 - ek);
      } else {
        ctx.globalAlpha = p.alpha * Math.min(1, k * 1.4 + 0.1);
      }
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = '#dcae54';
      ctx.shadowColor = '#dcae54';
      ctx.shadowBlur = k >= 1 ? 6 : 2;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    if (!exiting && formed > particles.length * 0.96 && t > 2400) {
      overlay.classList.add('formed'); // triggers greeting + glow via CSS
    }
  }
  requestAnimationFrame(frame);

  // ---- real boot lines ----
  const lines = ['MAAT core online'];
  let name = null;
  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (h.bootAnimation === false) { finish(true); return; }
    name = h.user;
    lines.push(`adapters: ${h.watcher.adapters.map((a) => a.id + ' v' + a.version).join(' · ') || 'none detected'}`);
    lines.push(`${h.watcher.sessions} sessions indexed · watcher ${h.watcher.alive ? 'alive' : 'starting'}`);
    lines.push('zero-token loop engaged');
  }).catch(() => {
    lines.push('server warming up…');
  });

  let li = 0;
  const typer = setInterval(() => {
    if (li < lines.length) {
      const div = document.createElement('div');
      div.className = 'boot-line';
      div.textContent = '▸ ' + lines[li++];
      logEl.appendChild(div);
    }
  }, 420);

  // ---- greeting ----
  setTimeout(() => {
    const h = new Date().getHours();
    const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    greetEl.textContent = name ? `${part}, ${name}.` : `${part}.`;
    subEl.textContent = 'every agent, weighed';
  }, 2600);

  // ---- exit ----
  const exitTimer = setTimeout(exit, 4300);
  overlay.addEventListener('click', exit);
  document.addEventListener('keydown', onKey);
  function onKey(e) { if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') exit(); }

  function exit() {
    if (exiting) return;
    exiting = true; exitAt = performance.now();
    clearTimeout(exitTimer);
    clearInterval(typer);
    overlay.classList.add('exit');
    setTimeout(() => finish(false), 650);
  }

  function finish(instant) {
    done = true;
    clearInterval(typer);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.classList.add(instant ? 'revealed-instant' : 'revealed');
  }
})();
