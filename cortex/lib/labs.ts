import { sqlite } from "@/db/client";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { profile } from "@/lib/course-profile";
import { persistExercise, type ExamQuestion, type StepCb } from "@/lib/exam";
import { search } from "@/lib/search";
import { verifyAndHarden, type VerifyReport } from "@/lib/verify";
import fs from "node:fs";
import path from "node:path";

/**
 * NS13 — Exercices « Labs » au format de la question Projet (Q6) du Final 2025.
 *
 * 8% du final CS-202 = les Labs. La prof a tranché (Ed #688, JCC : « see last year exam for
 * a typical example ») : le MOULE = Question 6 du Final 2025 (3 sous-questions : conceptuel /
 * écrire une fonction C du lab / ownership-mémoire-debug), le CONTENU = les labs de cette année.
 *
 * ⚠️ EXCEPTION 8% : ICI écrire/débugger du C et raisonner sur les pointeurs EST attendu —
 * ce module a donc ses PROPRES directives + sa propre étape de vérif (verify.ts `VerifyOpts`).
 * Le générateur/vérificateur d'examens 92% (lib/exam.ts, directives.ts) reste INTOUCHÉ.
 */

const LABS_ROOT = path.join("data", "cs-202", "labs"); // relatif au cwd (cortex/)
const GC = path.join(LABS_ROOT, "grilledcheese");

export type LabDef = {
  id: string;
  label: string; // libellé UI / énoncés
  summary: string; // ce que fait le lab (pour le prompt)
  guidance: string; // sur quoi porter l'exo + calibrage staff
  topics: string[]; // mots-clés pour résoudre un sujet libre → lab
  /** Fichiers réels (relatifs au cwd). `key: true` = à LIRE obligatoirement avant de générer. */
  files: { rel: string; role: string; key?: boolean }[];
};

