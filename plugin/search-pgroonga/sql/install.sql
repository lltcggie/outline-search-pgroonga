-- PGroonga search index for Outline (plugin: search-pgroonga).
--
-- Run once against the Outline database as a superuser, e.g.
--   psql -U postgres -d outline -f install.sql
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so do not
-- pass --single-transaction. Building the index does not block writes.
--
-- If a build is interrupted it leaves an invalid index behind, which IF NOT
-- EXISTS below would keep. Run uninstall.sql first, then this file again.
--
-- Upgrading from a version that indexed documents.text (index
-- documents_pgroonga_idx): run this file, switch to the new plugin, then drop
-- the old index with
--   DROP INDEX CONCURRENTLY IF EXISTS documents_pgroonga_idx;

CREATE EXTENSION IF NOT EXISTS pgroonga;

-- The body is taken from documents.content, the ProseMirror JSON that the
-- editor saves every few seconds. documents.text (Markdown) is only rewritten
-- once the document is closed or has not been edited for 5 minutes, so
-- searching it misses recent edits.
--
-- These functions are part of the index definition: changing what they
-- return requires rebuilding the index (REINDEX INDEX CONCURRENTLY).

-- Plain text of a node of documents.content. Inline content (a paragraph, a
-- heading…) is joined as is, so that a word split by formatting stays one
-- word, and blocks are separated by line breaks. The file name of an
-- attachment and the alt text (caption) of an image are included, set apart by
-- line breaks as an image sits inside a paragraph.
CREATE OR REPLACE FUNCTION search_pgroonga_node_text(node jsonb)
  RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path FROM CURRENT
AS $$
DECLARE
  children jsonb := node -> 'content';
  separator text;
BEGIN
  CASE node ->> 'type'
    WHEN 'text' THEN
      RETURN COALESCE(node ->> 'text', '');
    WHEN 'mention' THEN
      RETURN CASE WHEN node #>> '{attrs,type}' = 'user' THEN '@' ELSE '' END
        || COALESCE(node #>> '{attrs,label}', '');
    WHEN 'br' THEN
      RETURN E'\n';
    WHEN 'attachment' THEN
      RETURN COALESCE(node #>> '{attrs,title}', '');
    WHEN 'image' THEN
      RETURN E'\n' || COALESCE(node #>> '{attrs,alt}', '') || E'\n';
    ELSE
      NULL;
  END CASE;

  IF jsonb_typeof(children) IS DISTINCT FROM 'array' THEN
    RETURN '';
  END IF;

  separator := CASE
    WHEN jsonb_path_exists(children, '$[*] ? (@.type == "text" || @.type == "mention")')
    THEN ''
    ELSE E'\n'
  END;

  RETURN COALESCE(
    (SELECT string_agg(search_pgroonga_node_text(child), separator ORDER BY position)
     FROM jsonb_array_elements(children) WITH ORDINALITY AS c(child, position)),
    '');
END;
$$;

-- The searchable body of a document: the text of documents.content, followed
-- by the targets of its links, which documents.text (Markdown) also contains.
CREATE OR REPLACE FUNCTION search_pgroonga_document_text(content jsonb)
  RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path FROM CURRENT
AS $$
  SELECT concat_ws(
    E'\n',
    search_pgroonga_node_text(content),
    (SELECT string_agg(href #>> '{}', E'\n')
     FROM jsonb_path_query(content, 'strict $.**.href') AS href)
  )
$$;

-- The indexed expression is [title, body, ...previous titles] and must stay
-- exactly as written here: the provider repeats it in its query, and
-- PostgreSQL only uses an expression index when the two match. The body falls
-- back to documents.text for a document without content.
--
-- tokenizer:  bigrams for every script, so both 日本語 and English match on
--             any substring.
-- normalizer: NFKC + case folding, so ＡＢＣ = abc = ABC and ｶﾀｶﾅ = カタカナ.
--             Use  NormalizerNFKC150("unify_kana", true)  instead if you
--             also want ひらがな and カタカナ to match each other.
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_pgroonga_v2_idx
  ON documents
  USING pgroonga ((ARRAY[title::text, COALESCE(search_pgroonga_document_text(content), text)] || COALESCE("previousTitles", '{}')::text[]))
  WITH (
    tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
    normalizers = 'NormalizerNFKC150'
  );
