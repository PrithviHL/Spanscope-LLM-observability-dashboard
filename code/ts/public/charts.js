// Small dependency-free SVG charts: stacked time bars, multi-line, horizontal bars.
// Each chart re-renders on container resize and ships a hover tooltip.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** "Nice" axis maximum and tick step for 0..max. */
function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** Rect with only the top corners rounded (data end), square at the baseline. */
function topRoundedRect(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Rect with only the right corners rounded (horizontal bar data end). */
function rightRoundedRect(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return "";
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export const fmtTime = (t) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function setupTooltip(container) {
  let tip = container.querySelector(".tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    container.appendChild(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.classList.add("show");
      const cw = container.clientWidth;
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > cw) left = x - tw - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y - 10)}px`;
    },
    hide() {
      tip.classList.remove("show");
    },
  };
}

function ttRow(color, label, value, line = false) {
  return `<div class="tt-row"><span class="swatch${line ? " line" : ""}" style="background:${color}"></span>${esc(label)}<b>${esc(value)}</b></div>`;
}

/** Re-render on width change. Returns a disposer. */
function responsive(container, render) {
  let lastW = 0;
  const run = () => {
    const w = Math.floor(container.clientWidth);
    if (w > 0 && w !== lastW) {
      lastW = w;
      render(w);
    }
  };
  const ro = new ResizeObserver(run);
  ro.observe(container);
  run();
  return () => ro.disconnect();
}

function emptyState(container, msg) {
  container.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

function yAxis(svg, m, w, h, scale, fmt) {
  const g = el("g", { class: "axis" }, svg);
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = m.top + h - (v / scale.max) * h;
    if (v > 0) el("line", { class: "gridline", x1: m.left, x2: m.left + w, y1: y, y2: y }, g);
    const t = el("text", { x: m.left - 8, y: y + 3.5, "text-anchor": "end" }, g);
    t.textContent = fmt(v);
  }
  el("line", { class: "baseline", x1: m.left, x2: m.left + w, y1: m.top + h, y2: m.top + h }, g);
}

function xTimeAxis(svg, m, w, h, data, xAt) {
  const g = el("g", { class: "axis" }, svg);
  const n = data.length;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 90))));
  for (let i = 0; i < n; i += every) {
    const t = el("text", { x: xAt(i), y: m.top + h + 18, "text-anchor": "middle" }, g);
    t.textContent = fmtTime(data[i].t);
  }
}

/**
 * Stacked vertical bars over time.
 * opts: { data: [{t, ...}], stacks: [{ key(d)->number, label, color }], height, yFormat, title(d) }
 */
export function stackedBars(container, opts) {
  const { data, stacks, height = 220, yFormat = (v) => String(v) } = opts;
  if (!data.length || data.every((d) => stacks.every((s) => s.value(d) === 0))) {
    emptyState(container, "No spans in this time range yet.");
    return () => {};
  }
  return responsive(container, (width) => {
    container.innerHTML = "";
    const tip = setupTooltip(container);
    const m = { top: 8, right: 8, bottom: 26, left: 40 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel || "" });
    container.prepend(svg);
    const totals = data.map((d) => stacks.reduce((a, s) => a + s.value(d), 0));
    const scale = niceScale(Math.max(...totals));
    yAxis(svg, m, w, h, scale, yFormat);
    const slot = w / data.length;
    const bw = Math.max(1, Math.min(18, slot - 2));
    const xAt = (i) => m.left + slot * i + slot / 2;
    xTimeAxis(svg, m, w, h, data, xAt);
    const bars = el("g", {}, svg);
    const GAP = 2; // surface gap between stacked segments
    data.forEach((d, i) => {
      let y = m.top + h;
      const segs = stacks.map((s) => ({ s, v: s.value(d) })).filter((x) => x.v > 0);
      segs.forEach((seg, k) => {
        const sh = (seg.v / scale.max) * h;
        const top = k === segs.length - 1;
        const gap = k > 0 ? GAP : 0;
        const x = xAt(i) - bw / 2;
        const segH = Math.max(0, sh - gap);
        const path = top
          ? topRoundedRect(x, y - sh, bw, segH, 3)
          : `M${x},${y - sh}h${bw}v${segH}h${-bw}Z`;
        if (path) el("path", { d: path, style: `fill:${seg.s.color}` }, bars);
        y -= sh;
      });
    });
    // full-column hit targets (bigger than the marks)
    const hits = el("g", {}, svg);
    const hover = el("rect", { x: 0, y: m.top, width: slot, height: h, style: "fill:var(--text-primary);opacity:0" }, svg);
    hover.style.pointerEvents = "none";
    svg.insertBefore(hover, bars);
    data.forEach((d, i) => {
      const r = el("rect", { x: m.left + slot * i, y: m.top, width: slot, height: h, fill: "transparent" }, hits);
      r.addEventListener("mouseenter", () => {
        hover.setAttribute("x", m.left + slot * i);
        hover.style.opacity = "0.05";
        const rows = stacks.map((s) => ttRow(s.color, s.label, s.format ? s.format(s.value(d)) : s.value(d))).join("");
        const extra = opts.extraRows ? opts.extraRows(d) : "";
        tip.show(`<div class="tt-title">${esc(opts.title ? opts.title(d) : fmtTime(d.t))}</div>${rows}${extra}`,
          (xAt(i) / width) * container.clientWidth, m.top);
      });
    });
    hits.addEventListener("mouseleave", () => {
      hover.style.opacity = "0";
      tip.hide();
    });
  });
}

/**
 * Multi-series line chart over time with crosshair + tooltip.
 * opts: { data, series: [{ value(d), label, color }], height, yFormat, valueFormat }
 */
export function lineChart(container, opts) {
  const { data, series, height = 220, yFormat = (v) => String(v), valueFormat = yFormat } = opts;
  const has = (d) => d.count > 0;
  if (!data.some(has)) {
    emptyState(container, "No spans in this time range yet.");
    return () => {};
  }
  return responsive(container, (width) => {
    container.innerHTML = "";
    const tip = setupTooltip(container);
    const m = { top: 10, right: 44, bottom: 26, left: 48 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel || "" });
    container.prepend(svg);
    const maxV = Math.max(...data.filter(has).flatMap((d) => series.map((s) => s.value(d))));
    const scale = niceScale(maxV);
    yAxis(svg, m, w, h, scale, yFormat);
    const step = data.length > 1 ? w / (data.length - 1) : 0;
    const xAt = (i) => m.left + step * i;
    const yAt = (v) => m.top + h - (v / scale.max) * h;
    xTimeAxis(svg, m, w, h, data, xAt);
    const cross = el("line", { class: "crosshair", y1: m.top, y2: m.top + h, x1: 0, x2: 0, opacity: 0 }, svg);
    const dots = [];
    series.forEach((s) => {
      // Break the line where a bucket has no data instead of drawing to zero.
      let d = "";
      let pen = false;
      let last = null;
      data.forEach((pt, i) => {
        if (!has(pt)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(s.value(pt)).toFixed(1)}`;
        pen = true;
        last = i;
      });
      el("path", { d, fill: "none", style: `stroke:${s.color}`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (last !== null) {
        const lx = xAt(last);
        const ly = yAt(s.value(data[last]));
        el("circle", { cx: lx, cy: ly, r: 3.5, style: `fill:${s.color};stroke:var(--surface-1)`, "stroke-width": 2 }, svg);
        s._endY = ly;
        s._endX = lx;
      }
      dots.push(el("circle", { r: 4.5, style: `fill:${s.color};stroke:var(--surface-1)`, "stroke-width": 2, opacity: 0 }, svg));
    });
    // direct end labels, nudged apart if they collide
    const labeled = series.filter((s) => s._endY !== undefined).sort((a, b) => a._endY - b._endY);
    for (let i = 1; i < labeled.length; i++) {
      if (labeled[i]._endY - labeled[i - 1]._endY < 13) labeled[i]._endY = labeled[i - 1]._endY + 13;
    }
    labeled.forEach((s) => {
      const t = el("text", { class: "end-label", x: s._endX + 8, y: s._endY + 4 }, svg);
      t.textContent = s.short || s.label;
    });
    const overlay = el("rect", { x: m.left, y: m.top, width: w, height: h, fill: "transparent" }, svg);
    overlay.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * width;
      const i = Math.max(0, Math.min(data.length - 1, Math.round((px - m.left) / (step || 1))));
      const pt = data[i];
      const x = xAt(i);
      cross.setAttribute("x1", x);
      cross.setAttribute("x2", x);
      cross.setAttribute("opacity", 1);
      series.forEach((s, k) => {
        if (has(pt)) {
          dots[k].setAttribute("cx", x);
          dots[k].setAttribute("cy", yAt(s.value(pt)));
          dots[k].setAttribute("opacity", 1);
        } else dots[k].setAttribute("opacity", 0);
      });
      const rows = has(pt)
        ? series.map((s) => ttRow(s.color, s.label, valueFormat(s.value(pt)), true)).join("") +
          `<div class="tt-row" style="color:var(--text-muted)">spans<b>${pt.count}</b></div>`
        : `<div class="tt-row" style="color:var(--text-muted)">no spans</div>`;
      tip.show(`<div class="tt-title">${esc(fmtTime(pt.t))}</div>${rows}`, (x / width) * container.clientWidth, m.top);
    });
    overlay.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", 0);
      dots.forEach((d) => d.setAttribute("opacity", 0));
      tip.hide();
    });
  });
}

