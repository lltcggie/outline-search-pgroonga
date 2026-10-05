import { QueryTypes } from "sequelize";
import { DirectionFilter, SortFilter } from "@shared/types";
import { parser } from "@server/editor";
import { sequelizeReadOnly } from "@server/storage/database";
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import PostgresSearchProvider from "../../search-postgres/server/PostgresSearchProvider";
import PGroongaSearchProvider from "./PGroongaSearchProvider";

const provider = new PGroongaSearchProvider();

/** A node of EXPLAIN (FORMAT JSON) output, only the fields used here. */
interface PlanNode {
  "Node Type": string;
  "Subplan Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

async function setup(
  docs: { title: string; text?: string; previousTitles?: string[] }[]
) {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id });
  const collection = await buildCollection({
    userId: user.id,
    teamId: team.id,
  });
  const documents = [];
  for (const doc of docs) {
    documents.push(
      await buildDocument({
        userId: user.id,
        teamId: team.id,
        collectionId: collection.id,
        text: "",
        ...doc,
      })
    );
  }
  const search = async (query: string) => {
    const { results } = await provider.searchForUser(user, { query });
    return results.map((r) => r.document.title);
  };
  return { team, user, collection, documents, search };
}

describe("PGroongaSearchProvider", () => {
  describe("Japanese", () => {
    it("should find a word in the middle of a sentence", async () => {
      const { search } = await setup([
        { title: "議事録", text: "これは検索のテストです。" },
        { title: "無関係", text: "なにもありません。" },
      ]);
      expect(await search("テスト")).toEqual(["議事録"]);
      expect(await search("検索")).toEqual(["議事録"]);
      expect(await search("検索のテスト")).toEqual(["議事録"]);
    });

    it("should find a single character", async () => {
      const { search } = await setup([
        { title: "経理", text: "消費税の計算方法" },
        { title: "総務", text: "備品の購入" },
      ]);
      expect(await search("税")).toEqual(["経理"]);
    });

    it("should require every term, across title and body", async () => {
      const { search } = await setup([
        { title: "設計書", text: "認証基盤について" },
        { title: "設計書", text: "決済について" },
        { title: "手順書", text: "認証基盤について" },
      ]);
      const results = await search("設計書 認証");
      expect(results).toEqual(["設計書"]);
      // full-width space as separator
      expect(await search("設計書　認証")).toEqual(["設計書"]);
    });

    it("should ignore width and case differences", async () => {
      const { search } = await setup([
        { title: "環境", text: "ＰｏｓｔｇｒｅＳＱＬとﾊﾝｶｸｶﾀｶﾅを使う" },
      ]);
      expect(await search("postgresql")).toEqual(["環境"]);
      expect(await search("ハンカクカタカナ")).toEqual(["環境"]);
    });

    it("should support exclusion and OR", async () => {
      const { search } = await setup([
        { title: "東京", text: "出張の記録" },
        { title: "大阪", text: "出張の記録" },
        { title: "福岡", text: "旅行の記録" },
      ]);
      expect((await search("出張 -東京")).sort()).toEqual(["大阪"]);
      expect((await search("-東京 出張")).sort()).toEqual(["大阪"]);
      expect((await search("東京 OR 福岡")).sort()).toEqual(
        ["東京", "福岡"].sort()
      );
      expect((await search('"出張の記録" -"大阪"')).sort()).toEqual(["東京"]);
    });

    it("should rank a title match above a body match", async () => {
      const { search } = await setup([
        { title: "雑記", text: "障害対応の話を少し" },
        { title: "障害対応", text: "手順" },
      ]);
      expect(await search("障害対応")).toEqual(["障害対応", "雑記"]);
    });

    it("should return a ranking and highlighted context", async () => {
      const filler = "あ".repeat(400);
      const { user } = await setup([
        { title: "長文", text: `${filler}ここに検索語があります${filler}` },
      ]);
      const { results } = await provider.searchForUser(user, {
        query: "検索語",
      });
      expect(results.length).toBe(1);
      expect(results[0].ranking).toBeGreaterThan(0);
      expect(results[0].context).toContain("<b>検索語</b>");
    });

    it("should keep the ranking when filtered and sorted", async () => {
      const { user, collection } = await setup([
        { title: "障害対応", text: "手順" },
        { title: "雑記", text: "障害対応の話を少し" },
      ]);
      // Filters and sorting are applied outside the PGroonga match and must not
      // zero the scores. With a database this small the planner may not try
      // another index anyway, so this checks the result rather than the plan.
      const filter = {
        field: "collectionId",
        operator: "eq",
        value: collection.id,
      } as const;

      const ranked = await provider.searchForUser(user, {
        query: "障害対応",
        filter,
      });
      expect(ranked.results.map((r) => r.document.title)).toEqual([
        "障害対応",
        "雑記",
      ]);
      expect(ranked.results[0].ranking).toBeGreaterThan(
        ranked.results[1].ranking ?? 0
      );

      const sorted = await provider.searchForUser(user, {
        query: "障害対応",
        filter,
        sort: SortFilter.Title,
        direction: DirectionFilter.ASC,
      });
      expect(sorted.total).toBe(2);
      for (const result of sorted.results) {
        expect(result.ranking).toBeGreaterThan(0);
      }
    });

    it("should find a document by a previous title", async () => {
      const { search } = await setup([
        { title: "新しい名前", previousTitles: ["旧プロジェクト名"] },
      ]);
      expect(await search("旧プロジェクト")).toEqual(["新しい名前"]);
    });
  });

  describe("body", () => {
    it("should find what was just written, before Outline rewrites text", async () => {
      const { search, documents } = await setup([
        { title: "議事録", text: "古い本文" },
      ]);
      // What the collaboration server saves while editing: content only, text
      // is rewritten later.
      await documents[0].update(
        { content: parser.parse("新しく書いた本文")?.toJSON() },
        { hooks: false }
      );
      await documents[0].reload();
      expect(documents[0].text).toBe("古い本文");

      expect(await search("新しく書いた")).toEqual(["議事録"]);
      expect(await search("古い本文")).toEqual([]);
    });

    it("should match a word split by formatting", async () => {
      const { search } = await setup([
        { title: "書式", text: "これは**太字**です" },
      ]);
      expect(await search("は太字で")).toEqual(["書式"]);
    });

    it("should not match across paragraphs", async () => {
      const { search } = await setup([
        { title: "段落", text: "あいう\n\nえおか" },
      ]);
      expect(await search("いう")).toEqual(["段落"]);
      expect(await search("うえ")).toEqual([]);
    });

    it("should find a link target and a mention", async () => {
      const { search, documents, user } = await setup([
        { title: "リンク", text: "[資料](https://example.com/spec-123)" },
      ]);
      expect(await search("example.com/spec-123")).toEqual(["リンク"]);

      await documents[0].update(
        {
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "担当は" },
                  {
                    type: "mention",
                    attrs: {
                      type: "user",
                      label: "山田太郎",
                      modelId: user.id,
                      id: "mention-1",
                    },
                  },
                ],
              },
            ],
          },
        },
        { hooks: false }
      );
      expect(await search("担当は@山田太郎")).toEqual(["リンク"]);
    });

    it("should not match across list items or table cells", async () => {
      const { search, documents } = await setup([
        {
          title: "一覧",
          text: "- あいう\n- えおか\n\n| かき | くけ |\n| --- | --- |\n| こさ | しす |",
        },
      ]);
      expect(JSON.stringify(documents[0].content)).toContain(
        '"type":"table"'
      );
      expect(await search("いう")).toEqual(["一覧"]);
      expect(await search("かき")).toEqual(["一覧"]);
      expect(await search("うえ")).toEqual([]);
      expect(await search("きく")).toEqual([]);
    });

    it("should find an attachment name and an image caption", async () => {
      const { search, documents } = await setup([{ title: "添付" }]);
      await documents[0].update(
        {
          content: {
            type: "doc",
            content: [
              {
                type: "attachment",
                attrs: {
                  id: "attachment-1",
                  href: "/api/attachments.redirect?id=attachment-1",
                  title: "見積書_2026.pdf",
                  size: 1024,
                },
              },
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "前" },
                  {
                    type: "image",
                    attrs: { src: "/images/diagram.png", alt: "構成図の説明" },
                  },
                  { type: "text", text: "後" },
                ],
              },
            ],
          },
        },
        { hooks: false }
      );
      expect(await search("見積書")).toEqual(["添付"]);
      expect(await search("構成図の説明")).toEqual(["添付"]);
      // The caption is set apart from the text around the image.
      expect(await search("前構")).toEqual([]);
    });

    it("should fall back to text for a document without content", async () => {
      const { search, documents } = await setup([
        { title: "旧形式", text: "本文だけの文書" },
      ]);
      await documents[0].update({ content: null }, { hooks: false });
      expect(await search("本文だけ")).toEqual(["旧形式"]);
    });
  });

  describe("English", () => {
    it("should match partial words", async () => {
      const { search } = await setup([
        { title: "Database", text: "We run PostgreSQL in production" },
      ]);
      expect(await search("postgre")).toEqual(["Database"]);
      expect(await search("product")).toEqual(["Database"]);
    });
  });

  describe("unusual input", () => {
    it("should treat operators and symbols literally", async () => {
      const { search } = await setup([
        { title: "C++ と C# の比較", text: "a:b (c) * ~ > < + \\ end" },
      ]);
      for (const query of [
        "C++",
        "c#",
        "a:b",
        "(c)",
        "(",
        ")",
        "*",
        "\\",
        '"',
        '"C++',
        "-",
        "OR",
        "OR OR",
        "C++ OR",
        "title:比較",
        "+ end",
      ]) {
        // must never throw, whatever it matches
        await expect(search(query)).resolves.toBeDefined();
      }
      expect(await search("C++")).toEqual(["C++ と C# の比較"]);
      expect(await search("a:b")).toEqual(["C++ と C# の比較"]);
      expect(await search("title:比較")).toEqual([]);
    });

    it("should search for the words when only exclusions are given", async () => {
      const { search } = await setup([{ title: "東京" }, { title: "大阪" }]);
      expect(await search("-東京")).toEqual(["東京"]);
    });

    it("should not match other teams", async () => {
      const { search } = await setup([{ title: "共有されない文書" }]);
      const other = await setup([{ title: "共有されない文書" }]);
      expect(await search("共有されない")).toEqual(["共有されない文書"]);
      expect(await other.search("共有されない")).toEqual(["共有されない文書"]);
    });
  });

  describe("query plan", () => {
    it("should find the matches through the PGroonga index only", async () => {
      const { user, collection } = await setup([
        { title: "障害対応", text: "手順" },
      ]);
      // The where of a real search, with a collection filter that a b-tree
      // index could serve.
      const where = await PostgresSearchProvider["buildWhere"](user, {
        filter: { field: "collectionId", operator: "eq", value: collection.id },
      });
      const sql = PGroongaSearchProvider["buildRankedSql"]({
        where,
        sort: SortFilter.UpdatedAt,
        direction: DirectionFilter.DESC,
        usePopularityBoost: true,
      });

      // Planned with the same settings as a search runs with.
      const [row] = await PGroongaSearchProvider["withMatchSettings"](
        (transaction) =>
          sequelizeReadOnly.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (FORMAT JSON) ${sql}`,
            {
              replacements: {
                query: PGroongaSearchProvider.parseQuery("障害対応").groonga,
                teamId: user.teamId,
                limit: 15,
                offset: 0,
              },
              type: QueryTypes.SELECT,
              transaction,
            }
          )
      );
      const output = row["QUERY PLAN"];
      const [{ Plan }] = (
        typeof output === "string" ? JSON.parse(output) : output
      ) as { Plan: PlanNode }[];

      // MATERIALIZED keeps the CTE a plan of its own…
      const cte = flattenPlan(Plan).find(
        (node) => node["Subplan Name"] === "CTE matches"
      );
      expect(cte).toBeDefined();
      const cteNodes = cte ? flattenPlan(cte) : [];

      // …that reaches the documents through the PGroonga index and nothing
      // else…
      expect(cteNodes.map((node) => node["Node Type"])).not.toContain(
        "Seq Scan"
      );
      const indexNames = cteNodes.flatMap((node) =>
        node["Index Name"] ? [node["Index Name"]] : []
      );
      expect(indexNames.length).toBeGreaterThan(0);
      expect(new Set(indexNames)).toEqual(
        new Set([PGroongaSearchProvider.indexName])
      );

      // …and into which no condition of the outer query is pushed.
      expect(JSON.stringify(cte)).not.toContain("collectionId");
    });
  });

  describe("parseQuery", () => {
    it("should quote and escape every term", () => {
      expect(PGroongaSearchProvider.parseQuery("検索 テスト").groonga).toBe(
        '"検索" "テスト"'
      );
      expect(PGroongaSearchProvider.parseQuery('a\\b "c d"').groonga).toBe(
        '"a\\\\b" "c d"'
      );
      expect(PGroongaSearchProvider.parseQuery("a OR b -c").groonga).toBe(
        '"a" OR "b" -"c"'
      );
      expect(PGroongaSearchProvider.parseQuery("OR a OR").groonga).toBe('"a"');
      expect(PGroongaSearchProvider.parseQuery("OR").groonga).toBe('"OR"');
      expect(PGroongaSearchProvider.parseQuery('  ""  ').groonga).toBeUndefined();
      expect(PGroongaSearchProvider.parseQuery(undefined).groonga).toBeUndefined();
    });
  });
});
