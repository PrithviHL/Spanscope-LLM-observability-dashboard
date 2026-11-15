import { stackedBars, lineChart, hBars, sparkline, fmtTime } from "./charts.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmtInt = (n) => Math.round(Number(n || 0)).toLocaleString();
const fmtUsd = (n) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const fmtPct = (r) => `${(r * 100).toFixed(r && r < 0.01 ? 2 : 1)}%`;
const shortId = (id) => (id ? `${id.slice(0, 8)}…` : "");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const REPO_URL = "https://github.com/PrithviHL/Spanscope-LLM-observability-dashboard";

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable (private mode): preference just isn't saved */
    }
  },
};

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

// Feather-style line icons, inlined so the app has no icon dependency.
const svgIcon = (d, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  activity: svgIcon('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  alert: svgIcon(
    '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  ),
  coin: svgIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
  ),
  clock: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  grid: svgIcon(
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  ),
  layers: svgIcon(
    '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  ),
  list: svgIcon('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  send: svgIcon('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>'),
  zap: svgIcon('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'),
  moon: svgIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  pause: svgIcon(
    '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  ),
  play: svgIcon('<path d="M6 4l14 8-14 8V4z"/>'),
  github: svgIcon(
    '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.4 6.4-1.5 6.4-7A5.4 5.4 0 0 0 20 4.8 5 5 0 0 0 19.9 1S18.7.7 16 2.5a13.4 13.4 0 0 0-7 0C6.3.7 5.1 1 5.1 1a5 5 0 0 0-.1 3.8A5.4 5.4 0 0 0 3.5 8.5c0 5.4 3.3 6.6 6.4 7a3.4 3.4 0 0 0-.9 2.6V22"/>',
  ),
  search: svgIcon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  sparkle: svgIcon('<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>'),
  copy: svgIcon(
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    13,
  ),
  check: svgIcon('<path d="M20 6L9 17l-5-5"/>', 14),
  x: svgIcon('<path d="M18 6L6 18M6 6l12 12"/>', 14),
};

function toast(msg, kind = "ok") {
  const t = $("#toast");
  const icon = kind === "err" ? ICON.x : kind === "warn" ? ICON.zap : ICON.check;
  t.innerHTML = `${icon}<span>${esc(msg)}</span>`;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

function statusBadge(s) {
  return s === "ERROR"
    ? `<span class="status err"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.8"/></svg>Error</span>`
    : `<span class="status ok"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2l2.3 2.3L8.5 2.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>OK</span>`;
}

// Provider identity: categorical slots 1-3 (validated all-pairs), always beside a text label.
const PROVIDER_VAR = { openai: "--series-1", anthropic: "--series-2", google: "--series-3" };
const providerOf = (model = "") =>
  /^(gpt|o\d)/.test(model)
    ? "openai"
    : model.startsWith("claude")
      ? "anthropic"
      : model.startsWith("gemini")
        ? "google"
        : "other";
const providerDot = (p) =>
  `<span class="dot" style="background:var(${PROVIDER_VAR[p] || "--text-muted"})" title="${esc(p)}"></span>`;
const modelCell = (model, system) =>
  `<span class="model-cell">${providerDot(system || providerOf(model))}${esc(model)}</span>`;

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 5
    ? "just now"
    : s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : `${Math.floor(s / 3600)}h ago`;
};

/** Animate a number from its previous value to `to`. */
function countUp(node, to, fmt, instant) {
  const prev = Number(node.dataset.v);
  const from = Number.isFinite(prev) ? prev : 0; // first paint counts up from zero
  node.dataset.v = String(to);
  cancelAnimationFrame(node._raf);
  if (instant || reducedMotion || from === to) {
    node.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const dur = from === 0 ? 1000 : 650;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (k < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}

function highlightJson(obj) {
  return esc(JSON.stringify(obj, null, 2)).replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?)\b/g,
    (_m, str, colon, num) =>
      str
        ? colon
          ? `<span class="k">${str}</span>${colon}`
          : `<span class="s">${str}</span>`
        : `<span class="n">${num}</span>`,
  );
}

const hex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [route, qs] = raw.split("?");
  return { route: route || "overview", params: new URLSearchParams(qs || "") };
}

function setHashParams(route, params) {
  const qs = params.toString();
  history.replaceState(null, "", `#/${route}${qs ? `?${qs}` : ""}`);
}

/** Sliding highlight behind the pressed button of a segmented control. */
function segPill(seg) {
  let pill = seg.querySelector(".seg-pill");
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "seg-pill";
    pill.setAttribute("aria-hidden", "true");
    seg.prepend(pill);
  }
  const b = seg.querySelector('[aria-pressed="true"]');
  if (!b) return;
  pill.style.width = `${b.offsetWidth}px`;
  pill.style.transform = `translateX(${b.offsetLeft}px)`;
}

function moveNavPill() {
  const a = $('.nav a[aria-current="page"]');
  const pill = $(".nav-pill");
  if (!a) {
    pill.style.opacity = "0";
    return;
  }
  pill.style.width = `${a.offsetWidth}px`;
  pill.style.transform = `translateX(${a.offsetLeft}px)`;
  pill.style.opacity = "1";
}
const relayout = () => {
  moveNavPill();
  document.querySelectorAll(".seg").forEach(segPill);
};
addEventListener("resize", relayout);
document.fonts?.ready.then(relayout);

/** Staggered entrance for the page's top-level blocks (cards inside grids individually). */
function revealIn(view) {
  let i = 0;
  const add = (n) => {
    n.classList.add("reveal");
    n.style.setProperty("--i", String(i++));
    n.addEventListener("animationend", () => n.classList.remove("reveal"), { once: true });
  };
  for (const c of view.children) {
    if (c.classList.contains("grid")) [...c.children].forEach(add);
    else add(c);
  }
}

// ---------------------------------------------------------------------------
// sign-in (GitHub). Viewing is public; actions need a signed-in user when the
// server has sign-in enabled.
// ---------------------------------------------------------------------------

const session = { authEnabled: false, user: null };
const canWrite = () => !session.authEnabled || !!session.user;

function signIn() {
  location.href = `/auth/github/login?next=${encodeURIComponent(`/${location.hash}`)}`;
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST" }).catch(() => {});
  session.user = null;
  renderAccount();
  toast("Signed out");
  route();
}

/** Label for a gated action button: the action itself, or a sign-in prompt. */
const actionLabel = (icon, label, gated = `Sign in to ${label.toLowerCase()}`) =>
  canWrite() ? `${icon}${label}` : `${ICON.github}${gated}`;

function renderAccount() {
  const box = $("#account");
  if (!session.authEnabled) {
    box.innerHTML = "";
    return;
  }
  if (!session.user) {
    box.innerHTML = `<button class="btn gh-btn" id="signin">${ICON.github}<span>Sign in</span></button>`;
    $("#signin").addEventListener("click", signIn);
    return;
  }
  const u = session.user;
  const avatar = u.avatar
    ? `<img src="${esc(u.avatar)}" alt="" width="24" height="24" referrerpolicy="no-referrer">`
    : `<span class="avatar-fallback">${esc(u.login.slice(0, 1).toUpperCase())}</span>`;
  box.innerHTML = `
    <button class="account-btn" id="account-btn" aria-haspopup="menu" aria-expanded="false" title="Signed in as @${esc(u.login)}">${avatar}<span class="account-name">${esc(u.login)}</span></button>
    <div class="account-menu" id="account-menu" role="menu" hidden>
      <div class="account-who"><b>${esc(u.name)}</b><span>@${esc(u.login)}</span></div>
      <a role="menuitem" href="#/send">${ICON.send}Ingest key &amp; send data</a>
      <button role="menuitem" id="signout">${ICON.x}Sign out</button>
    </div>`;
  const btn = $("#account-btn");
  const menu = $("#account-menu");
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#account")) setOpen(false);
  });
  $("#signout").addEventListener("click", signOut);
}

