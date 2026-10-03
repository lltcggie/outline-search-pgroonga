-- Removes the PGroonga search index. Set SEARCH_PROVIDER back to "postgres"
-- (or unset it) before running this.
DROP INDEX CONCURRENTLY IF EXISTS documents_pgroonga_idx;
-- DROP EXTENSION pgroonga;  -- only if nothing else uses it
