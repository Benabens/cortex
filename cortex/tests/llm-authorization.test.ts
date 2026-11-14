import assert from "node:assert/strict";
import { test } from "node:test";

test("un utilisateur non propriétaire ne peut pas appeler le LLM sans autorisation de dépense", async () => {
  const { runWithUser } = await import("../db/context");
  const { complete } = await import("../lib/llm");

  const testAuth = process.env.CORTEX_LLM_TEST_AUTH;
  delete process.env.CORTEX_LLM_TEST_AUTH;
  try {
    await assert.rejects(
      () => runWithUser("user-sans-credit", () => complete({ prompt: "Ne doit jamais partir", model: "haiku" })),
      (error: Error & { code?: string; status?: number }) => {
        assert.equal(error.code, "PAYMENT_REQUIRED");
        assert.equal(error.status, 402);
        assert.match(error.message, /crédit/i);
        return true;
      },
    );
  } finally {
    if (testAuth) process.env.CORTEX_LLM_TEST_AUTH = testAuth;
  }
});

test("une réservation explicite autorise l'appel jusqu'au point provider", async () => {
  const { runWithUser } = await import("../db/context");
  const { complete } = await import("../lib/llm");
  const { runWithLlmAuthorization } = await import("../lib/llm/authorization");

  await assert.rejects(
    () => runWithUser("user-autorise", () => runWithLlmAuthorization(
      { kind: "assist", ref: "assist:user-autorise:test" },
      () => complete({ prompt: "Autorisé jusqu'au provider", model: "haiku" }),
    )),
    (error: Error & { code?: string }) => error.code !== "PAYMENT_REQUIRED",
  );
});
