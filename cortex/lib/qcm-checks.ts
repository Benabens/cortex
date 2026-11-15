import { normalize, tokenize } from "@/lib/text";

/**
 * CONTRÔLES DÉTERMINISTES D'UN QCM ET D'UN EXAMEN — job 23 (14/11/2026, examen QCM #9).
 * Les contrôles de #82/#83 reposaient sur le modèle (doublons) ou sur une seule tournure
 * (« affirmer que… ») : l'examen livré avait trois questions à la même réponse (biais de
 * disponibilité), neuf explications qui réfutaient des distracteurs absents (« Les distracteurs
 * confondent ce concept avec A, B, C, D » pour trois options fausses) et une question à deux
 * options identiques. Ici, sans appel au modèle :
 *  - `explanationIssues` : les distracteurs que l'explication réfute, comptés et rapprochés des
 *    options réelles ;
 *  - `duplicateOptionIndices` : deux options d'un même QCM qui nomment la même notion ;
 *  - `keyNotion` / `capDrops` : la notion de la bonne réponse et le plafond de questions par notion.
 * Un signalement déclenche une réparation (réécriture, nouveaux distracteurs, remplacement),
 * jamais un rejet direct : un faux positif coûte un appel, pas une question.
 */

/** Mots outils et vocabulaire de la réfutation : ils ne désignent aucune option. */
const STOP = new Set([
  "avec", "dans", "pour", "sans", "sous", "vers", "chez", "entre", "selon", "comme", "mais", "donc", "ainsi", "alors", "aussi", "tout", "tous", "toute", "toutes",
  "cette", "celle", "celui", "ceux", "celles", "leur", "leurs", "elle", "elles", "nous", "vous", "dont", "quand", "quel", "quelle", "quels", "quelles", "lequel",
  "laquelle", "lesquels", "lesquelles", "plus", "moins", "tres", "bien", "encore", "meme", "memes", "autre", "autres", "chaque", "certains", "certaines", "simple",
  "seul", "seule", "seuls", "seules", "seulement", "cela", "ceci", "etre", "sont", "etait", "fait", "faits", "elles", "parce", "puisque", "lorsque", "tandis",
  "option", "options", "proposition", "propositions", "reponse", "reponses", "bonne", "bonnes", "mauvaise", "mauvaises", "distracteur", "distracteurs",
  "affirmation", "affirmations", "enonce", "cours", "notion", "notions", "concept", "concepts", "voisin", "voisine", "voisines", "voisins", "different",
  "differente", "differentes", "differents", "distinct", "distincte", "distincts", "distinctes", "confond", "confondent", "confondre", "assimile", "assimilent",
  "suppose", "supposent", "supposer", "affirme", "affirment", "affirmer", "considere", "considerent", "considerer", "pretend", "pretendent", "pretendre",
  "attribue", "attribuent", "attribuer", "inverse", "inversent", "inverser", "reduit", "reduisent", "deplace", "deplacent", "evoque", "evoquent", "evoquant",
  "mentionne", "mentionnent", "decrit", "decrivent", "parle", "parlent", "propose", "proposent", "renvoie", "renvoient", "correspond", "correspondent",
  "echoue", "echouent", "tort", "faux", "fausse", "fausses", "erronee", "erronees", "errone", "inexact", "inexacte", "incorrect", "incorrecte", "nier",
  "restreindre", "reprendre", "presente", "presentee", "explique", "expliquent", "porte", "portent", "relevent", "releve",
  "with", "that", "this", "these", "those", "from", "into", "than", "other", "others", "only", "they", "their", "which", "while", "option", "answer", "answers",
  "choice", "choices", "distractor", "distractors", "confuse", "confuses", "wrongly", "wrong", "false", "incorrect", "course",
]);

/** Racine d'un mot : ses 5 premières lettres (« transit »/« transitent », « style »/« styles »), comme lib/coverage. */
const root = (w: string) => (w.length >= 5 ? w.slice(0, 5) : w);

/** Racines des mots porteurs de sens d'un texte (4 lettres au moins, hors mots outils). */
function contentRoots(text: string): Set<string> {
  return new Set(tokenize(text, 4).filter((t) => !STOP.has(t)).map(root));
}

/** Texte sans ses parenthèses (souvent le pourquoi de la réfutation, pas le contenu de l'option). */
const withoutParens = (s: string) => s.replace(/\([^()]*\)/g, " ");