export const LABS: LabDef[] = [
  {
    id: "lab1",
    label: "Lab 1 (Warmup) — C: pointers, arrays, memory",
    summary:
      "Warmup C : fonctions sur tableaux (swap, tri par sélection, filtre pair/impair) avec passage par pointeurs, " +
      "allocation (malloc/calloc/free), entropie sur des comptes entiers, traces de valeurs bit-à-bit. " +
      "Les réflexes exam : compiler dans sa tête, warnings, out-of-bounds (ASan), variable non initialisée, " +
      "division entière, heap vs stack, cas limites (0, 1, négatif, vide).",
    guidance:
      "Bon terrain pour 6.2 : écrire une fonction sur tableau/pointeurs avec contrat d'erreur (retour -1/0, NULL checks, tailles). " +
      "Pour 6.3 : ownership d'un buffer (statique vs malloc vs not-owner) et un extrait à débugger (out-of-bounds / free manquant / division entière).",
    topics: ["warmup", "pointer", "pointeur", "array", "tableau", "swap", "sort", "tri", "filter", "entropy", "stats", "malloc", "heap", "stack"],
    files: [
      { rel: path.join(GC, "provided", "ex_multiple", "array_std.h"), role: "API tableaux (alloc/print/fill)", key: true },
      { rel: path.join(GC, "provided", "ex_multiple", "array_std.c"), role: "implémentation tableaux (malloc/free)", key: true },
      { rel: path.join(GC, "provided", "ex_multiple", "array_sort.c"), role: "tri par sélection + swap" },
      { rel: path.join(GC, "provided", "ex_multiple", "array_filter.c"), role: "filtre pair/impair (alloc d'un sous-tableau)" },
      { rel: path.join(GC, "provided", "ex_multiple", "swap.c"), role: "swap par pointeurs" },
      { rel: path.join(GC, "provided", "ex_multiple", "main.c"), role: "programme principal (enchaîne les étapes)" },
      { rel: path.join(GC, "provided", "ex_single", "sum_odd.c"), role: "somme des impairs (boucle simple)" },
      { rel: path.join(LABS_ROOT, "lab1_entrainement", "ex2.c"), role: "entropie avec 4 bugs (entraînement de Ben)", key: true },
      { rel: path.join(LABS_ROOT, "lab1_entrainement", "stats.c"), role: "stats (moyenne/variance) lab-style" },
    ],
  },
  {
    id: "lab2",
    label: "Lab 2 — Syscalls & UDP client-server",
    summary:
      "Couche socket maison (socket_layer.h : udp_socket/udp_server_init/udp_read/udp_send, et tcp_*), " +
      "lecture/écriture de fichiers par SYSCALLS (open/read/write/lseek/close — file_read.c, file_write.c), " +
      "transfert de fichier sur UDP (get_file = client qui demande, send_file = serveur qui sert, " +
      "protocole taille-puis-contenu avec ACK), udp-test-client/server. Gestion d'erreur lab-style : " +
      "codes d'erreur négatifs, perror, fermeture des fd.",
    guidance:
      "Bon terrain pour 6.1 : scénario protocole concret (tailles, ACK, perte/erreur — que renvoie le serveur ?). " +
      "Pour 6.2 : écrire une fonction du protocole (parser une requête, lire N octets par syscalls avec gestion d'erreur). " +
      "Pour 6.3 : ownership d'un buffer de message / d'un nom de fichier reçu du réseau.",
    topics: ["socket", "udp", "syscall", "client", "server", "serveur", "get_file", "send_file", "file descriptor", "open", "read", "write", "lseek", "réseau", "network", "client-serveur"],
    files: [
      { rel: path.join(GC, "done", "lab2", "Step2", "socket_layer.h"), role: "API socket maison (udp_*/tcp_*)", key: true },
      { rel: path.join(GC, "done", "lab2", "Step2", "socket_layer.c"), role: "implémentation (socket/bind/sendto/recvfrom/listen/accept)", key: true },
      { rel: path.join(GC, "done", "lab2", "Step2", "get_file.c"), role: "client : demande un fichier, le reçoit (solution de Ben)", key: true },
      { rel: path.join(GC, "done", "lab2", "Step2", "send_file.c"), role: "serveur : sert le fichier demandé" },
      { rel: path.join(GC, "done", "lab2", "Step2", "file_read.c"), role: "lecture fichier par syscalls open/read" },
      { rel: path.join(GC, "done", "lab2", "Step2", "file_write.c"), role: "écriture fichier par syscalls" },
      { rel: path.join(GC, "done", "lab2", "Step2", "util.h"), role: "helpers (checked calls, tailles)" },
      { rel: path.join(GC, "provided", "Lab2", "handouts", "1.syscalls.md"), role: "énoncé officiel du lab (syscalls)" },
    ],
  },
  {
    id: "lab4",
    label: "Lab 4 — UnixV6 filesystem (direntv6)",
    summary:
      "Filesystem UnixV6 complet, en couches : sector.c (lire un secteur de 512 B), inode.c (lire/parcourir " +
      "les inodes, inode_findsector avec adressage direct/indirect ADDR_SMALL_LENGTH=8), filev6.c (ouvrir/lire " +
      "un fichier par son inode, offset), direntv6.c (répertoires : direntv6_opendir/readdir/dirlookup — " +
      "résolution d'un path composant par composant), mount.c (superbloc), u6fs_utils (cat/inode stats). " +
      "Structs clés : struct inode (i_mode/i_size/i_addr[8]), struct directory_reader, struct filev6, struct unix_filesystem.",
    guidance:
      "Bon terrain pour 6.1 : inode walk concret (taille de fichier non ronde → quels secteurs lus ? direct vs indirect ; " +
      "ou résolution d'un path /a/b/c). Pour 6.2 : écrire une fonction de la pile (ex. lire le k-ième secteur d'un fichier, " +
      "chercher un nom dans un répertoire) avec les VRAIS structs. Pour 6.3 : ownership dans direntv6/filev6 " +
      "(qui possède le buffer de secteur, le nom retourné par readdir, la struct filev6).",
    topics: ["direntv6", "inode", "filesystem", "file system", "unixv6", "u6fs", "sector", "secteur", "filev6", "mount", "superblock", "dirlookup", "path", "indirect"],
    files: [
      { rel: path.join(GC, "done", "Lab4", "src", "unixv6fs.h"), role: "structs ON-DISK (inode, dirent, superbloc) — LA référence", key: true },
      { rel: path.join(GC, "done", "Lab4", "src", "inode.h"), role: "API inodes" },
      { rel: path.join(GC, "done", "Lab4", "src", "inode.c"), role: "inode_read/findsector (direct/indirect) — solution de Ben", key: true },
      { rel: path.join(GC, "done", "Lab4", "src", "direntv6.h"), role: "API répertoires (directory_reader)" },
      { rel: path.join(GC, "done", "Lab4", "src", "direntv6.c"), role: "opendir/readdir/dirlookup (résolution de path)", key: true },
      { rel: path.join(GC, "done", "Lab4", "src", "filev6.c"), role: "ouvrir/lire un fichier par inode (offset)" },
      { rel: path.join(GC, "done", "Lab4", "src", "sector.c"), role: "lecture d'un secteur (512 B)" },
      { rel: path.join(GC, "done", "Lab4", "src", "mount.c"), role: "montage : superbloc, bitmaps" },
      { rel: path.join(GC, "provided", "Lab4", "handouts", "4.inodes.md"), role: "énoncé officiel (inodes)" },
      { rel: path.join(GC, "provided", "Lab4", "handouts", "5.directories.md"), role: "énoncé officiel (répertoires)" },
    ],
  },
  {
    id: "lab5",
    label: "Lab 5 — Multi-threading (TCP file server)",
    summary:
      "Le serveur de fichiers passe en TCP multi-threadé : un thread worker par connexion (pthread_create + " +
      "pthread_detach, args allouées sur le HEAP — une par connexion — pour éviter les races sur la stack), " +
      "socket passif global, délai artificiel SERVER_DELAY, et une table de mutex PAR NOM DE FICHIER " +
      "(filename_lock_t mutexes[NB_FILES_MAX] protégée par mutexes_lock) pour sérialiser les écritures " +
      "concurrentes sur un même fichier sans bloquer les autres.",
    guidance:
      "CALIBRAGE STAFF (Katerina, Ed #711) : le débug concurrence le PLUS DUR acceptable = repérer un data race " +
      "et ajouter lock()/unlock() au bon endroit. PAS de condition variables/sémaphores complexes, PAS de " +
      "gymnastique deadlock. Bon terrain pour 6.1 : scénario à 2-3 clients concurrents (qui attend qui, " +
      "avec le délai serveur). Pour 6.2 : écrire une fonction de la table de mutex / du worker (heap args). " +
      "Pour 6.3 : ownership des thread_args_t (qui alloue, qui libère) + un extrait avec race à corriger par lock/unlock.",
    topics: ["thread", "pthread", "mutex", "lock", "multi-threading", "multithreading", "concurrence", "concurrency", "race", "tcp", "worker"],
    files: [
      { rel: path.join(GC, "done", "lab5", "get_file.c"), role: "serveur TCP multi-threadé COMPLET (workers, table de mutex) — solution de Ben", key: true },
      { rel: path.join(LABS_ROOT, "lab5", "socket_layer.h"), role: "API socket (tcp_server_init/tcp_accept/tcp_read/tcp_send)", key: true },
      { rel: path.join(LABS_ROOT, "lab5", "socket_layer.c"), role: "implémentation TCP" },
      { rel: path.join(LABS_ROOT, "lab5", "send_file.c"), role: "client d'upload" },
      { rel: path.join(LABS_ROOT, "lab5_upload", "get_file_v3.c"), role: "variante (étapes upload)" },
    ],
  },
];

