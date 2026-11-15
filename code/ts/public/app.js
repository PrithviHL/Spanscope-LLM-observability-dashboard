import { stackedBars, lineChart, hBars, fmtTime } from "./charts.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtUsd = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const fmtPct = (r) => `${(r * 100).toFixed(r && r < 0.01 ? 2 : 1)}%`;
const shortId = (id) => (id ? `${id.slice(0, 8)}…` : "");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function statusBadge(s) {
  return s === "ERROR"
    ? `<span class="status err"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.8"/></svg>Error</span>`
    : `<span class="status ok"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2l2.3 2.3L8.5 2.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>OK</span>`;
}

const hex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [route, qs] = raw.split("?");
  return { route: route || "overview", params: new URLSearchParams(qs || "") };
}

function setHashParams(route, params) {
  const qs = params.toString();
  history.replaceState(null, "", `#/${route}${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// live polling + theme
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
    btn.title = this.paused ? "Resume auto-refresh" : "Pause auto-refresh";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = this.paused
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg>`;
  },
};

$("#pause").addEventListener("click", () => {
  live.paused = !live.paused;
  store.set("obs-paused", live.paused ? "1" : "0");
  live.schedule();
  if (!live.paused && live.refresh) live.refresh().catch(() => {});
});

$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = isDark ? "light" : "dark";
  store.set("obs-theme", root.dataset.theme);
  route(); // charts read colors from CSS variables
});

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
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

