import invariant from "invariant";
import { compact, escapeRegExp, find, map } from "es-toolkit/compat";
import type {
  BindOrReplacements,
  FindAttributeOptions,
  FindOptions,
  Order,
  WhereOptions,
} from "sequelize";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { DirectionFilter, SortFilter } from "@shared/types";
import { regexIndexOf, regexLastIndexOf } from "@shared/utils/string";
import Collection from "@server/models/Collection";
import Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { sequelizeReadOnly } from "@server/storage/database";
import type {
  SearchOptions,
  SearchResponse,
} from "@server/utils/BaseSearchProvider";
import PostgresSearchProvider from "../../search-postgres/server/PostgresSearchProvider";

type RankedDocument = Document & {
  id: string;
  dataValues: Partial<Document> & {
    searchRanking: number;
  };
};

type ScopedWhere = WhereOptions<Document> & {
  [Op.and]: WhereOptions<Document>[];
};

interface ParsedQuery {
  /** The query in Groonga query syntax, or undefined if there are no terms. */
  groonga?: string;
  /** Terms that must (or may) appear, used for highlighting. */
  terms: string[];
  /** The query as typed, a match on all of it is the best place to excerpt. */
  raw: string;
}

/**
 * Search provider that uses PGroonga for full-text search, so that languages
 * written without spaces between words (Japanese, Chinese, Korean…) can be
 * searched by any substring.
 *
 * Everything other than text matching and ranking is inherited from the
 * built-in PostgreSQL provider: permission scoping, filters, title search and
 * collection search. The PGroonga index lives in the same database and is kept
 * up to date by PostgreSQL itself, so index/remove/updateMetadata stay no-ops.
 *
 * Requires the index created by `sql/install.sql`.
 */
export default class PGroongaSearchProvider extends PostgresSearchProvider {
  id = "pgroonga";

  /** Name of the index created by sql/install.sql. */
  public static indexName = "documents_pgroonga_idx";

  /**
   * Relative weight of a match in the title, the body and a previous title.
   * The proportions mirror the built-in provider (tsvector weights A, D, C).
   */
  public static titleWeight = 10;
  public static bodyWeight = 1;
  public static previousTitleWeight = 2;

  /**
   * How many of a document's previous titles are searched. PGroonga ignores
   * array elements that have no weight, so this is a hard limit.
   */
  public static maxPreviousTitles = 20;

  /**
   * The most matching documents considered for a single search, best scoring
   * first. Only reached by terms that appear in more than this many documents.
   */
  public static maxMatches = 10000;

  /**
   * The indexed expression: [title, body, ...previous titles]. This must be
   * written exactly as in sql/install.sql, PostgreSQL only uses an expression
   * index when the query repeats the expression it was built from.
   */
  private static readonly INDEXED_SQL = `ARRAY[title::text, text] || COALESCE("previousTitles", '{}')::text[]`;

  /**
   * Finds matching documents and their scores using only the PGroonga index.
   *
   * This runs as its own statement, rather than as one more condition on the
   * main query, because PGroonga only computes a score (and only guarantees
   * its full-text semantics) when the row is found through its index. Combined
   * with the permission conditions, PostgreSQL is free to locate rows through
   * some other index and merely re-check the text condition, which would
   * silently zero the ranking. Here the index is the only way in:
   *
   * - the text condition is the only indexable one, teamId is compared as text
   *   so that no b-tree index applies to it.
   * - sequential scans are disabled for the transaction by the caller.
   */
  private static readonly MATCH_SQL = `
    SELECT id, pgroonga_score(tableoid, ctid) AS score
    FROM documents
    WHERE ${PGroongaSearchProvider.INDEXED_SQL} &@~ pgroonga_condition(
        :query,
        weights => ARRAY[${[
          PGroongaSearchProvider.titleWeight,
          PGroongaSearchProvider.bodyWeight,
          ...Array<number>(PGroongaSearchProvider.maxPreviousTitles).fill(
            PGroongaSearchProvider.previousTitleWeight
          ),
        ].join(", ")}],
        index_name => '${PGroongaSearchProvider.indexName}'
      )
      AND "teamId"::text = :teamId
    ORDER BY score DESC
    LIMIT :limit`;

  /** Looks up the score of the current row in the :scores replacement. */
  private static readonly SCORE_SQL = `(CAST(:scores AS jsonb) ->> "id"::text)::float8`;

