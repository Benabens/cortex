# Cortex

**An engine that learns the format of an exam from past papers, then generates practice exams faithful to that format.**

Most question generators produce generic multiple-choice quizzes that look nothing like the exam you will actually sit. Cortex starts from the opposite end: it reads a course's real past exams, extracts their actual structure — exercise types, grading weights, recurring traps, layout — and uses it as a template. The output is a PDF that looks like the real thing.

> Web application — Next.js 16 · TypeScript · PostgreSQL — deployed as a single container on Railway.

---

## What it does

| | |
|---|---|
| **Courses** | Each user creates their own courses and uploads their own material (PDF, HTML). Nothing is shared between accounts. |
| **Ingestion** | Text extraction and full-text indexing (FTS5) with typo tolerance. |
| **Exam DNA** | Analyses past papers to infer the real format: exercise archetypes, grading weights, number of questions, presentation conventions. |
| **Generation** | Produces a complete exam in LaTeX → PDF through a multi-pass pipeline: corpus study → trap design → writing → adversarial review → verification. |
| **Verification** | Numeric answers, symbolic results and code are **verified by execution** in an isolated sandbox — not just re-read by a model. |
| **Revision** | Weakness tracking, spaced repetition, targeted drills on what comes up most often. |

## Engineering highlights

- **Deterministic verification** — a generated answer is accepted only if it is *proven*: code runs in a sandbox (`unshare`, no network, no writes outside the working directory, timeout), numbers are compared with a relative tolerance, symbolic results are checked with sympy. The rule is strict: when in doubt, the verdict is `not_applicable` — **never a false "proven"**.
- **Structural multi-tenant isolation** — one PostgreSQL schema per (user, course), with `search_path` set at connection level. Other users' data is not "filtered out": it is simply not reachable.
- **Fail-closed cost guardrails** — every model call goes through a single entry point enforcing a global spend cap, per-user daily spend caps, quotas and rate limits, and recording the real cost of each call. In a guarded deployment, a missing setting never lifts a limit.
- **Provider-agnostic LLM layer** — Anthropic API, any OpenAI-compatible endpoint, or a local CLI for development, selected by an environment variable.
- **Non-regression invariant** — for a reference course, the generated prompt and `.tex` must stay **byte-identical** to canonical fingerprints. Any silent drift in the engine fails the build. (It runs wherever the reference corpus is available; course material is not versioned.)
- **Durable job queue** — long generations (10–20 min) run as supervised child processes with heartbeats, checkpoints and automatic requeue after a crash.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL (SQLite in development) · Auth.js · Stripe · tectonic (LaTeX → PDF) · matplotlib · Docker · GitHub Actions

## Getting started

```bash
cd cortex
npm install
npm run dev
```

With no environment variables at all, the app runs locally on SQLite, without authentication or external services. See `cortex/.env.example` for everything that can be configured.

```bash
npm test          # unit tests: engine, sandbox, verification, billing, DB drivers, isolation
npm run backup    # database + volume backup
```

## Repository layout

```
cortex/
  app/          pages (App Router) and API routes
  components/   React components
  lib/          the engine: generation, verification, LLM layer, billing, auth
  db/           SQLite/PostgreSQL drivers, tenant context, migrations
  scripts/      ingestion, job runner, backups, maintenance
  tests/        unit tests (node:test)
  latex/        LaTeX preamble and macros
```

## Documentation (in French)

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the system is built, and why.
- **[DEPLOY.md](DEPLOY.md)** — deployment, backups, production workflow.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — conventions, invariants and required checks.

## Course material

This repository contains **no** course material, past exams or slides: those documents belong to their authors and institutions. Each user uploads their own documents through the app, and they stay in that user's storage.

## Status

Personal project under active development. The generation engine, multi-tenant isolation, course management and cost guardrails are working and tested. The payment interface and the public landing page are in progress.

## License

No license is granted at this time: the code is published for demonstration purposes, all rights reserved.
