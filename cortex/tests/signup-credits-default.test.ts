import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-no-free-credits-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
delete process.env.SIGNUP_FREE_CREDITS;

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.BILLING_ENABLED;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un compte neuf ne reçoit aucun crédit sans configuration explicite", async () => {
  const { getBalanceCenti } = await import("../lib/billing/credits");
  assert.equal(await getBalanceCenti("compte-neuf"), 0);
});
