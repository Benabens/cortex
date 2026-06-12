/**
 * V3 — Moteur de DIFFICULTÉ et de STYLE de la prof (cs-202).
 *
 * Le générateur imitait le LOOK des vrais finals, pas leur DIFFICULTÉ. Ce module encode ce qui
 * manquait, EXTRAIT DES VRAIS EXAMENS (Final 2024/2025 + Midterm 2024, lus en vision) :
 *  - `TRAPS` : la bibliothèque de PIÈGES réels par archétype — chacun = une idée fausse précise
 *    que la prof teste, le cas-limite qui la déclenche, et l'erreur du « pattern-matcher ».
 *  - `RUBRIC` : la barre de difficulté MESURÉE (nb de sous-questions, étapes, taille des grilles,
 *    enchaînement, cas-limite obligatoire) — la question générée doit l'atteindre, sinon → révision.
 *  - `STYLE_GUIDE` : la patte de Katerina (réseaux/OS) et JCC (C/Labs) — phrasé, « justify »,
 *    « state your assumptions », réponses qui peuvent être « non / on ne peut pas / pas assez d'info ».
 *
 * Données ancrées (exemples réels) : 2025 Q1 « 102 adresses ⇒ /25 » (oubli broadcast+routeur) ;
 * Q1.3 « pas d'ARP/DNS à la 2ᵉ action » (caches) ; Q2 Tahoe + 4ᵉ segment perdu ⇒ timeout ;
 * Q2.2 store-and-forward « le switch a-t-il relayé d'autre trafic ? » ; Q3.2 mémoire vs I/O (DMA) ;
 * 2024 Q3 fork×threads « la valeur est-elle fixée ? unique ? justify completely ».
 *
 * cs-202 d'abord : `TRAPS`/`RUBRIC` sont indexés par les id d'archétypes de lib/archetypes.ts.
 * Pour un autre cours, `trapsFor`/`rubricFor` renvoient vide → les blocs dégradent en consignes
 * génériques (l'architecte multi-passes reste utile : conception de piège + critique adversariale).
 */

export type Trap = {
  /** L'idée fausse précise que la question punit (1 phrase). */
  misconception: string;
  /** Le setup concret qui DÉCLENCHE le piège (ce qu'il faut mettre dans l'énoncé). */
  setup: string;
  /** Le cas-limite / la subtilité (frontière, négatif, ordre, cache, ownership…). */
  edge: string;
  /** Ce que répond un étudiant qui PATTERN-MATCHE (et pourquoi c'est faux) — sert à discriminer. */
  patternMatchFail: string;
};

export type Rubric = {
  /** Nb de sous-questions en escalier attendu (médian réel du type). */
  subparts: number;
  /** Nb d'étapes de raisonnement non-triviales pour la sous-question dure. */
  steps: number;
  /** La grille/charge de bookkeeping attendue (taille). */
  bookkeeping: string;
  /** Vrai si au moins une sous-question doit DÉPENDRE d'une précédente. */
  mustChain: boolean;
  /** Vrai si un cas-limite/piège est obligatoire (toujours, ici). */
  edgeRequired: boolean;
  /** Vrai si une réponse légitime peut être « non / on ne peut pas / pas assez d'info ». */
  mayBeNegative: boolean;
};

// ───────────────────────── BIBLIOTHÈQUE DE PIÈGES (par archétype) ─────────────────────────

