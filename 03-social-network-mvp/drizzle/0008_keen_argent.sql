CREATE TABLE `message_likes` (
	`message` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`message`, `member`),
	FOREIGN KEY (`message`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`post` text NOT NULL,
	`member` text NOT NULL,
	`option` integer NOT NULL,
	PRIMARY KEY(`post`, `member`),
	FOREIGN KEY (`post`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `members` ADD `invisible` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `last_active` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `poll` text;