// ---------------------------------------------------------------------------
// live polling, theme, incident simulation
// ---------------------------------------------------------------------------

const live = {
  paused: store.get("obs-paused", "0") === "1",
  timer: null,
  refresh: null,
  start(fn) {
    this.refresh = fn;
    this.schedule();
  },
  schedule() {
    clearInterval(this.timer);
    if (!this.paused && this.refresh) {
      this.timer = setInterval(() => {
        if (!document.hidden) this.refresh().catch(() => {});
      }, 5000);
    }
    this.render();
  },
  render(error) {
    const box = $("#live");
    box.classList.toggle("paused", this.paused);
    box.classList.toggle("error", !!error);
    $("#live-text").textContent = error ? "Offline" : this.paused ? "Paused" : "Live";
    const btn = $("#pause");
    btn.title = this.paused ? "Resume live updates" : "Pause live updates";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = this.paused ? ICON.play : ICON.pause;
  },
};

function togglePause() {
  live.paused = !live.paused;
  store.set("obs-paused", live.paused ? "1" : "0");
  live.schedule();
  if (!live.paused && live.refresh) live.refresh().catch(() => {});
  toast(live.paused ? "Live updates paused" : "Live updates resumed");
}
$("#pause").addEventListener("click", togglePause);

/** Re-render without entrance animations (theme switch). */
let quiet = false;

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const apply = () => {
    root.dataset.theme = isDark ? "light" : "dark";
    store.set("obs-theme", root.dataset.theme);
    quiet = true;
    return route().finally(() => (quiet = false)); // charts read colors from CSS variables
  };
  if (!document.startViewTransition || reducedMotion) return apply();
  const r = $("#theme").getBoundingClientRect();
  root.style.setProperty("--vt-x", `${r.left + r.width / 2}px`);
  root.style.setProperty("--vt-y", `${r.top + r.height / 2}px`);
  document.startViewTransition(apply);
}
$("#theme").addEventListener("click", toggleTheme);

const INCIDENT_MODELS = [
  "gpt-4o-mini",
  "gpt-5.4",
  "claude-3-5-sonnet",
  "claude-opus-4-7",
  "gemini-2-5-pro",
];

/** Inject a burst of slow, failing calls on one model so every chart reacts. */
async function simulateIncident(btn) {
  if (!canWrite()) return signIn();
  const model = INCIDENT_MODELS[Math.floor(Math.random() * INCIDENT_MODELS.length)];
  const system = providerOf(model);
  const now = Date.now();
  const spans = Array.from({ length: 150 }, () =>
    makeSpan({
      system,
      model,
      latencyMs: Math.round(2600 + Math.random() * 5200),
      inputTokens: 800 + Math.floor(Math.random() * 3000),
      outputTokens: 100 + Math.floor(Math.random() * 600),
      error: Math.random() < 0.45,
      endMs: now - Math.random() * 100_000,
    }),
  );
  if (btn) btn.disabled = true;
  try {
    await api("/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spans),
    });
    toast(`Incident injected on ${model}. Watch errors and p95 latency spike.`, "warn");
    if (parseHash().route !== "overview") location.hash = "#/overview";
    else if (live.refresh) await live.refresh().catch(() => {});
  } catch (e) {
    toast(`Couldn't inject the incident: ${e.message}`, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// drawer (span / trace detail)
// ---------------------------------------------------------------------------

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-backdrop").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);

const copyBtn = (value, label) =>
  `<button class="copy-btn" data-copy-value="${esc(value)}" title="Copy ${esc(label)}" aria-label="Copy ${esc(label)}">${ICON.copy}</button>`;

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy-value]");
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copyValue);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't copy. Select the text instead.", "err");
  }
});

