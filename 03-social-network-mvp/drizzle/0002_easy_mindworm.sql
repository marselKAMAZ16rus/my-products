CREATE TABLE `comment_likes` (
	`comment` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`comment`, `member`),
	FOREIGN KEY (`comment`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`target` text,
	`post` text,
	`created` integer NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recipient`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_created` ON `notifications` (`recipient`,`created`);--> statement-breakpoint
CREATE TABLE `upload_parts` (
	`upload` text NOT NULL,
	`part` integer NOT NULL,
	`etag` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`upload`, `part`),
	FOREIGN KEY (`upload`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`upload_id` text NOT NULL,
	`size` integer NOT NULL,
	`type` text NOT NULL,
	`width` integer,
	`height` integer,
	`expires` integer NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `members` ADD `invite_limit` integer DEFAULT 3 NOT NULL;