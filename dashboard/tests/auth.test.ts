import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GitHubAuth, TokenSigner, safeNext, type AuthConfig } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { ObservabilityStore } from "../src/store.js";

const SECRET = "x".repeat(40);
const ghUser = {
  id: 42,
  login: "octo",
  name: "Octo Cat",
  avatar_url: "https://avatars.example/42",
};

/** Fake github.com + api.github.com. */
function fakeGitHub(opts: { tokenOk?: boolean } = {}) {
  const seen: { url: string; body: string }[] = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/login/oauth/access_token")) {
      return Response.json(
        opts.tokenOk === false ? { error: "bad_verification_code" } : { access_token: "gho_test" },
      );
    }
    if (url === "https://api.github.com/user") return Response.json(ghUser);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetchFn };
}

function setup(cfg: Partial<AuthConfig> = {}) {
  const gh = fakeGitHub();
  const auth = new GitHubAuth({
    clientId: "cid",
    clientSecret: "csecret",
    sessionSecret: SECRET,
    publicUrl: "https://spanscope.test",
    fetch: gh.fetchFn,
    ...cfg,
  });
  const store = new ObservabilityStore(100);
  const app = buildApp(store, { auth });
  return { app, auth, store, gh };
}

/** "a=1; b=2" from a response's Set-Cookie headers (ignoring deletions). */
const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");

const span = JSON.stringify({
  attributes: { "gen_ai.system": "openai", "gen_ai.request.model": "gpt-4o-mini" },
});
const post = (app: ReturnType<typeof buildApp>, headers: Record<string, string> = {}) =>
  app.request("/trace", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: span,
  });

async function signIn(app: ReturnType<typeof buildApp>, next = "/#/send") {
  const login = await app.request(`/auth/github/login?next=${encodeURIComponent(next)}`);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const cb = await app.request(`/auth/github/callback?code=abc&state=${state}`, {
    headers: { cookie: cookiesFrom(login) },
  });
  return { login, cb, cookie: cookiesFrom(cb) };
}

test("TokenSigner rejects tampering, wrong kind and expiry", () => {
  const s = new TokenSigner(SECRET);
  const t = s.sign("session", { login: "a" }, 60);
  assert.equal(s.verify<"session", { login: string }>(t, "session")?.login, "a");
  assert.equal(s.verify(t, "ingest"), null); // a session can't be used as an ingest key
  const [body, sig] = t.split(".");
  const forged = Buffer.from(
    JSON.stringify({ login: "admin", kind: "session", exp: 9e9 }),
  ).toString("base64url");
  assert.equal(s.verify(`${forged}.${sig}`, "session"), null);
  assert.equal(s.verify(`${body}.${sig}x`, "session"), null);
  assert.equal(new TokenSigner("y".repeat(40)).verify(t, "session"), null);
  assert.equal(s.verify(s.sign("session", {}, -1), "session"), null);
});

test("safeNext only allows same-site relative paths", () => {
  assert.equal(safeNext("/#/send"), "/#/send");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", undefined]) {
    assert.equal(safeNext(bad), "/");
  }
});