async function openSpan(span) {
  $("#drawer-title").textContent = span.name || "Span";
  $("#drawer-body").innerHTML =
    `<div class="empty"><span class="skel" style="width:60%"></span></div>`;
  $("#drawer").classList.add("open");
  $("#drawer-backdrop").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  let trace = [span];
  try {
    trace = (await api(`/api/traces/${encodeURIComponent(span.trace_id)}`)).spans;
  } catch {
    // trace lookup failed: fall back to showing just this span
  }
  const a = span.attributes || {};
  const t0 = Math.min(...trace.map((s) => s.start_time_unix_nano));
  const t1 = Math.max(...trace.map((s) => s.end_time_unix_nano));
  const total = Math.max(1, t1 - t0);
  const wf = trace
    .map((s) => {
      const left = ((s.start_time_unix_nano - t0) / total) * 100;
      const width = ((s.end_time_unix_nano - s.start_time_unix_nano) / total) * 100;
      return `<div class="wf-row${s.span_id === span.span_id ? " current" : ""}">
        <span class="wf-name" title="${esc(s.name)}">${esc(s.name)} <span style="color:var(--text-muted)">${esc(s.model)}</span></span>
        <span class="wf-track"><span class="wf-bar${s.status === "ERROR" ? " err" : ""}" style="left:${left}%;width:${width}%"></span></span>
        <span class="mono" style="text-align:right">${fmtMs(s.latency_ms)}</span>
      </div>`;
    })
    .join("");
  const tokIn = a["gen_ai.usage.input_tokens"];
  const tokOut = a["gen_ai.usage.output_tokens"];
  $("#drawer-body").innerHTML = `
    <div class="drawer-stats">
      <div><span>Latency</span><b>${fmtMs(span.latency_ms)}</b></div>
      <div><span>Tokens</span><b>${fmtInt((tokIn || 0) + (tokOut || 0))}</b></div>
      <div><span>Cost</span><b>${fmtUsd(span.cost_usd)}</b></div>
    </div>
    <dl class="kv">
      <dt>Status</dt><dd>${statusBadge(span.status)}</dd>
      <dt>Model</dt><dd>${modelCell(span.model, a["gen_ai.system"])}</dd>
      <dt>Operation</dt><dd>${esc(a["gen_ai.operation.name"])}</dd>
      <dt>Tokens in / out</dt><dd>${fmtInt(tokIn)} / ${fmtInt(tokOut)}</dd>
      <dt>Ended</dt><dd>${esc(new Date(span.end_time_unix_nano / 1e6).toLocaleString())}</dd>
      <dt>Trace ID</dt><dd><span class="mono">${esc(span.trace_id)}</span>${copyBtn(span.trace_id, "trace ID")}</dd>
      <dt>Span ID</dt><dd><span class="mono">${esc(span.span_id)}</span>${copyBtn(span.span_id, "span ID")}</dd>
      ${span.parent_span_id ? `<dt>Parent span</dt><dd class="mono">${esc(span.parent_span_id)}</dd>` : ""}
    </dl>
    <div class="section-title">Trace waterfall · ${trace.length} span${trace.length === 1 ? "" : "s"}</div>
    <div class="waterfall">${wf}</div>
    <div class="section-title">Attributes</div>
    <pre class="json">${highlightJson(a)}</pre>`;
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

const WINDOWS = [
  ["15m", "15 min"],
  ["1h", "1 hour"],
  ["6h", "6 hours"],
  ["24h", "24 hours"],
];

const KPIS = [
  {
    id: "req",
    label: "Requests",
    icon: ICON.activity,
    color: "--series-1",
    value: (s) => s.spans,
    fmt: fmtInt,
    hint: (s, mins) => `${(s.spans / mins).toFixed(1)} per minute`,
    spark: (d) => d.count,
  },
  {
    id: "err",
    label: "Error rate",
    icon: ICON.alert,
    color: "--critical",
    value: (s) => s.errorRate,
    fmt: fmtPct,
    hint: (s) => `${fmtInt(s.errors)} failed span${s.errors === 1 ? "" : "s"}`,
    // Rolling 5-bucket rate, so isolated failures don't read as spikes.
    spark: (_d, i, all) => {
      const win = all.slice(Math.max(0, i - 4), i + 1);
      const n = win.reduce((t, x) => t + x.count, 0);
      return n ? win.reduce((t, x) => t + x.errors, 0) / n : null;
    },
    bad: (s) => s.errorRate > 0.05,
  },
  {
    id: "cost",
    label: "Spend",
    icon: ICON.coin,
    color: "--series-1",
    value: (s) => s.costUsd,
    fmt: fmtUsd,
    hint: (s) => `${fmtInt(s.inputTokens + s.outputTokens)} tokens`,
    spark: (d) => d.costUsd,
  },
  {
    id: "p95",
    label: "p95 latency",
    icon: ICON.clock,
    color: "--series-2",
    value: (s) => s.p95LatencyMs,
    fmt: fmtMs,
    hint: (s) => `p50 ${fmtMs(s.p50LatencyMs)}`,
    spark: (d) => (d.count ? d.p95LatencyMs : null),
  },
];

const heroHtml = () => `
  <section class="card hero" id="hero">
    <button class="icon-btn hero-close" id="hero-close" aria-label="Dismiss introduction" title="Dismiss">${ICON.x}</button>
    <div>
      <span class="eyebrow"><span class="live-dot"></span>Live demo · streaming now</span>
      <h1>See inside every <span class="gradient-text">LLM call</span>.</h1>
      <p>Spanscope turns OpenTelemetry traces from AI apps into live latency, error and cost insight for every model. New requests arrive every few seconds. Go ahead and break something.</p>
      <div class="hero-actions">
        <button class="btn primary lg" id="hero-incident">${actionLabel(ICON.zap, "Simulate an incident")}</button>
        <a class="btn lg" href="#/traces">${ICON.list}Explore traces</a>
        <span class="hero-hint">or press <kbd>${isMac ? "⌘" : "Ctrl "}K</kbd> for everything</span>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="art-title"><span>trace · chat_turn</span><span>2.41 s</span></div>
      ${[
        ["retrieve", 0, 20, ""],
        ["embed", 3, 12, ""],
        ["gpt-5.4", 21, 58, ""],
        ["guardrail", 80, 9, "err"],
        ["eval.faith", 82, 17, ""],
      ]
        .map(
          ([n, l, w, c], i) =>
            `<div class="art-row"><span>${n}</span><span class="art-track"><span class="art-bar ${c}" style="left:${l}%;width:${w}%;animation-delay:${i * 0.18}s"></span></span></div>`,
        )
        .join("")}
    </div>
  </section>`;

async function pageOverview(view) {
  let windowKey = store.get("obs-window", "1h");
  const showHero = store.get("obs-hero", "1") !== "0";
  view.innerHTML = `
    ${showHero ? heroHtml() : ""}
    <div class="page-head">
      <div><h1>Overview</h1><p>Traffic, errors, latency and spend across every model.</p></div>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Time range">
        ${WINDOWS.map(([k, l]) => `<button data-w="${k}" aria-pressed="${k === windowKey}">${l}</button>`).join("")}
      </div>
    </div>
    <div class="grid kpis">
      ${KPIS.map(
        (k) => `<div class="card card-pad kpi lift" id="kpi-${k.id}">
          <div class="kpi-top"><span class="kpi-icon" style="color:var(${k.color});background:color-mix(in srgb, var(${k.color}) 13%, transparent)">${k.icon}</span><span class="label">${k.label}</span></div>
          <div class="value"><span class="skel" style="width:60%;height:22px"></span></div>
          <div class="hint">&nbsp;</div>
          <div class="spark"></div>
        </div>`,
      ).join("")}
    </div>
    <div class="grid charts">
      <section class="card card-pad span-2">
        <div class="card-head">
          <div><h2>Requests</h2><div class="sub" id="req-sub">&nbsp;</div></div>
          <span class="spacer"></span>
          <div class="legend">
            <span><i class="swatch" style="background:var(--series-1)"></i>Successful</span>
            <span><i class="swatch" style="background:var(--critical)"></i>Errors</span>
          </div>
        </div>
        <div class="chart" id="c-req"><div class="skel" style="height:200px"></div></div>
      </section>
      <section class="card card-pad">
        <div class="card-head">
          <div><h2>Live stream</h2><div class="sub">Newest requests as they land</div></div>
          <span class="spacer"></span>
          <a href="#/traces" class="notice">All traces →</a>
        </div>
        <ul class="stream" id="stream">${'<li><span class="skel"></span></li>'.repeat(6)}</ul>
      </section>
      <section class="card card-pad span-2">
        <div class="card-head">
          <div><h2>Latency</h2><div class="sub">Per time bucket, all models</div></div>
          <span class="spacer"></span>
          <div class="legend">
            <span><i class="swatch line" style="background:var(--series-1)"></i>p50</span>
            <span><i class="swatch line" style="background:var(--series-2)"></i>p95</span>
          </div>
        </div>
        <div class="chart" id="c-lat"><div class="skel" style="height:200px"></div></div>
      </section>
      <section class="card card-pad">
        <div class="card-head">
          <div><h2>Cost by model</h2><div class="sub">USD in the selected range</div></div>
          <span class="spacer"></span>
          <a href="#/models" class="notice">Table view →</a>
        </div>
        <div class="chart" id="c-cost"></div>
      </section>
    </div>`;
  if (!quiet) revealIn(view);

  if (showHero) {
    $("#hero-close").addEventListener("click", () => {
      store.set("obs-hero", "0");
      const hero = $("#hero");
      hero.style.transition = "opacity .25s, transform .25s";
      hero.style.opacity = "0";
      hero.style.transform = "translateY(-6px)";
      setTimeout(() => hero.remove(), reducedMotion ? 0 : 250);
    });
    $("#hero-incident").addEventListener("click", (e) => simulateIncident(e.currentTarget));
  }

  const seg = $(".seg", view);
  segPill(seg);
  seg.querySelectorAll("[data-w]").forEach((b) =>
    b.addEventListener("click", () => {
      windowKey = b.dataset.w;
      store.set("obs-window", windowKey);
      seg
        .querySelectorAll("[data-w]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      segPill(seg);
      last = "";
      animateNext = true;
      refresh();
    }),
  );

  // live stream
  const seen = new Set();
  let streamItems = [];
  let streamPrimed = false;
  const renderStream = (items) => {
    const ul = $("#stream");
    if (!ul) return;
    ul.innerHTML = items.length
      ? items
          .map((s, i) => {
            const fresh = streamPrimed && !seen.has(s.span_id);
            const a = s.attributes || {};
            const tok =
              (a["gen_ai.usage.input_tokens"] || 0) + (a["gen_ai.usage.output_tokens"] || 0);
            return `<li class="${fresh ? "new" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="Open ${esc(s.model)} span">
              ${providerDot(a["gen_ai.system"] || providerOf(s.model))}
              <div style="min-width:0"><div class="s-model">${esc(s.model)}</div><div class="s-meta">${esc(ago(s.end_time_unix_nano / 1e6))} · ${fmtInt(tok)} tok</div></div>
              <div class="s-right">${fmtMs(s.latency_ms)}<span class="s-meta">${s.status === "ERROR" ? '<span style="color:var(--critical-ink);font-weight:600">failed</span>' : fmtUsd(s.cost_usd)}</span></div>
            </li>`;
          })
          .join("")
      : `<li class="empty" style="cursor:default">Waiting for spans…</li>`;
    items.forEach((s) => seen.add(s.span_id));
    streamItems = items;
    streamPrimed = true;
  };
  const openFromStream = (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) openSpan(streamItems[Number(li.dataset.i)]);
  };
  $("#stream").addEventListener("click", openFromStream);
  $("#stream").addEventListener("keydown", (e) => e.key === "Enter" && openFromStream(e));

  let last = "";
  let disposers = [];
  let sparkDisposers = [];
  let animateNext = !quiet;
  let kpiPrimed = false;
  async function refresh() {
    let data;
    let latest;
    try {
      [data, latest] = await Promise.all([
        api(`/api/overview?window=${windowKey}`),
        api("/api/spans?limit=7").catch(() => null),
      ]);
      live.render(false);
    } catch (e) {
      live.render(true);
      throw e;
    }
    if (latest) renderStream(latest.items);
    const key = JSON.stringify([data.summary, data.series, data.models]);
    if (key === last) return; // nothing changed: keep hover state intact
    last = key;
    const s = data.summary;
    const mins = data.windowMs / 60000;

    sparkDisposers.forEach((d) => d());
    sparkDisposers = KPIS.map((k) => {
      const card = $(`#kpi-${k.id}`);
      const v = $(".value", card);
      if (!kpiPrimed) v.textContent = "";
      countUp(v, k.value(s), k.fmt, quiet);
      v.classList.toggle("bad", !!k.bad?.(s));
      $(".hint", card).textContent = k.hint(s, mins);
      return sparkline($(".spark", card), data.series.map(k.spark), css(k.color), {
        animate: animateNext,
      });
    });
    kpiPrimed = true;

    const bucketMin = data.series.length > 1 ? (data.series[1].t - data.series[0].t) / 60000 : 1;
    $("#req-sub").textContent =
      `Spans per ${bucketMin >= 1 ? `${+bucketMin.toFixed(1)}-minute` : `${Math.round(bucketMin * 60)}-second`} bucket · hover for detail`;

    disposers.forEach((d) => d());
    const blue = css("--series-1");
    const orange = css("--series-2");
    const red = css("--critical");
    const animate = animateNext;
    animateNext = false;
    disposers = [
      stackedBars($("#c-req"), {
        data: data.series,
        animate,
        ariaLabel: "Requests over time, successful and errors",
        stacks: [
          { label: "Successful", color: blue, value: (d) => d.count - d.errors },
          { label: "Errors", color: red, value: (d) => d.errors },
        ],
        yFormat: (v) => fmtInt(v),
        extraRows: (d) =>
          `<div class="tt-row" style="color:var(--text-muted)">cost<b>${fmtUsd(d.costUsd)}</b></div>`,
        title: (d) => `${fmtTime(d.t)} – ${fmtTime(d.t + bucketMin * 60000)}`,
      }),
      lineChart($("#c-lat"), {
        data: data.series,
        animate,
        ariaLabel: "p50 and p95 latency over time",
        series: [
          { label: "p50", color: blue, value: (d) => d.p50LatencyMs },
          { label: "p95", color: orange, value: (d) => d.p95LatencyMs },
        ],
        yFormat: (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}s` : `${v}ms`),
        valueFormat: fmtMs,
      }),
      hBars($("#c-cost"), {
        animate,
        items: [...data.models]
          .sort((a, b) => b.costUsd - a.costUsd)
          .map((m) => ({
            label: m.model,
            value: m.costUsd,
            detail: `<div class="tt-row" style="color:var(--text-muted)">spans<b>${fmtInt(m.count)}</b></div>`,
          })),
        color: blue,
        valueLabel: "cost",
        format: fmtUsd,
        ariaLabel: "Cost by model",
      }),
    ];
  }
  await refresh();
  live.start(refresh);
  return () => [...disposers, ...sparkDisposers].forEach((d) => d());
}

const skeletonRows = (cols, n = 8) =>
  Array.from(
    { length: n },
    () =>
      `<tr>${Array.from({ length: cols }, () => `<td><span class="skel"></span></td>`).join("")}</tr>`,
  ).join("");

async function pageModels(view) {
  let sort = { key: "count", dir: -1 };
  const cols = [
    ["model", "Model", false],
    ["count", "Spans", true],
    ["errors", "Errors", true],
    ["errorRate", "Error rate", true],
    ["inputTokens", "Input tok", true],
    ["outputTokens", "Output tok", true],
    ["costUsd", "Cost", true],
    ["p50LatencyMs", "p50", true],
    ["p95LatencyMs", "p95", true],
    ["p99LatencyMs", "p99", true],
    ["price", "Price in / out per 1M", true],
  ];
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Models</h1><p>Everything held in memory, rolled up per model. Click a column to sort, or a row to see its traces.</p></div>
    </div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, l, n]) => `<th class="sortable${n ? " num" : ""}" data-k="${k}">${l}<span class="arrow"></span></th>`).join("")}</tr></thead>
      <tbody id="m-body">${skeletonRows(cols.length, 5)}</tbody>
    </table></div></section>`;
  if (!quiet) revealIn(view);
  let rows = [];
  const render = () => {
    const sorted = [...rows].sort((a, b) => {
      const va = sort.key === "price" ? (a.price?.input ?? -1) : a[sort.key];
      const vb = sort.key === "price" ? (b.price?.input ?? -1) : b[sort.key];
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
    view.querySelectorAll("th[data-k]").forEach((th) => {
      th.querySelector(".arrow").textContent =
        th.dataset.k === sort.key ? (sort.dir > 0 ? "▲" : "▼") : "";
      th.setAttribute(
        "aria-sort",
        th.dataset.k === sort.key ? (sort.dir > 0 ? "ascending" : "descending") : "none",
      );
    });
    const maxCost = Math.max(...rows.map((r) => r.costUsd), 0) || 1;
    $("#m-body").innerHTML = sorted.length
      ? sorted
          .map(
            (r) => `<tr class="clickable" data-model="${esc(r.model)}" tabindex="0">
          <td>${modelCell(r.model)}</td>
          <td class="num">${fmtInt(r.count)}</td>
          <td class="num">${fmtInt(r.errors)}</td>
          <td class="num"${r.errorRate > 0.05 ? ' style="color:var(--critical-ink);font-weight:600"' : ""}>${fmtPct(r.errorRate)}</td>
          <td class="num">${fmtInt(r.inputTokens)}</td>
          <td class="num">${fmtInt(r.outputTokens)}</td>
          <td class="num"><span class="bar-cell"><span class="mini-bar"><i style="width:${((r.costUsd / maxCost) * 100).toFixed(1)}%"></i></span>${fmtUsd(r.costUsd)}</span></td>
          <td class="num">${fmtMs(r.p50LatencyMs)}</td>
          <td class="num">${fmtMs(r.p95LatencyMs)}</td>
          <td class="num">${fmtMs(r.p99LatencyMs)}</td>
          <td class="num">${r.price ? `$${r.price.input} / $${r.price.output}` : `<span style="color:var(--text-muted)">not priced</span>`}</td>
        </tr>`,
          )
          .join("")
      : `<tr><td colspan="${cols.length}" class="empty">No spans yet. Send some from the <a href="#/send">Send data</a> page.</td></tr>`;
  };
  view.querySelectorAll("th[data-k]").forEach((th) =>
    th.addEventListener("click", () => {
      sort = {
        key: th.dataset.k,
        dir: sort.key === th.dataset.k ? -sort.dir : th.dataset.k === "model" ? 1 : -1,
      };
      render();
    }),
  );
  const go = (e) => {
    const tr = e.target.closest("tr[data-model]");
    if (tr) location.hash = `#/traces?model=${encodeURIComponent(tr.dataset.model)}`;
  };
  $("#m-body").addEventListener("click", go);
  $("#m-body").addEventListener("keydown", (e) => e.key === "Enter" && go(e));
  async function refresh() {
    try {
      rows = (await api("/api/models")).models;
      live.render(false);
    } catch (e) {
      live.render(true);
      throw e;
    }
    render();
  }
  await refresh();
  live.start(refresh);
}

async function pageTraces(view, params) {
  const PAGE = 50;
  const state = {
    model: params.get("model") || "",
    status: params.get("status") || "",
    q: params.get("q") || "",
    offset: 0,
  };
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Traces</h1><p>Newest spans first. Click a span to inspect it and its trace.</p></div>
    </div>
    <div class="filters">
      <select id="f-model" aria-label="Model"><option value="">All models</option></select>
      <div class="seg" role="group" aria-label="Status" id="f-status">
        <button data-s="" aria-pressed="${state.status === ""}">All</button>
        <button data-s="OK" aria-pressed="${state.status === "OK"}">OK</button>
        <button data-s="ERROR" aria-pressed="${state.status === "ERROR"}">Errors</button>
      </div>
      <label class="search">${ICON.search}<input type="search" id="f-q" placeholder="Search trace ID, span ID or name" value="${esc(state.q)}" aria-label="Search"></label>
      <span class="hero-hint">Press <kbd>/</kbd> to search</span>
    </div>
    <section class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Trace</th><th>Model</th><th>Status</th><th class="num">Latency</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead>
        <tbody id="t-body">${skeletonRows(7)}</tbody>
      </table></div>
      <div class="pager"><span id="t-count"></span>
        <button class="btn" id="t-prev">Previous</button><button class="btn" id="t-next">Next</button></div>
    </section>`;
  if (!quiet) revealIn(view);

  // Model list only feeds the filter dropdown; the page still works without it.
  api("/api/models")
    .then(({ models }) => {
      const names = models.map((m) => m.model).sort();
      if (state.model && !names.includes(state.model)) names.push(state.model);
      $("#f-model").innerHTML =
        `<option value="">All models</option>` +
        names
          .map((m) => `<option ${m === state.model ? "selected" : ""}>${esc(m)}</option>`)
          .join("");
    })
    .catch(() => {
      /* dropdown stays at "All models" */
    });

  const seg = $("#f-status");
  segPill(seg);

  let items = [];
  const seen = new Set();
  let primed = false;
  async function refresh() {
    const qs = new URLSearchParams({ limit: PAGE, offset: state.offset });
    if (state.model) qs.set("model", state.model);
    if (state.status) qs.set("status", state.status);
    if (state.q) qs.set("q", state.q);
    let data;
    try {
      data = await api(`/api/spans?${qs}`);
      live.render(false);
    } catch (e) {
      live.render(true);
      throw e;
    }
    items = data.items;
    const maxLat = Math.max(...items.map((s) => s.latency_ms), 1);
    $("#t-body").innerHTML = items.length
      ? items
          .map((s, i) => {
            const a = s.attributes;
            const fresh = primed && !seen.has(s.span_id);
            return `<tr class="clickable${fresh ? " fresh" : ""}" data-i="${i}" tabindex="0">
              <td>${esc(new Date(s.end_time_unix_nano / 1e6).toLocaleTimeString())}</td>
              <td class="mono" title="${esc(s.trace_id)}">${esc(shortId(s.trace_id))}</td>
              <td>${modelCell(s.model, a["gen_ai.system"])}</td>
              <td>${statusBadge(s.status)}</td>
              <td class="num"><span class="bar-cell"><span class="mini-bar"><i style="width:${((s.latency_ms / maxLat) * 100).toFixed(1)}%${s.status === "ERROR" ? ";background:var(--critical)" : ""}"></i></span>${fmtMs(s.latency_ms)}</span></td>
              <td class="num">${fmtInt(a["gen_ai.usage.input_tokens"])} / ${fmtInt(a["gen_ai.usage.output_tokens"])}</td>
              <td class="num">${fmtUsd(s.cost_usd)}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="empty">No spans match these filters.</td></tr>`;
    items.forEach((s) => seen.add(s.span_id));
    primed = true;
    const end = Math.min(state.offset + PAGE, data.total);
    $("#t-count").textContent = data.total
      ? `${fmtInt(state.offset + 1)}–${fmtInt(end)} of ${fmtInt(data.total)}`
      : "";
    $("#t-prev").disabled = state.offset === 0;
    $("#t-next").disabled = end >= data.total;
  }
  const apply = () => {
    state.offset = 0;
    primed = false;
    const p = new URLSearchParams();
    if (state.model) p.set("model", state.model);
    if (state.status) p.set("status", state.status);
    if (state.q) p.set("q", state.q);
    setHashParams("traces", p);
    refresh();
  };
  $("#f-model").addEventListener("change", (e) => {
    state.model = e.target.value;
    apply();
  });
  seg.querySelectorAll("[data-s]").forEach((b) =>
    b.addEventListener("click", () => {
      state.status = b.dataset.s;
      seg
        .querySelectorAll("[data-s]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      segPill(seg);
      apply();
    }),
  );
  let deb;
  $("#f-q").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      state.q = e.target.value.trim();
      apply();
    }, 250);
  });
  $("#t-prev").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - PAGE);
    primed = false;
    refresh();
  });
  $("#t-next").addEventListener("click", () => {
    state.offset += PAGE;
    primed = false;
    refresh();
  });
  const open = (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) openSpan(items[Number(tr.dataset.i)]);
  };
  $("#t-body").addEventListener("click", open);
  $("#t-body").addEventListener("keydown", (e) => e.key === "Enter" && open(e));
  await refresh();
  live.start(refresh);
}

const PROVIDERS = { openai: "gpt-4o-mini", anthropic: "claude-opus-4-7", google: "gemini-2-5-pro" };

function makeSpan({
  system,
  model,
  latencyMs,
  inputTokens,
  outputTokens,
  error,
  endMs = Date.now(),
}) {
  const end = endMs * 1e6;
  return {
    trace_id: hex(16),
    span_id: hex(8),
    name: `chat ${model}`,
    start_time_unix_nano: end - latencyMs * 1e6,
    end_time_unix_nano: end,
    status: error ? "ERROR" : "OK",
    attributes: {
      "gen_ai.system": system,
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": inputTokens,
      "gen_ai.usage.output_tokens": error ? 0 : outputTokens,
      "gen_ai.response.finish_reasons": [error ? "error" : "stop"],
      "app.source": "web-console",
    },
  };
}

async function pageSend(view) {
  const { pricing } = await api("/api/models").catch(() => ({ pricing: {} }));
  const priced = Object.keys(pricing);
  const origin = location.origin;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Send data</h1><p>Push test spans, simulate traffic, or connect a real app.</p></div>
    </div>
    <div class="grid send-grid">
      <section class="card card-pad feature-card span-all">
        <span class="f-icon">${svgIcon('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 20)}</span>
        <div style="flex:1;min-width:220px"><h2>Simulate an incident</h2>
          <div class="sub">Sends 150 slow, failing calls for one random model over the last two minutes, then takes you to the Overview to watch the spike.</div></div>
        <button class="btn primary lg" id="incident">${actionLabel(ICON.zap, "Break something", "Sign in to break something")}</button>
      </section>
      ${
        canWrite()
          ? ""
          : `<section class="card card-pad span-all signin-card"><span>${ICON.github}</span><div style="flex:1;min-width:220px"><h2>Sign in to send data</h2><div class="sub">Anyone can explore the dashboard. Signing in with GitHub lets you simulate incidents, send test spans, generate traffic and get an ingest key for your own app. Spanscope only reads your public profile.</div></div><button class="btn primary" id="signin-send">${ICON.github}Sign in with GitHub</button></section>`
      }

      <section class="card card-pad">
        <div class="card-head"><div><h2>Send a test span</h2><div class="sub">Posts one span to <code>/trace</code>, timestamped now.</div></div></div>
        <form id="one" class="form-grid">
          <div class="field"><label for="s-sys">Provider</label>
            <select id="s-sys">${Object.keys(PROVIDERS)
              .map((p) => `<option>${p}</option>`)
              .join("")}<option>other</option></select></div>
          <div class="field"><label for="s-model">Model</label>
            <input type="text" id="s-model" list="models-dl" value="gpt-4o-mini" required>
            <datalist id="models-dl">${priced.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></div>
          <div class="field"><label for="s-lat">Latency (ms)</label><input type="number" id="s-lat" value="850" min="0" required></div>
          <div class="field"><label for="s-status">Status</label>
            <select id="s-status"><option value="OK">OK</option><option value="ERROR">Error</option></select></div>
          <div class="field"><label for="s-in">Input tokens</label><input type="number" id="s-in" value="420" min="0" required></div>
          <div class="field"><label for="s-out">Output tokens</label><input type="number" id="s-out" value="180" min="0" required></div>
        </form>
        <div class="form-actions"><button class="btn primary" form="one" type="submit">${actionLabel(ICON.send, "Send span", "Sign in to send")}</button><span class="notice" id="one-msg"></span></div>
      </section>

      <section class="card card-pad">
        <div class="card-head"><div><h2>Generate traffic</h2><div class="sub">Random spans across all priced models, spread over the recent past.</div></div></div>
        <form id="gen" class="form-grid">
          <div class="field"><label for="g-n">Number of spans</label><input type="number" id="g-n" value="200" min="1" max="5000" required></div>
          <div class="field"><label for="g-err">Error rate (%)</label><input type="number" id="g-err" value="3" min="0" max="100" required></div>
          <div class="field"><label for="g-spread">Spread over last (minutes)</label><input type="number" id="g-spread" value="10" min="0" max="1440" required></div>
          <div class="field"><label for="g-lat">Typical latency (ms)</label><input type="number" id="g-lat" value="1200" min="1" required></div>
        </form>
        <div class="form-actions"><button class="btn primary" form="gen" type="submit">${actionLabel(ICON.sparkle, "Generate", "Sign in to generate")}</button><span class="notice" id="gen-msg"></span></div>
      </section>

      <section class="card card-pad span-all">
        <div class="card-head"><div><h2>Connect your app</h2><div class="sub">Point any OpenTelemetry SDK at this server using the OTLP/HTTP <b>JSON</b> exporter (protobuf isn't supported).</div></div></div>
        ${
          session.authEnabled
            ? `<div class="section-title" style="margin-top:4px">Your ingest key</div>
        ${
          session.user
            ? `<p class="notice">Apps send this key instead of signing in. It's valid for 90 days and is shown only once, so store it like a password.</p>
        <div class="form-actions" style="margin-top:8px"><button class="btn primary" id="make-key">${ICON.sparkle}Create ingest key</button><span class="notice" id="key-msg"></span></div>`
            : `<p class="notice">Sign in to create a key that lets your own app send traces here.</p>`
        }`
            : ""
        }
        <div class="section-title"${session.authEnabled ? "" : ' style="margin-top:4px"'}>Environment variables</div>
        <pre class="snippet" id="snip-env">OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${origin}/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json${session.authEnabled ? `\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<span class="key-slot">YOUR_INGEST_KEY</span>` : ""}</pre>
        <div class="form-actions" style="margin-top:8px"><button class="btn" data-copy="snip-env">${ICON.copy}Copy</button></div>
        <div class="section-title">Or send a flat span with curl</div>
        <pre class="snippet" id="snip-curl">curl -X POST ${origin}/trace -H 'content-type: application/json' \\${session.authEnabled ? `\n  -H 'authorization: Bearer <span class="key-slot">YOUR_INGEST_KEY</span>' \\` : ""}
  -d '{"start_time_unix_nano":${Date.now()}000000,"end_time_unix_nano":${Date.now() + 900}000000,"attributes":{"gen_ai.system":"openai","gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":120,"gen_ai.usage.output_tokens":40}}'</pre>
        <div class="form-actions" style="margin-top:8px"><button class="btn" data-copy="snip-curl">${ICON.copy}Copy</button></div>
      </section>

      <section class="card card-pad span-all" id="reset-card" hidden>
        <div class="card-head"><div><h2>Reset</h2><div class="sub">Delete every span held in memory and reset the counters. This can't be undone.</div></div>
          <span class="spacer"></span><button class="btn danger" id="clear">Clear all spans</button></div>
      </section>
    </div>`;
  if (!quiet) revealIn(view);

  $("#incident").addEventListener("click", (e) => simulateIncident(e.currentTarget));
  $("#signin-send")?.addEventListener("click", signIn);
  $("#make-key")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { key, expiresAt } = await api("/api/keys", { method: "POST" });
      view.querySelectorAll(".key-slot").forEach((n) => (n.textContent = key));
      $("#key-msg").className = "notice ok";
      $("#key-msg").textContent =
        `Key created, valid until ${new Date(expiresAt).toLocaleDateString()}. It's now in the snippets below. Copy it before leaving this page.`;
      toast("Ingest key created");
    } catch (err) {
      $("#key-msg").className = "notice err";
      $("#key-msg").textContent = `Failed: ${err.message}`;
      btn.disabled = false;
    }
  });

  $("#s-sys").addEventListener("change", (e) => {
    if (PROVIDERS[e.target.value]) $("#s-model").value = PROVIDERS[e.target.value];
  });

  $("#one").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canWrite()) return signIn();
    const msg = $("#one-msg");
    try {
      const span = makeSpan({
        system: $("#s-sys").value,
        model: $("#s-model").value.trim(),
        latencyMs: Number($("#s-lat").value),
        inputTokens: Number($("#s-in").value),
        outputTokens: Number($("#s-out").value),
        error: $("#s-status").value === "ERROR",
      });
      const r = await api("/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(span),
      });
      msg.className = "notice ok";
      msg.innerHTML = `Accepted. <a href="#/traces?q=${span.trace_id}">View span →</a> (${fmtInt(r.counters.accepted)} total)`;
      toast("Span accepted");
    } catch (err) {
      msg.className = "notice err";
      msg.textContent = `Failed: ${err.message}`;
    }
  });

  $("#gen").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canWrite()) return signIn();
    const msg = $("#gen-msg");
    const n = Math.min(5000, Math.max(1, Number($("#g-n").value)));
    const errRate = Number($("#g-err").value) / 100;
    const spreadMs = Number($("#g-spread").value) * 60000;
    const baseLat = Number($("#g-lat").value);
    const models = priced.length ? priced : ["gpt-4o-mini"];
    const now = Date.now();
    const spans = Array.from({ length: n }, () => {
      const model = models[Math.floor(Math.random() * models.length)];
      // log-normal-ish latency with a long tail
      const latencyMs = Math.round(
        baseLat * Math.exp((Math.random() - 0.5) * 1.2 + (Math.random() < 0.05 ? 1 : 0)),
      );
      return makeSpan({
        system: providerOf(model),
        model,
        latencyMs,
        inputTokens: 100 + Math.floor(Math.random() * 3000),
        outputTokens: 40 + Math.floor(Math.random() * 700),
        error: Math.random() < errRate,
        endMs: now - Math.random() * spreadMs,
      });
    });
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const r = await api("/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spans),
      });
      msg.className = "notice ok";
      msg.innerHTML = `Sent ${fmtInt(n)} spans. <a href="#/overview">See overview →</a> (${fmtInt(r.counters.held)} held)`;
      toast(`Sent ${fmtInt(n)} spans`);
    } catch (err) {
      msg.className = "notice err";
      msg.textContent = `Failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  view.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent);
        toast("Copied to clipboard");
      } catch {
        toast("Couldn't copy. Select the text instead.", "err");
      }
    }),
  );

  // The public demo refuses DELETE /api/spans, so only offer Reset when allowed.
  api("/api/config")
    .then((cfg) => {
      if (!cfg.demo && $("#reset-card")) $("#reset-card").hidden = false;
    })
    .catch(() => {
      // Older server without /api/config: keep the Reset card hidden.
    });

  $("#clear").addEventListener("click", async () => {
    if (!confirm("Delete all spans held in memory? This can't be undone.")) return;
    try {
      await api("/api/spans", { method: "DELETE" });
      toast("All spans cleared");
    } catch (err) {
      toast(`Failed: ${err.message}`, "err");
    }
  });
  live.start(null);
}

// ---------------------------------------------------------------------------
// command palette (⌘K / Ctrl+K)
// ---------------------------------------------------------------------------

const palette = { open: false, items: [], sel: 0, models: [] };
const go = (r) => {
  location.hash = `#/${r}`;
};