export const TRAPS: Record<string, Trap[]> = {
  "packet-trace": [
    {
      misconception: "Dimensionner un sous-réseau en comptant seulement les end-systems (2^n ≥ hosts).",
      setup: "Un sous-réseau dont le nombre d'hôtes est JUSTE sous une puissance de 2 (ex. 126 ou 100 hôtes) + 1 routeur ; demande le préfixe de TAILLE LA PLUS PETITE.",
      edge: "Il faut compter les hôtes + l'interface du routeur (gateway) + l'adresse de broadcast : 126 hôtes ⇒ 126+1+1 = 128 ⇒ 8 bits ⇒ /24 (pas /25).",
      patternMatchFail: "Le pattern-matcher fait 2^7 = 128 ≥ 126 ⇒ /25, en oubliant gateway+broadcast ⇒ préfixe trop petit d'un bit (FAUX).",
    },
    {
      misconception: "Allouer des préfixes qui se chevauchent ou non agrégeables entre deux sous-réseaux/AS.",
      setup: "Deux AS (ou plusieurs sous-réseaux) à adresser depuis un bloc commun, dont un AS à TRÈS gros effectif (ex. 30 000 hôtes ⇒ /17), avec un QCM de 4 scénarios d'allocation dont un seul valide.",
      edge: "Rejeter les 3 mauvais en 1 phrase chacun (chevauchement de préfixes, /16 alors qu'on a besoin de /17, agrégat incohérent) ; « flip one bit » pour garder l'agrégation.",
      patternMatchFail: "Le pattern-matcher choisit le 1er scénario « qui a l'air de marcher » sans vérifier le chevauchement ni la taille du gros AS.",
    },
    {
      misconception: "Croire que la 2ᵉ requête web ré-déclenche ARP et la résolution DNS récursive.",
      setup: "Deux actions utilisateur successives (2 URLs sur le même domaine) après reboot+caches vides ; demande si la 2ᵉ action génère des messages ARP/DNS.",
      edge: "Caches : après la 1ʳᵉ action, ARP (gateway) et DNS (TTL) sont en cache ⇒ la 2ᵉ action n'échange NI ARP NI DNS. L'ARP ne traverse pas le switch L2 (pas d'IP) ; la résolution DNS récursive ne passe pas par l'interface vers l'hôte.",
      patternMatchFail: "Le pattern-matcher « refait tout le handshake » à chaque requête ⇒ liste ARP+DNS à tort.",
    },
    {
      misconception: "Calculer le forwarding sans agréger et sans ignorer les sous-réseaux sans end-systems.",
      setup: "Demande la table de forwarding d'un routeur après convergence, avec un sous-réseau de transit sans end-system et deux préfixes agrégeables.",
      edge: "Ignorer les sous-réseaux sans end-systems ; longest-prefix avec une égalité APPARENTE (deux préfixes couvrent la destination, le plus spécifique gagne).",
      patternMatchFail: "Le pattern-matcher liste une entrée par sous-réseau sans agréger / sans gérer l'égalité de préfixe.",
    },
    {
      misconception: "Croire qu'il faut un calcul de délai sophistiqué là où il faut compter les segments par RTT (slow start).",
      setup: "On donne que la transmission d'un objet prend « un peu plus de 2 mais moins de 3 RTT » ; remonter à la TAILLE d'un autre objet (back-reasoning).",
      edge: "Compter les segments envoyables par round sous slow start (1,2,4,…) ; la borne 2–3 RTT fixe un intervalle de tailles, pas une valeur unique.",
      patternMatchFail: "Le pattern-matcher tente une formule de délai bout-en-bout au lieu de compter les rounds ⇒ se perd.",
    },
  ],
  "tcp-reno": [
    {
      misconception: "Appliquer la reprise rapide (Reno) là où la perte est détectée par TIMEOUT (Tahoe ou pas de triple-ACK).",
      setup: "TCP Tahoe (ou Reno mais perte d'un segment isolé sans 3 ACK dupliqués) ; un segment précis est perdu (ex. le 4ᵉ, le SYN-ACK comptant comme 1ᵉʳ) ; timeout = 3×RTT.",
      edge: "Détection par timeout ⇒ ssthresh = cwnd/2, cwnd ← 1 MSS, retour en slow start. Reno ne fait du fast-recovery QUE sur triple-ACK dupliqué.",
      patternMatchFail: "Le pattern-matcher applique cwnd ← ssthresh (fast recovery) à une perte par timeout ⇒ courbe cwnd fausse.",
    },
    {
      misconception: "ACK = numéro du segment +1 (au lieu du prochain OCTET attendu, cumulatif).",
      setup: "Remplir la table SEQ/ACK d'un échange de ~8–10 segments avec MSS non rond, dont une perte.",
      edge: "ACK = prochain octet attendu (octets 1..1000 reçus ⇒ ACK 1001). Après perte, l'ACK reste bloqué (dup-ACK) sur le dernier octet contigu.",
      patternMatchFail: "Le pattern-matcher incrémente l'ACK de 1 par segment, ou avance l'ACK malgré le trou ⇒ bookkeeping faux.",
    },
    {
      misconception: "Multiplier le délai de propagation par le nombre de bits / oublier le store-and-forward au goulot.",
      setup: "Deux liens de débits différents (ex. 4R puis R), store-and-forward, P par lien, nombres NON RONDS (P=10 ms, R=10 Mbps, MSS=1250 B). « Le switch a-t-il relayé d'autre trafic ? » + taille minimale de la file.",
      edge: "Délai = SOMME des composantes (setup + rounds + transmission des derniers segments au goulot) ; comparer au temps donné pour DÉDUIRE s'il y a eu d'autre trafic ; le 2ᵉ lien (R) est le goulot ⇒ file qui se remplit.",
      patternMatchFail: "Le pattern-matcher multiplie la propagation par le nombre de paquets/bits, ou ignore la mise en file au lien lent ⇒ temps faux.",
    },
  ],
  "inode-walk": [
    {
      misconception: "Compter les blocs de données sans le bloc d'index supplémentaire à la frontière direct→indirect.",
      setup: "Un open/lseek/read dont la plage CHEVAUCHE la frontière entre le dernier pointeur direct et le single-indirect ; tailles/offsets non ronds ; taille de fichier via i_size0«16 | i_size1.",
      edge: "Franchir la frontière ⇒ un accès EN PLUS pour lire le bloc d'index single-indirect, avant le bloc de données indirect.",
      patternMatchFail: "Le pattern-matcher compte 1 accès par bloc de données et oublie la lecture du bloc d'index ⇒ sous-compte d'un accès.",
    },
    {
      misconception: "Compter un accès disque pour un trou (sparse) ou pour un bloc déjà en cache.",
      setup: "Un fichier sparse (un lseek crée un trou) puis read sur le trou ET sur un bloc déjà lu (donc caché).",
      edge: "Un trou se lit comme des zéros SANS accès disque ; un read non caché = 1 accès disque, mais un bloc déjà en cache n'est PAS recompté.",
      patternMatchFail: "Le pattern-matcher compte un accès par read sans distinguer trou/cache ⇒ sur-compte.",
    },
    {
      misconception: "Compter les accès disque d'un open(O_CREAT)/write/lseek/read sans distinguer inode vs data, Read vs Write.",
      setup: "UN programme C concret (open avec O_CREAT|O_TRUNC sur /home/<u>/x.txt, write, lseek, read, close) ; remplir une TABLE À DOUBLE ENTRÉE : accès inode-block et data-block, en lecture ET en écriture, PAR syscall et PAR composant du path (midterm '24 Q4).",
      edge: "open résout le path (lecture des inodes/data de chaque répertoire) ET ÉCRIT (créer l'inode + l'entrée du répertoire parent) ; lseek ne touche RIEN ; read après write se sert du cache (0 accès) ; close = 0.",
      patternMatchFail: "Le pattern-matcher met un accès par syscall (lseek compris) et oublie les ÉCRITURES de la création (inode + data du répertoire parent).",
    },
    {
      misconception: "Confondre taille adressable max par niveau d'indirection.",
      setup: "Demander la taille de fichier maximale en direct seul, puis direct+single-indirect, avec SECTOR_SIZE et ADDRESSES_PER_SECTOR donnés (non ronds).",
      edge: "direct = 8×512 ; single-indirect ajoute 256 pointeurs × 512 ; la frontière exacte décide direct vs indirect pour un offset donné.",
      patternMatchFail: "Le pattern-matcher additionne mal les niveaux ou oublie que les 8 (ou 7) premiers restent directs.",
    },
  ],
  "fork-sched": [
    {
      misconception: "La valeur d'une variable partagée est déterministe ET son affichage est ordonné.",
      setup: "UN programme avec fork ET threads partageant une variable, qui imprime sa valeur ; demander : la valeur finale est-elle FIXÉE ? UNIQUE ? « justify completely ».",
      edge: "Avec processus (fork) : copie de l'espace d'adressage ⇒ valeurs indépendantes. Avec threads : mémoire partagée ⇒ data race ⇒ valeur PAS garantie ; l'ENTRELACEMENT (ordre des prints) n'est jamais garanti même si la valeur l'est.",
      patternMatchFail: "Le pattern-matcher répond « la valeur est X » sans distinguer fork (copie) de thread (partagé), ni valeur vs ordre.",
    },
    {
      misconception: "Compter les processus comme si fork bouclait, ou que le fils repart du début.",
      setup: "Une cascade de fork (avec une condition / une boucle bornée) ; demander combien de processus, qui imprime quoi, et l'arbre.",
      edge: "fork renvoie 2 fois ; le fils reprend APRÈS le fork (pas de re-exécution du début) ; waitpid/zombie pour la terminaison.",
      patternMatchFail: "Le pattern-matcher calcule 2^n sans tenir compte des conditions / suppose un fork infini.",
    },
    {
      misconception: "Croire que la sortie d'un programme fork+wait est forcément non-déterministe (ou l'inverse).",
      setup: "Un programme fork/exec/wait CONCRET (ex. le fils execvp un `ls`, le parent wait puis imprime) ; demander la sortie exacte ET « is this output deterministic? Justify ».",
      edge: "wait() ORDONNE le parent après le fils ⇒ la sortie EST déterministe ici (midterm '24 Q1) ; sans wait, l'entrelacement ne l'est pas. Et execvp REMPLACE l'image : le code après execvp ne s'exécute pas (sauf échec).",
      patternMatchFail: "Le pattern-matcher répond « non-déterministe » par réflexe (ou imprime le code situé après execvp), sans voir que wait() fixe l'ordre.",
    },
    {
      misconception: "Estimer l'épuisement de la pile sans compter TOUT ce qu'un appel empile.",
      setup: "Une fonction récursive (ex. fibonacci) avec convention d'appel donnée (arguments sur la pile, pas d'optimisation) et une taille de pile NON RONDE (ex. 8 KiB) ; demander après ~combien d'appels la pile déborde, et l'effet de retirer UNE variable.",
      edge: "Chaque frame = arguments + adresse de retour + variables locales (midterm '24 Q2 : 5 mots de 8 octets → ~204 appels) ; la récursion est DEPTH-FIRST (la première branche épuise la pile avant l'autre) ; retirer une variable fait 5→4 mots (recalcul).",
      patternMatchFail: "Le pattern-matcher oublie l'adresse de retour (ou compte les deux branches en parallèle) ⇒ estimation fausse.",
    },
    {
      misconception: "Simuler un scheduler sans ses hypothèses (RR sans durées, single-core).",
      setup: "Plusieurs jobs avec temps d'arrivée/durées non ronds ; simuler FIFO/SJF/STCF/RR/MLFQ sur ≥16 lignes ; turnaround + response.",
      edge: "RR ne suppose AUCUNE durée connue ; single-core par défaut ; STCF préempte à l'arrivée d'un job plus court ; MLFQ dégrade la priorité.",
      patternMatchFail: "Le pattern-matcher applique SJF non préemptif là où c'est STCF, ou suppose des durées en RR.",
    },
    {
      misconception: "Croire qu'une section critique sans verrou est correcte « parce que ça marche souvent ».",
      setup: "Un court extrait avec un data race (incrément partagé par 2 threads) ; demander d'ajouter lock()/unlock() au BON endroit + la concurrence max autorisée.",
      edge: "Le verrou doit entourer EXACTEMENT la section critique (ni trop large = sérialise tout, ni trop étroit = race subsiste).",
      patternMatchFail: "Le pattern-matcher met le lock au mauvais endroit (race restante) ou verrouille tout (perte de parallélisme).",
    },
  ],
  // OS conceptuel (sous-questions d'échauffement/discrimination, style Katerina — en scope) :
  "os-concept": [
    {
      misconception: "« Pas d'instruction load/store ⇒ pas d'accès mémoire ».",
      setup: "On regarde de l'assembleur sans mov vers/depuis la mémoire ; un ami conclut « aucun accès mémoire » ; vrai/faux + justification.",
      edge: "FAUX : le fetch des instructions est un accès mémoire ; push/pop (pile) aussi ; un syscall peut en déclencher.",
      patternMatchFail: "Le pattern-matcher valide le raisonnement de l'ami (regarde seulement les load/store explicites).",
    },
    {
      misconception: "Lire depuis le disque occupe le CPU comme lire depuis la mémoire.",
      setup: "Process A lit N octets en mémoire, Process B lit N octets du disque (non cachés) ; 4 affirmations vrai/faux à justifier en 1–2 phrases (kernel code ? plus rapide ? occupation CPU ?).",
      edge: "B nécessite un syscall (kernel) ; l'I/O disque se fait par DMA ⇒ le CPU n'est PAS occupé pendant l'attente I/O ; A est bien plus rapide mais B « occupe » peu le CPU (il bloque).",
      patternMatchFail: "Le pattern-matcher dit « B occupe plus le CPU car plus lent », en confondant temps écoulé et temps CPU.",
    },
    {
      misconception: "Confondre user/kernel, OS/kernel, syscall/exception/interruption.",
      setup: "Affirmations vrai/faux sur limited direct execution, instructions privilégiées, timer interrupt, ce qui fait passer le CPU en kernel.",
      edge: "Les 3 causes de bascule (syscall, exception/trap, interruption) diffèrent ; le timer interrupt rend le scheduling possible ; instruction privilégiée ⇒ trap si en user.",
      patternMatchFail: "Le pattern-matcher mélange syscall (volontaire) et interruption (asynchrone).",
    },
  ],
  "c-reading": [
    {
      misconception: "Confondre appel de bibliothèque et appel système.",
      setup: "Un extrait lab-style (file I/O ou sockets) avec fopen/fread/fwrite ET open/read/write ; demander quels SYSCALLS sont déclenchés.",
      edge: "fopen/fread déclenchent open/read SOUS LE CAPOT ; un fread peut ne PAS faire de read (buffer de la libc).",
      patternMatchFail: "Le pattern-matcher classe fopen comme syscall, ou compte un syscall par appel libc.",
    },
    {
      misconception: "Mauvais suivi des file descriptors après fork.",
      setup: "Un programme ouvre des fd puis fork ; demander quels fd sont ouverts dans le fils, ce que voit chaque processus.",
      edge: "Les fd (et l'offset partagé) sont HÉRITÉS après fork ; la valeur de retour de fork distingue parent/fils.",
      patternMatchFail: "Le pattern-matcher croit que le fils repart avec des fd neufs.",
    },
    {
      misconception: "Libérer une structure imbriquée dans le mauvais ordre (ou pas entièrement).",
      setup: "Une structure avec tableau de pointeurs mallocés (ex. lignes d'un set, midterm '24 Q5) ; LIRE une fonction free_set proposée et dire si elle fuit / double-free / utilise après free.",
      edge: "Ordre : libérer chaque ligne, PUIS le tableau de lignes, PUIS (selon le contrat) pas le set lui-même ; NULL-check d'abord ; un free du tableau avant les lignes = fuite.",
      patternMatchFail: "Le pattern-matcher valide un free(set->lines) sans la boucle sur les lignes (fuite invisible à ses yeux).",
    },
    {
      misconception: "Mauvais ordre / rôle des appels socket.",
      setup: "Un extrait client OU serveur ; demander l'ordre des appels et quel côté fait quoi.",
      edge: "Serveur : socket→bind→listen→accept ; client : socket→connect. Confondre les deux côtés est l'erreur.",
      patternMatchFail: "Le pattern-matcher attribue bind/listen au client ou connect au serveur.",
    },
  ],
};

