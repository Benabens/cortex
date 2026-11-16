/**
 * SONDE DU CONNECTEUR MCP — rejoue, contre une instance de Cortex, ce que fait
 * chaque client MCP avant d'afficher sa page de connexion : découverte (401 +
 * WWW-Authenticate, métadonnées RFC 9728 et RFC 8414), carte du serveur, icônes,
 * CORS depuis le navigateur du client, puis son enregistrement (CIMD ou DCR).
 *
 *   npx tsx scripts/oauth-probe.ts                                   # local, tous les préréglages
 *   npx tsx scripts/oauth-probe.ts --base https://app.cortexexam.com --preset chatgpt,chatgpt-cimd
 *   npx tsx scripts/oauth-probe.ts --base … --no-register            # aucune écriture
 *
 * Aucun compte, aucune session, aucun jeton : rien n'est autorisé ni débité.
 * L'acceptation d'un client se lit au point de jeton avec un code inventé :
 * « invalid_grant » = client accepté (seul le code est faux), « invalid_client » = refusé.
 * Seule écriture : l'enregistrement DCR (préréglages DCR, sauf --no-register), un client
 * nommé « cortex-probe … » jamais autorisé, purgé par Cortex au bout de 7 jours.
 * Code de sortie 1 si une vérification échoue.
 */

type Dcr = { redirects: string[]; kept: string[] };
type Cimd = { clientId: string; redirect: string; assertion?: boolean };
type Preset = { label: string; origin?: string; cimd?: Cimd; dcr?: Dcr; note?: string };

const PRESETS: Record<string, Preset> = {
  claude: {
    label: "Claude (claude.ai, Desktop, mobile)", origin: "https://claude.ai",
    cimd: { clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", redirect: "https://claude.ai/api/mcp/auth_callback" },
    dcr: { redirects: ["https://claude.ai/api/mcp/auth_callback"], kept: ["https://claude.ai/api/mcp/auth_callback"] },
  },
  "claude-code": {
    label: "Claude Code",
    cimd: { clientId: "https://claude.ai/oauth/claude-code-client-metadata", redirect: "http://localhost:54123/callback" },
  },
  chatgpt: {
    label: "ChatGPT (DCR)", origin: "https://chatgpt.com",
    dcr: {
      redirects: ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/cortex_probe"],
      kept: ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/cortex_probe"],
    },
  },
  "chatgpt-cimd": {
    label: "ChatGPT (CIMD, assertion private_key_jwt au point de jeton)", origin: "https://chatgpt.com",
    cimd: { clientId: "https://chatgpt.com/oauth/client.json", redirect: "https://chatgpt.com/connector_platform_oauth_redirect", assertion: true },
  },
  cursor: {
    label: "Cursor",
    dcr: { redirects: ["http://localhost:8787/callback", "cursor://anysphere.cursor-mcp/oauth/callback"], kept: ["http://localhost:8787/callback"] },
  },
  vscode: {
    label: "VS Code", origin: "https://vscode.dev",
    dcr: { redirects: ["https://vscode.dev/redirect", "http://127.0.0.1:33418"], kept: ["https://vscode.dev/redirect", "http://127.0.0.1:33418"] },
  },
  "gemini-cli": {
    label: "Gemini CLI",
    dcr: { redirects: ["http://localhost:7777/oauth/callback"], kept: ["http://localhost:7777/oauth/callback"] },
  },
  codex: {
    label: "Codex CLI", note: "port local choisi par Codex : chemin indicatif",
    dcr: { redirects: ["http://127.0.0.1:43210/callback"], kept: ["http://127.0.0.1:43210/callback"] },
  },
};

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes("-h") || a.includes("--help")) {
    console.log(`Usage : npx tsx scripts/oauth-probe.ts [--base URL] [--preset ${Object.keys(PRESETS).join(",")}|all] [--no-register]`);
    process.exit(0);
  }
  const base = (val("--base") ?? "http://localhost:3000").replace(/\/+$/, "");
  const wanted = (val("--preset") ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
  const names = wanted.includes("all") ? Object.keys(PRESETS) : wanted;
  for (const n of names) if (!PRESETS[n]) { console.error(`Préréglage inconnu : ${n}`); process.exit(2); }
  return { base, names, register: !a.includes("--no-register") };
}

