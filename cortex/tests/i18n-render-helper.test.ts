import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { useTranslations } from "use-intl/react";
import { renderIntl } from "./helpers/intl";

function Title() {
  return createElement("h1", null, useTranslations("locale")("title"));
}

test("un composant traduit se rend en français par défaut, en anglais sur demande", () => {
  assert.equal(renderIntl(createElement(Title)), "<h1>Langue</h1>");
  assert.equal(renderIntl(createElement(Title), "en"), "<h1>Language</h1>");
});
