CREATE TABLE `photo_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`post` text NOT NULL,
	`media` text NOT NULL,
	`member` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`post`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `photo_tags_post` ON `photo_tags` (`post`);--> statement-breakpoint
ALTER TABLE `comments` ADD `reply_to` text REFERENCES comments(id);--> statement-breakpoint
ALTER TABLE `invites` ADD `code_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_unique` ON `invites` (`code_hash`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `push_claimed` integer;--> statement-breakpoint
ALTER TABLE `notifications` ADD `next_push` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO friends(a,b,created) SELECT min(i.inviter,i.claimed_by),max(i.inviter,i.claimed_by),r.created FROM invites i JOIN members u ON u.id=i.claimed_by JOIN friend_requests r ON r.sender=i.inviter AND r.recipient=i.claimed_by WHERE abs(r.created-u.created)<=5;
--> statement-breakpoint
DELETE FROM friend_requests WHERE EXISTS(SELECT 1 FROM friends f WHERE f.a=friend_requests.a AND f.b=friend_requests.b);
--> statement-breakpoint
DELETE FROM notifications WHERE kind='friend_request' AND EXISTS(SELECT 1 FROM friends f WHERE f.a=min(notifications.recipient,notifications.actor) AND f.b=max(notifications.recipient,notifications.actor));