let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? ` : ${detail}` : ""}`);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

const fakeAssertion = (sub: string) =>
  [{ alg: "RS256", typ: "JWT" }, { iss: sub, sub, exp: Math.floor(Date.now() / 1000) + 300 }]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".sonde";

/** Point de jeton avec un code inventé : invalid_grant = client accepté. */
async function clientAccepted(tokenEndpoint: string, resource: string, clientId: string, redirect: string, assertion = false) {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: "cortex-probe-invalid", code_verifier: "x".repeat(50), redirect_uri: redirect, resource });
  if (assertion) {
    form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    form.set("client_assertion", fakeAssertion(clientId));
  } else form.set("client_id", clientId);
  const res = await fetch(tokenEndpoint, { method: "POST", body: form });
  const body = await json(res);
  check(body.error === "invalid_grant", "client accepté au point de jeton", `${res.status} ${String(body.error ?? "")}`);
}

async function main() {
  const { base, names, register } = args();
  const mcp = `${base}/mcp`;
  console.log(`Sonde du connecteur MCP : ${mcp}\n\nDécouverte (commune à tous les clients)`);

  const challenge = await fetch(mcp, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const www = challenge.headers.get("www-authenticate") ?? "";
  check(challenge.status === 401, "POST /mcp sans jeton → 401", String(challenge.status));
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  check(!!prmUrl, "WWW-Authenticate annonce resource_metadata", prmUrl ?? www);
  check(/scope="[^"]*cortex\.read/.test(www), "WWW-Authenticate annonce les portées");

  const prm = await json(await fetch(prmUrl ?? `${base}/.well-known/oauth-protected-resource/mcp`));
  check(prm.resource === mcp, "ressource protégée = adresse MCP (RFC 9728)", String(prm.resource));
  const asBase = (prm.authorization_servers as string[] | undefined)?.[0];
  check(!!asBase, "serveur d'autorisation annoncé", asBase);
  const as = await json(await fetch(`${asBase ?? base}/.well-known/oauth-authorization-server`));
  check(((as.code_challenge_methods_supported as string[]) ?? []).includes("S256"), "PKCE S256");
  check(as.authorization_response_iss_parameter_supported === true, "iss dans la réponse d'autorisation (retour stable de ChatGPT)");
  check(as.client_id_metadata_document_supported === true, "CIMD pris en charge");
  check(typeof as.registration_endpoint === "string", "enregistrement dynamique (DCR)");
  check(((as.token_endpoint_auth_methods_supported as string[]) ?? []).includes("none"), "clients publics (« none »)");
  const tokenEndpoint = String(as.token_endpoint ?? `${base}/oauth/token`);

  for (const p of ["/mcp/server-card", "/.well-known/mcp/server-card.json"]) {
    const res = await fetch(`${base}${p}`);
    const card = await json(res);
    const url = (card.remotes as { url?: string }[] | undefined)?.[0]?.url;
    check(res.status === 200 && url === mcp, `carte du serveur ${p}`, `${res.status} ${url ?? ""}`);
    check(res.headers.get("access-control-allow-origin") === "*", `${p} lisible depuis tout navigateur`);
  }
  for (const icon of (await json(await fetch(`${base}/mcp/server-card`))).icons as { src: string; mimeType: string }[] ?? []) {
    const res = await fetch(icon.src);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 0);
    check(res.status === 200 && (res.headers.get("content-type") ?? "").startsWith(icon.mimeType), `icône ${new URL(icon.src).pathname}`, `${res.status} ${res.headers.get("content-type")}`);
    check(maxAge >= 86400, `  cache long`, res.headers.get("cache-control") ?? "absent");
  }

  for (const name of names) {
    const p = PRESETS[name];
    console.log(`\n${p.label} [${name}]${p.note ? ` (${p.note})` : ""}`);
    if (p.origin) {
      const res = await fetch(mcp, {
        method: "OPTIONS",
        headers: { origin: p.origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, mcp-protocol-version" },
      });
      check(res.headers.get("access-control-allow-origin") === p.origin, `CORS depuis ${p.origin}`, `${res.status} ${res.headers.get("access-control-allow-origin") ?? "aucun en-tête"}`);
    }
    if (p.cimd) await clientAccepted(tokenEndpoint, mcp, p.cimd.clientId, p.cimd.redirect, p.cimd.assertion);
    if (p.dcr) {
      if (!register) { console.log("  · enregistrement DCR sauté (--no-register)"); continue; }
      const res = await fetch(String(as.registration_endpoint ?? `${base}/oauth/register`), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: `cortex-probe ${name}`, redirect_uris: p.dcr.redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      });
      const reg = await json(res);
      check(res.status === 201, "enregistrement DCR", `${res.status} ${String(reg.error ?? "")} ${String(reg.error_description ?? "")}`.trim());
      if (res.status !== 201) continue;
      check(JSON.stringify(reg.redirect_uris) === JSON.stringify(p.dcr.kept), "URL de retour retenues", JSON.stringify(reg.redirect_uris));
      await clientAccepted(tokenEndpoint, mcp, String(reg.client_id), p.dcr.kept[0]);
    }
  }

  console.log(failures ? `\n${failures} vérification(s) en échec.` : "\nTout est conforme.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
