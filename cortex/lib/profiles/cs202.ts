import { ARCHETYPES, type Archetype } from "@/lib/archetypes";
import { buildBlueprint } from "@/lib/blueprint";
import type { CourseProfile, Slot } from "@/lib/course-profile";
import { directivesBlock, staffNotesText } from "@/lib/directives";
import { refImageFor, visionBlock } from "@/lib/figrefs";

/**
 * Profil cs-202 = les textes HISTORIQUES, déplacés ici VERBATIM depuis lib/exam.ts.
 * Toute modification ici change le prompt cs-202 → à NE PAS toucher sans raison.
 */

const LATEX_CONTRACT = [
  `═══ FORMAT DE SORTIE : LaTeX COMPILABLE (pdflatex/tectonic), PAS de HTML ═══`,
  `\`statement_tex\` et \`solution_tex\` contiennent du LaTeX (le CORPS seulement). N'écris NI \\documentclass, NI \\usepackage, NI \\section, NI \\begin{document}, NI l'en-tête de question, NI l'espace réponse (le système les ajoute).`,
  `Macros disponibles (utilise-les) :`,
  `  - \\subq{1.1}{Titre de la sous-question}{16}  → en-tête de sous-question avec points.`,
  `  - \\cn{1} \\cn{2} \\cn{3} \\cn{4}  → énumérateurs entourés ① ② ③ ④.`,
  `  - \\callout{This question is \\textbf{\\large FOR ALL STUDENTS.}}  → encadré centré (comme les vrais examens).`,
  `Conventions LaTeX :`,
  `  - Listes : \\begin{itemize}...\\end{itemize} ; options a) b) c) : \\begin{enumerate}[label=\\alph*)]...\\end{enumerate}.`,
  `  - Code inline : \\texttt{find\\_all()} ; bloc de code : \\begin{lstlisting}[language=C] ... \\end{lstlisting}.`,
  `  - Variables/maths en italique : $R_1$, $A_{100}$, $C_{1000}$, $2^{16}$.`,
  `  - Tableaux À REMPLIR : \\begin{tabular}{|l|c|c|}\\hline ... \\\\\\hline \\end{tabular} avec des \\rule{2.5cm}{0.4pt} pour les cases vides.`,
  `  - FIGURES = vraies figures TikZ RICHES (PAS d'ASCII), PLEINE LARGEUR, centrées, avec une légende numérotée — au niveau des images de référence que tu as regardées :`,
  `      • TCP : utilise la macro \\tcpladder{D_1}{A_1}{5 Kbytes}{1 MSS}{$\\infty$}{7} (diagramme en échelle scaffoldé : colonnes + handshake + espace à remplir).`,
  `      • Topologie réseau : appelle IMPÉRATIVEMENT la macro \\examtopo (topologie canonique 2-AS DÉJÀ dessinée et FIXE : AS1 = {$R_1,R_2$, SW1, cluster $A_1\\ldots A_{100}$, cluster $B_1\\ldots B_{10}$ avec $B_1$=DNS}, AS2 = {$R_3,R_4$, SW2, cluster $C_1\\ldots C_{100}$, cluster $D_1\\ldots D_{10}$ avec $D_1$=d1.epfl.ch}, interfaces orange e,f,g,h,i,j,k,l,m,p,q, coûts roses 5/10/1, débits verts 1G/100M/1G, cloud « Rest of the Internet » relié à $R_3$). NE dessine PAS de topologie à la main : utilise \\examtopo et ancre TES sous-questions (sous-réseaux, forwarding, longest-prefix, packet-trace ARP+DNS+TCP, Dijkstra/Bellman-Ford, délais) sur CES éléments fixes.`,
  `      • OS/FS : utilise les MACROS VERROUILLÉES (ne dessine PAS ces figures à la main) : \\examinode (inode v6 : addr[0..7], direct/single/double-indirect → index → data) ; \\begin{examproctree} ... \\end{examproctree} (nœuds \\node[pnode]{...}, flèches \\draw[forkarrow] = fork, \\draw[execarrow] = exec, étiquette programme + var=val) ; \\examstates (diagramme d'états Running/Ready/Blocked).`,
  `    Mets chaque figure dans \\begin{center}\\begin{tikzpicture}[node distance=1.2cm] ... \\end{tikzpicture}\\end{center}\\figcaption{Figure N: ...}. La géométrie doit être propre et lisible.`,
  `  - GRILLES DE RÉPONSE (OBLIGATOIRE) : APRÈS CHAQUE sous-question, émets son échafaudage de réponse PRÉ-DESSINÉ, dimensionné comme chez la prof — JAMAIS un simple blanc ni « Answers: » :`,
  `      • packet-trace (« list ALL packets seen at interface X », ARP + DNS + TCP) → \\packetgrid{12} (12-15 lignes).`,
  `      • simulation d'états de processus / scheduling → \\statesim{16} (15-20 lignes).`,
  `      • comptage d'accès disque / inode → \\diskgrid{8}.`,
  `      • décisions de forwarding / longest-prefix → \\forwardgrid{6}.`,
  `      • diagramme TCP → \\tcpladder{D_1}{A_1}{5 Kbytes}{1 MSS}{$\\infty$}{8} (échelle scaffoldée).`,
  `      • question ouverte / justification (V/F, « explain », « justify ») → \\rulelines{6}.`,
  `    Choisis la grille ET son nombre de lignes selon le type de sous-question. Chaque sous-question DOIT finir par sa grille.`,
  `RÈGLES DE COMPILATION (impératif) : échappe \\% \\& \\# \\_ dans le texte courant ; équilibre toutes les accolades et environnements ; pas de markdown ; pas d'images externes ; LaTeX qui COMPILE du premier coup.`,
].join("\n");

