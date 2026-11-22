# Séquence d'emails d'onboarding (Loops)

Prête à coller dans Loops (Loop Emails). Déclenchée par l'événement `signup` envoyé à
la création du compte (`lib/loops.ts`). `{{firstName}}` est vide pour un compte créé par
magic-link sans nom Google — les deux versions gèrent ce cas avec une salutation neutre.

Branches conditionnelles (filtres Loops, « A reçu l'événement » / « N'a pas reçu l'événement ») :
- **J3** : n'envoyer qu'aux contacts n'ayant **pas** reçu `course_created` depuis le signup.
- **J7** : n'envoyer qu'aux contacts n'ayant **pas** reçu `first_mock_exam` depuis le signup.

Désinscription : lien standard Loops (`{{unsubscribeUrl}}` dans le bloc pied de page du
template), un clic, pas de reconfirmation. Ces emails sont transactionnels/liés au compte
(aide à démarrer un service déjà souscrit, pas de la promo) — voir note RGPD dans le récap
de la PR.

---

## FR

### J0 — Bienvenue

**Objet** : Bienvenue sur Cortex — 3 étapes pour ton premier examen blanc
**Preview** : Crée ton cours, ajoute tes annales, et Cortex s'occupe du reste.

```
Salut {{firstName|et bienvenue}},

Cortex génère des examens blancs « prouvés corrects » à partir des vraies annales de ton
cours — pas des questions inventées au hasard.

Pour ton premier examen blanc, trois étapes :

1. Crée ton cours (son nom, sa branche)
2. Ajoute tes annales — c'est ce qui donne à Cortex le format et le niveau de ton examen
3. Lance ta première génération

Tu peux aussi tout faire depuis Claude (ou un autre assistant IA compatible MCP) une fois
connecté — je t'explique ça demain.

Une question, un bug, une idée : réponds direct à cet email, je lis tout.

Ben
```

### J1 — Connecte ton IA

**Objet** : Pilote Cortex depuis Claude (ou ChatGPT)
**Preview** : Crée un cours, ajoute des annales, lance un examen — sans quitter ton assistant.

```
{{firstName|Salut}},

Cortex se pilote aussi en langage naturel, depuis ton assistant IA préféré (Claude,
ChatGPT…) via MCP : créer un cours, ajouter une annale, lancer un examen blanc ou un
drill de révision, tout ça en lui parlant normalement.

Connecte-le ici : https://cortexexam.com/mcp

Ça prend deux minutes, et ça reste un compte Cortex normal derrière — même crédits, même
historique.

Ben
```

### J3 — Relance : pas encore de cours (si `course_created` absent)

**Objet** : Ton premier cours t'attend
**Preview** : Deux minutes pour créer ton cours et voir Cortex à l'œuvre.

```
{{firstName|Salut}},

Je vois que tu n'as pas encore créé de cours sur Cortex. C'est la seule étape qui bloque
tout le reste : sans cours, pas d'annales, pas d'examen blanc.

Si quelque chose n'était pas clair ou a buggé, dis-le-moi — je préfère corriger ça que
te voir partir sans avoir essayé.

Sinon, deux minutes et c'est fait : https://app.cortexexam.com

Ben
```

### J7 — Relance : pas encore d'examen blanc (si `first_mock_exam` absent)

**Objet** : Prêt pour ton premier examen blanc ?
**Preview** : Ton cours est créé — il manque juste la génération.

```
{{firstName|Salut}},

Ton cours est en place sur Cortex, mais tu n'as pas encore généré d'examen blanc. C'est
le moment où Cortex devient utile : un sujet qui ressemble vraiment à ce que ton prof
donne, avec un corrigé qui tient la route.

Si une annale manque ou qu'un format ne colle pas, réponds à cet email — je regarde.

Lance-le ici : https://app.cortexexam.com

Ben
```

---

## EN

### Day 0 — Welcome

**Subject**: Welcome to Cortex — 3 steps to your first mock exam
**Preview**: Create your course, add past exams, and Cortex handles the rest.

```
Hey {{firstName|there}},

Cortex generates mock exams that are "proven correct" from your course's real past
exams — not random invented questions.

Three steps to your first mock exam:

1. Create your course (name, track)
2. Add your past exams — that's what gives Cortex the format and level of your exam
3. Run your first generation

You can also do all of this from Claude (or any MCP-compatible AI assistant) once
connected — more on that tomorrow.

Question, bug, idea: just reply to this email, I read everything.

Ben
```

### Day 1 — Connect your AI

**Subject**: Drive Cortex from Claude (or ChatGPT)
**Preview**: Create a course, add past exams, run an exam — without leaving your assistant.

```
Hey {{firstName|there}},

Cortex can also be driven in plain language, from your favorite AI assistant (Claude,
ChatGPT…) via MCP: create a course, add a past exam, run a mock exam or a revision
drill, just by talking to it normally.

Connect it here: https://cortexexam.com/mcp

Takes two minutes, and it's still a normal Cortex account behind it — same credits,
same history.

Ben
```

### Day 3 — Nudge: no course yet (if `course_created` missing)

**Subject**: Your first course is waiting
**Preview**: Two minutes to create your course and see Cortex in action.

```
Hey {{firstName|there}},

I noticed you haven't created a course on Cortex yet. It's the one step that unlocks
everything else: no course, no past exams, no mock exam.

If something wasn't clear or something broke, tell me — I'd rather fix it than see you
leave without trying it.

Otherwise, two minutes and you're set: https://app.cortexexam.com

Ben
```

### Day 7 — Nudge: no mock exam yet (if `first_mock_exam` missing)

**Subject**: Ready for your first mock exam?
**Preview**: Your course is set up — just the generation left.

```
Hey {{firstName|there}},

Your course is set up on Cortex, but you haven't generated a mock exam yet. This is
where Cortex actually becomes useful: a paper that genuinely looks like what your
professor gives, with a solution that holds up.

If a past exam is missing or a format doesn't fit, reply to this email — I'll take a
look.

Run it here: https://app.cortexexam.com

Ben
```
