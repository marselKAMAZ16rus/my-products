ALTER TABLE `push_subscriptions` ADD `last_status` integer;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `last_attempt` integer;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `last_success` integer;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `last_error` text DEFAULT '' NOT NULL;