/** Résout un id (« lab4 », « Lab 4 ») ou un sujet libre (« direntv6 », « multi-threading ») → lab. */
export function resolveLab(input: string): LabDef {
  const t = (input ?? "").toLowerCase().trim();
  const m = t.match(/lab\s*0*([1245])/);
  if (m) {
    const hit = LABS.find((l) => l.id === `lab${m[1]}`);
    if (hit) return hit;
  }
  let best = LABS[2]; // défaut : lab4 (le plus gros / le plus probable à l'exam)
  let score = 0;
  for (const l of LABS) {
    const s = l.topics.filter((k) => t.includes(k)).length;
    if (s > score) { score = s; best = l; }
  }
  return best;
}

// ---------- Les blocs de prompt (générateur ET vérificateur) ----------

/** Images-étalon : la vraie Q6 2025 (énoncé + corrigé officiel), rendues dans data/refs/figref/. */
const Q6_HANDOUT_IMGS = [20, 21, 22, 23].map((p) => `data/refs/figref/labs_q6_2025_handout-${p}.png`);
const Q6_SOL_IMGS = [19, 20, 21, 22].map((p) => `data/refs/figref/labs_q6_2025_sol-${p}.png`);

/**
 * Directives DURES des exos Labs — remplace directives.ts (92% théorie) pour CE type d'exo.
 * L'exception est documentée : Study Guide + Ed #688/#711 (cf. notes/RECAP_8PCT_C_LABS_FINAL.md).
 */
