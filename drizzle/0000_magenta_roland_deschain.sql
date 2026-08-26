CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`location` text DEFAULT 'Switzerland' NOT NULL,
	`description` text NOT NULL,
	`language_status` text NOT NULL,
	`language_summary` text NOT NULL,
	`language_signals` text DEFAULT '[]' NOT NULL,
	`fit_score` integer DEFAULT 0 NOT NULL,
	`matched_keywords` text DEFAULT '[]' NOT NULL,
	`missing_keywords` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_url_unique` ON `jobs` (`source_url`);--> statement-breakpoint
CREATE INDEX `jobs_language_status_idx` ON `jobs` (`language_status`);--> statement-breakpoint
CREATE INDEX `jobs_status_updated_idx` ON `jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`target_role` text DEFAULT '' NOT NULL,
	`cv_file_name` text DEFAULT '' NOT NULL,
	`cv_object_key` text DEFAULT '' NOT NULL,
	`cv_text` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