function paletteCommands(q) {
  const ql = q.trim().toLowerCase();
  const base = [
    {
      group: "Go to",
      label: "Overview",
      icon: ICON.grid,
      hint: "G then O",
      run: () => go("overview"),
    },
    {
      group: "Go to",
      label: "Models",
      icon: ICON.layers,
      hint: "G then M",
      run: () => go("models"),
    },
    { group: "Go to", label: "Traces", icon: ICON.list, hint: "G then T", run: () => go("traces") },
    {
      group: "Go to",
      label: "Send data",
      icon: ICON.send,
      hint: "G then S",
      run: () => go("send"),
    },
    {
      group: "Actions",
      label: "Simulate an incident",
      icon: ICON.zap,
      hint: "I",
      run: () => simulateIncident(),
    },
    {
      group: "Actions",
      label: "Show only failed traces",
      icon: ICON.alert,
      run: () => (location.hash = "#/traces?status=ERROR"),
    },
    {
      group: "Actions",
      label: live.paused ? "Resume live updates" : "Pause live updates",
      icon: live.paused ? ICON.play : ICON.pause,
      hint: "P",
      run: togglePause,
    },
    {
      group: "Actions",
      label: "Toggle light / dark theme",
      icon: ICON.moon,
      hint: "T",
      run: toggleTheme,
    },
    {
      group: "Actions",
      label: "Show the welcome banner",
      icon: ICON.sparkle,
      run: () => {
        store.set("obs-hero", "1");
        if (parseHash().route === "overview") route();
        else go("overview");
      },
    },
    ...(session.authEnabled
      ? [
          session.user
            ? {
                group: "Account",
                label: `Sign out (@${session.user.login})`,
                icon: ICON.x,
                run: signOut,
              }
            : { group: "Account", label: "Sign in with GitHub", icon: ICON.github, run: signIn },
        ]
      : []),
    {
      group: "Links",
      label: "View source on GitHub",
      icon: ICON.github,
      run: () => window.open(REPO_URL, "_blank", "noopener"),
    },
  ];
  if (!ql) return base;
  const models = palette.models
    .filter((m) => m.toLowerCase().includes(ql))
    .map((m) => ({
      group: "Models",
      label: `Traces for ${m}`,
      icon: providerDot(providerOf(m)),
      run: () => (location.hash = `#/traces?model=${encodeURIComponent(m)}`),
    }));
  return [
    ...base.filter((c) => c.label.toLowerCase().includes(ql)),
    ...models,
    {
      group: "Search",
      label: `Search traces for “${q.trim()}”`,
      icon: ICON.search,
      run: () => (location.hash = `#/traces?q=${encodeURIComponent(q.trim())}`),
    },
  ];
}

