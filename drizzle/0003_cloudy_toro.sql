CREATE TABLE `dismissed_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text DEFAULT '' NOT NULL,
	`source_job_id` text DEFAULT '' NOT NULL,
	`canonical_url` text DEFAULT '' NOT NULL,
	`identity_fingerprint` text DEFAULT '' NOT NULL,
	`dismissed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dismissed_jobs_source_identity_idx` ON `dismissed_jobs` (`source_key`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `dismissed_jobs_canonical_url_idx` ON `dismissed_jobs` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `dismissed_jobs_fingerprint_idx` ON `dismissed_jobs` (`identity_fingerprint`);--> statement-breakpoint
CREATE TABLE `search_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_roles_position_idx` ON `search_roles` (`position`);--> statement-breakpoint
CREATE TABLE `search_run_sources` (
	`run_id` text NOT NULL,
	`source_key` text NOT NULL,
	`source_name` text NOT NULL,
	`country` text NOT NULL,
	`status` text NOT NULL,
	`roles_searched` text DEFAULT '[]' NOT NULL,
	`found_count` integer DEFAULT 0 NOT NULL,
	`known_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`run_id`, `source_key`)
);
--> statement-breakpoint
CREATE INDEX `search_run_sources_source_key_idx` ON `search_run_sources` (`source_key`,`run_id`);--> statement-breakpoint
CREATE TABLE `search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `search_runs_started_at_idx` ON `search_runs` (`started_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `canonical_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `source_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `source_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `source_job_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `country` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `identity_fingerprint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `is_saved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `application_status` text DEFAULT 'not_applied' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `visibility_status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posted_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `first_seen_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `last_seen_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_country_application_visibility_idx` ON `jobs` (`country`,`application_status`,`visibility_status`);--> statement-breakpoint
CREATE INDEX `jobs_source_identity_idx` ON `jobs` (`source_key`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `jobs_canonical_url_idx` ON `jobs` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `jobs_identity_fingerprint_idx` ON `jobs` (`identity_fingerprint`);