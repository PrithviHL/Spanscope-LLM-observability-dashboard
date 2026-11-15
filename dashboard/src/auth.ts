/**
 * Optional "Sign in with GitHub" (enabled when GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and SESSION_SECRET are set).
 *
 * Stateless by design, so it works on hosts without persistent storage:
 * - Sessions are HMAC-signed cookies (HttpOnly, SameSite=Lax, Secure on HTTPS).
 * - The OAuth `state` is a signed, short-lived cookie checked on callback.
 * - Ingest keys for external apps are signed tokens too; rotating
 *   SESSION_SECRET revokes every session and key at once.
 * - The GitHub access token is used once to read the public profile and is
 *   never stored. No OAuth scopes are requested.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  /** At least 32 characters; signs sessions, OAuth state and ingest keys. */
  sessionSecret: string;
  /** Public origin, e.g. https://example.onrender.com. Derived from the request if unset. */
  publicUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

export type User = { id: number; login: string; name: string; avatar: string };

type Signed<K extends string, T> = T & { kind: K; exp: number };

const SESSION_COOKIE = "ss_session";
const STATE_COOKIE = "ss_oauth";
const SESSION_TTL_S = 7 * 24 * 3600;
const STATE_TTL_S = 10 * 60;
const KEY_TTL_S = 90 * 24 * 3600;
export const INGEST_KEY_PREFIX = "ssk_";

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Compact signed token: base64url(JSON payload) "." base64url(HMAC-SHA256). */
export class TokenSigner {
  constructor(private readonly secret: string) {}

  private mac(data: string): string {
    return b64(createHmac("sha256", this.secret).update(data).digest());
  }

  sign<K extends string, T extends object>(kind: K, payload: T, ttlS: number): string {
    const body = b64(
      JSON.stringify({ ...payload, kind, exp: Math.floor(Date.now() / 1000) + ttlS }),
    );
    return `${body}.${this.mac(body)}`;
  }

  /** The payload if the signature, kind and expiry all check out; otherwise null. */
  verify<K extends string, T extends object>(
    token: string | undefined,
    kind: K,
  ): Signed<K, T> | null {
    if (!token) return null;
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined || !safeEqual(sig, this.mac(body))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Signed<K, T>;
      if (p.kind !== kind || typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
      return p;
    } catch {
      return null;
    }
  }
}

/** Only same-site relative paths, so the post-login redirect can't be an open redirect. */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

const page = (title: string, message: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#222">
<h1 style="font-size:20px">${title}</h1><p>${message}</p><p><a href="/">Back to Spanscope</a></p></body>`;

export class GitHubAuth {
  readonly signer: TokenSigner;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: AuthConfig) {
    if (cfg.sessionSecret.length < 32)
      throw new Error("SESSION_SECRET must be at least 32 characters");
    this.signer = new TokenSigner(cfg.sessionSecret);
    this.fetchFn = cfg.fetch ?? fetch;
  }

  private origin(c: Context): string {
    if (this.cfg.publicUrl) return this.cfg.publicUrl.replace(/\/+$/, "");
    const url = new URL(c.req.url);
    const proto =
      c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host;
    return `${proto}://${host}`;
  }

  private cookieOpts(c: Context, maxAge: number) {
    return {
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: this.origin(c).startsWith("https://"),
      maxAge,
    };
  }

  /** The signed-in browser user, from the session cookie. */
  sessionUser(c: Context): User | null {
    const p = this.signer.verify<"session", User>(getCookie(c, SESSION_COOKIE), "session");
    return p ? { id: p.id, login: p.login, name: p.name, avatar: p.avatar } : null;
  }

  /** The owner of a valid `Authorization: Bearer ssk_…` ingest key. */
  keyUser(c: Context): User | null {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const token = m?.[1];
    if (!token?.startsWith(INGEST_KEY_PREFIX)) return null;
    const p = this.signer.verify<"ingest", User>(token.slice(INGEST_KEY_PREFIX.length), "ingest");
    return p ? { id: p.id, login: p.login, name: p.name, avatar: p.avatar } : null;
  }

  issueIngestKey(user: User): { key: string; expiresAt: string } {
    const key = INGEST_KEY_PREFIX + this.signer.sign("ingest", user, KEY_TTL_S);
    return { key, expiresAt: new Date(Date.now() + KEY_TTL_S * 1000).toISOString() };
  }

  /** Mount /auth/github/login, /auth/github/callback and /auth/logout. */
  mount(app: Hono): void {
    app.get("/auth/github/login", (c) => {
      const state = b64(randomBytes(24));
      const next = safeNext(c.req.query("next"));
      setCookie(
        c,
        STATE_COOKIE,
        this.signer.sign("state", { state, next }, STATE_TTL_S),
        this.cookieOpts(c, STATE_TTL_S),
      );
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", this.cfg.clientId);
      url.searchParams.set("redirect_uri", `${this.origin(c)}/auth/github/callback`);
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "true");
      return c.redirect(url.toString(), 302);
    });

    app.get("/auth/github/callback", async (c) => {
      const saved = this.signer.verify<"state", { state: string; next: string }>(
        getCookie(c, STATE_COOKIE),
        "state",
      );
      deleteCookie(c, STATE_COOKIE, { path: "/" });
      const next = safeNext(saved?.next);
      if (c.req.query("error")) return c.redirect(next, 302); // user pressed Cancel on GitHub
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!saved || !code || !state || !safeEqual(state, saved.state)) {
        return c.html(
          page("Sign-in expired", "That sign-in link is invalid or expired. Please try again."),
          400,
        );
      }
      try {
        const user = await this.fetchGitHubUser(code, `${this.origin(c)}/auth/github/callback`);
        setCookie(
          c,
          SESSION_COOKIE,
          this.signer.sign("session", user, SESSION_TTL_S),
          this.cookieOpts(c, SESSION_TTL_S),
        );
        return c.redirect(next, 302);
      } catch (err) {
        console.error(`[spanscope] GitHub sign-in failed: ${String(err)}`);
        return c.html(
          page("Sign-in failed", "GitHub didn't confirm the sign-in. Please try again."),
          502,
        );
      }
    });

    app.post("/auth/logout", (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.body(null, 204);
    });
  }

  private async fetchGitHubUser(code: string, redirectUri: string): Promise<User> {
    const tokenRes = await this.fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new Error(`token exchange: ${tok.error ?? tokenRes.status}`);
    const userRes = await this.fetchFn("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${tok.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "spanscope",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) throw new Error(`GitHub /user returned ${userRes.status}`);
    const u = (await userRes.json()) as {
      id: number;
      login: string;
      name?: string | null;
      avatar_url?: string;
    };
    return { id: u.id, login: u.login, name: u.name || u.login, avatar: u.avatar_url ?? "" };
  }
}
