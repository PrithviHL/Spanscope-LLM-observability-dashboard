import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildApp, MAX_BODY_BYTES } from "../src/server.js";
import { flattenOtlp } from "../src/otlp.js";
import { ObservabilityStore } from "../src/store.js";

const otlpBody = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "chatbot" } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "5b8efff798038103d269b633813fc60c",
              spanId: "eee19b7ec3c1b174",
              parentSpanId: "",
              name: "chat gpt-4o-mini",
              startTimeUnixNano: "1731000000000000000",
              endTimeUnixNano: "1731000000500000000",
              status: { code: 2 },
              attributes: [
                { key: "gen_ai.system", value: { stringValue: "openai" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
                {
                  key: "gen_ai.response.finish_reasons",
                  value: { arrayValue: { values: [{ stringValue: "stop" }] } },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("flattenOtlp decodes OTLP JSON attributes, status and resource attrs", () => {
  const [flat] = flattenOtlp(otlpBody);
  assert.ok(flat);
  const attrs = flat["attributes"] as Record<string, unknown>;
  assert.equal(attrs["gen_ai.usage.input_tokens"], 120);
  assert.equal(attrs["service.name"], "chatbot");
  assert.deepEqual(attrs["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(flat["status"], "ERROR");
  assert.equal(flat["parent_span_id"], undefined);
});

test("POST /v1/traces accepts a real OTLP/HTTP JSON export", async () => {
  const store = new ObservabilityStore();
  const app = buildApp(store);
  const res = await post(app, "/v1/traces", otlpBody);
  assert.equal(res.status, 202);
  assert.deepEqual(store.counters(), { accepted: 1, rejected: 0, held: 1 });
  const [span] = store.snapshot();
  assert.equal(span?.status, "ERROR");
  assert.equal(span?.end_time_unix_nano - span!.start_time_unix_nano, 500_000_000);
});

test("a span with a non-string response model does not break the dashboard", async () => {
  const store = new ObservabilityStore();
  const app = buildApp(store);
  await post(app, "/trace", {
    start_time_unix_nano: 0,
    end_time_unix_nano: 5_000_000,
    attributes: {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.response.model": 123,
    },
  });
  const res = await app.request("/dashboard");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /gpt-4o-mini/);
});

test("dashboard escapes model names", async () => {
  const store = new ObservabilityStore();
  store.ingest({
    attributes: { "gen_ai.system": "x", "gen_ai.request.model": "<script>alert(1)</script>" },
  });
  const html = await (await buildApp(store).request("/dashboard")).text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("invalid JSON returns 400 and oversized bodies return 413", async () => {
  const app = buildApp(new ObservabilityStore());
  assert.equal((await post(app, "/trace", "not json")).status, 400);
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  assert.equal((await post(app, "/trace", big)).status, 413);
});

test("ingest does not mutate the caller's attribute object", () => {
  const attrs = { "gen_ai.system": "openai", "gen_ai.request.model": "m" };
  new ObservabilityStore().ingest({ attributes: attrs });
  assert.deepEqual(attrs, { "gen_ai.system": "openai", "gen_ai.request.model": "m" });
});
