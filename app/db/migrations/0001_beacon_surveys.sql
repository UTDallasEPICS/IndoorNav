DROP TABLE `beacons`;--> statement-breakpoint
CREATE TABLE `beacon_surveys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`floor_id` integer NOT NULL,
	`name` text NOT NULL,
	`project_id` text,
	`exported_at` text,
	`height_offset_m` real,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `beacon_surveys_name_unique` ON `beacon_surveys` (`name`);--> statement-breakpoint
CREATE TABLE `beacons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`floor_id` integer NOT NULL,
	`survey_id` integer,
	`namespace` text NOT NULL,
	`instance` text NOT NULL,
	`label` text,
	`status` text NOT NULL,
	`position_source` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`sigma_major_m` real,
	`sigma_minor_m` real,
	`ellipse_bearing_deg` real,
	`radius_95_m` real,
	`alternate_latitude` real,
	`alternate_longitude` real,
	`tx_power_dbm` real,
	`path_loss_exponent` real,
	`fit_rmse_db` real,
	`bins` integer,
	`samples` integer,
	`peak_latitude` real,
	`peak_longitude` real,
	`peak_rssi_dbm` real,
	`max_rssi_dbm` real,
	`advertised_tx_power_dbm` real,
	`first_seen` text,
	`last_seen` text,
	`updated_at` text,
	`notes` text,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`survey_id`) REFERENCES `beacon_surveys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `beacons_namespace_instance_unique` ON `beacons` (`namespace`,`instance`);
