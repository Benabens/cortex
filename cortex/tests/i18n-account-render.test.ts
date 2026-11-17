import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { test } from "node:test";
import { BillingPanel } from "../app/compte/BillingPanel";
import { UsagePanel } from "../app/compte/UsagePanel";
import { DeleteAccount } from "../app/compte/DeleteAccount";
import { WithdrawalForm } from "../app/compte/WithdrawalForm";
import { looksFrench } from "./helpers/i18n-scan";
import { renderIntl } from "./helpers/intl";

function visibleText(html: string): string {
  return html
    .replace(/<details lang="fr"[\s\S]*?<\/details>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ")
    .replace(/\s+/g, " ");
}

test("/compte rend ses panneaux en anglais sans texte français visible hors de la version juridique", () => {
  const purchase = { id: "cs_fake", type: "pack" as const, purchasedAt: "2026-11-17 10:00:00", label: "10-credit pack" };
  const html = [
    renderIntl(createElement(BillingPanel), "en"),
    renderIntl(createElement(UsagePanel), "en"),
    renderIntl(createElement(DeleteAccount), "en"),
    renderIntl(createElement(WithdrawalForm as ComponentType<{ initialPurchases: typeof purchase[]; initialSelected: string; initialConfirming: boolean }>, { initialPurchases: [purchase], initialSelected: "pack:cs_fake", initialConfirming: true }), "en"),
  ].join("\n");
  assert.match(html, /Loading balance/);
  assert.match(html, /Loading your usage/);
  assert.match(html, /Delete my account/);
  assert.match(html, /The French version is legally binding/);
  assert.match(html, /<details lang="fr"/);
  assert.equal(looksFrench(visibleText(html)), false, visibleText(html));
});
