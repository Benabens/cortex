CREATE TABLE `exam_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exam_id` integer,
	`concept` text NOT NULL,
	`statement_html` text NOT NULL,
	`solution_html` text,
	`source_inspiration` text,
	`weakness_id` integer,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`weakness_id`) REFERENCES `weaknesses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`format_template` text,
	`targeted_weakness_ids` text,
	`html_path` text,
	`status` text DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`type` text NOT NULL,
	`lecture_id` text,
	`title` text,
	`text` text NOT NULL,
	`html` text,
	`images` text,
	`tags` text,
	`anchor` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`concept` text NOT NULL,
	`last_tested_at` text,
	`interval_days` integer DEFAULT 1 NOT NULL,
	`next_due_at` text,
	`ease` real DEFAULT 2.5 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_concept_unique` ON `schedule` (`concept`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`year` integer,
	`recency_weight` real DEFAULT 1 NOT NULL,
	`ingested_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `weaknesses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`description` text,
	`screenshot_path` text,
	`severity` integer DEFAULT 2 NOT NULL,
	`related_item_ids` text,
	`times_seen` integer DEFAULT 1 NOT NULL,
	`logged_at` text DEFAULT (datetime('now')),
	`last_reviewed_at` text
);