export function labsDirectivesBlock(): string {
  return [
    `═══════════════════════════════════════════════════════════════════════════`,
    `CONTRAINTES DURES — QUESTION « LABS » (les 8% du final, décision du staff)`,
    `═══════════════════════════════════════════════════════════════════════════`,
    `CONTEXTE : cette année les LABS remplacent le Projet. La prof a tranché (Ed #688, JCC) : le`,
    `format des questions Labs = EXACTEMENT celui de la question « Projet » (Question 6) du Final 2025`,
    `(« see last year exam for a typical example »). Le CONTENU vient des labs de CETTE année.`,
    ``,
    `⚠️ EXCEPTION 8% LABS — CONTRAIREMENT aux 92% théorie : ICI, demander d'ÉCRIRE / COMPLÉTER /`,
    `DÉBUGGER du code C, de raisonner sur les POINTEURS, malloc/calloc/strdup/free et l'OWNERSHIP`,
    `est ATTENDU — c'est le cœur de l'exercice (cf. Q6 2025 : message_to_kv_pair + node ownership).`,
    `N'applique PAS l'exclusion « pas de C complexe » ici.`,
    ``,
    `LIMITES À RESPECTER QUAND MÊME :`,
    `  - Le SYSTÈME de l'exercice = le code RÉEL du lab ciblé (structs, fonctions, conventions de CE`,
    `    code) — PAS « DKVS »/le projet des années passées. Seul le MOULE vient de Q6 2025.`,
    `  - Concurrence : le plus dur acceptable = repérer un data race et placer lock()/unlock() au bon`,
    `    endroit (Katerina, Ed #711). Pas de condition variables/sémaphores complexes, pas de deadlock tordu.`,
    `  - Examen sur PAPIER : tout doit se résoudre à la main, sans compilateur ni gdb.`,
    `  - LANGUE : 100% ANGLAIS (énoncés ET corrigés).`,
    `  - DIFFICULTÉ : niveau d'un vrai final EPFL — nombres NON RONDS, cas d'erreur et cas limites,`,
    `    au niveau des pages-étalon Q6 2025.`,
    `═══════════════════════════════════════════════════════════════════════════`,
  ].join("\n");
}