async function openSpan(span) {
  $("#drawer-title").textContent = span.name || "Span";
  $("#drawer-body").innerHTML = `<div class="empty">Loading…</div>`;
  $("#drawer").classList.add("open");
  $("#drawer-backdrop").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  let trace = [span];
  try {
    trace = (await api(`/api/traces/${encodeURIComponent(span.trace_id)}`)).spans;
  } catch {}
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
  $("#drawer-body").innerHTML = `
    <dl class="kv">
      <dt>Status</dt><dd>${statusBadge(span.status)}</dd>
      <dt>Model</dt><dd>${esc(span.model)}</dd>
      <dt>Provider</dt><dd>${esc(a["gen_ai.system"])}</dd>
      <dt>Operation</dt><dd>${esc(a["gen_ai.operation.name"])}</dd>
      <dt>Latency</dt><dd>${fmtMs(span.latency_ms)}</dd>
      <dt>Tokens in / out</dt><dd>${fmtInt(a["gen_ai.usage.input_tokens"])} / ${fmtInt(a["gen_ai.usage.output_tokens"])}</dd>
      <dt>Cost</dt><dd>${fmtUsd(span.cost_usd)}</dd>
      <dt>Ended</dt><dd>${esc(new Date(span.end_time_unix_nano / 1e6).toLocaleString())}</dd>
      <dt>Trace ID</dt><dd class="mono">${esc(span.trace_id)}</dd>
      <dt>Span ID</dt><dd class="mono">${esc(span.span_id)}</dd>
      ${span.parent_span_id ? `<dt>Parent span</dt><dd class="mono">${esc(span.parent_span_id)}</dd>` : ""}
    </dl>
    <div class="section-title">Trace waterfall · ${trace.length} span${trace.length === 1 ? "" : "s"}</div>
    <div class="waterfall">${wf}</div>
    <div class="section-title">Attributes</div>
    <pre class="json">${esc(JSON.stringify(a, null, 2))}</pre>`;
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

const WINDOWS = [["15m", "15 min"], ["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"]];

async function pageOverview(view) {
  let windowKey = store.get("obs-window", "1h");
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Overview</h1><p>Traffic, errors, latency and spend across every model.</p></div>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Time range">
        ${WINDOWS.map(([k, l]) => `<button data-w="${k}" aria-pressed="${k === windowKey}">${l}</button>`).join("")}
      </div>
    </div>
    <div class="grid kpis" id="kpis"></div>
    <div class="grid charts">
      <section class="card card-pad wide">
        <div class="card-head">
          <div><h2>Requests</h2><div class="sub" id="req-sub"></div></div>
          <span class="spacer"></span>
          <div class="legend">
            <span><i class="swatch" style="background:var(--series-1)"></i>Successful</span>
            <span><i class="swatch" style="background:var(--critical)"></i>Errors</span>
          </div>
        </div>
        <div class="chart" id="c-req"></div>
      </section>
      <section class="card card-pad">
        <div class="card-head">
          <div><h2>Latency</h2><div class="sub">Per time bucket, all models</div></div>
          <span class="spacer"></span>
          <div class="legend">
            <span><i class="swatch line" style="background:var(--series-1)"></i>p50</span>
            <span><i class="swatch line" style="background:var(--series-2)"></i>p95</span>
          </div>
        </div>
        <div class="chart" id="c-lat"></div>
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

  view.querySelectorAll("[data-w]").forEach((b) =>
    b.addEventListener("click", () => {
      windowKey = b.dataset.w;
      store.set("obs-window", windowKey);
      view.querySelectorAll("[data-w]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      last = "";
      refresh();
    }),
  );

  let last = "";
  let disposers = [];
  async function refresh() {
    let data;
    try {
      data = await api(`/api/overview?window=${windowKey}`);
      live.render(false);
    } catch (e) {
      live.render(true);
      throw e;
    }
    const key = JSON.stringify([data.summary, data.series, data.models]);
    if (key === last) return; // nothing changed: keep hover state intact
    last = key;
    const s = data.summary;
    const mins = data.windowMs / 60000;
    $("#kpis").innerHTML = `
      <div class="card card-pad kpi"><div class="label">Requests</div><div class="value">${fmtInt(s.spans)}</div><div class="hint">${(s.spans / mins).toFixed(1)} / min</div></div>
      <div class="card card-pad kpi"><div class="label">Error rate</div><div class="value${s.errorRate > 0.05 ? " bad" : ""}">${fmtPct(s.errorRate)}</div><div class="hint">${fmtInt(s.errors)} failed span${s.errors === 1 ? "" : "s"}</div></div>
      <div class="card card-pad kpi"><div class="label">Spend</div><div class="value">${fmtUsd(s.costUsd)}</div><div class="hint">${fmtInt(s.inputTokens + s.outputTokens)} tokens</div></div>
      <div class="card card-pad kpi"><div class="label">p95 latency</div><div class="value">${fmtMs(s.p95LatencyMs)}</div><div class="hint">p50 ${fmtMs(s.p50LatencyMs)}</div></div>`;
    const bucketMin = data.series.length > 1 ? (data.series[1].t - data.series[0].t) / 60000 : 1;
    $("#req-sub").textContent = `Spans per ${bucketMin >= 1 ? `${+bucketMin.toFixed(1)}-minute` : `${Math.round(bucketMin * 60)}-second`} bucket`;

    disposers.forEach((d) => d());
    const blue = css("--series-1");
    const orange = css("--series-2");
    const red = css("--critical");
    disposers = [
      stackedBars($("#c-req"), {
        data: data.series,
        ariaLabel: "Requests over time, successful and errors",
        stacks: [
          { label: "Successful", color: blue, value: (d) => d.count - d.errors },
          { label: "Errors", color: red, value: (d) => d.errors },
        ],
        yFormat: (v) => fmtInt(v),
        extraRows: (d) => `<div class="tt-row" style="color:var(--text-muted)">cost<b>${fmtUsd(d.costUsd)}</b></div>`,
        title: (d) => `${fmtTime(d.t)} – ${fmtTime(d.t + bucketMin * 60000)}`,
      }),
      lineChart($("#c-lat"), {
        data: data.series,
        ariaLabel: "p50 and p95 latency over time",
        series: [
          { label: "p50", color: blue, value: (d) => d.p50LatencyMs },
          { label: "p95", color: orange, value: (d) => d.p95LatencyMs },
        ],
        yFormat: (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}s` : `${v}ms`),
        valueFormat: fmtMs,
      }),
      hBars($("#c-cost"), {
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
  return () => disposers.forEach((d) => d());
}

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
      <div><h1>Models</h1><p>Everything held in the ring buffer, rolled up per model. Click a row to see its traces.</p></div>
    </div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, l, n]) => `<th class="sortable${n ? " num" : ""}" data-k="${k}">${l}<span class="arrow"></span></th>`).join("")}</tr></thead>
      <tbody id="m-body"></tbody>
    </table></div></section>`;
  let rows = [];
  const render = () => {
    const sorted = [...rows].sort((a, b) => {
      const va = sort.key === "price" ? a.price?.input ?? -1 : a[sort.key];
      const vb = sort.key === "price" ? b.price?.input ?? -1 : b[sort.key];
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
    view.querySelectorAll("th[data-k]").forEach((th) => {
      th.querySelector(".arrow").textContent = th.dataset.k === sort.key ? (sort.dir > 0 ? "▲" : "▼") : "";
      th.setAttribute("aria-sort", th.dataset.k === sort.key ? (sort.dir > 0 ? "ascending" : "descending") : "none");
    });
    $("#m-body").innerHTML = sorted.length
      ? sorted
          .map(
            (r) => `<tr class="clickable" data-model="${esc(r.model)}">
          <td>${esc(r.model)}</td>
          <td class="num">${fmtInt(r.count)}</td>
          <td class="num">${fmtInt(r.errors)}</td>
          <td class="num">${fmtPct(r.errorRate)}</td>
          <td class="num">${fmtInt(r.inputTokens)}</td>
          <td class="num">${fmtInt(r.outputTokens)}</td>
          <td class="num">${fmtUsd(r.costUsd)}</td>
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
      sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : th.dataset.k === "model" ? 1 : -1 };
      render();
    }),
  );
  $("#m-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-model]");
    if (tr) location.hash = `#/traces?model=${encodeURIComponent(tr.dataset.model)}`;
  });
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
  let models = [];
  try {
    models = (await api("/api/models")).models.map((m) => m.model).sort();
  } catch {}
  if (state.model && !models.includes(state.model)) models.push(state.model);
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Traces</h1><p>Newest spans first. Click a span to inspect it and its trace.</p></div>
    </div>
    <div class="filters">
      <select id="f-model" aria-label="Model"><option value="">All models</option>${models.map((m) => `<option ${m === state.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
      <select id="f-status" aria-label="Status">
        <option value="">Any status</option>
        <option value="OK" ${state.status === "OK" ? "selected" : ""}>OK</option>
        <option value="ERROR" ${state.status === "ERROR" ? "selected" : ""}>Error</option>
      </select>
      <input type="search" id="f-q" placeholder="Search trace ID, span ID or name" value="${esc(state.q)}" style="min-width:260px;flex:1;max-width:380px">
    </div>
    <section class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Trace</th><th>Name</th><th>Model</th><th>Status</th><th class="num">Latency</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead>
        <tbody id="t-body"></tbody>
      </table></div>
      <div class="pager"><span id="t-count"></span>
        <button class="btn" id="t-prev">Previous</button><button class="btn" id="t-next">Next</button></div>
    </section>`;

  let items = [];
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
    $("#t-body").innerHTML = items.length
      ? items
          .map((s, i) => {
            const a = s.attributes;
            return `<tr class="clickable" data-i="${i}">
              <td>${esc(new Date(s.end_time_unix_nano / 1e6).toLocaleTimeString())}</td>
              <td class="mono" title="${esc(s.trace_id)}">${esc(shortId(s.trace_id))}</td>
              <td>${esc(s.name)}</td>
              <td>${esc(s.model)}</td>
              <td>${statusBadge(s.status)}</td>
              <td class="num">${fmtMs(s.latency_ms)}</td>
              <td class="num">${fmtInt(a["gen_ai.usage.input_tokens"])} / ${fmtInt(a["gen_ai.usage.output_tokens"])}</td>
              <td class="num">${fmtUsd(s.cost_usd)}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="8" class="empty">No spans match these filters.</td></tr>`;
    const end = Math.min(state.offset + PAGE, data.total);
    $("#t-count").textContent = data.total ? `${fmtInt(state.offset + 1)}–${fmtInt(end)} of ${fmtInt(data.total)}` : "";
    $("#t-prev").disabled = state.offset === 0;
    $("#t-next").disabled = end >= data.total;
  }
  const apply = () => {
    state.offset = 0;
    const p = new URLSearchParams();
    if (state.model) p.set("model", state.model);
    if (state.status) p.set("status", state.status);
    if (state.q) p.set("q", state.q);
    setHashParams("traces", p);
    refresh();
  };
  $("#f-model").addEventListener("change", (e) => { state.model = e.target.value; apply(); });
  $("#f-status").addEventListener("change", (e) => { state.status = e.target.value; apply(); });
  let deb;
  $("#f-q").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { state.q = e.target.value.trim(); apply(); }, 250);
  });
  $("#t-prev").addEventListener("click", () => { state.offset = Math.max(0, state.offset - PAGE); refresh(); });
  $("#t-next").addEventListener("click", () => { state.offset += PAGE; refresh(); });
  $("#t-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) openSpan(items[Number(tr.dataset.i)]);
  });
  await refresh();
  live.start(refresh);
}

const PROVIDERS = { openai: "gpt-4o-mini", anthropic: "claude-opus-4-7", google: "gemini-2-5-pro" };

function makeSpan({ system, model, latencyMs, inputTokens, outputTokens, error, endMs = Date.now() }) {
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
      <section class="card card-pad">
        <div class="card-head"><div><h2>Send a test span</h2><div class="sub">Posts one span to <code>/trace</code>, timestamped now.</div></div></div>
        <form id="one" class="form-grid">
          <div class="field"><label for="s-sys">Provider</label>
            <select id="s-sys">${Object.keys(PROVIDERS).map((p) => `<option>${p}</option>`).join("")}<option>other</option></select></div>
          <div class="field"><label for="s-model">Model</label>
            <input type="text" id="s-model" list="models-dl" value="gpt-4o-mini" required>
            <datalist id="models-dl">${priced.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></div>
          <div class="field"><label for="s-lat">Latency (ms)</label><input type="number" id="s-lat" value="850" min="0" required></div>
          <div class="field"><label for="s-status">Status</label>
            <select id="s-status"><option value="OK">OK</option><option value="ERROR">Error</option></select></div>
          <div class="field"><label for="s-in">Input tokens</label><input type="number" id="s-in" value="420" min="0" required></div>
          <div class="field"><label for="s-out">Output tokens</label><input type="number" id="s-out" value="180" min="0" required></div>
        </form>
        <div class="form-actions"><button class="btn primary" form="one" type="submit">Send span</button><span class="notice" id="one-msg"></span></div>
      </section>

      <section class="card card-pad">
        <div class="card-head"><div><h2>Generate traffic</h2><div class="sub">Random spans across all priced models, spread over the recent past.</div></div></div>
        <form id="gen" class="form-grid">
          <div class="field"><label for="g-n">Number of spans</label><input type="number" id="g-n" value="200" min="1" max="5000" required></div>
          <div class="field"><label for="g-err">Error rate (%)</label><input type="number" id="g-err" value="3" min="0" max="100" required></div>
          <div class="field"><label for="g-spread">Spread over last (minutes)</label><input type="number" id="g-spread" value="10" min="0" max="1440" required></div>
          <div class="field"><label for="g-lat">Typical latency (ms)</label><input type="number" id="g-lat" value="1200" min="1" required></div>
        </form>
        <div class="form-actions"><button class="btn primary" form="gen" type="submit">Generate</button><span class="notice" id="gen-msg"></span></div>
      </section>

      <section class="card card-pad" style="grid-column:1/-1">
        <div class="card-head"><div><h2>Connect your app</h2><div class="sub">Point any OpenTelemetry SDK at this server using the OTLP/HTTP <b>JSON</b> exporter (protobuf isn't supported).</div></div></div>
        <div class="section-title" style="margin-top:4px">Environment variables</div>
        <pre class="snippet" id="snip-env">OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${origin}/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json</pre>
        <div class="form-actions" style="margin-top:8px"><button class="btn" data-copy="snip-env">Copy</button></div>
        <div class="section-title">Or send a flat span with curl</div>
        <pre class="snippet" id="snip-curl">curl -X POST ${origin}/trace -H 'content-type: application/json' \\
  -d '{"start_time_unix_nano":${Date.now()}000000,"end_time_unix_nano":${Date.now() + 900}000000,"attributes":{"gen_ai.system":"openai","gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":120,"gen_ai.usage.output_tokens":40}}'</pre>
        <div class="form-actions" style="margin-top:8px"><button class="btn" data-copy="snip-curl">Copy</button></div>
      </section>

      <section class="card card-pad" style="grid-column:1/-1">
        <div class="card-head"><div><h2>Reset</h2><div class="sub">Delete every span held in memory and reset the counters. This can't be undone.</div></div>
          <span class="spacer"></span><button class="btn danger" id="clear">Clear all spans</button></div>
      </section>
    </div>`;

  $("#s-sys").addEventListener("change", (e) => {
    if (PROVIDERS[e.target.value]) $("#s-model").value = PROVIDERS[e.target.value];
  });

  $("#one").addEventListener("submit", async (e) => {
    e.preventDefault();
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
      const r = await api("/trace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(span) });
      msg.className = "notice ok";
      msg.innerHTML = `Accepted. <a href="#/traces?q=${span.trace_id}">View span →</a> (${fmtInt(r.counters.accepted)} total)`;
    } catch (err) {
      msg.className = "notice err";
      msg.textContent = `Failed: ${err.message}`;
    }
  });

  $("#gen").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#gen-msg");
    const n = Math.min(5000, Math.max(1, Number($("#g-n").value)));
    const errRate = Number($("#g-err").value) / 100;
    const spreadMs = Number($("#g-spread").value) * 60000;
    const baseLat = Number($("#g-lat").value);
    const models = priced.length ? priced : ["gpt-4o-mini"];
    const now = Date.now();
    const spans = Array.from({ length: n }, () => {
      const model = models[Math.floor(Math.random() * models.length)];
      const system = model.startsWith("gpt") ? "openai" : model.startsWith("claude") ? "anthropic" : "google";
      // log-normal-ish latency with a long tail
      const latencyMs = Math.round(baseLat * Math.exp((Math.random() - 0.5) * 1.2 + (Math.random() < 0.05 ? 1 : 0)));
      return makeSpan({
        system,
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
      const r = await api("/trace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spans) });
      msg.className = "notice ok";
      msg.innerHTML = `Sent ${fmtInt(n)} spans. <a href="#/overview">See overview →</a> (${fmtInt(r.counters.held)} held)`;
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
        toast("Couldn't copy. Select the text instead.");
      }
    }),
  );

  $("#clear").addEventListener("click", async () => {
    if (!confirm("Delete all spans held in memory? This can't be undone.")) return;
    try {
      await api("/api/spans", { method: "DELETE" });
      toast("All spans cleared");
    } catch (err) {
      toast(`Failed: ${err.message}`);
    }
  });
  live.start(null);
}

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
  document.querySelectorAll(".nav a").forEach((a) =>
    a.dataset.route === page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"),
  );
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
      view.innerHTML = `<div class="card card-pad"><h2>Can't reach the server</h2><p class="notice err">${esc(e.message)}</p><p class="notice">Is <code>npm run serve</code> still running?</p></div>`;
    }
  }
}

// Filter changes on the traces page use replaceState and don't fire this.
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && live.refresh && !live.paused) live.refresh().catch(() => {});
});
route();
