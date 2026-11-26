CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`member` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_member` ON `push_subscriptions` (`member`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `pushed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `push_attempts` integer DEFAULT 0 NOT NULL;