/** Découpe en phrases : un point, un point d'exclamation ou d'interrogation suivi d'une majuscule. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[«"A-ZÀ-ÖØ-Þ])/u).map((s) => s.trim()).filter(Boolean);
}

/** Découpe `s` sur `sep` hors parenthèses. */
function splitTopLevel(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0 && m[0].length) {
        out.push(cur);
        cur = "";
        i += m[0].length - 1;
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Début d'une réfutation groupée : la liste des distracteurs réfutés suit. */
const GROUP_ANCHORS = [
  /\b(?:les\s+)?(?:autres|trois|deux|quatre|mauvaises)\s+(?:options|propositions|réponses|affirmations)\b/iu,
  /\b(?:les\s+)?distracteurs\b/iu,
  /\bet\s+non\s+(?:pas\s+)?/iu,
  /\bsans\s+(?:prétendre|affirmer|dire|supposer)\b/iu,
  /\b(?:the\s+)?(?:other|wrong|incorrect)\s+(?:options|answers|choices|statements)\b/iu,
  /\b(?:the\s+)?distractors\b/iu,
  /\band\s+not\s+/iu,
];

/** Une phrase consacrée à UNE option (« L'option qui… », « Celle qui… »). */
const ONE_OPTION = /^(?:l['’]|la\s+|une\s+|the\s+)?(?:autre\s+)?(?:option|proposition|réponse|affirmation|distracteur|celle|celui|one)s?\s+(?:qui|selon|évoquant|affirmant|mentionnant|parlant|décrivant|invoquant|portant|où|dont|that|which|claiming|stating)\b/iu;

/** Phrase qui résume sans rien ajouter (« Chacune de ces trois options confond donc… »). */
const SUMMARY = /^(?:chacune|aucune|toutes|tous|ces|each|all|none)\b/iu;

/** Morceau qui prolonge l'élément précédent au lieu d'en ouvrir un nouveau. */
const CONTINUES = /^(?:qui|que|qu['’]|dont|où|lequel|laquelle|lesquel(?:le)?s|ce\s+qui|ce\s+que|car|mais|alors|puisque|parce|tandis|comme|notamment|c['’]est-à-dire|à\s+savoir|y\s+compris|tel(?:le)?s?|selon|sans|pas|which|that|because|since|while|as)\b/iu;

/** Conjonction en tête d'un élément de liste. */
const LEADING = /^(?:(?:et|ou|ni|or|nor|and)\s+(?:encore\s+)?|soit\s+(?:parce\s+qu['’]\s*|que\s+)?|(?:ou\s+)?avec\s+|enfin\s+)+/iu;

/** « confondent ce concept avec… » : la tournure qui précède le premier distracteur nommé. */
const CONFUSES = /^(?:confond\p{L}*|assimil\p{L}*|mélang\p{L}*|rapproch\p{L}*|confus\p{L}*)\s+[^,()]{0,60}?\s+(?:avec|à|with)\s+/iu;

/** Les éléments que l'explication réfute, dans l'ordre (un par distracteur dans une explication saine). */
export function refutedItems(explanation: string): string[] {
  const out: string[] = [];
  for (const s of sentences(explanation)) {
    if (SUMMARY.test(s)) continue;
    if (ONE_OPTION.test(s)) { out.push(s); continue; }
    const anchors = GROUP_ANCHORS.map((re) => re.exec(s)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index);
    const a = anchors[0];
    if (!a) continue;
    let rest = s.slice(a.index + a[0].length).replace(/[.!?]+$/u, "");
    // « … des notions voisines : X, Y, ou Z » : la liste suit les deux-points.
    const colon = splitTopLevel(rest, /^\s:\s/);
    if (colon.length > 1) rest = colon.slice(1).join(" : ");
    // « soit X, soit Y » est une liste dont chaque « soit » ouvre un élément entier, virgules
    // comprises ; « X, soit Y » une apposition.
    if ((rest.match(/\bsoit\b/giu) ?? []).length >= 2) {
      const list = rest.slice(/\bsoit\b/iu.exec(rest)?.index ?? 0);
      const soit = splitTopLevel(list, /^,?\s*\bsoit\s+(?:parce\s+qu['’]\s*|parce\s+que\s+|que\s+)?/iu);
      out.push(...soit.filter((p) => contentRoots(p).size >= 1));
      continue;
    }
    const pieces = splitTopLevel(rest, /^(?:,\s*|;\s*|\s+ni\s+)/iu);
    const items: string[] = [];
    for (const raw of pieces) {
      const lead = raw.replace(LEADING, "");
      // « confondent ce mécanisme avec le biais de négativité » : le distracteur suit « avec ».
      const p = lead.replace(CONFUSES, "").trim();
      if (!p) continue;
      // « …, ou que la définition exige… » : coordonné, c'est un nouvel élément même s'il commence par « que ».
      const coordinated = lead.length < raw.trim().length;
      if (items.length && !coordinated && (CONTINUES.test(p) || contentRoots(p).size < 2)) { items[items.length - 1] += `, ${p}`; continue; }
      if (contentRoots(p).size < 1) continue;
      items.push(p);
    }
    // « Les autres options décrivent des mécanismes (X, Y, Z) mais… » : la liste est entre parenthèses.
    if (items.length <= 1) {
      const paren = /\(([^()]*)\)/u.exec(rest);
      const inner = paren ? splitTopLevel(paren[1], /^,\s*/u).filter((x) => contentRoots(x).size >= 2) : [];
      if (inner.length >= 2) { out.push(...inner); continue; }
    }
    out.push(...items);
  }
  return out;
}

/** « supposent à tort que X », « ou que X » : l'élément réfute une affirmation, X. */
const CLAIM = /^(?:(?:affirm|suppos|consid[eè]r|prét?end|croi|pens|soutien|laiss\p{L}*\s+entend|impliqu|sugg[eè]r|admett|pos|claim|assum|suggest|stat)\p{L}*\s+(?:à\s+tort\s+|faussement\s+|wrongly\s+)?)?(?:que\s+|qu['’]\s*|that\s+)/iu;

/** Élément qui nomme une notion ou une affirmation (« le biais de négativité », « une analyse lente… »). */
const NAMES_SOMETHING = /^(?:l['’]|le|la|les|un|une|des|du|de\s+la|de\s+l['’]|d['’]|ce|cette|celle|celui|the|an?)\b/iu;
/** Ce qui suit le nom réfuté : une relative, une cause, une parenthèse, une incise. */
const ITEM_TAIL = /\s+(?:qui|que|qu['’]|dont|où|lequel|laquelle|car|parce|puisque|alors|tandis|mais|which|that|because|whereas)\b|,|\(|\s[—–]\s/iu;
const itemHead = (item: string) => item.slice(0, ITEM_TAIL.exec(item)?.index ?? item.length);

export type ExplanationIssue = {
  /** Éléments réfutés par l'explication. */
  refuted: number;
  /** Options fausses réellement proposées. */
  distractors: number;
  /** Éléments réfutés qui ne correspondent à aucune option fausse (notion ou affirmation absente). */
  absent: string[];
};

/**
 * Options citées entre guillemets comme vraies ou fausses, mais absentes de la version finale.
 * Une citation est textuelle : seuls les espaces et les apostrophes typographiques sont harmonisés.
 * Les autres citations de l'explication (auteur, terme du cours) ne sont pas des options.
 */
export function absentOptionCitations(explanation: string, options: string[]): string[] {
  const exact = (s: string) => s.trim().replace(/[’]/g, "'").replace(/\s+/g, " ");
  const available = new Set(options.map(exact));
  const absent: string[] = [];
  for (const match of explanation.matchAll(/[«“"]\s*([^»”"]{3,500}?)\s*[»”"]/gu)) {
    const cited = match[1].trim();
    const start = match.index ?? 0;
    const around = explanation.slice(Math.max(0, start - 50), Math.min(explanation.length, start + match[0].length + 50));
    const optionLike = /(?:bonne|mauvaise)\s+r[ée]ponse|(?:option|proposition)|\b(?:juste|correcte?|fausse?|incorrecte?|d[ée]fendable)\b/iu.test(around);
    if (optionLike && !available.has(exact(cited))) absent.push(cited);
  }
  return [...new Set(absent)];
}

/**
 * L'explication réfute-t-elle autre chose que les options fausses réellement proposées ? Signale :
 *  - plus d'éléments réfutés que d'options fausses (job 23, Q10 : cinq pour trois) ;
 *  - un élément réfuté dont les mots propres (hors énoncé et clé) ne se retrouvent dans aucune
 *    option fausse (Q9 : « le biais de négativité », absent des quatre options).
 * null si rien d'anormal, ou si l'explication ne réfute rien de repérable.
 */
export function explanationIssues(explanation: string, options: string[], correct: number[], stem = ""): ExplanationIssue | null {
  const wrong = options.map((o, i) => ({ o, i })).filter(({ i }) => !correct.includes(i));
  if (!explanation.trim() || !wrong.length) return null;
  const items = refutedItems(explanation);
  if (!items.length) return null;
  const known = new Set([...contentRoots(stem), ...correct.flatMap((k) => [...contentRoots(options[k] ?? "")])]);
  const wrongRoots = wrong.map(({ o }) => contentRoots(o));
  const absent: string[] = [];
  for (const item of items) {
    // « inversent l'ordre des révolutions », « elles reposent sur une incitation financière » :
    // l'élément décrit le défaut d'une option avec d'autres mots ; seul le compte le juge.
    const one = ONE_OPTION.exec(item) ?? CLAIM.exec(item);
    if (!one && !NAMES_SOMETHING.test(item)) continue;
    // « L'option qui affirme que X », « supposent à tort que X » : X, une affirmation qu'une option
    // doit porter presque mot pour mot ; sinon le nom, sans la relative ni la parenthèse qui disent
    // pourquoi il est faux, qu'il suffit de retrouver.
    const own = [...contentRoots(one ? withoutParens(item.slice(one[0].length)) : itemHead(item))].filter((r) => !known.has(r));
    // Rien de propre à l'élément (il ne fait que reprendre l'énoncé ou la clé) : on ne juge pas.
    if (!own.length) continue;
    const best = Math.max(...wrongRoots.map((rs) => own.filter((r) => rs.has(r)).length));
    if (one ? best < 2 && best / own.length < 0.34 : best === 0) absent.push(item.slice(0, 120));
  }
  const issue = { refuted: items.length, distractors: wrong.length, absent };
  return absent.length || items.length > wrong.length ? issue : null;
}

/** Le défaut d'une explication, dit au réécrivain et au journal du job. */
export function describeExplanationIssue(x: ExplanationIssue): string {
  const parts = [
    x.refuted > x.distractors ? `réfute ${x.refuted} distracteurs alors que la question n'a que ${x.distractors} options fausses` : "",
    x.absent.length ? `réfute ${x.absent.map((a) => `« ${a} »`).join(", ")}, absent(s) des options` : "",
  ].filter(Boolean);
  return parts.join(" ; ");
}

/** Mots communs à toutes les options en tête (« Il s'agit du », « Les médias sociaux permettent »). */
function commonPrefixWords(options: string[]): number {
  const words = options.map((o) => o.trim().split(/\s+/u));
  let n = 0;
  while (words.every((w) => w.length > n + 1 && normalize(w[n]) === normalize(words[0][n]))) n++;
  return n;
}

const ARTICLE = /^(?:(?:il\s+s['’]agit|c['’]est|it\s+is)\s+)?(?:du\s+|de\s+la\s+|de\s+l['’]|des\s+|de\s+|d['’]|le\s+|la\s+|les\s+|l['’]|un\s+|une\s+|the\s+|an?\s+)?/iu;
/** Ce qui suit le nom d'une notion en tête d'option : une définition, une cause, une précision. */
const HEAD_END = /^(?:,\s*(?:soit|c['’]est-à-dire|qui|car|parce|puisque|selon|où|dont|comme|that|which|because|i\.e\.)\b|\s*:\s|\s+\(|\s+[—–]\s)/iu;
const YES_NO = new Set(["oui", "non", "vrai", "faux", "yes", "true", "false"]);

/**
 * La notion qu'une option nomme en tête (« Le biais de disponibilité, soit… » → « biais de
 * disponibilite ») : le texte avant la PREMIÈRE ponctuation, quand celle-ci ouvre une définition,
 * une cause ou une précision. null pour une phrase, une valeur, une liste ou un « Oui, car… ».
 */
export function optionHead(option: string, options: string[]): string | null {
  const skip = commonPrefixWords(options);
  const text = option.trim().split(/\s+/u).slice(skip).join(" ").replace(ARTICLE, "");
  const punct = /[,;:.(—–]/u.exec(text);
  if (!punct) return null;
  const head = text.slice(0, punct.index).trim();
  if (!HEAD_END.test(text.slice(punct.index - (text[punct.index - 1] === " " ? 1 : 0)))) return null;
  const words = head.split(/\s+/u).filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const toks = tokenize(head, 2);
  if (!toks.some((t) => t.length >= 4 && !STOP.has(t) && !YES_NO.has(t))) return null;
  return toks.join(" ");
}

/**
 * Options qui répètent une autre option du même QCM : deux options fausses sur la même notion
 * en tête (job 23, Q9 : « Le biais de disponibilité, soit… » deux fois), ou le même libellé. Un distracteur qui ne diffère
 * que par un mot ou par l'ordre (« les vraies… que les fausses », « dix fois » pour « six fois »)
 * reste permis : c'est souvent le procédé même (inversion, chiffre changé). La bonne réponse n'est
 * jamais désignée ; entre deux options fausses, la seconde.
 */
export function duplicateOptionIndices(options: string[], correct: number[]): number[] {
  const heads = options.map((o) => optionHead(o, options));
  const flat = options.map((o) => normalize(o).replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  const out = new Set<number>();
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      const ki = correct.includes(i), kj = correct.includes(j);
      // La bonne notion avec une mauvaise raison (« Le biais de disponibilité, car… » face à la clé
      // « Le biais de disponibilité, soit… ») est un distracteur permis ; deux options fausses sur
      // la même notion, non.
      const sameHead = !ki && !kj && !!heads[i] && heads[i] === heads[j];
      if (flat[i] !== flat[j] && !sameHead) continue;
      if (ki && kj) continue;
      out.add(ki ? j : kj ? i : j);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** La notion de la bonne réponse d'une question à réponse unique, ou null (calcul, phrase, MCQ). */
export function keyNotion(it: { options: string[]; correct: number[] }): string | null {
  if (it.correct.length !== 1) return null;
  return optionHead(it.options[it.correct[0]] ?? "", it.options);
}

/**
 * Questions permises par notion du programme : une seule quand le programme a au moins autant de
 * notions que l'examen a de questions ; sinon deux (sous des angles vraiment distincts), davantage
 * seulement si le programme est trop court pour que le nombre demandé reste atteignable.
 */
export function notionCap(notionCount: number, count: number): number {
  if (notionCount >= count) return 1;
  return Math.max(2, Math.ceil(count / Math.max(1, notionCount)));
}

/**
 * Libellé de notion ramené à sa base : sans le sous-thème qu'y ajoute le concepteur (« Désinformation
 * générative : notions clés — shared reality » → « desinformation generative notions cles »).
 */
export function notionBase(label: string): string {
  return normalize(label.split(/\s[—–]\s/u)[0]).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Indices à retirer pour tenir les plafonds : `perNotion` questions par notion du programme,
 * `perKey` par notion de bonne réponse (deux questions dont la réponse est « le biais de
 * disponibilité » se réussissent de la même façon). Une question appartient à la notion de
 * chacun de ses libellés (`labelsOf` : sujet donné à la conception, notion nommée par le contrôle
 * des doublons…). La première occurrence reste ; les questions de l'accent demandé par
 * l'étudiant ne comptent pas.
 */
export function capDrops<T extends { options: string[]; correct: number[]; focusSlot?: boolean }>(
  items: T[],
  caps: { perNotion: number; perKey: number },
  labelsOf: (it: T, i: number) => (string | null | undefined)[],
): number[] {
  const drop = new Set<number>();
  // Un compte par libellé, sans fusion : deux libellés d'une même question (sujet du lot, notion du
  // contrôle) ne rapprochent pas les autres questions de l'un et de l'autre.
  const perLabel = new Map<string, number>();
  const keys = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.focusSlot) return;
    const labels = [...new Set(labelsOf(it, i).filter((l): l is string => !!l?.trim()).map(notionBase).filter(Boolean))];
    const key = keyNotion(it);
    if (labels.some((l) => (perLabel.get(l) ?? 0) >= caps.perNotion) || (!!key && (keys.get(key) ?? 0) >= caps.perKey)) { drop.add(i); return; }
    for (const l of labels) perLabel.set(l, (perLabel.get(l) ?? 0) + 1);
    if (key) keys.set(key, (keys.get(key) ?? 0) + 1);
  });
  return [...drop].sort((a, b) => a - b);
}

/** Décisions d'une ultime passe : absent = clé/hors-cours rejeté, triviaux = une réparation. */
export function ultimateAuditActions<T extends { stem: string; trivialDistractors?: number[] | null }>(
  initial: T[], audited: T[],
): { drop: number[]; repair: number[] } {
  const byStem = new Map(audited.map((it) => [it.stem, it]));
  const drop: number[] = [];
  const repair: number[] = [];
  initial.forEach((it, i) => {
    const checked = byStem.get(it.stem);
    if (!checked) drop.push(i);
    else if (checked.trivialDistractors?.length) repair.push(i);
  });
  return { drop, repair };
}

type AuditVerdict = { index: number; key: boolean; offCourse: boolean; trivial: number[] };

/** Consolide deux lectures indépendantes : union des défauts, hors-cours seulement par accord. */
export function auditConsensus(first: AuditVerdict[], second: AuditVerdict[]): AuditVerdict[] {
  const other = new Map(second.map((v) => [v.index, v]));
  return first.map((a) => {
    const b = other.get(a.index);
    if (!b) return { ...a, key: false };
    return {
      index: a.index,
      key: a.key && b.key,
      offCourse: a.offCourse && b.offCourse,
      trivial: [...new Set([...(a.trivial ?? []), ...(b.trivial ?? [])])].sort((x, y) => x - y),
    };
  });
}

/**
 * Retraits décidés par l'audit sémantique des doublons. En mode strict, les notions du modèle
 * restent descriptives : seul le sujet planifié est assez stable pour appliquer un plafond. Les
 * paires explicitement reconnues comme le même fait ou la même règle restent toujours retirées.
 * Hors mode strict, les libellés et règles du modèle servent aussi à rapprocher deux formulations.
 */
export function duplicateAuditDrops<T extends { focusSlot?: boolean }>(
  items: T[],
  audit: {
    notions: string[];
    angles: string[];
    regles: string[];
    duplicates: { first: number; second: number }[];
  },
  strict: boolean,
): number[] {
  const drop = new Set<number>();
  const focusPair = (a: number, b: number) => !!items[a]?.focusSlot && !!items[b]?.focusSlot;
  if (!strict) {
    const first = new Map<string, number>();
    const firstByRule = new Map<string, number>();
    items.forEach((_, i) => {
      const notion = normalize(audit.notions[i] ?? "");
      const angle = normalize(audit.angles[i] ?? "");
      const rule = normalize(audit.regles[i] ?? "");
      if (notion && angle) {
        const key = `${notion}\u0000${angle}`;
        const holder = first.get(key);
        if (holder === undefined) first.set(key, i);
        else if (!focusPair(holder, i)) drop.add(i);
      }
      if (notion && rule) {
        const key = `${notion}\u0000${rule}`;
        const holder = firstByRule.get(key);
        if (holder === undefined) firstByRule.set(key, i);
        else if (!focusPair(holder, i)) drop.add(i);
      }
    });
  }
  for (const pair of audit.duplicates) {
    const later = Math.max(pair.first, pair.second);
    if (Number.isInteger(later) && later >= 0 && later < items.length && pair.first !== pair.second && !focusPair(pair.first, pair.second)) drop.add(later);
  }
  return [...drop].sort((a, b) => a - b);
}

/**
 * L'explication réduite à ce qu'elle dit de la bonne réponse : les phrases et fins de phrase qui
 * réfutent des distracteurs sont retirées (repli quand la réécriture sur les options réelles
 * échoue : une explication courte et juste vaut mieux qu'une qui réfute des options absentes).
 * null s'il ne reste pas une vraie phrase.
 */
export function keyOnlyExplanation(explanation: string): string | null {
  const kept: string[] = [];
  for (const s of sentences(explanation)) {
    if (ONE_OPTION.test(s) || SUMMARY.test(s)) continue;
    const a = GROUP_ANCHORS.map((re) => re.exec(s)).filter((m): m is RegExpExecArray => !!m).sort((x, y) => x.index - y.index)[0];
    if (!a) { kept.push(s); continue; }
    const head = s.slice(0, a.index).replace(/[\s,;:—–-]+$/u, "").trim();
    if (contentRoots(head).size >= 3) kept.push(/[.!?]$/u.test(head) ? head : `${head}.`);
  }
  const out = kept.join(" ").trim();
  return out.length >= 40 ? out : null;
}