/**
 * Horizontal bars, one hue, value labeled at the bar end.
 * opts: { items: [{ label, value, detail? }], color, format, rowHeight }
 */
export function hBars(container, opts) {
  const { items, color, format = (v) => String(v), rowHeight = 30 } = opts;
  if (!items.length) {
    emptyState(container, "No data yet.");
    return () => {};
  }
  return responsive(container, (width) => {
    container.innerHTML = "";
    const tip = setupTooltip(container);
    const labelW = Math.min(150, Math.max(90, width * 0.3));
    const valueW = 76;
    const m = { top: 4, right: valueW, bottom: 4, left: labelW };
    const height = m.top + m.bottom + items.length * rowHeight;
    const w = width - m.left - m.right;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel || "" });
    container.prepend(svg);
    const max = Math.max(...items.map((d) => d.value), 0) || 1;
    const bh = Math.min(16, rowHeight - 12);
    items.forEach((d, i) => {
      const yMid = m.top + i * rowHeight + rowHeight / 2;
      const lab = el("text", { class: "cat-label", x: m.left - 10, y: yMid + 4, "text-anchor": "end" }, svg);
      lab.textContent = d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label;
      const bw = Math.max(d.value > 0 ? 3 : 0, (d.value / max) * w);
      const p = rightRoundedRect(m.left, yMid - bh / 2, bw, bh, 4);
      if (p) el("path", { d: p, style: `fill:${color}` }, svg);
      const val = el("text", { class: "bar-label", x: m.left + bw + 8, y: yMid + 4 }, svg);
      val.textContent = format(d.value);
      const hit = el("rect", { x: 0, y: yMid - rowHeight / 2, width, height: rowHeight, fill: "transparent" }, svg);
      hit.addEventListener("mouseenter", () => {
        tip.show(
          `<div class="tt-title">${esc(d.label)}</div>${ttRow(color, opts.valueLabel || "value", format(d.value))}${d.detail || ""}`,
          ((m.left + bw) / width) * container.clientWidth,
          yMid - rowHeight / 2,
        );
      });
      hit.addEventListener("mouseleave", () => tip.hide());
    });
  });
}
