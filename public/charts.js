'use strict';
/* Charts: the zero-dependency line-chart engine for the spend dashboard.
 * Canvas, DPR-aware, theme-aware (colors read from CSS variables at draw
 * time), with a hover crosshair and a per-series tooltip - the "point at a
 * spot, read the exact numbers" grammar. Every number drawn here arrived in
 * the board payload; nothing is interpolated or invented. */

const Charts = (() => {
  const active = new Set(); // { canvas, off } for cleanup on re-render

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* Series palette: gold first (the accent), then hues tuned to read on both
   * themes. "Other" always renders dim. */
  function palette() {
    return [cssVar('--accent') || '#dcae54', '#5cbd8f', '#7ba7d9', '#c98bc9', '#d9a37b', '#8b95a5'];
  }

  function stop() {
    for (const a of active) a.off();
    active.clear();
  }

  /**
   * Multi-series line chart with hover tooltip.
   * el: canvas. opts:
   *   labels: string[] (x categories, e.g. days as "MM-DD")
   *   series: [{ name, values: number[], color?, dashed? }]
   *   fmt: (v) => string for tooltip/axis values
   *   tipEl: shared tooltip div
   *   fill: index of one series to area-fill (usually 0), or -1
   */
  function line(el, opts) {
    const { labels, series, fmt, tipEl } = opts;
    if (!el || !labels.length || !series.length) return;
    const colors = palette();
    series.forEach((s, i) => { if (!s.color) s.color = s.name === 'other' ? colors[colors.length - 1] : colors[i % (colors.length - 1)]; });

    const draw = (hoverIx) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      if (el.width !== w * dpr) { el.width = w * dpr; el.height = h * dpr; }
      const x = el.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);

      const line = cssVar('--line'), dim = cssVar('--dim'), mono = '10px ' + (cssVar('--font-mono') || 'monospace');
      const max = Math.max(...series.flatMap((s) => s.values), 1e-9);
      const padL = 8 + String(fmt(max)).length * 5.4, padR = 10, padT = 8, padB = 18;
      const iw = w - padL - padR, ih = h - padT - padB;
      const X = (i) => padL + (labels.length === 1 ? iw / 2 : i / (labels.length - 1) * iw);
      const Y = (v) => padT + ih - (v / max) * ih;

      // gridlines + y labels (0, mid, max): the axis the sparkline never had
      x.strokeStyle = line; x.fillStyle = dim; x.font = mono; x.textAlign = 'right'; x.textBaseline = 'middle';
      for (const gv of [0, max / 2, max]) {
        const gy = Y(gv);
        x.globalAlpha = 0.6; x.beginPath(); x.moveTo(padL, gy); x.lineTo(w - padR, gy); x.stroke(); x.globalAlpha = 1;
        x.fillText(fmt(gv), padL - 5, gy);
      }
      // x labels: first, middle, last (crowding kills legibility)
      x.textAlign = 'center'; x.textBaseline = 'top';
      for (const i of [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])]) {
        x.fillText(labels[i], X(i), padT + ih + 5);
      }

      // series lines (+ optional area fill on the first)
      series.forEach((s, si) => {
        x.strokeStyle = s.color; x.lineWidth = 1.7; x.lineJoin = 'round';
        if (s.dashed) x.setLineDash([4, 3]);
        x.beginPath();
        s.values.forEach((v, i) => { const px = X(i), py = Y(v); i ? x.lineTo(px, py) : x.moveTo(px, py); });
        x.stroke(); x.setLineDash([]);
        if (si === (opts.fill == null ? 0 : opts.fill)) {
          x.globalAlpha = 0.08; x.fillStyle = s.color;
          x.lineTo(X(s.values.length - 1), Y(0)); x.lineTo(X(0), Y(0)); x.closePath(); x.fill(); x.globalAlpha = 1;
        }
      });

      // hover crosshair + points
      if (hoverIx != null) {
        const hx = X(hoverIx);
        x.strokeStyle = dim; x.globalAlpha = 0.5; x.setLineDash([3, 3]);
        x.beginPath(); x.moveTo(hx, padT); x.lineTo(hx, padT + ih); x.stroke();
        x.setLineDash([]); x.globalAlpha = 1;
        for (const s of series) {
          x.fillStyle = s.color; x.beginPath(); x.arc(hx, Y(s.values[hoverIx]), 3, 0, 7); x.fill();
        }
      }
      return { padL, padR, iw };
    };

    let geo = draw(null);
    const onMove = (ev) => {
      const r = el.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      geo = geo || draw(null);
      if (!geo) return;
      const ix = Math.max(0, Math.min(labels.length - 1, Math.round((mx - geo.padL) / Math.max(geo.iw, 1) * (labels.length - 1))));
      draw(ix);
      if (tipEl) {
        const rows = [...series]
          .sort((a, b) => b.values[ix] - a.values[ix])
          .map((s) => `<div class="tip-row"><i style="background:${s.color}"></i><span>${s.name}</span><b>${fmt(s.values[ix])}</b></div>`)
          .join('');
        tipEl.innerHTML = `<div class="tip-head">${opts.tipTitle ? opts.tipTitle + ' · ' : ''}${labels[ix]}</div>${rows}`;
        tipEl.hidden = false;
        const tw = tipEl.offsetWidth;
        const px = ev.clientX + 14 + tw > innerWidth ? ev.clientX - tw - 12 : ev.clientX + 14;
        tipEl.style.left = px + 'px';
        tipEl.style.top = Math.min(ev.clientY + 12, innerHeight - tipEl.offsetHeight - 8) + 'px';
      }
    };
    const onLeave = () => { draw(null); if (tipEl) tipEl.hidden = true; };
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    active.add({ canvas: el, off: () => { el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave); } });
  }

  return { line, stop, palette };
})();
