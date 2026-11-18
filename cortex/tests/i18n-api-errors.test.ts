/**
 * Erreurs d'API à code stable : `{ error, code, params? }`, la phrase dans la langue de la
 * requête (cookie, sinon Accept-Language, sinon anglais), le code identique dans toutes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, requestLocale } from "../lib/i18n/api-error";
import { errorText, isUserError, userError, UserFacingError } from "../lib/i18n/user-error";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/x", { headers });

test("langue d'une requête : cookie, puis Accept-Language, puis anglais", () => {
  assert.equal(requestLocale(req({ cookie: "a=1; cortex_locale=fr", "accept-language": "en" })), "fr");
  assert.equal(requestLocale(req({ "accept-language": "fr-CH,fr;q=0.9" })), "fr");
  assert.equal(requestLocale(req()), "en");
  assert.equal(requestLocale(req({ cookie: "cortex_locale=xx", "accept-language": "de" })), "en");
});

test("apiError : phrase dans la langue de la requête, code et statut stables", async () => {
  const fr = apiError(req({ "accept-language": "fr" }), "unauthenticated", 401);
  const en = apiError(req({ "accept-language": "en" }), "unauthenticated", 401);
  assert.equal(fr.status, 401);
  assert.deepEqual(await fr.json(), { error: "Non authentifié.", code: "unauthenticated" });
  assert.deepEqual(await en.json(), { error: "You’re not signed in.", code: "unauthenticated" });
});

test("apiError : champs en plus conservés, mais jamais à la place de error et code", async () => {
  const res = apiError(req(), userError("rate_limited"), 429, { retryAfter: 60, code: "x", error: "y" });
  assert.deepEqual(await res.json(), { retryAfter: 60, error: "Too many requests. Try again in a minute.", code: "rate_limited" });
});

test("UserFacingError : message français (journaux), code et statut portés", async () => {
  const e = new UserFacingError(userError("locale_unsupported"), 400);
  assert.equal(e.message, "Langue non disponible.");
  assert.equal(e.status, 400);
  assert.ok(isUserError(e));
  assert.ok(!isUserError({ code: "pas_un_code" }));
  assert.equal(errorText("en", e), "This language isn’t available.");
  assert.deepEqual(await apiError(req(), e, e.status).json(), { error: "This language isn’t available.", code: "locale_unsupported" });
});

test("la langue de la requête suit la chaîne async (useUser), français sans requête", async () => {
  const { currentLocale, runWithLocale } = await import("../lib/i18n/context");
  const { useUser } = await import("../lib/req");
  assert.equal(currentLocale(), "fr", "scripts, worker : comportement historique");
  await runWithLocale("fr", async () => {
    useUser(req({ "accept-language": "en-GB" }));
    await Promise.resolve();
    assert.equal(currentLocale(), "en");
  });
});

test("erreur d'un fichier : son nom en tête, ponctuation de la langue", async () => {
  const { apiError } = await import("../lib/i18n/api-error");
  const { errorForFile } = await import("../lib/i18n/user-error");
  const e = errorForFile({ code: "document_encrypted" }, "annale.pdf");
  const fr = await apiError(req({ "accept-language": "fr" }), e, 422).json();
  const en = await apiError(req({ "accept-language": "en" }), e, 422).json();
  assert.match(fr.error, /^annale\.pdf : PDF protégé/);
  assert.match(en.error, /^annale\.pdf: \S/);
  assert.equal(en.code, "document_encrypted");
  assert.equal(en.params.file, "annale.pdf");
});

test("refus d'un fichier parmi d'autres (import partiel) : même phrase et même ponctuation qu'une erreur", async () => {
  const { fileErrorText } = await import("../lib/i18n/api-error");
  const e = { code: "document_encrypted" as const };
  assert.match(fileErrorText(req({ "accept-language": "en" }), "exam.pdf", e), /^exam\.pdf: \S/);
  assert.match(fileErrorText(req({ "accept-language": "fr" }), "annale.pdf", e), /^annale\.pdf : PDF protégé/);
});

test("champ d'un cours : nommé dans la langue du lecteur, jamais le nom français dans une phrase anglaise", async () => {
  const { errorText } = await import("../lib/i18n/user-error");
  assert.equal(errorText("en", { code: "course_field_required", params: { field: "examDate" } }), "The “exam date” field is required.");
  assert.equal(errorText("fr", { code: "course_field_required", params: { field: "examDate" } }), "Le champ « date d'examen » est obligatoire.");
  assert.equal(errorText("en", { code: "course_tex_command_forbidden", params: { field: "teacher" } }), "A teacher name can’t contain a backslash (\\).");
});