const EXAM_SLOTS: Slot[] = [
  { category: "Networking", points: 50, brief: "Subnets / forwarding / longest-prefix (with a trap) / FULL packet-trace at a router interface (ARP + recursive DNS + TCP, \\packetgrid{12}) — anchored on the FIXED canonical topology \\examtopo (use its routers R1-R4, interfaces e-q, clusters A/B/C/D, B1=DNS, D1=d1.epfl.ch). The statement MUST start with \\examtopo." },
  { category: "Networking", points: 50, brief: "TCP on the canonical topology (no need to repeat the figure; refer to Figure 1): \\tcpladder diagram (slow start, Tahoe vs Reno, fast recovery, SEQ/ACK bookkeeping) + end-to-end delay computation across two links with a bottleneck and non-round numbers." },
  { category: "OS", points: 25, brief: "Disk access & inodes: multi-level indexing, count block accesses for an open/lseek/read/write sequence crossing the direct→single-indirect boundary (trap: sparse file / cache hit), \\diskgrid{8}. Optionally \\examinode figure." },
  { category: "OS", points: 30, brief: "Processes & CPU scheduling: ONE concrete program with fork/exec/wait (process tree via \\examproctree if helpful) + a multi-line state/scheduling simulation \\statesim{16} (FIFO/SJF/STCF/RR or MLFQ, turnaround/response, single-core, RR assumes no known durations) + a data race fixed by lock()/unlock() (max allowed concurrency)." },
  { category: "C", points: 10, brief: "READING lab-style C code (client socket code or file I/O): recognize syscalls, file descriptors, fork/exec/wait — never write/debug code. \\begin{lstlisting} with the code, then short questions with \\rulelines." },
  { category: "Labs", points: 15, brief: "A REAL lab artifact in READING: client-server get_file/send_file/socket_layer OR filesystem direntv6 inode walk. Recognize what the code does, trace a call, identify the syscalls involved." },
];

