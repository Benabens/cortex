import { jsonrepair } from "jsonrepair";

/**
 * Lecture du JSON d'une réponse de modèle — UNIQUE pour tous les sites d'appel.
 *
 * Ordre, du plus sûr au plus tolérant :
 *  1. la réponse entière est du JSON (cas de la sortie structurée) ;
 *  2. une clôture ``` qui ENVELOPPE toute la réponse est retirée ;
 *  3. un bloc ```json ouvert et fermé en début de ligne ;
 *  4. la plus grande valeur JSON complète (objet OU tableau), trouvée par un
 *     balayage équilibré qui respecte chaînes et échappements ;
 *  5. réparation (jsonrepair) de cette valeur — jamais d'une réponse tronquée.
 *
 * Piège de prod (01/11, CS-290) : l'ancienne regex non gourmande prenait le
 * PREMIER bloc ``` venu, y compris un bloc ```python écrit DANS une chaîne de
 * l'énoncé, et tronquait le JSON à cet endroit. Une clôture n'est donc retirée
 * que si elle enveloppe la réponse ou s'ouvre et se ferme en début de ligne :
 * dans du JSON valide, un retour à la ligne d'une chaîne est échappé (\n), le
 * ``` d'un énoncé n'est jamais en début de ligne.
 */

/** Réponse illisible du modèle : `code` aligné sur LlmError pour les routes et le connecteur. */
export class JsonOutputError extends Error {
  readonly code = "BAD_OUTPUT";
  /** true : la réponse s'arrête avant la fin de son JSON (à redemander plus concise). */
  readonly truncated: boolean;
  constructor(message: string, opts: { truncated?: boolean } = {}) {
    super(message);
    this.name = "JsonOutputError";
    this.truncated = opts.truncated ?? false;
  }
}

const WHOLE_FENCE = /^```[\w-]*[^\S\n]*\n?([\s\S]*?)\n?[^\S\n]*```$/;
const LINE_FENCES = /^```([\w-]*)[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```[^\S\n]*$/gm;
/** Au-delà, une réponse n'est plus un JSON entouré de prose : inutile de tout balayer. */
const MAX_STARTS = 64;

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

function tryParse(s: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    // virgules traînantes (`,]` / `,}`), fréquentes en sortie de modèle (comportement historique)
    try {
      return { ok: true, value: JSON.parse(s.replace(/,(\s*[}\]])/g, "$1")) };
    } catch {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

type Scan = { state: "closed" | "open" | "mismatch"; end: number };

/**
 * Fin de la valeur qui s'ouvre en `start` ({ ou [), chaînes et échappements
 * respectés : "closed" au délimiteur fermant, "open" si le texte s'arrête avant
 * (réponse coupée, ou guillemet non échappé), "mismatch" sur un fermant qui ne
 * correspond pas.
 */
function scanValue(s: string, start: number): Scan {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return { state: "mismatch", end: i };
      if (!stack.length) return { state: "closed", end: i };
    }
  }
  return { state: "open", end: s.length - 1 };
}

/**
 * Longueur du plus long préfixe de `s` conforme à la grammaire JSON : s.length
 * quand le texte s'arrête avant la fin d'une valeur (réponse COUPÉE), moins
 * quand il dévie (prose, guillemet non échappé). Lu sur la position que donne
 * JSON.parse (« … in JSON at position N », ou « Unexpected end of JSON input »).
 */
function validPrefix(s: string): number {
  try {
    JSON.parse(s);
    return s.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const at = /at position (\d+)/.exec(msg);
    if (at) return Number(at[1]);
    return /end of JSON input/i.test(msg) ? s.length : 0;
  }
}

type Span = { start: number; end: number; closed: boolean; prefix: number };

/**
 * Valeurs candidates du texte, sans redescendre dans une valeur fermée. Une
 * valeur NON fermée dont la grammaire tient jusqu'à la fin du texte est une
 * réponse coupée : rien après elle n'est indépendant, le balayage s'arrête
 * (sinon son premier élément complet passerait pour la réponse). Une valeur
 * non fermée qui dévie avant (crochet de prose « [0, 1[ », guillemet non
 * échappé) n'arrête pas le balayage.
 */
function candidateSpans(s: string): Span[] {
  const spans: Span[] = [];
  let starts = 0;
  for (let i = 0; i < s.length && starts < MAX_STARTS; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    starts++;
    const r = scanValue(s, i);
    if (r.state === "closed") {
      spans.push({ start: i, end: r.end, closed: true, prefix: r.end + 1 - i });
      i = r.end;
      continue;
    }
    const prefix = validPrefix(s.slice(i));
    spans.push({ start: i, end: s.length - 1, closed: false, prefix });
    if (i + prefix >= s.length) break;
  }
  return spans;
}

/** Une valeur suivie de « , ] } » est un élément d'une structure plus grande, pas la réponse. */
function isInnerElement(s: string, sp: Span): boolean {
  return /^\s*[,\]}]/.test(s.slice(sp.end + 1));
}

/** Extrait la valeur JSON (objet ou tableau) d'une réponse de modèle. Lève JsonOutputError. */
export function extractJson<T = unknown>(text: string): T {
  const t = (text ?? "").trim();
  if (!t) throw new JsonOutputError("Réponse du modèle vide (JSON attendu).");

  const direct = tryParse(t);
  if (direct.ok) return direct.value as T;

  const whole = WHOLE_FENCE.exec(t)?.[1]?.trim();
  if (whole) {
    const r = tryParse(whole);
    if (r.ok) return r.value as T;
  }

  const blocks = [...t.matchAll(LINE_FENCES)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2].trim() }));
  for (const b of [...blocks.filter((x) => x.lang === "json"), ...blocks.filter((x) => x.lang === "")]) {
    const r = tryParse(b.body);
    if (r.ok) return r.value as T;
  }

  // La plus grande valeur candidate est la réponse ; la prose autour peut contenir
  // des crochets (« selon [1] », « [0, 1[ ») ou des accolades sans être du JSON. Une
  // valeur non fermée compte pour la part de son texte qui reste du JSON.
  const body = whole ?? t;
  const best = candidateSpans(body)
    .filter((sp) => !sp.closed || !isInnerElement(body, sp))
    .sort((a, b) => b.prefix - a.prefix)[0];
  if (!best) throw new JsonOutputError("Réponse du modèle sans JSON (objet ou tableau attendu).");
  let parseError = direct.error;
  if (best.closed) {
    const r = tryParse(body.slice(best.start, best.end + 1));
    if (r.ok) return r.value as T;
    parseError = r.error;
  }

  // Réparation en dernier recours. Une réponse COUPÉE (max_tokens, flux interrompu)
  // n'est jamais complétée : jsonrepair fermerait les accolades et rendrait un
  // objet partiel qui passerait pour une réponse complète.
  const target = best.closed
    ? body.slice(best.start, best.end + 1)
    : body.slice(best.start).replace(/\n?```\s*$/, "").trimEnd();
  if (!best.closed && best.prefix >= target.length) {
    throw new JsonOutputError("Réponse du modèle tronquée : le JSON s'arrête avant sa fin.", { truncated: true });
  }
  try {
    return JSON.parse(jsonrepair(target)) as T;
  } catch {
    throw new JsonOutputError(`Réponse du modèle illisible (JSON invalide : ${parseError}).`);
  }
}