/** Le moule Q6 2025 : 3 sous-questions, 3+5+7 = 15 points. */
function q6MouldBlock(): string {
  return [
    `═══ LE MOULE — « QUESTION PROJET » (Q6, Final 2025) À REPRODUIRE FIDÈLEMENT ═══`,
    `Ton exercice = LA question Labs (15 points) d'un Final CS-202, EN ANGLAIS, avec EXACTEMENT 3 sous-questions :`,
    `  - \\subq{6.1}{<titre court>}{3} — CONCEPTUEL sur le système du lab : une config/scénario CONCRET`,
    `    (petite table de valeurs, arguments d'une commande, état du système) → « que se passe-t-il /`,
    `    quelle valeur ou erreur ? Justify your answer. » Raisonnement sur la LOGIQUE du lab (comme le`,
    `    ring R/N de Q6.1 2025). Termine par \\rulelines{6}.`,
    `  - \\subq{6.2}{<titre court>}{5} — ÉCRIRE UNE FONCTION C DU LAB : donne les structs/typedefs RÉELS`,
    `    du code du lab (\\begin{lstlisting}[language=C]), spécifie le contrat (int, -1 en cas d'erreur,`,
    `    0 sinon) et demande d'ÉCRIRE la fonction complète : gestion d'erreur (NULL checks, tailles,`,
    `    valeurs de retour) ET gestion mémoire (malloc/calloc/strdup/free) — comme message_to_kv_pair()`,
    `    de Q6.2 2025. Termine par \\rulelines{14} (place pour écrire du code à la main).`,
    `  - \\subq{6.3}{<titre court>}{7} — OWNERSHIP / MÉMOIRE / DEBUG, décliné en trois volets \\cn{1} \\cn{2} \\cn{3} :`,
    `    \\cn{1} identifier le modèle d'ownership (statically allocated / dynamically allocated / not owner)`,
    `    de 3 variantes d'un struct RÉEL du lab ; \\cn{2} écrire init/release pour chaque variante`,
    `    (commentaire « // do nothing » si rien à faire) ; \\cn{3} un extrait de code à lignes NUMÉROTÉES`,
    `    (lstlisting) qui fait une copie temporaire / un usage douteux : dire pour chaque variante si ça`,
    `    (a) compile et (b) se comporte correctement, et CORRIGER les lignes fautives — comme le`,
    `    node_end(&tmp_node) de Q6.3 2025. Termine par \\rulelines{10}.`,
    `Total = 15 points exactement (3+5+7). PAS de page de garde, PAS d'autres sous-questions, PAS de figures TikZ.`,
  ].join("\n");
}

/** Bloc vision : REGARDE la vraie Q6 2025 (énoncé + corrigé). */
function q6VisionBlock(): string {
  return [
    `═══ ANCRAGE VISUEL — LA VRAIE Q6 2025 (outil Read, OBLIGATOIRE) ═══`,
    `OUVRE et OBSERVE d'abord ces images — la vraie Question 6 du Final 2025, ton moule exact :`,
    ...Q6_HANDOUT_IMGS.map((p) => `  - ${p}  (énoncé : mise en page, formulation, encadrés de code)`),
    ...Q6_SOL_IMGS.map((p) => `  - ${p}  (corrigé officiel : niveau de détail attendu)`),
    `Calque la STRUCTURE, la FORMULATION et la DIFFICULTÉ sur ces pages ; produis du NEUF (autre système : TON lab) dans ce moule exact.`,
  ].join("\n");
}

/** Bloc lab : description + fichiers réels à LIRE. */
function labBlock(lab: LabDef, topic: string): string {
  const files = lab.files.filter((f) => fs.existsSync(path.join(process.cwd(), f.rel)));
  return [
    `═══ LE LAB CIBLE : ${lab.label} ═══`,
    lab.summary,
    ``,
    `FICHIERS RÉELS du lab (outil Read). LIS d'abord les fichiers marqués ★ — ton exercice DOIT utiliser`,
    `les VRAIS structs / fonctions / conventions de CE code (pas des noms inventés) :`,
    ...files.map((f) => `  ${f.key ? "★" : "-"} ${f.rel}  →  ${f.role}`),
    ``,
    `PISTES (choisis UN angle et creuse-le) : ${lab.guidance}`,
    topic ? `FOCUS demandé par l'étudiant : « ${topic} » — l'exercice doit porter dessus.` : ``,
  ].filter(Boolean).join("\n");
}

