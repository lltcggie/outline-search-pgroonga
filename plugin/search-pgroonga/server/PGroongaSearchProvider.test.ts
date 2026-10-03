import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import PGroongaSearchProvider from "./PGroongaSearchProvider";

const provider = new PGroongaSearchProvider();

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

    it("should find a document by a previous title", async () => {
      const { search } = await setup([
        { title: "新しい名前", previousTitles: ["旧プロジェクト名"] },
      ]);
      expect(await search("旧プロジェクト")).toEqual(["新しい名前"]);
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
      expect(PGroongaSearchProvider.parseQuery('  ""  ').groonga).toBeUndefined();
      expect(PGroongaSearchProvider.parseQuery(undefined).groonga).toBeUndefined();
    });
  });
});
