import * as cheerio from "cheerio";

/**
 * TEXTE UTILE D'UNE PAGE HTML ENREGISTRÉE (Moodle, Canvas, site du cours) : sans la navigation,
 * le bandeau, les encadrés et le pied de page de la plateforme, qui entraient dans le corpus et
 * dans les prompts (« Log in », « My courses »… — audit ingestion du 16/11/2026, P2). Module pur.
 */

/** Jamais du texte : code, styles, gabarits. Les formules MathJax en script sont relues avant. */
const NEVER_TEXT = "script, style, noscript, template";
/** Navigation, partout : une table des matières dans la leçon n'apporte rien au corpus non plus. */
const NAVIGATION = "nav, [role=navigation], [role=search]";
/** Structure de la page, retirée seulement HORS de la leçon : un encadré « Définition » dans un article reste. */
const PAGE_FRAME = "header, footer, aside, [role=banner], [role=contentinfo], [role=complementary]";
const MAIN = "main, [role=main], article";
/** En dessous, une « zone principale » balisée est une coquille vide : le reste du corps est lu. */
const MIN_MAIN_CHARS = 200;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function htmlPageText(html: string, fallbackTitle: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || fallbackTitle;
  // MathJax 2 : la source LaTeX est dans le script ; elle reste à sa place, entre dollars.
  $('script[type^="math/tex"]').each((_, el) => {
    const display = /mode\s*=\s*display/.test($(el).attr("type") ?? "");
    $(el).replaceWith(` ${display ? "$$" : "$"}${$(el).text().trim()}${display ? "$$" : "$"} `);
  });
  $(NEVER_TEXT).remove();
  $(NAVIGATION).remove();
  $(PAGE_FRAME).filter((_, el) => $(el).closest(MAIN).length === 0).remove();
  // Zones principales de premier niveau, toutes (fil de discussion : un article par message).
  const zones = $(MAIN).filter((_, el) => $(el).parent().closest(MAIN).length === 0);
  const main = clean(zones.toArray().map((el) => $(el).text()).join(" "));
  return { title, text: main.length >= MIN_MAIN_CHARS ? main : clean($("body").text()) };
}
