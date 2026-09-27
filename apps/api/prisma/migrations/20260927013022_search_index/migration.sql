-- CreateEnum
CREATE TYPE "SearchGenerationStatus" AS ENUM ('BUILDING', 'ACTIVE', 'RETIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "SearchEntityType" AS ENUM ('DOG_EAR', 'ANNOTATION', 'REREAD_MARK');

-- CreateTable
CREATE TABLE "search_generations" (
    "id" SERIAL NOT NULL,
    "status" "SearchGenerationStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "search_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_documents" (
    "id" UUID NOT NULL,
    "generation_id" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "entity_type" "SearchEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "source_version" INTEGER NOT NULL,
    "page_start" INTEGER NOT NULL,
    "page_end" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "term_count" INTEGER NOT NULL,
    "source_created_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_postings" (
    "document_id" UUID NOT NULL,
    "generation_id" INTEGER NOT NULL,
    "term" VARCHAR(64) NOT NULL,
    "tf" INTEGER NOT NULL,

    CONSTRAINT "search_postings_pkey" PRIMARY KEY ("document_id","term")
);

-- CreateIndex
CREATE INDEX "search_documents_generation_id_user_id_deleted_at_idx" ON "search_documents"("generation_id", "user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "search_documents_user_id_idx" ON "search_documents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "search_documents_generation_id_entity_type_entity_id_key" ON "search_documents"("generation_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "search_postings_generation_id_term_idx" ON "search_postings"("generation_id", "term");

-- AddForeignKey
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "search_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_postings" ADD CONSTRAINT "search_postings_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "search_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Search engine invariants (hand-written, mirrors the style of the init migration):
-- at most one ACTIVE and one BUILDING generation at any moment.
CREATE UNIQUE INDEX "search_generations_single_active_key"
  ON "search_generations"(("status"))
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "search_generations_single_building_key"
  ON "search_generations"(("status"))
  WHERE "status" = 'BUILDING';

ALTER TABLE "search_postings" ADD CONSTRAINT "search_postings_tf_positive_check" CHECK ("tf" > 0);

-- Every write transaction dual-writes into the ACTIVE (and BUILDING) generation,
-- so an initial ACTIVE generation must exist before the API serves traffic.
INSERT INTO "search_generations" ("status") VALUES ('ACTIVE');