test("login redirects to GitHub with state and no scopes", async () => {
  const { app } = setup();
  const res = await app.request("/auth/github/login?next=/%23/send");
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get("location")!);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://spanscope.test/auth/github/callback");
  assert.ok((url.searchParams.get("state") ?? "").length >= 32);
  assert.equal(url.searchParams.get("scope"), null);
  const cookie = res.headers.getSetCookie()[0]!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("full sign-in: session cookie, /api/me, and the client secret stays server-side", async () => {
  const { app, gh } = setup();
  const { cb, cookie } = await signIn(app);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/#/send");
  const me = (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
    authEnabled: boolean;
    user: { login: string; name: string; id: number };
  };
  assert.equal(me.authEnabled, true);
  assert.deepEqual([me.user.id, me.user.login, me.user.name], [42, "octo", "Octo Cat"]);
  assert.ok(gh.seen[0]!.body.includes("csecret"));
  assert.ok(!cb.headers.getSetCookie().join().includes("gho_test")); // GitHub token never stored
});

test("callback rejects a missing or mismatched state", async () => {
  const { app } = setup();
  const login = await app.request("/auth/github/login");
  const bad = await app.request("/auth/github/callback?code=abc&state=wrong", {
    headers: { cookie: cookiesFrom(login) },
  });
  assert.equal(bad.status, 400);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const noCookie = await app.request(`/auth/github/callback?code=abc&state=${state}`);
  assert.equal(noCookie.status, 400);
});

test("a failed token exchange shows an error and signs nobody in", async () => {
  const gh = fakeGitHub({ tokenOk: false });
  const { app } = setup({ fetch: gh.fetchFn });
  const { cb, cookie } = await signIn(app);
  assert.equal(cb.status, 502);
  assert.equal(cookie.includes("ss_session"), false);
});

test("cancelling on GitHub returns to the app without signing in", async () => {
  const { app } = setup();
  const login = await app.request("/auth/github/login?next=/%23/traces");
  const res = await app.request("/auth/github/callback?error=access_denied", {
    headers: { cookie: cookiesFrom(login) },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/#/traces");
});

test("writes need sign-in; reads stay public", async () => {
  const { app, store } = setup();
  assert.equal((await post(app)).status, 401);
  assert.equal((await app.request("/api/spans", { method: "DELETE" })).status, 401);
  assert.equal((await app.request("/api/overview")).status, 200);
  assert.equal((await app.request("/api/spans")).status, 200);
  const { cookie } = await signIn(app);
  assert.equal((await post(app, { cookie })).status, 202);
  assert.equal(store.counters().held, 1);
});

test("ingest keys: issued to signed-in users, accepted as Bearer, forgeries rejected", async () => {
  const { app } = setup();
  assert.equal((await app.request("/api/keys", { method: "POST" })).status, 401);
  const { cookie } = await signIn(app);
  const res = await app.request("/api/keys", { method: "POST", headers: { cookie } });
  assert.equal(res.status, 201);
  const { key, expiresAt } = (await res.json()) as { key: string; expiresAt: string };
  assert.match(key, /^ssk_/);
  assert.ok(Date.parse(expiresAt) > Date.now() + 80 * 86_400_000);
  assert.equal((await post(app, { authorization: `Bearer ${key}` })).status, 202);
  assert.equal((await post(app, { authorization: `Bearer ${key}x` })).status, 401);
  // The session cookie value can't be replayed as an ingest key.
  const session = cookie.split("ss_session=")[1]!.split(";")[0]!;
  assert.equal((await post(app, { authorization: `Bearer ssk_${session}` })).status, 401);
  // Keys from a server with another secret are rejected.
  const other = setup({ sessionSecret: "z".repeat(40) });
  assert.equal((await post(other.app, { authorization: `Bearer ${key}` })).status, 401);
});

test("logout clears the session cookie", async () => {
  const { app } = setup();
  const res = await app.request("/auth/logout", { method: "POST" });
  assert.equal(res.status, 204);
  assert.match(res.headers.getSetCookie()[0]!, /ss_session=;.*Max-Age=0/);
});

test("without sign-in configured, everything works as before", async () => {
  const app = buildApp(new ObservabilityStore(10));
  assert.deepEqual(await (await app.request("/api/me")).json(), { authEnabled: false, user: null });
  assert.equal((await post(app)).status, 202);
  assert.equal((await app.request("/auth/github/login")).status, 404);
});

test("config: sign-in needs both GitHub values and a long SESSION_SECRET", () => {
  assert.equal(loadConfig([], {}).auth, null);
  assert.throws(() => loadConfig([], { GITHUB_CLIENT_ID: "a" }), /GITHUB_CLIENT_SECRET/);
  assert.throws(
    () =>
      loadConfig([], { GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b", SESSION_SECRET: "short" }),
    /SESSION_SECRET/,
  );
  assert.throws(
    () =>
      loadConfig([], {
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
        SESSION_SECRET: SECRET,
        PUBLIC_URL: "https://x.com/path",
      }),
    /PUBLIC_URL/,
  );
  assert.deepEqual(
    loadConfig([], {
      GITHUB_CLIENT_ID: "a",
      GITHUB_CLIENT_SECRET: "b",
      SESSION_SECRET: SECRET,
      PUBLIC_URL: "https://x.com",
    }).auth,
    { clientId: "a", clientSecret: "b", sessionSecret: SECRET, publicUrl: "https://x.com" },
  );
});
