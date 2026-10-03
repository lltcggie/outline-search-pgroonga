// Scale check run by the release skill (run-tests.sh copies it to
// plugins/search-pgroonga-scale/server/ in the Outline tree): paging and
// counting over 6,000 matching documents with the PGroonga provider.
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import PGroongaSearchProvider from "../../search-pgroonga/server/PGroongaSearchProvider";

const provider = new PGroongaSearchProvider();

it("pages and counts 6,000 matches", async () => {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id });
  const collection = await buildCollection({
    userId: user.id,
    teamId: team.id,
  });
  for (let i = 0; i < 6000; i += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, j) =>
        buildDocument({
          userId: user.id,
          teamId: team.id,
          collectionId: collection.id,
          title: `議事録 ${i + j}`,
          text: "定例会議のメモ",
        })
      )
    );
  }

  const timed = async (options: Parameters<typeof provider.searchForUser>[1]) => {
    const start = Date.now();
    const response = await provider.searchForUser(user, options);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(options), `${Date.now() - start}ms`);
    return response;
  };

  const first = await timed({ query: "議事録", limit: 25, offset: 0 });
  expect(first.total).toBe(6000);
  expect(first.results).toHaveLength(25);
  expect(first.results[0].ranking).toBeGreaterThan(0);

  const last = await timed({ query: "議事録", limit: 25, offset: 5990 });
  expect(last.results).toHaveLength(10);
  expect(last.total).toBe(6000);

  const beyond = await timed({ query: "議事録", limit: 25, offset: 6000 });
  expect(beyond.results).toHaveLength(0);
  expect(beyond.total).toBe(6000);

  const sorted = await timed({
    query: "議事録",
    limit: 25,
    offset: 25,
    sort: "title" as never,
    direction: "ASC" as never,
  });
  expect(sorted.total).toBe(6000);
  expect(sorted.results).toHaveLength(25);

  const none = await timed({ query: "存在しない語", limit: 25, offset: 0 });
  expect(none.total).toBe(0);
}, 600_000);
