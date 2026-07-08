'use strict';
/* Orb view: the project's file tree as a slowly rotating sphere, folders and
 * files are nodes, parent-child links are edges, nodes pulse gently. Pure
 * canvas, zero dependencies. Perf-budgeted per MAAT law: DPR capped at 2,
 * node count capped, rAF suspends when the tab hides or the canvas leaves
 * the DOM. The HUD corners show real counts, never invented load numbers. */

const Orb = (() => {
  let raf = null, canvas = null, ctx = null;
  let nodes = [], edges = [], hud = { left: '', right: '' };
  const MAX_NODES = 140;

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue('--accent').trim() || '#d8a35a',
      dim: cs.getPropertyValue('--dim').trim() || '#8b95a5',
      ink: cs.getPropertyValue('--text').trim() || '#e8e4da',
    };
  }

  function build(tree, hudLeft, hudRight) {
    const flat = [];
    (function walk(n, parent, depth) {
      if (flat.length >= MAX_NODES) return;
      const i = flat.length;
      flat.push({ parent, depth, dirNode: !!n.dir, phase: (i * 2.399) % (Math.PI * 2) });
      for (const c of n.children || []) walk(c, i, depth + 1);
    })(tree, -1, 0);

    // Fibonacci sphere: even coverage at any node count.
    const N = flat.length, GA = Math.PI * (3 - Math.sqrt(5));
    flat.forEach((n, i) => {
      const y = N > 1 ? 1 - (i / (N - 1)) * 2 : 0;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      n.x = Math.cos(GA * i) * r; n.y = y; n.z = Math.sin(GA * i) * r;
    });
    nodes = flat;
    // Shell mesh: link each node to its 2 nearest neighbours on the sphere.
    // Parent-child chords through the interior read as tangle at this scale;
    // the tree view is the readable map, the orb is the living one.
    const seen = new Set();
    edges = [];
    flat.forEach((n, i) => {
      const near = flat
        .map((m, j) => ({ j, d: j === i ? Infinity : (n.x - m.x) ** 2 + (n.y - m.y) ** 2 + (n.z - m.z) ** 2 }))
        .sort((a, b) => a.d - b.d).slice(0, 2);
      for (const { j } of near) {
        const key = Math.min(i, j) + ':' + Math.max(i, j);
        if (!seen.has(key)) { seen.add(key); edges.push([i, j]); }
      }
    });
    hud = { left: hudLeft || '', right: hudRight || '' };
  }

  /* rAF stops by itself in hidden tabs, that IS the suspend-on-hidden law;
   * no explicit check needed. draw() is separate so it can be tick()ed once
   * in tests without starting the loop. */
  function frame(now) {
    if (!canvas || !canvas.isConnected) return stop();
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function draw(now) {
    const p = palette();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // no layout yet (hidden tab, detached canvas): draw at the pixel size it has
    const w = canvas.clientWidth || canvas.width / dpr, h = canvas.clientHeight || canvas.height / dpr;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;
    const a = now * 0.00012;           // one revolution ≈ 50s: earth-slow
    const tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    const cosA = Math.cos(a), sinA = Math.sin(a);

    // core glow: a warm heart, breathing slowly
    const breathe = 0.85 + 0.15 * Math.sin(now * 0.0009);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15 * breathe);
    g.addColorStop(0, p.accent + 'aa');
    g.addColorStop(0.18, p.accent + '44');
    g.addColorStop(0.5, p.accent + '14');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

    // project every node once per frame
    const pts = nodes.map((n) => {
      const x = n.x * cosA + n.z * sinA;
      const z0 = -n.x * sinA + n.z * cosA;
      const y = n.y * ct - z0 * st;
      const z = n.y * st + z0 * ct;
      const s = 2.6 / (2.6 + z);        // light perspective
      return { sx: cx + x * R * s, sy: cy + y * R * s, z, s, n };
    });

    // edges first, faint, front links brighter
    ctx.lineWidth = 1;
    for (const [i, j] of edges) {
      const A = pts[i], B = pts[j];
      const zAvg = (A.z + B.z) / 2;
      const alpha = Math.max(0.04, 0.22 - zAvg * 0.14);
      ctx.strokeStyle = p.dim + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
    }

    // nodes: folders slightly larger, everything pulses on its own phase
    for (const q of pts) {
      const pulse = 0.55 + 0.45 * Math.sin(now * 0.0018 + q.n.phase);
      const alpha = Math.max(0.15, (0.9 - q.z * 0.5)) * pulse;
      const rad = (q.n.dirNode ? 2.4 : 1.5) * q.s;
      ctx.fillStyle = (q.n.depth === 0 ? p.ink : p.accent) + Math.round(Math.min(1, alpha) * 255).toString(16).padStart(2, '0');
      ctx.beginPath(); ctx.arc(q.sx, q.sy, rad, 0, Math.PI * 2); ctx.fill();
    }

    // honest HUD
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = p.dim;
    ctx.textAlign = 'left'; ctx.fillText(hud.left, 10, h - 10);
    ctx.textAlign = 'right'; ctx.fillText(hud.right, w - 10, h - 10);
  }

  function start(el, tree, hudLeft, hudRight) {
    stop();
    canvas = el; ctx = el.getContext('2d');
    build(tree, hudLeft, hudRight);
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; canvas = null; ctx = null;
  }

  return { start, stop, tick: (now) => { if (canvas) draw(now == null ? performance.now() : now); } };
})();
