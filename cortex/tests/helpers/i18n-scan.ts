/**
 * Repère le texte d'interface écrit en dur dans un fichier .ts/.tsx, sans l'exécuter
 * (analyse syntaxique TypeScript) :
 *  - tout texte JSX qui contient des lettres (`<p>Bonjour</p>`, en français ou en anglais :
 *    un texte visible passe par les dictionnaires) ;
 *  - tout libellé écrit en dur dans un attribut lu à l'écran ou par un lecteur d'écran
 *    (`aria-label="Delete"`, `placeholder`, `title`, `alt`), quelle que soit la langue ;
 *  - toute chaîne littérale qui ressemble à du français (accents, mots outils), où qu'elle
 *    soit : attribut, variable, message d'erreur, libellé d'option.
 * Ne comptent pas : les commentaires, les imports, les classes CSS, les clés passées à
 * `t(...)`, et une ligne précédée de `// i18n-allow: <raison>` (contenu de cours, nom propre).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Hit = { file: string; line: number; text: string };

const ACCENTS = /[àâçéèêëîïôûùüÿœæ]/i;
// Mots outils français qui n'existent pas en anglais : deux d'entre eux suffisent.
const FR_WORDS = /\b(le|la|les|des|du|une?|et|ou|pour|avec|dans|sur|est|sont|pas|ne|tu|ton|ta|tes|vos|votre|aucun|aucune|cette|ces|au|aux|qui|que|plus|déjà|encore|mon|ma|mes|ce)\b/gi;

export function looksFrench(s: string): boolean {
  const text = s.replace(/\{[^}]*\}/g, " ");
  if (!/[a-zà-ÿ]{2}/i.test(text)) return false;
  if (ACCENTS.test(text)) return true;
  return (text.match(FR_WORDS) ?? []).length >= 2;
}

const IGNORED_ATTRS = new Set(["className", "id", "href", "src", "key", "type", "name", "htmlFor", "role", "rel", "target", "method", "autoComplete", "inputMode", "lang", "hrefLang", "dir", "style", "viewBox", "d", "fill", "stroke", "xmlns", "variant", "size", "tone", "as", "accept", "pattern"]);
// Attributs lus à l'écran ou à voix haute : un littéral y est un texte d'interface, en toute langue.
const VISIBLE_ATTRS = new Set(["aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext", "placeholder", "title", "alt", "label"]);
const TRANSLATE_CALLS = new Set(["t", "useTranslations", "getT", "rich", "markup", "raw", "has"]);

function allowed(sf: ts.SourceFile, node: ts.Node): boolean {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split("\n");
  for (let l = line; l >= Math.max(0, line - 1); l--) if (/i18n-allow:/.test(lines[l] ?? "")) return true;
  return false;
}

function ignoredContext(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true; // type Status = "prêt" : un type, pas un texte
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isElementAccessExpression(p)) return true;
  if (ts.isCallExpression(p)) {
    const callee = p.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (TRANSLATE_CALLS.has(name) && p.arguments[0] === node) return true;
    if (name === "require" || name === "cn" || name === "clsx") return true;
  }
  // className={cn("…", cond && "…")} et attributs techniques : on remonte jusqu'à l'attribut.
  for (let a: ts.Node | undefined = p; a; a = a.parent) {
    if (ts.isJsxAttribute(a)) return IGNORED_ATTRS.has(a.name.getText());
    if (ts.isJsxElement(a) || ts.isJsxSelfClosingElement(a) || ts.isBlock(a) || ts.isSourceFile(a)) break;
  }
  return false;
}

export function scanSource(file: string, source: string): Hit[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];
  const push = (node: ts.Node, text: string) => {
    if (allowed(sf, node)) return;
    hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().slice(0, 80) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && VISIBLE_ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      const lit = ts.isStringLiteral(init) ? init
        : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) ? init.expression
        : null;
      if (lit && /\p{L}{2}/u.test(lit.text) && !looksFrench(lit.text)) push(lit, lit.text);
    }
    if (ts.isJsxText(node)) {
      const text = node.getText(sf);
      if (/\p{L}{2}/u.test(text)) push(node, text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!ignoredContext(node) && looksFrench(node.text)) push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" {x} ");
      if (!ignoredContext(node) && looksFrench(parts)) push(node, parts);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Fichiers d'interface du dépôt (chemins relatifs à cortex/). */
export function uiFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith(".tsx") || (dir.startsWith(path.join("lib", "ux")) && rel.endsWith(".ts"))) out.push(rel.split(path.sep).join("/"));
    }
  };
  for (const d of ["app", "components", path.join("lib", "ux")]) walk(d);
  return out.sort();
}
