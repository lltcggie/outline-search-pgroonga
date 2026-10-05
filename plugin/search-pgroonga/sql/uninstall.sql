-- Removes the PGroonga search index. Set SEARCH_PROVIDER back to "postgres"
-- (or unset it) before running this.
DROP INDEX CONCURRENTLY IF EXISTS documents_pgroonga_v2_idx;
-- Created by versions that indexed documents.text.
DROP INDEX CONCURRENTLY IF EXISTS documents_pgroonga_idx;
DROP FUNCTION IF EXISTS search_pgroonga_document_text(jsonb);
DROP FUNCTION IF EXISTS search_pgroonga_node_text(jsonb);
-- DROP EXTENSION pgroonga;  -- only if nothing else uses it