export const cs202Profile: CourseProfile = {
  directivesBlock,
  visionBlock,
  staffNotesText,
  refImageFor,
  latexContract: () => LATEX_CONTRACT,
  archetypes: ARCHETYPES,
  examSlots: () => EXAM_SLOTS,
  buildBlueprint,
  promptIntroFull: () => [
    `Tu es l'équipe enseignante de CS-202 Computer Systems à l'EPFL (Argyraki, Kashyap, Chappelier).`,
    `Tu rédiges le FINAL de l'an prochain : un « Final 2026 » INÉDIT, EN ANGLAIS, qui doit être INDISCERNABLE d'un vrai final EPFL (« ça aurait pu tomber tel quel »). Les CONTRAINTES DURES + l'ANCRAGE VISUEL ci-dessus priment sur tout.`,
    ``,
    `═══ STRUCTURE (calquée sur le Final 2025) ═══`,
    `6 exercices indépendants, notés séparément, regroupés : Networking (2, ~50 pts), OS (2, ~25 et ~30 pts), C (1, ~10 pts), Labs (1, ~15 pts). Total ≈ 180 pts, 3 h.`,
    `PRINCIPE (cf. directives) : chaque grosse question (≥25 pts) = UN artefact unique (programme/topologie/FS+programme/trace) creusé par 5-7 sous-questions \\subq{N.M}{...}{pts} EN ESCALIER (difficulté croissante), qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE et des nombres NON RONDS. Profondeur > largeur. Modèle de profondeur = Final 2024 Q3 (regarde son image).`,
    `Archétypes (en respectant les EXCLUSIONS) : Networking = TOPOLOGIE DENSE au niveau de la Figure 1 réelle (regarde data/refs/figref/topo_2024.png) : DEUX Autonomous Systems (AS1/AS2) avec un border router chacun, ~4 routeurs au total, 2-4 switches L2, PLUSIEURS clusters d'end-systems étiquetés (A1…A150, B1…B100, C1…C100, D1…D10), un serveur DNS (root/authoritative) ET un serveur web nommés, un cloud « Rest of the Internet ». COÛTS roses ET DÉBITS verts sur CHAQUE lien ; interfaces orange nommées sur CHAQUE port de routeur. Dessine chaque AS comme une RÉGION encadrée en POINTILLÉS étiquetée « AS1 »/« AS2 » (un rectangle ou un node[draw,dashed,fit=...] englobant ses routeurs+switches+clusters) ; note les grappes d'end-systems avec des points de suspension ($A_1 \\ldots A_{100}$). Layout propre et lisible (dense mais pas fouillis), pleine largeur, légende « Figure 1 ». Sur cette topologie : sous-réseaux & paquets (préfixes en PETIT, tableau des paquets/interfaces vus par un routeur), routage Dijkstra/Bellman-Ford, TCP (\\tcpladder : SEQ/ACK/cwnd/ssthresh/état + handshake, slow start, Tahoe/Reno, fast recovery), forwarding/longest-prefix (avec égalité piège), ARP, délais bout-en-bout (multi-saut, bottleneck). OS = accès disque & inodes (compter blocs par open/lseek/read/write, multi-level indexing, frontière direct/indirect piège), CPU scheduling (FIFO/SJF/STCF/RR/MLFQ, turnaround/response), états de processus, fork/exec/wait/waitpid (arbre de processus), kernel vs user (V/F à justifier). C = LIRE du code lab-style, reconnaître syscalls/fork/exec/wait/file descriptors (jamais écrire/débugger). Labs = lecture/compréhension de code des labs (client-serveur get_file/send_file/socket_layer, filesystem direntv6, multi-threading) — PAS « DKVS ».`,
  ],
  promptIntroBatch: (n: number) => [
    `Tu es l'équipe enseignante de CS-202 Computer Systems (EPFL). Tu rédiges ${n} exercices INÉDITS, EN ANGLAIS, d'un « Final 2026 » indiscernable d'un vrai final EPFL.`,
    `PRINCIPE : chaque exercice = UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS.`,
  ],
  exerciseLead: (target: string, a: Archetype, pts: number, refImage: string | null) => [
    `═══ ANCRAGE VISUEL ═══ Regarde la vraie page de référence du même type : ${refImage} (outil Read). Vise sa richesse/difficulté.`,
    ``,
    `Tu rédiges UN SEUL exercice de Final CS-202 EN ANGLAIS, qualité examen, CIBLÉ sur : « ${target} ».`,
    `Archétype à RÉ-INSTANCIER (ne recopie pas) : ${a.concept}. Construction : ${a.structure} Grille de réponse : ${a.grid}. Figure : ${a.figure}. PIÈGE à inclure : ${a.trap}.`,
    `Barème ~${pts} points. UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier, NOMBRES NON RONDS.`,
  ],
  regenLead: (category: string | undefined, concept: string, points: number | undefined, diagnostic: string, refImage: string | null) => [
    `Regarde la vraie page de référence du même type : ${refImage} (outil Read), pour viser sa richesse/difficulté.`,
    ``,
    `Régénère UN SEUL exercice de Final CS-202 EN ANGLAIS, catégorie « ${category} », concept proche de « ${concept} », barème ${points} points.`,
    `La version précédente a ce PROBLÈME à corriger : ${diagnostic}`,
    `Applique le PRINCIPE DE CONSTRUCTION : UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS, au niveau de la vraie page.`,
  ],
  qaIntro: () => `Tu es l'équipe enseignante de CS-202 Computer Systems (EPFL).`,
};