  /** Whether the index has been confirmed to exist, checked on first use. */
  private static indexVerified = false;

  private static readonly SNIPPET_BREAK_REGEX = new RegExp(
    `[ .,"'\n。、！？!?…　]`,
    "g"
  );

  async searchForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    // Permission scoping and filters come from the built-in provider. The
    // query is withheld so that it does not add its own tsvector condition.
    const where = await PostgresSearchProvider["buildWhere"](user, {
      ...options,
      query: undefined,
    });

    return this.search({
      teamId: user.teamId,
      where,
      options,
      usePopularityBoost: true,
      loadDocuments: (ids) =>
        Document.withMembershipScope(user.id, { includeDrafts: true }).findAll({
          where: {
            teamId: user.teamId,
            id: ids,
          },
        }),
    });
  }

  async searchForTeam(
    team: Team,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const where = await PostgresSearchProvider["buildWhere"](team, {
      ...options,
      query: undefined,
      // Team-context search (used by shares) is always restricted to
      // published, non-archived documents.
      filter: PostgresSearchProvider["withPublishedConstraint"](options.filter),
    });

    // --- Kept in step with PostgresSearchProvider.searchForTeam: restricts a
    // --- share-scoped search to the documents reachable through that share.
    if (options.share) {
      let documentIds: string[] | undefined;

      if (options.share.collectionId) {
        const sharedCollection =
          options.share.collection ??
          (await options.share.$get("collection", { scope: "unscoped" }));
        invariant(sharedCollection, "Cannot find collection for share");
        documentIds = sharedCollection.getAllDocumentIds();
      } else if (
        options.share.documentId &&
        options.share.includeChildDocuments
      ) {
        const sharedDocument = await options.share.$get("document");
        invariant(sharedDocument, "Cannot find document for share");

        const childDocumentIds = await sharedDocument.findAllChildDocumentIds({
          archivedAt: {
            [Op.is]: null,
          },
        });

        documentIds = [sharedDocument.id, ...childDocumentIds];
      }

      where[Op.and].push({
        id: documentIds,
      });
    }
    // --- End of block kept in step with the built-in provider.

    return this.search({
      teamId: team.id,
      where,
      options,
      usePopularityBoost: options.usePopularityBoost,
      loadDocuments: (ids) =>
        Document.findAll({
          where: {
            id: ids,
            teamId: team.id,
          },
          include: [
            {
              model: Collection,
              as: "collection",
            },
          ],
        }),
    });
  }

  /**
   * Shared tail of searchForUser and searchForTeam: narrows an already
   * permission-scoped `where` to the documents matching the query, then ranks,
   * paginates and counts them the same way the built-in provider does.
   */
  private async search({
    teamId,
    where,
    options,
    usePopularityBoost,
    loadDocuments,
  }: {
    teamId: string;
    where: ScopedWhere;
    options: SearchOptions;
    usePopularityBoost?: boolean;
    loadDocuments: (ids: string[]) => Promise<Document[]>;
  }): Promise<SearchResponse> {
    const { limit = 15, offset = 0 } = options;
    const parsed = PGroongaSearchProvider.parseQuery(options.query);
    let scores: Map<string, number> | undefined;

    if (parsed.groonga) {
      scores = await PGroongaSearchProvider.findMatches(teamId, parsed.groonga);

      if (scores.size === 0) {
        return { results: [], total: 0 };
      }

      where[Op.and].push({ id: Array.from(scores.keys()) });
    }

    const findOptions = PGroongaSearchProvider.buildPGroongaFindOptions({
      scores,
      sort: options.sort,
      direction: options.direction,
      usePopularityBoost,
    });

    const results = (await PostgresSearchProvider["findRankedResults"]({
      findOptions,
      where,
      limit,
      offset,
    })) as RankedDocument[];

    const [documents, count] = await Promise.all([
      loadDocuments(map(results, "id")),
      PostgresSearchProvider["countResults"]({
        results,
        limit,
        offset,
        replacements: findOptions.replacements,
        where,
      }),
    ]);

    return {
      results: compact(
        map(results, (result) => {
          const document = find(documents, {
            id: result.id,
          });

          // The ranked query may run on a read replica, so a document can be
          // returned that has since been removed on the primary.
          if (!document) {
            return null;
          }

          return {
            ranking: result.dataValues.searchRanking,
            context: scores
              ? PGroongaSearchProvider.buildSnippet(document, parsed)
              : undefined,
            document,
          };
        })
      ),
      total: count,
    };
  }

  /**
   * Runs the full-text match against the PGroonga index.
   *
   * @param teamId - the team to search within.
   * @param query - the query in Groonga query syntax.
   * @returns a map of matching document id to relevance score.
   */
  private static async findMatches(
    teamId: string,
    query: string
  ): Promise<Map<string, number>> {
    await PGroongaSearchProvider.verifyIndex();

    const rows = await sequelizeReadOnly.transaction(async (transaction) => {
      // See MATCH_SQL. Scoped to this transaction only.
      await sequelizeReadOnly.query("SET LOCAL enable_seqscan = off", {
        transaction,
      });

      return sequelizeReadOnly.query<{ id: string; score: number }>(
        PGroongaSearchProvider.MATCH_SQL,
        {
          replacements: {
            query,
            teamId,
            limit: PGroongaSearchProvider.maxMatches,
          },
          type: QueryTypes.SELECT,
          transaction,
        }
      );
    });

    return new Map(rows.map((row) => [row.id, Number(row.score)]));
  }

  /**
   * Fails loudly when the index is missing or unusable. Without it PostgreSQL
   * would still answer, slowly and with every score at zero, which is much
   * harder to notice than an error.
   */
  private static async verifyIndex() {
    if (this.indexVerified) {
      return;
    }

    const rows = await sequelizeReadOnly.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = :indexName AND i.indisvalid`,
      {
        replacements: { indexName: this.indexName },
        type: QueryTypes.SELECT,
      }
    );

    if (!rows.length) {
      throw new Error(
        `SEARCH_PROVIDER is "pgroonga" but the index "${this.indexName}" does not exist or is invalid. Run sql/install.sql from the search-pgroonga plugin against the database.`
      );
    }
    this.indexVerified = true;
  }

  /**
   * Convert a user search query into Groonga query syntax.
   *
   * Every term is emitted as an escaped, quoted phrase so that user input can
   * never be interpreted as Groonga operators or produce a syntax error.
   * Supported on top of plain terms (which are ANDed together):
   *
   * - `"exact phrase"`
   * - `-term` or `-"phrase"` to exclude
   * - `OR` (upper case) between two terms
   *
   * Terms may be separated by any whitespace, including the full-width space.
   *
   * @param query - the user search query.
   * @returns the Groonga query and the terms to highlight.
   */
  public static parseQuery(query: string | undefined): ParsedQuery {
    const limitedQuery = (query ?? "").slice(
      0,
      PostgresSearchProvider.maxQueryLength
    );

    type Token =
      | { type: "term"; text: string; negative: boolean }
      | { type: "or" };
    const tokens: Token[] = [];

    for (const match of limitedQuery.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
      const [, quotedMinus, phrase, bare] = match;

      if (bare === undefined) {
        if (phrase.trim()) {
          tokens.push({
            type: "term",
            text: phrase.trim(),
            negative: quotedMinus === "-",
          });
        }
        continue;
      }

      if (bare === "OR") {
        tokens.push({ type: "or" });
        continue;
      }

      const negative = bare.length > 1 && bare.startsWith("-");
      // Unbalanced quote characters carry no meaning, drop them.
      const text = (negative ? bare.slice(1) : bare).replace(/"/g, "");
      if (text) {
        tokens.push({ type: "term", text, negative });
      }
    }

    // Groonga cannot evaluate a query made only of exclusions, in that case
    // search for the words themselves.
    const hasPositive = tokens.some((t) => t.type === "term" && !t.negative);
    const parts: string[] = [];
    const terms: string[] = [];
    let pendingOr = false;

    for (const token of tokens) {
      if (token.type === "or") {
        pendingOr = parts.length > 0;
        continue;
      }

      const negative = hasPositive && token.negative;
      const quoted = `"${token.text.replace(/[\\"]/g, "\\$&")}"`;

      if (negative) {
        parts.push(`-${quoted}`);
      } else {
        parts.push(pendingOr ? `OR ${quoted}` : quoted);
        terms.push(token.text);
      }
      pendingOr = false;
    }

    return {
      groonga: parts.length ? parts.join(" ") : undefined,
      terms,
      raw: limitedQuery.trim(),
    };
  }

  private static buildPGroongaFindOptions({
    scores,
    sort,
    direction,
    usePopularityBoost = true,
  }: {
    scores?: Map<string, number>;
    sort?: SortFilter;
    direction?: DirectionFilter;
    usePopularityBoost?: boolean;
  }): FindOptions {
    const attributes: FindAttributeOptions = ["id"];
    const replacements: BindOrReplacements = {};
    const order: Order = [];
    const hasQuery = !!scores;

    if (scores) {
      const rankExpression = usePopularityBoost
        ? `${PGroongaSearchProvider.SCORE_SQL} * (1 + 0.25 * LN(1 + COALESCE("popularityScore", 0)))`
        : PGroongaSearchProvider.SCORE_SQL;

      attributes.push([Sequelize.literal(rankExpression), "searchRanking"]);
      replacements["scores"] = JSON.stringify(Object.fromEntries(scores));
    }

    // When searching with a query and no explicit sort, prioritize search
    // ranking as the primary sort criterion. Otherwise, use the specified sort
    // with ranking as a tiebreaker.
    if (hasQuery && !sort) {
      order.push(["searchRanking", "DESC"]);
      order.push([SortFilter.UpdatedAt, DirectionFilter.DESC]);
    } else {
      const sortField = sort ?? SortFilter.UpdatedAt;
      const sortDirection = direction ?? DirectionFilter.DESC;

      if (sortField === SortFilter.Title) {
        order.push([
          Sequelize.fn("LOWER", Sequelize.col("title")),
          sortDirection,
        ]);
      } else {
        order.push([sortField, sortDirection]);
      }

      if (hasQuery) {
        order.push(["searchRanking", "DESC"]);
      }
    }

    return { attributes, replacements, order };
  }

  /**
   * Build a snippet of text around the first match with every term wrapped in
   * <b> tags. Unlike the built-in provider this does not rely on word
   * boundaries, which do not exist in Japanese text.
   *
   * @param document - the matched document.
   * @param parsed - the parsed query.
   * @returns the snippet.
   */
  private static buildSnippet(document: Document, parsed: ParsedQuery): string {
    const text = DocumentHelper.toPlainText(document);

    if (!parsed.terms.length) {
      return text.slice(0, 250);
    }

    const fullMatchRegex = new RegExp(escapeRegExp(parsed.raw), "i");
    const highlightRegex = new RegExp(
      [
        fullMatchRegex.source,
        ...[...parsed.terms]
          // longest first, so that overlapping terms highlight fully
          .sort((a, b) => b.length - a.length)
          .map((term) => escapeRegExp(term)),
      ].join("|"),
      "gi"
    );

    PGroongaSearchProvider.SNIPPET_BREAK_REGEX.lastIndex = 0;
    const breakCharsRegex = PGroongaSearchProvider.SNIPPET_BREAK_REGEX;

    // Excerpt around the first match, preferring a match of the whole query.
    const fullMatchIndex = text.search(fullMatchRegex);
    const matchIndex =
      fullMatchIndex >= 0 ? fullMatchIndex : text.search(highlightRegex);
    const offsetStartIndex = matchIndex - 65;
    // Start on a break character shortly before the match when there is one,
    // otherwise (common in Japanese) simply a fixed distance before it.
    const breakStartIndex =
      offsetStartIndex <= 0
        ? 0
        : regexIndexOf(text, breakCharsRegex, offsetStartIndex);
    const startIndex =
      breakStartIndex >= 0 && breakStartIndex <= matchIndex
        ? breakStartIndex
        : Math.max(0, offsetStartIndex);

    // End on the last break character within the window, unless the window
    // reaches the end of the text or that would cut the match off.
    const maxEndIndex = Math.min(text.length, startIndex + 250);
    const breakIndex =
      maxEndIndex === text.length
        ? maxEndIndex
        : regexLastIndexOf(text, breakCharsRegex, maxEndIndex);
    const endIndex =
      breakIndex > Math.max(startIndex, matchIndex + 20)
        ? breakIndex
        : maxEndIndex;

    // Highlight after slicing, as the inserted tags shift every index that
    // follows an earlier match.
    return text
      .slice(startIndex, endIndex)
      .replace(highlightRegex, "<b>$&</b>");
  }
}
