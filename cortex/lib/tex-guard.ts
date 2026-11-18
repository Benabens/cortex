import fs from "node:fs";
import path from "node:path";

/**
 * GARDE DU SOURCE LaTeX AVANT COMPILATION.
 *
 * Le .tex compilé par tectonic contient du texte issu du modèle (énoncés,
 * corrigés), lui-même influençable par les documents importés, et des
 * métadonnées saisies par l'utilisateur (nom du cours, enseignants). TeX peut
 * lire n'importe quel fichier du conteneur (\input, \openin, \read…) et
 * l'inclure dans le PDF rendu à l'étudiant : un cours piégé exfiltrerait
 * .env ou les annales d'un autre compte. Le garde REJETTE le source (il ne le
 * réécrit jamais — l'invariant byte-identique de cs-202 reste intact) dès
 * qu'il contient, hors du préambule de confiance :
 *  - une primitive de lecture/écriture de fichier ou d'exécution ;
 *  - un moyen de fabriquer une telle primitive sans l'écrire (\csname,
 *    \catcode, \lowercase, \scantokens, notation ^^, \makeatletter…) ;
 *  - un environnement hors liste blanche (\begin{X} = \csname X\endcsname :
 *    \begin{@@input} lit un fichier sans écrire \input), un nom expl3
 *    (\file_input:n), une primitive XeTeX (\XeTeXpdffile) ;
 *  - \includegraphics vers un chemin absolu, remontant ou exotique.
 * Le compilateur tourne en plus avec `--untrusted` quand il le supporte
 * (cf. exam-latex). Défense en profondeur : le garde est la barrière, pas
 * un simple nettoyage.
 */

const LATEX_DIR = path.join(process.cwd(), "latex");

/** Séquences de contrôle interdites dans le corps (noms exacts, `@` toléré en préfixe). */
const BANNED = [
  // lecture / écriture / exécution
  "input", "include", "InputIfFileExists", "openin", "openout", "read", "readline", "write", "immediate",
  "endinput", "ifeof", "dump", "lstinputlisting", "verbatiminput", "verbatimtabinput", "CatchFileDef",
  "CatchFileEdef", "ReadFile", "includepdf", "includesvg", "includestandalone", "import", "subimport",
  "inputfrom", "subinputfrom", "subfile", "externaldocument", "bibliography", "addbibresource",
  "graphicspath", "DTLloaddb", "csvreader", "pdffiledump", "pdfobj", "pdfximage", "pdfmdfivesum",
  "directlua", "latelua", "ShellEscape", "DelayedShellEscape", "special", "jobname", "input@path",
  // primitives pdfTeX reprises par XeTeX (vérifié sous tectonic 0.16.9 --untrusted :
  // \filedump rend n'importe quel fichier en hexadécimal dans le PDF) et oracles.
  "filedump", "filesize", "filemoddate", "mdfivesum", "pdffilesize", "pdffilemoddate", "shellescape", "pdfshellescape",
  // fabrication de séquences de contrôle / changement de régime. (\def, \let,
  // \newcommand, \expandafter, \uppercase/\lowercase restent permis : sans
  // \csname ni \catcode ils ne peuvent pas forger un nom interdit — \lowercase
  // n'agit que sur les caractères, pas sur les noms de macros — et un corrigé
  // les emploie couramment.)
  // fabrication indirecte : \UseName{@@input} / \ExpandArgs{c} / \@nameuse forgent
  // une séquence de contrôle à partir d'une chaîne, exactement comme \csname.
  "csname", "catcode", "scantokens", "makeatletter", "UseName", "ExpandArgs", "nameuse", "ifundefined", "IfFileExists",
  // images hors \includegraphics (chemin non contrôlable ici) : bannies.
  "pgfimage", "pgfdeclareimage",
  "usepackage", "RequirePackage", "documentclass",
  "batchmode", "nonstopmode", "scrollmode", "errorstopmode",
  // expl3 : sans \ExplSyntaxOn, « _ » et « : » ne sont pas des lettres, un nom expl3 n'en est pas un.
  // \ProvidesExplPackage / Class / File l'allument aussi, pour toute la suite du fichier.
  "ExplSyntaxOn", "ProvidesExplPackage", "ProvidesExplClass", "ProvidesExplFile",
  // PGF : tracés lus dans un fichier, tracés gnuplot (écrivent puis relisent un .table) et
  // enregistrement d'un tracé dans un fichier. \font charge un fichier par son chemin.
  "pgfplotxyfile", "pgfplotxyzfile", "pgfplotgnuplot", "pgfplothandlerrecord", "font",
];
const BANNED_RE = new RegExp(String.raw`\\@*(?:${BANNED.join("|")})(?![A-Za-z@])`, "g");
/**
 * Fonctions expl3 (`\file_input:n`, `\ior_open:Nn`, `\use:c`…) : un nom de module (avec « _ »)
 * suivi de « : », ou un nom suivi d'une SIGNATURE non vide. L'ancien motif (« _ » ou « : »
 * après le nom) refusait tout indice de maths (`$\sigma_x$`) et faisait disparaître le PDF
 * entier (examen 4 de CS-290) ; une application `$\phi: X \to Y$` (signature vide) passe.
 * Défense en profondeur : \ExplSyntaxOn et \ProvidesExpl…, sans lesquels aucun nom expl3
 * n'existe, sont bannis.
 */
