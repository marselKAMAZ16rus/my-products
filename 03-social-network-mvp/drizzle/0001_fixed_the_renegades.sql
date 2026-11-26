CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`text` text NOT NULL,
	`created` integer NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sender`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_recipient_created` ON `messages` (`recipient`,`created`);--> statement-breakpoint
CREATE INDEX `messages_sender_created` ON `messages` (`sender`,`created`);--> statement-breakpoint
CREATE TABLE `post_media` (
	`post` text NOT NULL,
	`media` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`post`, `media`),
	FOREIGN KEY (`post`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_media_unique` ON `post_media` (`media`);--> statement-breakpoint
CREATE INDEX `post_media_order` ON `post_media` (`post`,`position`);--> statement-breakpoint
ALTER TABLE `media` ADD `thumbnail` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `members` ADD `bio` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `avatar_id` text REFERENCES media(id);--> statement-breakpoint
ALTER TABLE `posts` ADD `global` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `updated` integer;--> statement-breakpoint
CREATE INDEX `posts_created` ON `posts` (`created`,`id`);