/** Rendus anglais des principaux composants du parcours d’arrivée. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { LoginCard } from "../app/login/LoginCard";
import { CourseForm } from "../components/cours/CourseForm";
import { ImportPanel } from "../components/sources/ImportPanel";
import { CourseProvider } from "../lib/ux/api";
import { renderIntl } from "./helpers/intl";

const router = {
  back() {}, forward() {}, refresh() {}, hmrRefresh() {},
  push() {}, replace() {}, prefetch() {},
};

function withRouter(child: ReactElement): ReactElement {
  return createElement(AppRouterContext.Provider, { value: router as never }, child);
}

function withCourse(child: ReactElement): ReactElement {
  return createElement(CourseProvider, null, child);
}

const french = /\b(Connexion|Révise|conditions|Mentions|Créer|matière|Établissement|Annuler|Importer|Annales|Glisse|Préparer|Fichiers)\b/i;

test("LoginCard se rend entièrement en anglais", () => {
  const html = renderIntl(withRouter(createElement(LoginCard, {
    error: "AccessDenied", callbackUrl: "/", google: true, email: true, e2eTest: false,
    review: false, landing: "https://example.test", contact: "hello@example.test",
  })), "en");
  assert.match(html, /Sign in to Cortex/);
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), french);
});

test("CourseForm se rend entièrement en anglais", () => {
  const html = renderIntl(withRouter(withCourse(createElement(CourseForm))), "en");
  assert.match(html, /Create course/);
  assert.match(html, /Exam format/);
  assert.doesNotMatch(html, french);
});

test("ImportPanel se rend entièrement en anglais", () => {
  const html = renderIntl(withCourse(createElement(ImportPanel, { onChanged() {} })), "en");
  assert.match(html, /Import/);
  assert.match(html, /Prepare course/);
  assert.doesNotMatch(html, french);
});
