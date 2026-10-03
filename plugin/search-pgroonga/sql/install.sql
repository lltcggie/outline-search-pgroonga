-- PGroonga search index for Outline (plugin: search-pgroonga).
--
-- Run once against the Outline database as a superuser, e.g.
--   psql -U postgres -d outline -f install.sql
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so do not
-- pass --single-transaction. Building the index does not block writes.

CREATE EXTENSION IF NOT EXISTS pgroonga;

-- The indexed expression is [title, body, ...previous titles] and must stay
-- exactly as written here: the provider repeats it in its query, and
-- PostgreSQL only uses an expression index when the two match.
--
-- tokenizer:  bigrams for every script, so both 日本語 and English match on
--             any substring.
-- normalizer: NFKC + case folding, so ＡＢＣ = abc = ABC and ｶﾀｶﾅ = カタカナ.
--             Use  NormalizerNFKC150("unify_kana", true)  instead if you
--             also want ひらがな and カタカナ to match each other.
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_pgroonga_idx
  ON documents
  USING pgroonga ((ARRAY[title::text, text] || COALESCE("previousTitles", '{}')::text[]))
  WITH (
    tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
    normalizers = 'NormalizerNFKC150'
  );