// ───────────────────────── RUBRIQUE DE DIFFICULTÉ (par archétype) ─────────────────────────

export const RUBRIC: Record<string, Rubric> = {
  "packet-trace": { subparts: 4, steps: 5, bookkeeping: "table de forwarding + grille de paquets \\packetgrid{12} (12–15 lignes)", mustChain: true, edgeRequired: true, mayBeNegative: true },
  "tcp-reno": { subparts: 2, steps: 6, bookkeeping: "échelle \\tcpladder de ≥8 rounds + calcul de délai à ≥3 composantes additives", mustChain: true, edgeRequired: true, mayBeNegative: true },
  "inode-walk": { subparts: 3, steps: 5, bookkeeping: "comptage d'accès \\diskgrid{8} (énumérer chaque accès)", mustChain: true, edgeRequired: true, mayBeNegative: true },
  "fork-sched": { subparts: 4, steps: 5, bookkeeping: "arbre de processus + simulation d'états \\statesim{16} (≥16 lignes)", mustChain: true, edgeRequired: true, mayBeNegative: true },
  "os-concept": { subparts: 3, steps: 3, bookkeeping: "≥3 affirmations vrai/faux justifiées (\\rulelines{4} chacune)", mustChain: false, edgeRequired: true, mayBeNegative: true },
  "c-reading": { subparts: 3, steps: 3, bookkeeping: "extrait lstlisting + questions de lecture \\rulelines{4}", mustChain: false, edgeRequired: true, mayBeNegative: true },
};

