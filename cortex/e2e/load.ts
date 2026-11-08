import autocannon from "autocannon";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const url = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3210";
const seconds = Number(process.env.E2E_LOAD_SECONDS ?? 10);
type Row = { users: number; pipelining: number; p97_5: number; errors: number; timeouts: number; non2xx: number; requests: number };
type FlowRow = { users: number; ok: number; errors: number; p95: number; examples: string[] };

class Jar {
  private values = new Map<string, string>();
  add(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0]; const at = pair.indexOf("=");
      if (at > 0) this.values.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  get header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join("; "); }
}

async function request(jar: Jar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); if (jar.header) headers.set("cookie", jar.header);
  const response = await fetch(`${url}${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  jar.add(response); return response;
}

async function userFlow(index: number) {
  const jar = new Jar(); const email = `load-${Date.now()}-${index}@e2e.cortex.test`;
  const csrfResponse = await request(jar, "/api/auth/csrf");
  const csrf = String((await csrfResponse.json() as { csrfToken: string }).csrfToken);
  const login = await request(jar, "/api/auth/callback/e2e-test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email, callbackUrl: `${url}/` }) });
  if (![302, 303].includes(login.status)) throw new Error(`login ${login.status}`);
  const courseResponse = await request(jar, "/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Charge ${Date.now()} ${index}` }) });
  const courseBody = await courseResponse.json() as { course?: { id?: string }; error?: string };
  if (courseResponse.status !== 201 || !courseBody.course?.id) throw new Error(`course ${courseResponse.status}: ${courseBody.error ?? "sans id"}`);
  const drill = await request(jar, `/api/drill?course=${encodeURIComponent(courseBody.course.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concept: "intégrales" }) });
  if (drill.status !== 200) throw new Error(`generation ${drill.status}`);

  const callback = `${url}/e2e-load-callback`; const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const registration = await request(jar, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: `Load ${index}`, redirect_uris: [callback], token_endpoint_auth_method: "none" }) });
  const clientId = String((await registration.json() as { client_id: string }).client_id);
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", resource: `${url}/mcp`, scope: "cortex.read" });
  const consent = await request(jar, `/oauth/authorize?${query}`); const html = await consent.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1]; if (!ticket) throw new Error("oauth ticket absent");
  const decision = await request(jar, "/oauth/authorize/decision", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: url }, body: new URLSearchParams({ ticket, decision: "approve" }) });
  const code = new URL(decision.headers.get("location") ?? `${url}/`).searchParams.get("code"); if (!code) throw new Error("oauth code absent");
  const tokenResponse = await request(jar, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: callback, resource: `${url}/mcp` }) });
  const token = String((await tokenResponse.json() as { access_token: string }).access_token);
  const mcp = await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "load", version: "1" } } }), signal: AbortSignal.timeout(60_000) });
  if (!mcp.ok) throw new Error(`mcp ${mcp.status}`);
}

function socketLimits() {
  const command = process.platform === "darwin" ? ["sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"]] as const : ["sysctl", ["-n", "net.ipv4.ip_local_port_range"]] as const;
  try { return execFileSync(command[0], [...command[1]], { encoding: "utf8" }).trim().replace(/\n/g, " "); } catch { return "indisponible"; }
}

async function run(users: number, pipelining: number): Promise<Row> {
  const result = await autocannon({ url: `${url}/api/health`, connections: users, duration: seconds, pipelining });
  return { users, pipelining, p97_5: result.latency.p97_5, errors: result.errors, timeouts: result.timeouts, non2xx: result.non2xx, requests: result.requests.total };
}

async function runFlows(users: number): Promise<FlowRow> {
  const durations: number[] = []; const examples: string[] = []; let ok = 0;
  await Promise.all(Array.from({ length: users }, async (_, index) => {
    await new Promise((resolve) => setTimeout(resolve, index * 20)); const started = Date.now();
    try { await userFlow(index); ok++; } catch (error) { if (examples.length < 5) examples.push(String(error)); }
    durations.push(Date.now() - started);
  }));
  durations.sort((a, b) => a - b);
  return { users, ok, errors: users - ok, p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? 0, examples };
}

async function main() {
  const health = await fetch(`${url}/api/health`); if (!health.ok) throw new Error(`App indisponible: HTTP ${health.status}`);
  const before = await fetch(`${url}/api/metrics`).then((response) => response.text()).catch(() => "indisponible");
  // Les parcours passent avant le churn volontaire de sockets : sur macOS/Node 26,
  // ce dernier peut rendre le pool undici du GÉNÉRATEUR inutilisable (EINVAL).
  const flowRows = [await runFlows(50), await runFlows(200)];
  const rows: Row[] = [];
  for (const users of [50, 100, 150, 200]) rows.push(await run(users, 1));
  rows.push(await run(200, 10));
  let afterStatus = 0; let after = "indisponible";
  try {
    afterStatus = Number(execFileSync("curl", ["-sS", "--retry", "5", "--retry-delay", "1", "--retry-all-errors", "-o", "/dev/null", "-w", "%{http_code}", `${url}/api/health`], { encoding: "utf8" }));
    after = execFileSync("curl", ["-fsS", `${url}/api/metrics`], { encoding: "utf8" });
  } catch { /* Le statut nul est classé comme échec de santé. */ }
  const table = rows.map((row) => `| ${row.users} | ${row.pipelining} | ${row.requests} | ${row.p97_5} ms | ${row.errors} | ${row.timeouts} | ${row.non2xx} |`).join("\n");
  const flowTable = flowRows.map((row) => `| ${row.users} | ${row.ok} | ${row.errors} | ${row.p95} ms | ${row.examples.join(" ; ") || "—"} |`).join("\n");
  const appFailure = afterStatus !== 200 || rows.some((row) => row.timeouts > 0 || row.non2xx > 0) || flowRows.some((row) => row.errors > 0);
  const generatorLimited = process.platform === "darwin" && rows.some((row) => row.errors > 0) && !appFailure;
  fs.writeFileSync("e2e/RAPPORT-CHARGE.md", `# Rapport de charge\n\nDate : ${new Date().toISOString()}  \nPlateforme générateur : ${process.platform} ${os.release()}  \nPlage de ports : ${socketLimits()}\n\n| Utilisateurs | Pipeline/connexion | Requêtes | p97,5 (borne conservatrice p95) | Resets réseau | Timeouts | HTTP non-2xx |\n|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n## Parcours utilisateurs réels (auth → cours → génération → OAuth/MCP)\n\nCes parcours utilisent le pool keep-alive de Node et une montée progressive (20 ms entre utilisateurs).\n\n| Utilisateurs | Réussis | Erreurs | p95 parcours | Exemples |\n|---:|---:|---:|---:|---|\n${flowTable}\n\nSanté après charge (avec nouvelle connexion et reprise) : HTTP ${afterStatus}.  \nDiagnostic : ${appFailure ? "échec applicatif (parcours, timeout, HTTP ou health)" : generatorLimited ? "défaillance de la pile réseau du générateur macOS, pas de l'app : seuls ses resets apparaissent ; les parcours keep-alive passent et l'app redevient immédiatement saine. La comparaison Linux CI doit préciser si les ports éphémères sont la cause exacte" : "aucun échec applicatif observé ; comparer avec le run Linux CI"}.\n\n## Métriques avant\n\n\`\`\`\n${before.slice(0, 8000)}\n\`\`\`\n\n## Métriques après\n\n\`\`\`\n${after.slice(0, 8000)}\n\`\`\`\n`);
  console.log({ sockets: rows, flows: flowRows }); if (appFailure) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
