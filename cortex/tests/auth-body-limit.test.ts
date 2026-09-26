/**
 * LOT 2b-11 — /api/auth/* est PUBLIC (avant login) et le gestionnaire NextAuth lit
 * le corps sans borne. Le proxy refuse en amont un corps trop grand ou non
 * annoncé sur ces chemins : 64 Kio suffisent à tout formulaire de connexion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_BODY_MAX_BYTES, authBodyLimit } from "../lib/auth-body-limit";

const req = (method: string, pathname: string, headers: Record<string, string> = {}) =>
  ({ method, pathname, headers: new Headers(headers) });

test("GET et chemins hors /api/auth : jamais concernés", () => {
  assert.equal(authBodyLimit(req("GET", "/api/auth/session")), null);
  assert.equal(authBodyLimit(req("POST", "/api/jobs", { "content-length": "99999999" })), null);
});

test("POST /api/auth/* : trop grand → 413 ; longueur absente → 411 ; invalide → 400", () => {
  assert.equal(AUTH_BODY_MAX_BYTES, 64 * 1024);
  assert.equal(authBodyLimit(req("POST", "/api/auth/callback/credentials", { "content-length": "1024" })), null);
  assert.deepEqual(authBodyLimit(req("POST", "/api/auth/signin/email", { "content-length": String(64 * 1024 + 1) }))?.status, 413);
  assert.deepEqual(authBodyLimit(req("POST", "/api/auth/signin/email", { "transfer-encoding": "chunked" }))?.status, 411);
  assert.deepEqual(authBodyLimit(req("POST", "/api/auth/signin/email", { "content-length": "1e3" }))?.status, 400);
  assert.equal(authBodyLimit(req("POST", "/api/auth/signout")), null, "sans corps du tout (ni longueur ni chunked) : rien à borner");
});