// ───────────────────────── STYLE GUIDE (par prof) ─────────────────────────

const KATERINA_STYLE = [
  `STYLE DE KATERINA (Networking & OS) — IMITE-LE :`,
  `  - Phrasé : « Justify your answer. » ; « Say whether each of the following statements is True or False. Justify each answer in 1–2 sentences. » ; « Identify the one correct scenario and explain why you rejected the other three. »`,
  `  - Une réponse peut LÉGITIMEMENT être « No, because… » ou « We don't have enough information to compute it; explain why. » — n'hésite pas à concevoir une sous-question dont la bonne réponse est « non / on ne peut pas ».`,
  `  - « state your assumptions » ; impose des hypothèses explicites (single-core, caches activés TTL 1h, store-and-forward, headers négligeables).`,
  `  - « smallest possible size », « minimum size of the queue » : demande l'OPTIMUM, pas une valeur quelconque.`,
  `  - Sous-questions QUI S'ENCHAÎNENT : la sous-question N réutilise le résultat/scénario de N-1.`,
  `  - NOMBRES NON RONDS et volumes réalistes (P=10 ms, R=10 Mbps, MSS=1250 B, 30 000 hôtes, 8000/16000 octets).`,
  `  - Préambule « Background: » pour rappeler un appel/une convention (« Background: The library call execvp(cmd, …) replaces the current process image… ») puis « Assume… » pour les hypothèses (calling convention, tailles).`,
  `  - TABLES À DOUBLE ENTRÉE à remplir (le bookkeeping signature du midterm '24 Q4) : lignes = syscalls, colonnes = composants/types d'accès (inode vs data × Read vs Write).`,
  `  - « Is this output deterministic? Justify. » — questionne le déterminisme et son POURQUOI (wait(), entrelacement), pas juste la valeur.`,
];

