ALTER TABLE `comments` ADD `media_id` text REFERENCES media(id);--> statement-breakpoint
ALTER TABLE `media` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `media` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `comment_depth` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `comment_excluded` text DEFAULT '[]' NOT NULL;