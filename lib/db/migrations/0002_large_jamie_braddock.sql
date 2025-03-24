PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_Invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`customerName` text NOT NULL,
	`vendorName` text NOT NULL,
	`invoiceNumber` text NOT NULL,
	`invoiceDate` integer,
	`dueDate` integer,
	`amount` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_Invoice`("id", "customerName", "vendorName", "invoiceNumber", "invoiceDate", "dueDate", "amount", "createdAt", "updatedAt") SELECT "id", "customerName", "vendorName", "invoiceNumber", "invoiceDate", "dueDate", "amount", "createdAt", "updatedAt" FROM `Invoice`;--> statement-breakpoint
DROP TABLE `Invoice`;--> statement-breakpoint
ALTER TABLE `__new_Invoice` RENAME TO `Invoice`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_LineItem` (
	`id` text PRIMARY KEY NOT NULL,
	`invoiceId` text NOT NULL,
	`description` text,
	`quantity` integer,
	`unitPrice` integer,
	`amount` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_LineItem`("id", "invoiceId", "description", "quantity", "unitPrice", "amount", "createdAt", "updatedAt") SELECT "id", "invoiceId", "description", "quantity", "unitPrice", "amount", "createdAt", "updatedAt" FROM `LineItem`;--> statement-breakpoint
DROP TABLE `LineItem`;--> statement-breakpoint
ALTER TABLE `__new_LineItem` RENAME TO `LineItem`;