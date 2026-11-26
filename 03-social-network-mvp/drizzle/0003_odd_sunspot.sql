CREATE TABLE `friend_requests` (
	`a` text NOT NULL,
	`b` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`a`, `b`),
	FOREIGN KEY (`a`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`b`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `friend_requests_recipient` ON `friend_requests` (`recipient`,`created`);