const EXPL3_RE = /\\[A-Za-z@]+(?:_[A-Za-z@]+)+:[A-Za-z]*|\\[A-Za-z@]+:[A-Za-z]+/g;
/**
 * TikZ `plot file {…}` lit un fichier, `plot function {…}` relit un .table (audit du 14/11/2026).
 * Ce ne sont pas des séquences de contrôle : deux règles. PLOT_OP_RE voit la suite littérale
 * `plot [options] file|function`, y compris dans le corps d'un \def. Vérifié sous tectonic :
 * une macro peut tenir lieu de `plot` (`\def\p{plot}\draw \p file {x};`), pas de `file`.
 * PLOT_ARG_RE refuse donc le mot-clé suivi de son argument (accolade ou macro), mais seulement
 * si le source contient un `plot` (toute casse : \lowercase le fabrique) qui n'est pas un tracé
 * de coordonnées : « The file \texttt{records.bin} » est un énoncé cs-202 courant.
 */
const TEX_SPACE = String.raw`(?:\s|%[^\n]*\n)*`;
const PLOT_OPTS = String.raw`(?:\[(?:[^\[\]]|\[[^\]]*\])*\]${TEX_SPACE})?`;
const PLOT_OP_RE = new RegExp(String.raw`(?<![A-Za-z@\\])plot${TEX_SPACE}${PLOT_OPTS}(?:file|function)(?![A-Za-z@])`, "gi");
const PLOT_ARG_RE = new RegExp(String.raw`(?<![A-Za-z@\\])(?:file|function)${TEX_SPACE}(?:\{|\\(?![()\[\]]))`, "gi");
/** Un `plot` qui n'est pas `plot coordinates {…}` ni `plot (x, {f(x)})` : prose, ou tracé détourné. */
const PLOT_NOT_COORDS_RE = new RegExp(String.raw`(?<![A-Za-z@\\])plot(?![A-Za-z@])(?!${TEX_SPACE}${PLOT_OPTS}(?:coordinates(?![A-Za-z@])|\())`, "i");
/** Primitives XeTeX (tectonic = XeTeX) : \XeTeXpicfile, \XeTeXpdffile, encodages, glyphes… */
const XETEX_RE = /\\XeTeX[A-Za-z]*/g;
const ENV_RE = /\\(?:begin|end)\s*\{([^}]*)\}/g;
/** \begin / \end SANS accolade (`\begin\x`) : le nom vient d'une macro, invérifiable → refus. */
const ENV_NO_BRACE_RE = /\\(?:begin|end)(?![A-Za-z@])(?!\s*\{)/g;

/**
 * ENVIRONNEMENTS en LISTE BLANCHE : `\begin{X}` exécute `\csname X\endcsname`
 * — donc `\begin{@@input}` lit un fichier sans qu'aucun `\input` n'apparaisse,
 * et une liste noire de noms ne peut pas fermer cette porte. Ne passent que
 * les environnements usuels d'un énoncé/corrigé et ceux que le préambule du
 * dépôt définit lui-même.
 */
const ENV_ALLOWED = new Set([
  "document", "enumerate", "enumerate*", "itemize", "itemize*", "description", "list", "trivlist",
  "center", "flushleft", "flushright", "quote", "quotation", "verse", "samepage", "sloppypar", "comment",
  "verbatim", "verbatim*", "lstlisting", "alltt", "minipage", "tabbing", "picture",
  "tabular", "tabular*", "tabularx", "longtable", "xltabular", "array", "table", "table*", "figure", "figure*",
  "wrapfigure", "subfigure", "adjustbox",
  "math", "displaymath", "equation", "equation*", "align", "align*", "aligned", "alignat", "alignat*",
  "gather", "gather*", "gathered", "multline", "multline*", "split", "subequations", "flalign", "flalign*",
  "eqnarray", "eqnarray*", "cases", "cases*", "dcases", "dcases*", "rcases", "matrix", "pmatrix", "bmatrix",
  "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix",
  "tikzpicture", "scope", "multicols", "framed", "mdframed", "tcolorbox",
  "theorem", "lemma", "proposition", "corollary", "definition", "example", "remark", "proof",
  "algorithm", "algorithmic", "abstract",
  "tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge",
  "em", "bfseries", "itshape", "ttfamily", "spacing",
]);
const PREAMBLE_ENV_DEF_RE = /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtcolorbox|lstnewenvironment|NewEnviron|newtheorem)\*?\s*\{([^}]*)\}/g;
let _preambleEnvs: Set<string> | null = null;
function allowedEnvs(): Set<string> {
  if (_preambleEnvs) return _preambleEnvs;
  const set = new Set(ENV_ALLOWED);
  for (const block of trustedBlocks()) for (const m of block.matchAll(PREAMBLE_ENV_DEF_RE)) set.add(m[1].trim());
  return (_preambleEnvs = set);
}
const GRAPHICS_RE = /\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
/** Têtes \includegraphics : l'argument doit être une accolade littérale (`\includegraphics\p` = chemin invérifiable → refus). */
const GRAPHICS_HEAD_RE = /\\includegraphics\*?(?![A-Za-z@])/g;
function graphicsWithoutBrace(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(GRAPHICS_HEAD_RE)) {
    const rest = body.slice(m.index! + m[0].length).replace(/^\s*(?:\[[^\]]*\])?\s*/, "");
    if (!rest.startsWith("{")) out.push(`${m[0]} sans accolade`);
  }
  return out;
}
const SAFE_GRAPHICS_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export class TexHazardError extends Error {
  readonly hazards: string[];
  constructor(hazards: string[]) {
    super(`Source LaTeX refusé, primitive dangereuse : ${hazards.slice(0, 5).join(", ")}${hazards.length > 5 ? "…" : ""}`);
    this.name = "TexHazardError";
    this.hazards = hazards;
  }
}