/** Petit contexte corpus (cartes review + notes du cours sur le sujet du lab). */
function corpusBlock(lab: LabDef, topic: string): string {
  try {
    const groups = search(`${topic || lab.label} ${lab.topics.slice(0, 4).join(" ")}`, 12, "or");
    const picks: string[] = [];
    for (const g of groups) {
      if (!["review", "note"].includes(g.sourceType)) continue;
      for (const h of g.hits.slice(0, 2)) picks.push(`• (${h.sourceTitle}) ${h.snippet ?? h.title ?? ""}`.slice(0, 300));
      if (picks.length >= 4) break;
    }
    return picks.length ? [`═══ REPÈRES DU COURS (cartes/notes de l'étudiant) ═══`, ...picks].join("\n") : "";
  } catch {
    return "";
  }
}

const LAB_EX_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", description: "« Labs »" },
    concept: { type: "string", description: "Titre court (ex. « Lab 4 — Inode walk & directory ownership »)" },
    statement_tex: { type: "string", description: "Énoncé COMPLET en LaTeX (corps seulement) : \\subq{6.1..6.3}, lstlisting, \\cn, \\rulelines." },
    solution_tex: { type: "string", description: "Corrigé détaillé en LaTeX, par sous-question (code C complet pour 6.2, init/release + correction pour 6.3)." },
    points: { type: "integer", description: "15" },
  },
  required: ["category", "concept", "statement_tex", "solution_tex", "points"],
  additionalProperties: false,
} as const;

function buildLabPrompt(lab: LabDef, topic: string): string {
  const p = profile();
  return [
    labsDirectivesBlock(),
    ``,
    q6VisionBlock(),
    ``,
    `Tu es l'équipe enseignante de CS-202 Computer Systems à l'EPFL (Argyraki, Kashyap, Chappelier).`,
    `Tu rédiges LA question « Labs » (Question 6, 15 points) d'un Final 2026 INÉDIT, EN ANGLAIS,`,
    `indiscernable d'une vraie question d'examen EPFL — moule Q6 2025, contenu = le lab ci-dessous.`,
    ``,
    q6MouldBlock(),
    ``,
    labBlock(lab, topic),
    ``,
    corpusBlock(lab, topic),
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. Aucun outil au-delà de Read, aucun fichier.`,
    JSON.stringify(LAB_EX_SCHEMA, null, 2),
  ].join("\n");
}

/** Étape 1 de la vérif à l'aveugle, version Labs : moule Q6 + fichiers réels du lab. */
function labVerifyStep1(lab: LabDef): string {
  const keys = lab.files.filter((f) => f.key && fs.existsSync(path.join(process.cwd(), f.rel))).map((f) => f.rel);
  return [
    `ÉTAPE 1 — Ouvre d'abord LE MOULE (outil Read) : ${[...Q6_HANDOUT_IMGS.slice(0, 2), ...Q6_SOL_IMGS.slice(0, 2)].join(", ")} (la vraie Q6 du Final 2025 et son corrigé officiel).`,
    `Ouvre AUSSI le vrai code du lab : ${keys.join(", ")}.`,
    `Puis RÉSOUS L'EXERCICE CI-DESSOUS DE ZÉRO, toi-même, rigoureusement : trace le scénario de 6.1, ÉCRIS le code C de 6.2, classe les ownership et débugge l'extrait de 6.3. Écris ta solution complète dans "my_solution". Ne te laisse PAS influencer par le corrigé proposé (tu le verras à l'étape 2).`,
    `Vérifie au passage : (1) l'exercice suit le moule Q6 2025 — EXACTEMENT 3 sous-questions (conceptuel 3 pts / écrire une fonction C 5 pts / ownership-debug 7 pts en ①②③) ; (2) les structs/fonctions viennent du VRAI code de ce lab ; (3) tout se résout sur papier. Sinon → verdict "ambiguous" avec le problème dans "issue".`,
  ].join("\n");
}

