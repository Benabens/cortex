import { test, expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { loginPersona } from "./helpers";

const origin = "http://localhost:3210";
const callback = `${origin}/e2e-oauth-callback`;

async function oauthClient(page: Page, persona: string) {
  await page.context().clearCookies(); await loginPersona(page, persona);
  const created = await page.evaluate(async (name) => {
    const response = await fetch("/api/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Création du cours: HTTP ${response.status}`);
    if (body.course?.id) return body.course as { id: string };
    const listed = await fetch("/api/courses").then((r) => r.json());
    return listed.courses.find((course: { name: string }) => course.name === name) as { id: string };
  }, `MCP ${persona} ${Date.now()}`);
  const registration = await page.evaluate(async ({ persona, callback }) => {
    const response = await fetch("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: `E2E ${persona}`, redirect_uris: [callback], token_endpoint_auth_method: "none" }) });
    return { status: response.status, body: await response.json() };
  }, { persona, callback });
  expect(registration.status).toBe(201); const clientId = String(registration.body.client_id);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp`, scope: "cortex.read cortex.write cortex.generate", state: "e2e" });
  await page.goto(`/oauth/authorize?${params}`);
  await expect(page.getByRole("button", { name: "Autoriser" })).toBeVisible();
  const ticket = await page.locator('input[name="ticket"]').inputValue();
  const decision = await page.request.post("/oauth/authorize/decision", {
    form: { ticket, decision: "approve", generate: "on", write: "on" },
    headers: { origin }, maxRedirects: 0,
  });
  expect(decision.status()).toBe(303);
  const callbackUrl = decision.headers().location;
  expect(callbackUrl).toContain("code=");
  const code = new URL(callbackUrl).searchParams.get("code")!;
  expect(code, callbackUrl).toMatch(/^cx_code_/);
  const tokenResponse = await page.evaluate(async (fields) => {
    const response = await fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    return { status: response.status, body: await response.json() };
  }, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: callback, resource: `${origin}/mcp` });
  expect(tokenResponse.status, JSON.stringify(tokenResponse.body)).toBe(200); const accessToken = String(tokenResponse.body.access_token);
  const client = new Client({ name: `e2e-${persona}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => accessToken } });
  await client.connect(transport);
  return { client, transport, course: created.id };
}

const structured = (result: CallToolResult) => result.structuredContent as Record<string, unknown> | undefined;

test("MCP OAuth appelle chaque outil et lie les confirmations au bon compte", async ({ page }) => {
  const alice = await oauthClient(page, `mcp-alice-${Date.now()}`);
  const tools = await alice.client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "add_course_source", "check_answer", "create_course", "generate_drill", "generate_mock_exam", "get_account_status", "get_job_status", "get_results", "get_study_plan", "get_weak_points", "list_courses", "prepare_course", "report_question", "search_course_materials", "set_exam_format",
  ]);
  const args: Record<string, Record<string, unknown>> = {
    add_course_source: { course: alice.course, text: "Les intégrales utilisent des primitives.", title: "Notes E2E", category: "notes" },
    check_answer: { course: alice.course, statement: "Calcule 1+1", answer: "2" },
    create_course: { name: `Cours outil ${Date.now()}` },
    generate_drill: { course: alice.course, concept: "intégrales" },
    generate_mock_exam: { course: alice.course, format: "written", exercise_count: 1 },
    get_account_status: {}, get_job_status: { course: alice.course }, get_results: { course: alice.course },
    get_study_plan: { course: alice.course }, get_weak_points: { course: alice.course }, list_courses: {},
    prepare_course: { course: alice.course },
    report_question: { course: alice.course, exam_id: 999999, question_number: 1, reason: "wrong_answer" },
    search_course_materials: { course: alice.course, query: "intégrales" },
    set_exam_format: { course: alice.course, kind: "exercises", question_count: 2, duration_min: 60, language: "fr" },
  };
  const results = new Map<string, CallToolResult>();
  const expectedBusinessErrors = new Set(["generate_mock_exam", "prepare_course", "report_question"]);
  for (const tool of tools.tools) {
    const result = await alice.client.callTool({ name: tool.name, arguments: args[tool.name] }) as CallToolResult;
    results.set(tool.name, result); expect(result.content.length).toBeGreaterThan(0);
    if (result.isError && expectedBusinessErrors.has(tool.name)) {
      expect(JSON.stringify(result.content)).toMatch(tool.name === "report_question" ? /n'a pas de question/i : /Solde insuffisant/i);
    } else expect(result.isError, `${tool.name}: ${JSON.stringify(result.content)}`).not.toBeTruthy();
  }
  const quote = structured(results.get("generate_drill")!);
  const token = ((quote?.confirmation as { confirmation_token?: string } | undefined)?.confirmation_token);
  expect(token, JSON.stringify(quote)).toBeTruthy();

  const bob = await oauthClient(page, `mcp-bob-${Date.now()}`);
  const stolen = await bob.client.callTool({ name: "generate_drill", arguments: { course: bob.course, concept: "intégrales", confirmation_token: token } }) as CallToolResult;
  expect(stolen.isError).toBeTruthy();
  await bob.transport.close(); await alice.transport.close();
});
