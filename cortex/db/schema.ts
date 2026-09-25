import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Tout artefact ingéré : PDF cours, série, midterm, final, review de lecture, lab, cheatsheet. */
export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'course_pdf' | 'serie' | 'midterm' | 'final' | 'review' | 'lab' | 'cheatsheet'
  title: text("title").notNull(),
  path: text("path").notNull(),
  year: integer("year"),
  recencyWeight: real("recency_weight").notNull().default(1), // 2024/25 >> 2014
  ingestedAt: text("ingested_at").default(sql`(datetime('now'))`),
});

/** Unité atomique extraite d'une source : une carte, un exo, une définition. */
export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id").references(() => sources.id),
  type: text("type").notNull(), // 'card' | 'exercise' | 'definition' | 'method' | 'cheat'
  lectureId: text("lecture_id"), // 'l1'..'l18', 'c1'.., 'lab2'..
  title: text("title"),
  text: text("text").notNull(), // texte brut (indexé FTS)
  html: text("html"), // rendu original
  images: text("images"), // JSON array de chemins
  tags: text("tags"), // JSON array
  anchor: text("anchor"), // deep-link vers la page statique
});

/** Faiblesses : le carburant du générateur d'examens. */
export const weaknesses = sqliteTable("weaknesses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  topic: text("topic").notNull(),
  description: text("description"), // analyse LLM de la faiblesse de compréhension
  screenshotPath: text("screenshot_path"),
  severity: integer("severity").notNull().default(2), // 1..3
  relatedItemIds: text("related_item_ids"), // JSON array
  timesSeen: integer("times_seen").notNull().default(1),
  loggedAt: text("logged_at").default(sql`(datetime('now'))`),
  lastReviewedAt: text("last_reviewed_at"),
});

/** Répétition espacée par concept (courbe de l'oubli au niveau examen). */
export const schedule = sqliteTable("schedule", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  concept: text("concept").notNull().unique(),
  lastTestedAt: text("last_tested_at"),
  intervalDays: integer("interval_days").notNull().default(1),
  nextDueAt: text("next_due_at"),
  ease: real("ease").notNull().default(2.5),
});

/** Examens générés. */
export const exams = sqliteTable("exams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  formatTemplate: text("format_template"), // ex: 'final' | 'midterm'
  targetedWeaknessIds: text("targeted_weakness_ids"), // JSON array
  htmlPath: text("html_path"),
  status: text("status").notNull().default("draft"), // 'draft' | 'ready' | 'done'
});

/** Questions d'un examen généré. */
export const examQuestions = sqliteTable("exam_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  examId: integer("exam_id").references(() => exams.id),
  concept: text("concept").notNull(),
  statementHtml: text("statement_html").notNull(),
  solutionHtml: text("solution_html"),
  sourceInspiration: text("source_inspiration"),
  weaknessId: integer("weakness_id").references(() => weaknesses.id),
});
