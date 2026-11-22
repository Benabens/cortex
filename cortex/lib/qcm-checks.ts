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
export function contentRoots(text: string): Set<string> {
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
  // « contrairement aux hommes politiques, qui… » (job 28, Q1) : une seule notion absente, pas une
  // liste, mais la même mécanique de découpage s'applique au texte qui suit l'amorce. L'article
  // contracté (au/aux) n'est PAS consommé : c'est lui qui fait reconnaître le nom comme une notion
  // nommée (`NAMES_SOMETHING`) une fois l'amorce retirée.
  /\bcontrairement\s+(?=(?:à|au|aux)\b)/iu,
  /\bà\s+la\s+différence\s+(?=(?:de|du|des|d['’]))/iu,
  /\bau\s+contraire\s+(?=(?:de|du|des|d['’]))/iu,
  /\bpar\s+opposition\s+(?=(?:à|au|aux)\b)/iu,
  /\bunlike\b/iu,
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

/**
 * « et non à cause de la revente des données… » (job 28, Q9) : l'amorce de groupe (`et non `) ne
 * consomme pas la cause elle-même, qui reste en tête de l'élément sans déterminant reconnaissable
 * par `NAMES_SOMETHING` ; la retirer ici fait réapparaître le nom qu'elle introduit.
 */
const CAUSAL_LEAD = /^(?:à\s+cause\s+|en\s+raison\s+|du\s+fait\s+|faute\s+)(?=de\b)/iu;

/**
 * « évoquent l'automatisation… », « parlent d'une satire… » : un verbe de renvoi en tête d'un
 * élément d'énumération (job 25, Q6/Q7) ; il ne désigne rien par lui-même, seul ce qui suit compte.
 */
const VERB_LEAD = /^(?:évoqu\p{L}*|mentionn\p{L}*|décri\p{L}*|parl\p{L}*(?:\s+de)?|renvoi\p{L}*(?:\s+à)?|correspond\p{L}*(?:\s+à)?|port\p{L}*(?:\s+sur)?|concern\p{L}*|relev\p{L}*(?:\s+de)?|cit\p{L}*)\s+/iu;

/** Les éléments que l'explication réfute, dans l'ordre (un par distracteur dans une explication saine). */
export function refutedItems(explanation: string): string[] {
  const out: string[] = [];
  for (const s of sentences(explanation)) {
    if (SUMMARY.test(s)) continue;
    if (ONE_OPTION.test(s)) { out.push(s); continue; }
    const anchors = GROUP_ANCHORS.map((re) => re.exec(s)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index);
    const a = anchors[0];
    if (!a) {
      // « Il ne s'agit ni d'un X ni d'une Y, ni d'un Z » : au moins deux « ni », sans aucune autre
      // amorce (« les autres options »…), ouvrent chacun un élément entier (job 25, Q8).
      const niMatches = [...s.matchAll(/\bni\b/giu)];
      if (niMatches.length < 2) continue;
      const rest = s.slice(niMatches[0].index).replace(/[.!?]+$/u, "");
      const pieces = splitTopLevel(rest, /^(?:,\s*|;\s*|\s*\bni\s+)/iu);
      for (const raw of pieces) {
        const lead = raw.replace(LEADING, "").replace(VERB_LEAD, "").replace(CAUSAL_LEAD, "").trim();
        if (!lead || SUMMARY.test(lead) || contentRoots(lead).size < 1) continue;
        out.push(lead);
      }
      continue;
    }
    let rest = s.slice(a.index + a[0].length).replace(/[.!?]+$/u, "");
    // « … des notions voisines : X, Y, ou Z » : la liste suit les deux-points.
    const colon = splitTopLevel(rest, /^\s:\s/);
    if (colon.length > 1) rest = colon.slice(1).join(" : ");
    // « soit X, soit Y » est une liste dont chaque « soit » ouvre un élément entier, virgules
    // comprises ; « X, soit Y » une apposition.
    if ((rest.match(/\bsoit\b/giu) ?? []).length >= 2) {
      const list = rest.slice(/\bsoit\b/iu.exec(rest)?.index ?? 0);
      const soit = splitTopLevel(list, /^,?\s*\bsoit\s+(?:parce\s+qu['’]\s*|parce\s+que\s+|que\s+)?/iu);
      out.push(...soit.map((p) => p.replace(VERB_LEAD, "").trim()).filter((p) => !SUMMARY.test(p) && contentRoots(p).size >= 1));
      continue;
    }
    // « les autres options évoquent X ou Y, ni Z » : « ou » et « ni » ouvrent chacun un élément
    // au même titre qu'une virgule (job 25, Q6/Q9 : deux notions liées par « ou » comptaient pour une).
    const pieces = splitTopLevel(rest, /^(?:,\s*|;\s*|\s+ni\s+|\s+ou\s+)/iu);
    const items: string[] = [];
    for (const raw of pieces) {
      const lead = raw.replace(LEADING, "");
      // « confondent ce mécanisme avec le biais de négativité » : le distracteur suit « avec » ;
      // « évoquent l'automatisation » : le verbe de renvoi ne désigne rien par lui-même ;
      // « à cause de la revente… » : la cause elle-même, pas l'amorce qui l'introduit.
      const p = lead.replace(CONFUSES, "").replace(VERB_LEAD, "").replace(CAUSAL_LEAD, "").trim();
      if (!p || SUMMARY.test(p)) continue;
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

/**
 * Élément qui nomme une notion ou une affirmation (« le biais de négativité », « une analyse
 * lente… »). Les formes élidées (l'/d'/de l') n'exigent PAS de frontière `\b` après l'apostrophe :
 * `\b` est toujours ASCII en JavaScript, donc une voyelle accentuée juste après (« l'éducation »,
 * « l'évaluation ») n'en forme jamais une et la détection échouait (job 28, Q3).
 */
const NAMES_SOMETHING = /^(?:l['’]|d['’]|de\s+l['’])(?=\p{L})|^(?:le|la|les|un|une|des|du|de\s+la|au|aux|ce|cette|celle|celui|the|an?)\b/iu;
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
    // « L'option qui… »/« affirme que… » (tournure individuelle) : seuil tolérant à la
    // reformulation, qui laisse passer un seul mot commun sur beaucoup — une vraie paraphrase
    // partage peu de racines (job 23, Q16 : « un mode de pensée censé produire un calcul exact »
    // pour « Système 2… recalculerait avec exactitude »). Un élément COURT (≤ 2 mots propres,
    // notamment ceux d'une liste groupée) exige que son PREMIER mot propre — la tête du groupe
    // nominal (« biais » dans « biais cognitifs », « éducation » dans « éducation aux médias ») —
    // se retrouve dans une même option, sur 4 lettres (la racine à 5 lettres distingue encore deux
    // conjugaisons du même verbe : « soutenant »/« soutient » → « soute »/« souti », job 23 Q7) ;
    // un second mot qui ne fait que qualifier (« cognitifs ») reste permis sans appui (Q17/Q18 :
    // « les biais cognitifs » désigne bien l'option « Les biais… »), mais une tête absente ne l'est
    // jamais par la seule coïncidence d'un second mot (job 28, Q3 : « éducation aux médias » n'est
    // pas absent faute de mieux parce que « médias » apparaît, par hasard, dans un distracteur sur
    // les « médias synthétiques », sans rapport).
    const head4 = own[0]?.slice(0, 4);
    const absentNow = own.length <= 2
      ? !wrongRoots.some((rs) => [...rs].some((r) => r.slice(0, 4) === head4))
      : one ? best < 2 && best / own.length < 0.34 : best === 0;
    if (absentNow) absent.push(item.slice(0, 120));
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
  // Ponctuation de phrase et délimiteurs ($, `) ignorés ; les opérateurs comptent : « $x^2$ » et
  // « $x_2$ », « x > 0 » et « x < 0 », « -1 » et « 1 », « a == b » et « a != b » sont des
  // distracteurs distincts (erreur de signe, exposant, comparaison), pas des doublons.
  const flat = options.map((o) => normalize(o)
    .replace(/[^\p{L}\p{N}+\-−±*/×÷^_=<>≤≥≠!&|~%()[\]{}]+/gu, " ")
    // « x > 0 » et « x>0 » restent le même libellé.
    .replace(/\s*([+\-−±*/×÷^_=<>≤≥≠!&|~%()[\]{}])\s*/g, "$1")
    .trim());
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
 * Les racines de ce que la bonne réponse AFFIRME, texte de l'option PLUS le fait source qui
 * l'établit (pas seulement sa tête de notion, que `keyNotion` ne détecte pas toujours — job 25,
 * Q17/Q20 : « Le nudge rend une option plus attractive sans restreindre le choix », une phrase
 * sans la ponctuation qu'exige `optionHead`). Deux questions dont l'énoncé de l'option diffère mais
 * qui s'appuient sur le MÊME fait du cours (Q7/Q14, finition v5 : « le succès du modèle bénévole…
 * montre l'importance de motivations non financières », une fois sur un wiki collaboratif, une fois
 * sur un forum d'entraide) doivent rester détectables même quand seule l'option change. null pour
 * une MCQ ou une bonne réponse (option + fait source) trop courte pour juger.
 */
export function keyProposition(it: { options: string[]; correct: number[]; sourceFact?: string | null }): Set<string> | null {
  if (it.correct.length !== 1) return null;
  const roots = contentRoots(it.options[it.correct[0]] ?? "");
  const factRoots = contentRoots(it.sourceFact ?? "");
  const merged = new Set([...roots, ...factRoots]);
  return merged.size >= 3 ? merged : null;
}

/** Chevauchement de deux ensembles de racines, rapporté au plus petit : 1 si l'un couvre l'autre. */
export function overlapRatio(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let shared = 0;
  for (const r of small) if (big.has(r)) shared++;
  return shared / small.size;
}

/**
 * Deux bonnes réponses qui affirment le MÊME fait, même reformulé (job 25, Q10/Q15 : « les leaders
 * utilisent les réseaux sociaux… » deux fois ; Q17/Q20 : la définition du nudge). Un recouvrement
 * élevé plutôt qu'une égalité stricte, pour survivre à la reformulation ; le seuil reste haut pour
 * ne pas confondre deux faits voisins mais distincts.
 */
export function sameProposition(a: Set<string>, b: Set<string>): boolean {
  return overlapRatio(a, b) >= 0.7;
}

/**
 * Deux questions qui s'appuient sur le MÊME passage précis du cours — le même exemple, la même
 * étude, le même fait concret (job 28, finition v6, Q1/Q7 : la même comparaison chiffrée d'un
 * grand quotidien et d'une encyclopédie collaborative, l'une demandant les chiffres, l'autre ce
 * qu'ils illustrent). Comparé au fait source LUI-MÊME, pas à la bonne réponse : deux questions sur
 * le même passage peuvent avoir des bonnes réponses sans aucun mot en commun. Un recouvrement
 * élevé, pas une égalité stricte (reformulation), et un minimum de mots propres de chaque côté
 * pour ne pas rapprocher deux faits sources trop courts pour en juger.
 */
export function sameSourceFact(a?: string | null, b?: string | null): boolean {
  const ra = contentRoots(a ?? "");
  const rb = contentRoots(b ?? "");
  if (ra.size < 4 || rb.size < 4) return false;
  return overlapRatio(ra, rb) >= 0.6;
}

/**
 * L'étiquette de notion n'a AUCUN appui lexical dans ce que la question teste réellement (l'énoncé,
 * la bonne réponse, le fait source et l'explication) : elle alimente les points faibles de
 * l'étudiant sur la mauvaise notion (job 25, Q5 : étiquetée « Économie de l'IA et concentration du
 * marché » pour une question sur la désinformation et la vérification). Une étiquette sans mot
 * propre (trop générale pour juger) n'est jamais signalée ; `minRoots` (mots propres exigés) :
 * 1 quand un autre signal (le contrôle des doublons) désigne déjà une autre notion.
 */
export function notionMismatch(notion: string, tested: string, minRoots = 2): boolean {
  const own = contentRoots(notion);
  if (own.size < minRoots) return false;
  const tr = contentRoots(tested);
  return ![...own].some((r) => tr.has(r));
}

/**
 * La notion du programme dont le libellé a le plus d'appui lexical dans `tested`, pour recaler une
 * étiquette signalée par `notionMismatch` sans appel au modèle. null si aucune ne fait mieux que
 * zéro mot commun.
 */
export function bestNotionMatch(tested: string, candidates: string[]): string | null {
  const tr = contentRoots(tested);
  if (!tr.size) return null;
  let best: { label: string; score: number } | null = null;
  for (const label of candidates) {
    const own = contentRoots(label);
    if (own.size < 2) continue;
    const score = [...own].filter((r) => tr.has(r)).length;
    if (score > 0 && (!best || score > best.score)) best = { label, score };
  }
  return best?.label ?? null;
}

/**
 * Tournures de la consigne, communes à tant d'énoncés qu'elles ne disent rien du scénario
 * (« selon la définition … donnée dans le cours, laquelle des mesures suivantes … »).
 */
const FRAMING = new Set([
  "suivant", "suivants", "suivante", "suivantes", "definition", "definitions", "donnee", "donne", "correctement", "precisement", "precis", "precise",
  "mecanisme", "mecanismes", "decrit", "decrire", "explique", "expliquer", "constitue", "constituent", "situation", "situations", "exemple", "illustre",
  "illustree", "concernant", "presentee", "mieux", "description", "descriptions", "distingue", "role", "exposee", "expose", "specifiquement", "deux",
  "trois", "quatre", "quelle", "quels", "quelles", "parmi", "strict", "sens", "which", "following", "according", "best", "describes", "correctly",
]);

/** Racines du DÉCOR d'un énoncé : ses mots porteurs, hors consigne, hors libellé de la notion et hors `common`. */
function decorRoots(stem: string, notion: string, common: Set<string>): Set<string> {
  const label = contentRoots(notion);
  return new Set(tokenize(stem, 4).filter((t) => !STOP.has(t) && !FRAMING.has(t)).map(root).filter((r) => !label.has(r) && !common.has(r)));
}

/**
 * Racines qui reviennent dans une bonne part des énoncés d'un examen (au moins 3, et au moins un
 * quart) : la tournure maison des questions, pas le décor de l'une d'elles.
 */
export function commonStemRoots(stems: string[]): Set<string> {
  const df = new Map<string, number>();
  for (const st of stems) for (const r of new Set(tokenize(st, 4).map(root))) df.set(r, (df.get(r) ?? 0) + 1);
  const floor = Math.max(3, Math.ceil(stems.length / 4));
  return new Set([...df].filter(([, n]) => n >= floor).map(([r]) => r));
}

/**
 * Deux questions d'une MÊME notion qui testent en fait la même chose, sans modèle (examen #16,
 * 16/11 : Q3/Q12, la définition du nudge appliquée deux fois à une cantine — « réorganiser sans
 * retirer d'option » —, bâties sur deux faits distincts qui disaient la même chose, donc
 * invisibles au contrôle par identifiant de fait) :
 *  - le même scénario : le décor des deux énoncés (hors consigne, hors mots de la notion et hors
 *    tournures communes à l'examen, `common`) partage au moins trois mots porteurs, qui en font
 *    une part nette — le terme de la notion et un mot de passage ne suffisent pas ;
 *  - la même bonne réponse reformulée : un recouvrement plus bas qu'entre deux notions
 *    (`sameProposition`), la notion commune rendant la reformulation plus probable.
 * Deux angles vraiment distincts d'une notion (l'origine des étiquettes / le rôle des humains ;
 * la définition / l'efficacité dans la durée) ne partagent ni décor ni réponse.
 */
export function sameNotionQuestion(
  a: { stem: string; notion?: string | null; options: string[]; correct: number[] },
  b: { stem: string; notion?: string | null; options: string[]; correct: number[] },
  common: Set<string> = new Set(),
): boolean {
  if (!a.notion || !b.notion || notionBase(a.notion) !== notionBase(b.notion)) return false;
  const da = decorRoots(a.stem, a.notion, common);
  const db = decorRoots(b.stem, b.notion, common);
  const shared = [...da].filter((r) => db.has(r)).length;
  if (shared >= 3 && overlapRatio(da, db) >= 0.25) return true;
  if (a.correct.length !== 1 || b.correct.length !== 1) return false;
  // Les mots de la notion, communs par construction, ne comptent pas.
  const label = contentRoots(a.notion);
  const ka = new Set([...contentRoots(a.options[a.correct[0]] ?? "")].filter((r) => !label.has(r)));
  const kb = new Set([...contentRoots(b.options[b.correct[0]] ?? "")].filter((r) => !label.has(r)));
  return ka.size >= 4 && kb.size >= 4 && overlapRatio(ka, kb) >= 0.6;
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

/**
 * L'explication sans les phrases qui parlent d'une option RETIRÉE (distracteur remplacé, énoncé et
 * clé gardés). Mots propres à l'option retirée : absents de l'énoncé et des options finales. Une
 * phrase en parle quand elle en reprend deux, ou le seul qu'elle ait, ou tous ceux de son nom (« La
 * gamification du don d'organes, qui… » : « La gamification est un outil distinct »). La première
 * phrase reste si elle reprend autant de mots propres à la clé : c'est la justification de la clé.
 * Boucle moteur, itération 4 (15/11, hum-285-job14) : des explications réfutaient encore « les
 * vulnérabilités zero-day » ou « une distribution centralisée », remplacées entre-temps, et la
 * revérification à effort moyen ne les relevait plus. Le texte revient tel quel s'il ne cite aucune
 * option retirée ; null s'il ne reste pas une vraie phrase.
 */
export function withoutRemovedOptionRefs(explanation: string, removed: string[], options: string[], correct: number[], stem = ""): string | null {
  const known = new Set([...contentRoots(stem), ...options.flatMap((o) => [...contentRoots(o)])]);
  const gone = removed
    .map((o) => ({ own: [...contentRoots(withoutParens(o))].filter((r) => !known.has(r)), head: [...contentRoots(itemHead(withoutParens(o)))].filter((r) => !known.has(r)) }))
    .filter((g) => g.own.length);
  if (!gone.length) return explanation;
  const stemRoots = contentRoots(stem);
  const keyRoots = [...new Set(correct.flatMap((k) => [...contentRoots(options[k] ?? "")]))].filter((r) => !stemRoots.has(r));
  const all = sentences(explanation);
  const kept = all.filter((s, i) => {
    const rs = contentRoots(s);
    const keyHits = keyRoots.filter((r) => rs.has(r)).length;
    return !gone.some(({ own, head }) => {
      const hits = own.filter((r) => rs.has(r)).length;
      const cites = hits >= 2 || (hits === 1 && own.length === 1) || (head.length > 0 && head.every((r) => rs.has(r)));
      return cites && !(i === 0 && keyHits >= hits);
    });
  });
  if (kept.length === all.length) return explanation;
  const out = kept.join(" ").trim();
  return out.length >= 40 ? out : null;
}
