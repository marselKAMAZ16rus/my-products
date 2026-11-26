ALTER TABLE `members` ADD `feed_mode` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen` integer;