function renderPalette() {
  const list = $("#palette-list");
  palette.items = paletteCommands($("#palette-input").value);
  palette.sel = Math.min(palette.sel, Math.max(0, palette.items.length - 1));
  let group = "";
  list.innerHTML = palette.items
    .map((c, i) => {
      const head =
        c.group !== group ? `<li class="group" role="presentation">${esc(c.group)}</li>` : "";
      group = c.group;
      return `${head}<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === palette.sel}">
        <span class="p-icon">${c.icon}</span><span>${esc(c.label)}</span>${c.hint ? `<span class="p-hint">${esc(c.hint)}</span>` : ""}</li>`;
    })
    .join("");
  $("#palette-input").setAttribute("aria-activedescendant", `pal-${palette.sel}`);
  $(`#pal-${palette.sel}`)?.scrollIntoView({ block: "nearest" });
}

function openPalette(prefill = "") {
  palette.open = true;
  palette.sel = 0;
  $("#palette").classList.add("open");
  $("#palette-backdrop").classList.add("open");
  const input = $("#palette-input");
  input.value = prefill;
  renderPalette();
  input.focus();
  api("/api/models")
    .then(({ models }) => {
      palette.models = models.map((m) => m.model);
      if (palette.open) renderPalette();
    })
    .catch(() => {
      /* model suggestions are optional */
    });
}
function closePalette() {
  palette.open = false;
  $("#palette").classList.remove("open");
  $("#palette-backdrop").classList.remove("open");
}
function runPalette(i) {
  const c = palette.items[i];
  if (!c) return;
  closePalette();
  c.run();
}

