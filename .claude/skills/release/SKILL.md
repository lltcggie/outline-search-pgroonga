---
name: release
description: プラグインの Release 公開。Outline の最新版（または指定版）への対応から、テスト、タグ push、Release の確認までを行う。「リリースして」「Outline の新しいバージョンに対応して」「プラグインの修正をリリースして」で使う。
---

# リリース

リリースの実体は `outline-<バージョン>`（同じ Outline 版でのプラグイン修正は `outline-<バージョン>-r<n>`）のタグ push で、`.github/workflows/build.yml` がビルドして Release を作る。このスキルは、どのタグを打つかを決め、必要ならその前に新しい Outline 版への対応とテストをする。コマンドは PowerShell から `gh`・`git` を使う。Outline の clone など作業用のファイルは scratchpad に置く。

## 1. 対象を決める

1. 対象の Outline 版: ユーザーが版を指定していればそれ。無ければ Latest の Release の版（`gh release view -R outline/outline --json tagName -q .tagName` の先頭の `v` を除いたもの）。
2. 現在の対応版: `OUTLINE_VERSION`。
3. 既存のタグ: `git ls-remote --tags origin "refs/tags/outline-*"`。

次のどれに当たるかで分岐する。

- **新しい版**（対象 ≠ `OUTLINE_VERSION`）→ 2 → 3 → 4。
- **同じ版でタグが無い** → タグは `outline-<版>`。4 へ。
- **同じ版でタグがある** → 最新のタグ（`outline-<版>` を r1 とみなし、`-r<n>` の最大）からの差分を `git diff --stat <最新タグ> HEAD -- plugin OUTLINE_VERSION LICENSE NOTICE build.sh` で見る。
  - 配布物に効く差分があれば、タグは `-r<n+1>`。`plugin/` のコードが変わっていれば 3 → 4、そうでなければ 4 へ。
  - 差分が無ければ、リリースするものは無いと報告して終わる。

完了条件: 打つタグ名が一つに決まっている。または「リリース不要」と報告済み。

## 2. 新しい Outline 版に対応する

以下、`<旧>` は `OUTLINE_VERSION` の版、`<新>` は対象の版を指す。

### 2.1 試しにビルドする

`gh workflow run build.yml -f outline_version=<新>` を実行し、`gh run list --workflow build.yml --event workflow_dispatch --limit 1` で ID を取って、`gh run watch <ID> --exit-status` で待つ。型エラーで落ちたら `gh run view <ID> --log-failed` を読む。落ちた箇所は、プラグインが private メソッドや Outline のモジュールに依存しているところなので、2.2 の差分から原因を探す。

### 2.2 移植元の差分を追う

scratchpad に `git clone --filter=blob:none https://github.com/outline/outline.git` し、`git diff v<旧> v<新> -- <パス>` を見る。対象は次のすべて:

- `plugins/search-postgres/`（標準プロバイダーとそのテスト）と `server/utils/BaseSearchProvider.ts`
- プラグインが import している Outline のモジュールすべて（`plugin/search-pgroonga/server/*.ts` の `@server/`・`@shared/` の import 先）

差分ごとに、プラグイン側の対応箇所へ追随させる（地図は [NOTICE](../../../NOTICE) の由来一覧と CLAUDE.md のアーキテクチャ節）。特に見る箇所は、`searchForTeam` 内の「Kept in step with…」ブロック、`buildRankedOrder`、`buildSnippet`、`PGroongaSearchProvider.parity.test.ts`。CLAUDE.md の不変条件（MATERIALIZED CTE の構造、`INDEXED_SQL` と `install.sql` の式の一致）は保つ。

完了条件: 上記の差分の各ハンクについて、「追随した」か「プラグインに関係ない」かを言える。修正後に 2.1 を再実行して成功している。

### 2.3 バージョンを上げる

- `OUTLINE_VERSION` を `<新>` にする。
- `LICENSE` を `curl.exe -fsSL -o LICENSE https://raw.githubusercontent.com/outline/outline/v<新>/LICENSE` で、無改変のまま差し替える。
- `NOTICE` を直す: 版の表記（2 か所）、Change Date（新しい `LICENSE` の値）、由来箇所の一覧（2.2 で変わった場合）。
- `<旧>` の出現箇所をリポジトリ全体（`LICENSE` を除く）で grep し、意味ごとに直す。対応版の表記・ダウンロード URL・例のタグは `<新>` にする。README の「テスト状況」と CLAUDE.md の「確認済みの環境」は 3 の結果で書き換える。

## 3. テストする

[testing.md](testing.md) の手順で、WSL の Docker 上でテストを実行する。手順には本番コンテナの保護のルールが含まれるので、実行前に読む。失敗したら直して再実行する。

成功したら、その結果で README の「テスト状況」（と、DB の版が変わったなら CLAUDE.md の「確認済みの環境」）を書き換え、ここまでの変更をコミットする（まだ push しない）。コミットの前に、2.2 で入れた変更の要約（ハンクごとの判断）とテスト結果をユーザーに示す。

完了条件: testing.md の完了条件を満たし、変更がコミットされている。

## 4. 公開する

1. main を push し、そのコミットの CI が成功するのを待つ（`gh run list --commit (git rev-parse HEAD) --workflow build.yml` → `gh run watch <ID> --exit-status`。短縮 SHA では見つからない）。push するものが無いときは、`origin/main` の HEAD の CI が成功済みであることを確かめる。
2. `git tag <タグ>` → `git push origin <タグ>`。
3. 数秒おいて `gh run list --branch <タグ> --limit 1` で ID を取り、`gh run watch <ID> --exit-status` で待つ。
4. `gh release view <タグ> --json url,isDraft,assets` で、下書きでないこと、`search-pgroonga-outline-<版>.tar.gz` と `.sha256` の 2 つが添付されていることを確かめる。

タグの push 後にワークフローが落ちると、Release は作られずタグだけが残る。その場合はログを読んで原因を報告し、タグを消して打ち直すか、次の `-r<n>` にするかをユーザーに決めてもらう（リモートのタグを消すのはユーザーの了承を得てから）。

完了条件: 4 の確認が取れ、Release の URL・タグ・対応した Outline 版をユーザーに報告した。
