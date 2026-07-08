'use strict';
/* Brain graph: the project's knowledge base as an interactive 3D graph.
 * Force-laid-out once at build (no per-frame physics), then rendered like the
 * orb: slow auto-rotation, pulsing nodes, warm core. Interactive on top:
 * hover names a node, drag rotates by hand, click selects and hands the node
 * to app.js (which opens the note's content). Pure canvas, zero deps, same
 * perf laws as the orb: node caps, DPR ≤ 2, rAF suspends in hidden tabs. */

const BrainGraph = (() => {
  let raf = null, canvas = null, ctx = null, onClick = null;
  let nodes = [], links = [], hud = '';
  let yaw = 0, pitch = -0.25, dragging = false, lastX = 0, lastY = 0, lastDragAt = 0;
  let hovered = null, selected = null, pts = [];

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue('--accent').trim() || '#dcae54',
      dim: cs.getPropertyValue('--dim').trim() || '#8b95a5',
      ink: cs.getPropertyValue('--text').trim() || '#d3d9e3',
    };
  }

  /* One-shot 3D force layout: repulsion + springs + centering, cooled.
   * Runs at build time (≤180 nodes → a few million ops, tens of ms). */
  function layout() {
    const N = nodes.length;
    const GA = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach((n, i) => {
      const y = N > 1 ? 1 - (i / (N - 1)) * 2 : 0;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      n.x = Math.cos(GA * i) * r; n.y = y; n.z = Math.sin(GA * i) * r;
    });
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const L = links.map((l) => [idx.get(l.source), idx.get(l.target), l.kind]).filter((l) => l[0] != null && l[1] != null);
    const degArr = new Array(N).fill(0);
    for (const [i, j] of L) { degArr[i]++; degArr[j]++; }
    for (let iter = 0; iter < 140; iter++) {
      const heat = 1 - iter / 140;
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz + 0.02;
          const f = (0.03 * heat) / d2;
          dx *= f; dy *= f; dz *= f;
          a.x += dx; a.y += dy; a.z += dz;
          b.x -= dx; b.y -= dy; b.z -= dz;
        }
      }
      for (const [i, j, kind] of L) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
        const f = ((d - (kind === 'wiki' ? 0.75 : 0.5)) / d) * 0.025 * heat;
        // hubs barely move, leaves do the travelling: a heavily-linked note
        // pulled by every neighbour otherwise collapses the cluster on itself
        const wa = 1 / (1 + degArr[i] * 0.3), wb = 1 / (1 + degArr[j] * 0.3);
        a.x += dx * f * wa; a.y += dy * f * wa; a.z += dz * f * wa;
        b.x -= dx * f * wb; b.y -= dy * f * wb; b.z -= dz * f * wb;
      }
      // keep disconnected components in frame: recentre + gentle gravity
      let mx = 0, my = 0, mz = 0;
      for (const n of nodes) { mx += n.x; my += n.y; mz += n.z; }
      mx /= N; my /= N; mz /= N;
      for (const n of nodes) { n.x = (n.x - mx) * 0.998; n.y = (n.y - my) * 0.998; n.z = (n.z - mz) * 0.998; }
    }
    // normalise on a high percentile, not the max: one far outlier must not
    // squash the whole graph into the middle. Outliers clamp to the rim.
    const radii = nodes.map((n) => Math.hypot(n.x, n.y, n.z)).sort((a, b) => a - b);
    const scale = (radii[Math.floor(radii.length * 0.9)] || 0.001) + 1e-6;
    for (const n of nodes) {
      n.x /= scale; n.y /= scale; n.z /= scale;
      const r = Math.hypot(n.x, n.y, n.z);
      if (r > 1.25) { n.x *= 1.25 / r; n.y *= 1.25 / r; n.z *= 1.25 / r; }
    }
    const deg = new Map();
    for (const [i, j] of L) { deg.set(i, (deg.get(i) || 0) + 1); deg.set(j, (deg.get(j) || 0) + 1); }
    nodes.forEach((n, i) => { n.deg = deg.get(i) || 0; n.phase = (i * 2.399) % (Math.PI * 2); });
    links = L.map(([i, j, kind]) => ({ i, j, kind }));
  }

  function neighbors(i) {
    const set = new Set([i]);
    for (const l of links) { if (l.i === i) set.add(l.j); if (l.j === i) set.add(l.i); }
    return set;
  }

  function draw(now) {
    const p = palette();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // no layout yet (hidden tab, detached canvas): draw at the pixel size it has
    const w = canvas.clientWidth || canvas.width / dpr, h = canvas.clientHeight || canvas.height / dpr;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4;
    if (!dragging && now - lastDragAt > 2500) yaw += 0.0012; // auto-rotate resumes after the hand lets go
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, p.accent + '33');
    g.addColorStop(0.5, p.accent + '0d');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 1.1, cy - R * 1.1, R * 2.2, R * 2.2);

    pts = nodes.map((n, i) => {
      const x = n.x * cyaw + n.z * syaw;
      const z0 = -n.x * syaw + n.z * cyaw;
      const y = n.y * cp - z0 * sp;
      const z = n.y * sp + z0 * cp;
      const s = 2.6 / (2.6 + z);
      return { sx: cx + x * R * s, sy: cy + y * R * s, z, s, i };
    });

    const focus = selected != null ? neighbors(selected) : (hovered != null ? neighbors(hovered) : null);

    for (const l of links) {
      const A = pts[l.i], B = pts[l.j];
      const inFocus = focus && (focus.has(l.i) && focus.has(l.j));
      const zAvg = (A.z + B.z) / 2;
      let alpha = Math.max(0.04, (l.kind === 'wiki' ? 0.26 : 0.13) - zAvg * 0.1);
      if (focus) alpha = inFocus ? Math.min(0.75, alpha * 3.2) : alpha * 0.25;
      ctx.strokeStyle = (l.kind === 'wiki' ? p.accent : p.dim) + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.lineWidth = inFocus ? 1.4 : 1;
      ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
    }

    for (const q of pts) {
      const n = nodes[q.i];
      const pulse = 0.6 + 0.4 * Math.sin(now * 0.0018 + n.phase);
      let alpha = Math.max(0.15, 0.9 - q.z * 0.5) * pulse;
      if (focus) alpha = focus.has(q.i) ? Math.min(1, alpha * 1.6) : alpha * 0.3;
      const rad = (n.dir ? 2.6 : 1.6 + Math.min(2.2, n.deg * 0.18)) * q.s * (q.i === selected || q.i === hovered ? 1.7 : 1);
      ctx.fillStyle = (n.dir ? p.ink : p.accent) + Math.round(Math.min(1, alpha) * 255).toString(16).padStart(2, '0');
      ctx.beginPath(); ctx.arc(q.sx, q.sy, rad, 0, Math.PI * 2); ctx.fill();
    }

    // labels: only what the eye is asking about (hovered, selected, its neighbours)
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    const labeled = new Set();
    if (hovered != null) labeled.add(hovered);
    if (selected != null) { labeled.add(selected); let k = 0; for (const nb of neighbors(selected)) { if (k++ > 10) break; labeled.add(nb); } }
    for (const i of labeled) {
      const q = pts[i];
      ctx.fillStyle = i === selected || i === hovered ? p.ink : p.dim;
      ctx.fillText(nodes[i].name.slice(0, 28), q.sx + 6, q.sy - 5);
    }

    ctx.fillStyle = p.dim;
    ctx.textAlign = 'left'; ctx.fillText(hud, 10, h - 10);
    ctx.textAlign = 'right'; ctx.fillText(selected != null ? 'click empty space to release' : 'drag to turn · click a light to read it', w - 10, h - 10);
  }

  function frame(now) {
    if (!canvas || !canvas.isConnected) return stop();
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function hit(ev) {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bd = 100; // 10px radius
    for (const q of pts) {
      const d = (q.sx - x) ** 2 + (q.sy - y) ** 2;
      if (d < bd) { bd = d; best = q.i; }
    }
    return best;
  }

  function onDown(ev) { dragging = false; lastX = ev.clientX; lastY = ev.clientY; canvas.setPointerCapture(ev.pointerId); canvas.onpointermove = onMoveDrag; }
  function onMoveDrag(ev) {
    if (Math.abs(ev.clientX - lastX) + Math.abs(ev.clientY - lastY) > 3) dragging = true;
    if (!dragging) return;
    yaw += (ev.clientX - lastX) * 0.006;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (ev.clientY - lastY) * 0.006));
    lastX = ev.clientX; lastY = ev.clientY; lastDragAt = performance.now();
  }
  function onUp(ev) {
    canvas.onpointermove = onMoveHover;
    if (dragging) { dragging = false; lastDragAt = performance.now(); return; }
    const i = hit(ev);
    selected = i;
    if (i != null && onClick) onClick(nodes[i]);
  }
  function onMoveHover(ev) {
    hovered = hit(ev);
    canvas.style.cursor = hovered != null ? 'pointer' : 'grab';
  }

  function start(el, graph, hudText, clickCb) {
    stop();
    canvas = el; ctx = el.getContext('2d'); onClick = clickCb || null;
    nodes = graph.nodes.map((n) => ({ ...n }));
    links = graph.links;
    hud = hudText || '';
    hovered = null; selected = null; yaw = 0; pitch = -0.25;
    layout();
    canvas.onpointerdown = onDown;
    canvas.onpointerup = onUp;
    canvas.onpointermove = onMoveHover;
    canvas.onpointerleave = () => { hovered = null; };
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; canvas = null; ctx = null; pts = [];
  }

  return { start, stop, tick: (now) => { if (canvas) draw(now == null ? performance.now() : now); } };
})();