$("#cmd-open").addEventListener("click", () => openPalette());
$("#footer-shortcuts").addEventListener("click", () => openPalette());
$("#cmd-kbd").textContent = isMac ? "⌘K" : "Ctrl K";
$("#palette-backdrop").addEventListener("click", closePalette);
$("#palette-input").addEventListener("input", () => {
  palette.sel = 0;
  renderPalette();
});
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = palette.items.length;
    palette.sel = (palette.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPalette(palette.sel);
  }
});
$("#palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) runPalette(Number(li.dataset.i));
});
$("#palette-list").addEventListener("mousemove", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li && Number(li.dataset.i) !== palette.sel) {
    palette.sel = Number(li.dataset.i);
    document
      .querySelectorAll("#palette-list li[data-i]")
      .forEach((x) => x.setAttribute("aria-selected", String(Number(x.dataset.i) === palette.sel)));
  }
});

// Global keyboard shortcuts.
let gPending = 0;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return palette.open ? closePalette() : openPalette();
  }
  if (e.key === "Escape") {
    if (palette.open) return closePalette();
    return closeDrawer();
  }
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (typing || e.metaKey || e.ctrlKey || e.altKey || palette.open) return;
  const k = e.key.toLowerCase();
  if (k === "/") {
    const search = $("#f-q");
    e.preventDefault();
    return search ? search.focus() : openPalette();
  }
  if (gPending && Date.now() - gPending < 1200) {
    gPending = 0;
    const r = { o: "overview", m: "models", t: "traces", s: "send" }[k];
    if (r) go(r);
    return;
  }
  if (k === "g") gPending = Date.now();
  else if (k === "i") simulateIncident();
  else if (k === "p") togglePause();
  else if (k === "t") toggleTheme();
  else if (k === "?") openPalette();
});

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const PAGES = { overview: pageOverview, models: pageModels, traces: pageTraces, send: pageSend };
let cleanup = null;
let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  const { route: name, params } = parseHash();
  const page = PAGES[name] ? name : "overview";
  document
    .querySelectorAll(".nav a")
    .forEach((a) =>
      a.dataset.route === page
        ? a.setAttribute("aria-current", "page")
        : a.removeAttribute("aria-current"),
    );
  moveNavPill();
  if (cleanup) cleanup();
  cleanup = null;
  live.start(null);
  closeDrawer();
  const view = $("#view");
  try {
    const c = await PAGES[page](view, params);
    if (seq === routeSeq) cleanup = typeof c === "function" ? c : null;
  } catch (e) {
    if (seq === routeSeq) {
      view.innerHTML = `<div class="card card-pad" style="max-width:560px;margin:40px auto;text-align:center">
        <h2 style="font-size:18px">Can't reach the server</h2>
        <p class="notice err">${esc(e.message)}</p>
        <p class="notice">If this is the hosted demo, it may be waking up. That takes up to a minute.</p>
        <div class="form-actions" style="justify-content:center"><button class="btn primary" id="retry">Try again</button></div></div>`;
      $("#retry").addEventListener("click", route);
    }
  }
}

// Footer: which storage backend this server runs on.
api("/api/config")
  .then((cfg) => {
    $("#storage-label").textContent =
      cfg.storage === "clickhouse" ? " · Storage: ClickHouse" : " · Storage: in memory";
  })
  .catch(() => {
    /* label is informational only */
  });

// Filter changes on the traces page use replaceState and don't fire this.
window.addEventListener("hashchange", () => {
  if (palette.open) closePalette();
  route();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && live.refresh && !live.paused) live.refresh().catch(() => {});
});
// Learn whether sign-in is on (and who is signed in) before the first render.
api("/api/me")
  .then((me) => Object.assign(session, me))
  .catch(() => {
    /* older server or offline: behave as if sign-in is off */
  })
  .finally(() => {
    renderAccount();
    route();
  });
