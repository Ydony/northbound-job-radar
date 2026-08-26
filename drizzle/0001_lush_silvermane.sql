CREATE TABLE `search_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`role_override_a` text DEFAULT '' NOT NULL,
	`role_override_b` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`workplace` text DEFAULT 'any' NOT NULL,
	`seniority` text DEFAULT 'any' NOT NULL,
	`contract_type` text DEFAULT 'any' NOT NULL,
	`required_keywords` text DEFAULT '[]' NOT NULL,
	`excluded_keywords` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL
);