const JCC_STYLE = [
  `STYLE DE JCC (C & Labs) — IMITE-LE :`,
  `  - Ownership/mémoire : statically vs dynamically allocated vs not-owner ; écrire init/release.`,
  `  - « Will this code compile? AND will it behave correctly? If not, which line(s) must change, and how? »`,
  `  - Écrire une VRAIE fonction avec contrat d'erreur (retour -1/0, NULL checks, tailles) ET gestion mémoire (malloc/strdup/free, never leak).`,
];

/** Style guide pertinent pour une catégorie d'exercice. */
export function styleFor(category?: string): string[] {
  const c = (category ?? "").toLowerCase();
  if (c === "c" || c === "labs") return JCC_STYLE;
  return KATERINA_STYLE; // Networking / OS / défaut
}

// ───────────────────────── ACCÈS + BLOCS DE PROMPT ─────────────────────────

export function trapsFor(archetypeId: string): Trap[] {
  return TRAPS[archetypeId] ?? [];
}
export function rubricFor(archetypeId: string): Rubric | null {
  return RUBRIC[archetypeId] ?? null;
}

/** Pour un archétype OS, ajoute les pièges conceptuels (échauffement Katerina) au menu. */
export function trapMenuIds(archetypeId: string): string[] {
  if (archetypeId === "inode-walk" || archetypeId === "fork-sched") return [archetypeId, "os-concept"];
  return [archetypeId];
}

