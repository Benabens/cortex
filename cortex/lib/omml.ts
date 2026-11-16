import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

/**
 * FORMULES WORD / POWERPOINT (OMML, `m:oMath`) EN LATEX LINÉAIRE. mammoth et la lecture des
 * diapositives n'en gardaient rien : « Energy is E=mc² for… » devenait « Energy isfor… » (audit
 * ingestion du 16/11/2026). Les constructions courantes sont traduites (fractions, exposants et
 * indices, racines, délimiteurs, sommes et intégrales, fonctions, accents, matrices) ; une
 * construction inconnue rend au moins son texte.
 */

const NARY: Record<string, string> = { "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap" };
const ACCENTS: Record<string, string> = { "̂": "\\hat", "̄": "\\bar", "̅": "\\bar", "̇": "\\dot", "̈": "\\ddot", "⃗": "\\vec", "̃": "\\tilde" };

/** Une formule (`m:oMath` ou `m:oMathPara`) en LaTeX, sans les `$`. */
export function ommlToLatex($: CheerioAPI, node: Element): string {
  const kids = (el: Element) => $(el).children().toArray() as Element[];
  const child = (el: Element, name: string) => kids(el).find((k) => k.name === name);
  const prop = (el: Element, pr: string, name: string) => {
    const p = child(el, pr);
    const v = p && child(p, name);
    return v ? ($(v).attr("m:val") ?? null) : null;
  };
  const all = (el: Element | undefined): string => (el ? kids(el).map(conv).join("") : "");
  const part = (el: Element, name: string) => all(child(el, name));
  const opt = (s: string, wrap: (x: string) => string) => (s ? wrap(s) : "");

  function conv(el: Element): string {
    switch (el.name) {
      case "m:t": return $(el).text();
      case "m:f": return `\\frac{${part(el, "m:num")}}{${part(el, "m:den")}}`;
      case "m:sSup": return `{${part(el, "m:e")}}^{${part(el, "m:sup")}}`;
      case "m:sSub": return `{${part(el, "m:e")}}_{${part(el, "m:sub")}}`;
      case "m:sSubSup": return `{${part(el, "m:e")}}_{${part(el, "m:sub")}}^{${part(el, "m:sup")}}`;
      case "m:sPre": return `{}_{${part(el, "m:sub")}}^{${part(el, "m:sup")}}{${part(el, "m:e")}}`;
      case "m:rad": {
        const deg = part(el, "m:deg");
        return `\\sqrt${opt(deg, (d) => `[${d}]`)}{${part(el, "m:e")}}`;
      }
      case "m:d": {
        const beg = prop(el, "m:dPr", "m:begChr") ?? "(";
        const end = prop(el, "m:dPr", "m:endChr") ?? ")";
        const sep = prop(el, "m:dPr", "m:sepChr") ?? "|";
        return `${beg}${kids(el).filter((k) => k.name === "m:e").map(all).join(sep)}${end}`;
      }
      case "m:nary": {
        const chr = prop(el, "m:naryPr", "m:chr") ?? "∫";
        return `${NARY[chr] ?? chr}${opt(part(el, "m:sub"), (s) => `_{${s}}`)}${opt(part(el, "m:sup"), (s) => `^{${s}}`)} ${part(el, "m:e")}`;
      }
      case "m:func": return `${part(el, "m:fName")} ${part(el, "m:e")}`;
      case "m:acc": return `${ACCENTS[prop(el, "m:accPr", "m:chr") ?? "̂"] ?? "\\hat"}{${part(el, "m:e")}}`;
      case "m:bar": return `${prop(el, "m:barPr", "m:pos") === "bot" ? "\\underline" : "\\overline"}{${part(el, "m:e")}}`;
      case "m:limLow": return `{${part(el, "m:e")}}_{${part(el, "m:lim")}}`;
      case "m:limUpp": return `{${part(el, "m:e")}}^{${part(el, "m:lim")}}`;
      case "m:m": return `\\begin{matrix}${kids(el).filter((k) => k.name === "m:mr").map((row) => kids(row).filter((k) => k.name === "m:e").map(all).join(" & ")).join(" \\\\ ")}\\end{matrix}`;
      case "m:eqArr": return kids(el).filter((k) => k.name === "m:e").map(all).join(" \\\\ ");
      case "m:oMathPara": return kids(el).filter((k) => k.name === "m:oMath").map(all).join(" \\\\ ");
      default: return /Pr$/.test(el.name) ? "" : all(el);
    }
  }
  return conv(node).trim();
}

/** Les formules de plus haut niveau d'un document (une `m:oMath` d'un `m:oMathPara` n'est pas comptée deux fois). */
export function topLevelMath($: CheerioAPI): Cheerio<Element> {
  return $("m\\:oMathPara, m\\:oMath").filter((_, el) => $(el).parents("m\\:oMathPara, m\\:oMath").length === 0) as Cheerio<Element>;
}