let _trusted: string[] | null = null;
/** Textes de confiance retirés avant analyse : le préambule et les macros de figures du dépôt. */
function trustedBlocks(): string[] {
  if (_trusted) return _trusted;
  _trusted = ["preamble.tex", "figures.tex", "generic.tex", "unicode-fonts.tex", "cjk-fonts.tex"]
    .map((f) => path.join(LATEX_DIR, f))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8"))
    .filter((t) => t.length > 0);
  return _trusted;
}

/** Liste (vide = sûr) des motifs dangereux trouvés hors du préambule de confiance. */
export function findTexHazards(tex: string): string[] {
  let body = tex;
  for (const block of trustedBlocks()) body = body.split(block).join("");
  const found: string[] = [];
  for (const m of body.matchAll(BANNED_RE)) found.push(m[0]);
  for (const m of body.matchAll(EXPL3_RE)) found.push(m[0]);
  for (const m of body.matchAll(XETEX_RE)) found.push(m[0]);
  for (const m of body.matchAll(PLOT_OP_RE)) found.push(m[0].replace(/\s+/g, " "));
  if (PLOT_NOT_COORDS_RE.test(body)) for (const m of body.matchAll(PLOT_ARG_RE)) found.push(m[0].replace(/\s+/g, " "));
  if (/\\ExplSyntaxOn/.test(body)) found.push("\\ExplSyntaxOn");
  if (/\^\^/.test(body)) found.push("^^");
  const envs = allowedEnvs();
  for (const m of body.matchAll(ENV_RE)) {
    const name = m[1].trim();
    if (!envs.has(name)) found.push(`\\begin{${name}}`);
  }
  for (const m of body.matchAll(ENV_NO_BRACE_RE)) found.push(`${m[0].trim()} sans accolade`);
  for (const m of body.matchAll(GRAPHICS_RE)) {
    const p = m[1].trim().replace(/^"|"$/g, "");
    if (!SAFE_GRAPHICS_PATH.test(p) || p.split("/").includes("..")) found.push(`\\includegraphics{${p}}`);
  }
  found.push(...graphicsWithoutBrace(body));
  return Array.from(new Set(found));
}

/** Lève TexHazardError si le source n'est pas sûr. Ne modifie jamais le source. */
export function assertTexSafe(tex: string): void {
  const hazards = findTexHazards(tex);
  if (hazards.length) throw new TexHazardError(hazards);
}
