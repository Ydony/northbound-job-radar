CREATE TABLE `language_feedback` (
	`job_id` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`corrected_status` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
