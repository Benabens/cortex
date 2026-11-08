/**
 * La rubrique du juge du banc est figée : la retoucher sans changer de version rendrait
 * incomparables des runs jugés « pareil ». Nouvelle rubrique → nouvelle version ET nouvelle
 * empreinte ici.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUBRIC_VERSION, rubricFingerprint } from "../lib/bench/rubric";

const PINNED: Record<string, string> = {
  v1: "702422ae9b740987927b3f501087b7c59dea755e405f3787b53f87203b8232f6",
};

test("rubrique du juge : le texte de la version courante n'a pas bougé", () => {
  assert.equal(rubricFingerprint(), PINNED[RUBRIC_VERSION], `rubrique ${RUBRIC_VERSION} modifiée : passe à une nouvelle version et épingle son empreinte`);
});
