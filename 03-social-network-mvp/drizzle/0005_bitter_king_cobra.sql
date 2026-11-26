CREATE TABLE `custom_badges` (
	`id` text PRIMARY KEY NOT NULL,
	`member` text NOT NULL,
	`issuer` text NOT NULL,
	`kind` text NOT NULL,
	`icon` text NOT NULL,
	`media_id` text,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issuer`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `custom_badges_member` ON `custom_badges` (`member`,`created`);