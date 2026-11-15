# User guide

How to use the Spanscope web app. Everything here works on the
[live demo](https://spanscope-llm-observability-dashboard.onrender.com/) without
an account.

## Try it in 30 seconds

1. Open the live demo. On the free hosting plan the first visit can take up to
   a minute while the server wakes up.
2. Press **⚡ Simulate an incident** in the welcome banner.
3. Watch the Overview react: the **Requests** chart spikes with red error
   segments, the **Error rate** tile turns red, **p95 latency** jumps to several
   seconds, and failed calls slide into the **Live stream**.
4. Click any request in the live stream to see its details, or open **Traces**
   and choose **Errors** to see every failed call.

## What the demo data is

The demo receives synthetic traffic: about 30 simulated LLM calls per minute
across five models (OpenAI, Anthropic and Google), with realistic latency,
token counts and a ~3% error rate. It is not connected to a real product.
Costs are estimates from list prices.

The demo is shared: everyone sees the same data, including incidents other
visitors trigger. It keeps data in memory, so it starts fresh (with an hour of
generated history) whenever the server restarts or wakes from sleep.

## Pages

### Overview

| Part | What it shows |
|---|---|
| Time range (15 min, 1 hour, 6 hours, 24 hours) | Applies to everything on the page; remembered between visits |
| KPI tiles | Requests, error rate, spend and p95 latency, each with a trend line. Error rate turns red above 5% |
| Requests | Successful and failed calls per time bucket. Hover a bar for counts and cost |
| Live stream | The seven newest calls, with provider colour, latency and cost. New ones slide in; click one for details |
| Latency | p50 and p95 latency over time. Hover for exact values |
| Cost by model | Spend per model in the selected range |

The welcome banner can be closed with **×**. Bring it back from the command
palette with **Show the welcome banner**.

### Models

One row per model across all held data: requests, errors, error rate, tokens,
cost (with a bar showing each model's share), p50/p95/p99 latency and list
price. Click a column header to sort, or a row to see that model's traces.

### Traces

Every call, newest first, 50 per page.

- Filter by model, or by status (**All**, **OK**, **Errors**).
- Search by trace ID, span ID or name (press `/` to jump to the search box).
- New rows are briefly highlighted. Latency bars are red for failed calls.
- Click a row to open the detail panel: latency, tokens and cost, the trace
  waterfall, every attribute, and copy buttons for the IDs.

### Send data

| Card | What it does |
|---|---|
| Simulate an incident | Sends 150 slow, failing calls for one random model over the last two minutes, then opens the Overview |
| Send a test span | Sends one call with the provider, model, latency, status and tokens you choose |
| Generate traffic | Sends up to 5,000 random calls with your error rate, time spread and typical latency |
| Connect your app | Ready-to-copy OpenTelemetry settings and a `curl` example for this server |

On the public demo, clearing all data is disabled, and each visitor can make
up to 60 send requests per minute.

## Command palette and shortcuts

Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux), or click **Search** in the
header. Type to filter commands, model names or trace IDs; use the arrow keys
and Enter.

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open or close the command palette |
| `g` then `o` / `m` / `t` / `s` | Go to Overview / Models / Traces / Send data |
| `/` | Search traces (or open the palette) |
| `i` | Simulate an incident |
| `p` | Pause or resume live updates |
| `t` | Switch light and dark theme |
| `Esc` | Close the palette or detail panel |

Shortcuts are ignored while you're typing in a field.

## Other controls

- **Live / Paused**: the dashboard refreshes every 5 seconds. The pause button
  in the header stops that, for example while you study a chart.
- **Theme**: the half-moon button switches between light and dark.
- **Footer**: shows which storage the server uses (in memory or ClickHouse).
- **Reduced motion**: if your device is set to reduce motion, animations are
  turned off.
- **Phones**: every page works at phone width.

## Sign-in

The public demo has no sign-in, so visitors can use every feature immediately.
Sign in with GitHub exists as an optional server feature. When it's switched
on, a **Sign in** button appears and actions such as simulating incidents need
a signed-in user. See [deployment.md](deployment.md#sign-in-with-github-optional).
