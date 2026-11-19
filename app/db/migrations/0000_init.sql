CREATE TABLE `beacons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`floor_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`instance` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`label` text,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `beacons_namespace_instance_unique` ON `beacons` (`namespace`,`instance`);--> statement-breakpoint
CREATE TABLE `buildings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buildings_name_unique` ON `buildings` (`name`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`floor_id` integer NOT NULL,
	`group_id` text NOT NULL,
	`type` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connectors_group_idx` ON `connectors` (`group_id`);--> statement-breakpoint
CREATE TABLE `floors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`building_id` integer NOT NULL,
	`level` integer NOT NULL,
	`svg_path` text NOT NULL,
	`grid_path` text NOT NULL,
	`meters_per_cell` real,
	FOREIGN KEY (`building_id`) REFERENCES `buildings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `floors_building_id_level_unique` ON `floors` (`building_id`,`level`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`floor_id` integer NOT NULL,
	`number` text NOT NULL,
	`name` text,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`entrance_x` real,
	`entrance_y` real,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rooms_floor_number_idx` ON `rooms` (`floor_id`,`number`);