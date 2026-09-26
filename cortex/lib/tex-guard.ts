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
  // fabrication de séquences de contrôle / changement de régime. (\def, \let,
  // \newcommand, \expandafter, \uppercase/\lowercase restent permis : sans
  // \csname ni \catcode ils ne peuvent pas forger un nom interdit — \lowercase
  // n'agit que sur les caractères, pas sur les noms de macros — et un corrigé
  // les emploie couramment.)
  "csname", "catcode", "scantokens", "makeatletter",
  "usepackage", "RequirePackage", "documentclass",
  "batchmode", "nonstopmode", "scrollmode", "errorstopmode",
];
const BANNED_RE = new RegExp(String.raw`\\@*(?:${BANNED.join("|")})(?![A-Za-z@])`, "g");
const GRAPHICS_RE = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const SAFE_GRAPHICS_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export class TexHazardError extends Error {
  readonly hazards: string[];
  constructor(hazards: string[]) {
    super(`Source LaTeX refusé — primitive dangereuse : ${hazards.slice(0, 5).join(", ")}${hazards.length > 5 ? "…" : ""}`);
    this.name = "TexHazardError";
    this.hazards = hazards;
  }
}

let _trusted: string[] | null = null;
/** Textes de confiance retirés avant analyse : le préambule et les macros de figures du dépôt. */
function trustedBlocks(): string[] {
  if (_trusted) return _trusted;
  _trusted = ["preamble.tex", "figures.tex"]
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
  if (/\^\^/.test(body)) found.push("^^");
  for (const m of body.matchAll(GRAPHICS_RE)) {
    const p = m[1].trim().replace(/^"|"$/g, "");
    if (!SAFE_GRAPHICS_PATH.test(p) || p.split("/").includes("..")) found.push(`\\includegraphics{${p}}`);
  }
  return Array.from(new Set(found));
}

/** Lève TexHazardError si le source n'est pas sûr. Ne modifie jamais le source. */
export function assertTexSafe(tex: string): void {
  const hazards = findTexHazards(tex);
  if (hazards.length) throw new TexHazardError(hazards);
}
