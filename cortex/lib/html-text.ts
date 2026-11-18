import * as cheerio from "cheerio";

/**
 * TEXTE UTILE D'UNE PAGE HTML ENREGISTRÉE (Moodle, Canvas, site du cours) : sans la navigation,
 * le bandeau, les encadrés et le pied de page de la plateforme, qui entraient dans le corpus et
 * dans les prompts (« Log in », « My courses »… — audit ingestion du 16/11/2026, P2). Module pur.
 */

/** Structure d'une plateforme, jamais de la matière. Un <header> d'article (titre de la leçon) reste. */
const CHROME = "script, style, noscript, template, nav, aside, footer, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search]";
const MAIN = "main, [role=main], article";
/** En dessous, une « zone principale » balisée est une coquille vide : le reste du corps est lu. */
const MIN_MAIN_CHARS = 200;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function htmlPageText(html: string, fallbackTitle: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || fallbackTitle;
  $(CHROME).remove();
  $("header").filter((_, el) => $(el).closest(MAIN).length === 0).remove();
  const main = $(MAIN).toArray().map((el) => clean($(el).text())).find((t) => t.length >= MIN_MAIN_CHARS);
  return { title, text: main ?? clean($("body").text()) };
}