/** Bloc « bibliothèque de pièges » : le menu des idées fausses réelles à PUNIR. */
export function trapMenuBlock(archetypeId: string): string {
  const ids = trapMenuIds(archetypeId);
  const all = ids.flatMap((id) => trapsFor(id));
  if (!all.length) return "";
  return [
    `═══ BIBLIOTHÈQUE DE PIÈGES RÉELS (extraits des vrais finals CS-202) — CHOISIS-EN UN ET CONÇOIS LA QUESTION POUR LE PUNIR ═══`,
    `Une vraie question EPFL teste une IDÉE FAUSSE PRÉCISE. Choisis UN piège ci-dessous (ou un équivalent explicite), construis le SETUP qui le déclenche, et assure-toi qu'un étudiant qui « reconnaît le type » sans comprendre se TROMPE :`,
    ...all.map((t, i) => [
      `  PIÈGE ${i + 1} — idée fausse : ${t.misconception}`,
      `     • setup déclencheur : ${t.setup}`,
      `     • cas-limite : ${t.edge}`,
      `     • échec du pattern-matcher (= ce qui DISCRIMINE) : ${t.patternMatchFail}`,
    ].join("\n")),
  ].join("\n");
}

/** Bloc « rubrique de difficulté » : la barre mesurable à atteindre. */
export function rubricBlock(archetypeId: string): string {
  const r = rubricFor(archetypeId);
  if (!r) {
    return [
      `═══ BARRE DE DIFFICULTÉ ═══`,
      `Multi-étapes (pas mono-étape), un PIÈGE nommé réellement testé, nombres NON RONDS, charge de bookkeeping réelle, et une approche « pattern-matching » doit donner une MAUVAISE réponse.`,
    ].join("\n");
  }
  return [
    `═══ BARRE DE DIFFICULTÉ (mesurée sur les vrais finals — la question DOIT cocher TOUT) ═══`,
    `  [ ] ≥ ${r.subparts} sous-questions en escalier \\subq{N.M}{...}{pts} (difficulté croissante).`,
    `  [ ] La sous-question dure demande ≥ ${r.steps} étapes de raisonnement non-triviales.`,
    `  [ ] Bookkeeping réel : ${r.bookkeeping}.`,
    r.mustChain ? `  [ ] AU MOINS une sous-question DÉPEND du résultat/scénario d'une précédente.` : ``,
    `  [ ] Un PIÈGE NOMMÉ (de la bibliothèque) est réellement testé ; un pattern-matcher se trompe.`,
    `  [ ] NOMBRES NON RONDS / cas-limite (frontière, négatif, ordre, cache, ownership).`,
    r.mayBeNegative ? `  [ ] BIENVENU : au moins une sous-question dont la bonne réponse est « non / on ne peut pas / pas assez d'info » (style Katerina).` : ``,
  ].filter(Boolean).join("\n");
}

