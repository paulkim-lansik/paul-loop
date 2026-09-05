CREATE TABLE "memory_store" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"embedding_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_note" ADD COLUMN "owner_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_note" ADD COLUMN "corpus" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_note" ADD COLUMN "source_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_note" ADD COLUMN "embedding_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_note" ADD COLUMN "content_hash" text DEFAULT '' NOT NULL;