/** Régénère un exo Labs en corrigeant un diagnostic (boucle de durcissement de verify.ts). */
async function regenerateLabExercise(lab: LabDef, topic: string, q: ExamQuestion, diagnostic: string): Promise<ExamQuestion> {
  const p = profile();
  const prompt = [
    labsDirectivesBlock(),
    ``,
    q6VisionBlock(),
    ``,
    `Régénère LA question « Labs » (Q6, 15 points) d'un Final CS-202 EN ANGLAIS, concept proche de « ${q.concept} », même moule Q6 2025.`,
    `La version précédente a ce PROBLÈME à corriger : ${diagnostic}`,
    ``,
    q6MouldBlock(),
    ``,
    labBlock(lab, topic),
    ``,
    p.latexContract(),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON {category, concept, statement_tex, solution_tex, points}. Aucun outil au-delà de Read, aucun fichier.`,
    JSON.stringify(LAB_EX_SCHEMA, null, 2),
  ].join("\n");
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 480_000 });
  const r = extractJson<ExamQuestion>(text);
  return { ...r, category: "Labs", points: 15 };
}

export type LabExerciseInput = { lab?: string; topic?: string };

/**
 * Génère UN exercice Labs (moule Q6 2025, contenu = le vrai code du lab), vérifié à l'aveugle,
 * persisté comme exercice (2 PDF : énoncé + corrigé, sans page de garde). Tag `labs:<id>`.
 */
export async function generateLabExercise(
  input: string | LabExerciseInput,
  opts: { onStep?: StepCb } = {}
): Promise<{ id: number; url: string; texError?: string }> {
  const t0 = Date.now();
  const step = opts.onStep ?? (() => {});
  const norm: LabExerciseInput = typeof input === "string" ? (input.trim().startsWith("{") ? JSON.parse(input) : { topic: input }) : input;
  const topic = (norm.topic ?? "").trim();
  const lab = resolveLab(norm.lab ?? topic);
  step(`Lab ciblé : ${lab.label}${topic ? ` (focus « ${topic} »)` : ""}`, 8);

  const prompt = buildLabPrompt(lab, topic);
  step("Génération de l'exercice Labs — moule Q6 2025 + vrai code du lab (Claude · Max)…", 25);
  const text = await runClaudeCode({ prompt, model: "opus", timeoutMs: 600_000 });
  let q = extractJson<ExamQuestion>(text);
  q.category = "Labs";
  q.points = 15;

  step("Vérification à l'aveugle (moule Q6 + code du lab)…", 62);
  let report: VerifyReport | undefined;
  try {
    const v = await verifyAndHarden(
      { title: q.concept, questions: [q] },
      (qq, diag) => regenerateLabExercise(lab, topic, qq, diag),
      2,
      (m) => step(m, 75),
      { directives: labsDirectivesBlock(), step1: labVerifyStep1(lab) }
    );
    q = v.spec.questions[0] ?? q;
    report = v.report;
  } catch (e) {
    step(`Vérif interrompue : ${(e as Error).message}`, 82);
  }

  step("Compilation du PDF (sans garde)…", 92);
  const out = await persistExercise(q, report, `labs:${lab.id}`);
  if (out.texError) step(`⚠ Compilation LaTeX échouée → repli HTML lisible (${out.texError.slice(0, 180)})`, 97);
  step(`Terminé ✓ (${Math.round((Date.now() - t0) / 1000)}s)`, 100);
  return out;
}

/** La série figée : un exo par lab (UI + preuve NS13). */
export function labSeries(): { lab: LabDef; exams: { id: number; file: string | null; verified: number | null }[] }[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT e.id, e.html_path file, q.verified, q.source_inspiration tag
         FROM exams e JOIN exam_questions q ON q.exam_id = e.id
         WHERE q.source_inspiration LIKE 'labs:%' AND e.status = 'ready'
         ORDER BY e.id`
      )
      .all() as { id: number; file: string | null; verified: number | null; tag: string }[];
    return LABS.map((lab) => ({ lab, exams: rows.filter((r) => r.tag === `labs:${lab.id}`) }));
  } catch {
    return LABS.map((lab) => ({ lab, exams: [] }));
  }
}