/** Bloc complet de difficulté+style à injecter dans un prompt de génération ciblée. */
export function difficultyBlock(archetypeId: string, category?: string): string {
  return [trapMenuBlock(archetypeId), ``, rubricBlock(archetypeId), ``, ...styleFor(category)].filter(Boolean).join("\n");
}

/** Version compacte pour le prompt d'examen complet (6 exos) : menu de pièges par catégorie. */
export function difficultyBlockForExam(): string {
  const order = ["packet-trace", "tcp-reno", "inode-walk", "fork-sched", "c-reading"];
  return [
    `═══ DIFFICULTÉ & STYLE DE LA PROF — LE PLUS IMPORTANT (le look est réglé, la DIFFICULTÉ ne l'est pas) ═══`,
    `Chaque grosse question doit PUNIR une idée fausse précise (pas un exo mono-étape). Pièges réels par type :`,
    ...order.flatMap((id) => {
      const ts = trapsFor(id).slice(0, 2);
      return ts.length ? [`  • ${id} :`, ...ts.map((t) => `      – ${t.misconception} → cas-limite : ${t.edge}`)] : [];
    }),
    ``,
    `RÈGLE : pour chaque exo, un étudiant qui « reconnaît le type » sans comprendre doit obtenir une MAUVAISE réponse (sinon trop facile). Nombres NON RONDS. Une sous-question peut légitimement répondre « non / on ne peut pas ».`,
    ...KATERINA_STYLE,
  ].join("\n");
}
