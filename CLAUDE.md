# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Outline（Wiki）v1.10.1 用の検索プロバイダープラグイン。PGroonga（PostgreSQL 拡張）を使い、日本語など分かち書きしない言語でも部分一致検索できるようにする。Outline 本体は改変せず、コンパイル済みのプラグインをコンテナの `/opt/outline/build/plugins/search-pgroonga` にマウントし、`SEARCH_PROVIDER=pgroonga` で有効化する。利用者向けの説明・導入手順・メンテナー向けのリリース手順は README.md（日本語）にある。

## ビルドとテスト

このリポジトリ単体ではビルドもテストもできない。ソースは Outline 本体のモジュール（`@server/...`、`@shared/...`、`../../search-postgres/...`）を import しており、Outline のソースツリーの `plugins/` 配下に置かれて初めて解決される。

```sh
./build.sh          # OUTLINE_VERSION のバージョンでビルド
./build.sh 1.11.0   # 任意のバージョンでビルド
```

`build.sh` は指定バージョンの Outline を一時ディレクトリへ clone → `yarn install` → `plugin/search-pgroonga` を `plugins/` にコピー → `yarn tsc --noEmit` で型チェック → `swc` でコンパイル（`*.test.ts` は除外）し、結果を `dist/search-pgroonga/` に書き出す。そこへ `plugin.json`・`sql/`・`LICENSE`・`NOTICE`・`OUTLINE_VERSION` も入れる。git・Node.js（corepack か yarn 4）が必要で、bash で動く。

- `dist/` は git 管理外の生成物。配布は GitHub Releases で行う。
- `OUTLINE_VERSION`（ルート）が対応する Outline のバージョンの唯一の情報源。`.github/workflows/build.yml` は push/PR でこのバージョンに対してビルドし、手動実行では任意のバージョンを試せる。タグ `outline-<version>`（プラグインだけの修正は `outline-<version>-r<n>`）を push すると `search-pgroonga-outline-<version>.tar.gz` と `.sha256` を Release に添付する。タグのバージョンが `OUTLINE_VERSION` と違うと失敗する。
- ライセンスは Outline 本体と同じ BSL 1.1（Outline のコードを移植した派生物のため）。`LICENSE` は Outline のものを無改変で置いている。対応する Outline のバージョンを上げるときは、`OUTLINE_VERSION`・`LICENSE`（そのバージョンのもの）・`NOTICE`（バージョン、Change Date、由来箇所の一覧）をそろえて更新する。
- テスト（`*.test.ts`、Outline のテストランナー vitest 上で動く）も同様に、Outline のソースツリーの `plugins/search-pgroonga/` にコピーして Outline 側で実行する。テスト用 DB に PGroonga 拡張と `sql/install.sql` のインデックスが必要。
  - `PGroongaSearchProvider.test.ts`: 日本語・記号・演算子など、このプロバイダー固有の挙動。
  - `PGroongaSearchProvider.parity.test.ts`: Outline v1.10.1 の `plugins/search-postgres/server/PostgresSearchProvider.test.ts` の移植。権限・共有・フィルター・並び替え・ページングが標準プロバイダーと同じであることを確認する。差分は冒頭コメントに記載。

## アーキテクチャ

中心は `plugin/search-pgroonga/server/PGroongaSearchProvider.ts`。`index.ts` は `PluginManager.add` で `Hook.SearchProvider` として登録するだけ。

**標準プロバイダーの継承と内部メソッドの再利用**: `PostgresSearchProvider`（Outline 標準）を継承し、テキスト一致とランキング以外はすべてそちらに任せる。private な静的メソッド `buildWhere`・`withPublishedConstraint`・`findRankedResults`・`countResults` をブラケット記法（`PostgresSearchProvider["buildWhere"]`）で呼んでいる。`buildWhere` には `query: undefined` を渡し、標準の tsvector 条件が付かないようにしている。Outline 側でこれらが変わると `build.sh` の型チェックで止まる設計。`searchForTeam` 内の「Kept in step with…」ブロックは標準プロバイダーの同名メソッドからの写しなので、Outline を上げるときは差分を見比べて追随させる。

**2 段階の検索**:
1. `findMatches`: `MATCH_SQL` を独立したクエリとして実行し、PGroonga インデックスだけで一致文書 ID とスコアを取得（上位 `maxMatches` 件）。トランザクション内で `SET LOCAL enable_seqscan = off` し、`teamId` は `::text` にキャストして b-tree インデックスを使わせない。PGroonga はインデックス経由で行を見つけたときしかスコアを計算しないため、他の条件と混ぜて PostgreSQL に別のインデックスを選ばれるとスコアが黙って 0 になる。これを防ぐための構造なので崩さないこと。
2. 得られた ID を権限スコープ済みの `where` に `id IN (...)` として追加し、スコアは JSON にして replacement `:scores` で渡し SQL 側で引く（`SCORE_SQL`）。ランキング・並び替え・ページング・件数は標準プロバイダーの関数で行う。

**インデックス式の一致が必須**: `INDEXED_SQL`（`ARRAY[title::text, text] || COALESCE("previousTitles", '{}')::text[]`）は `sql/install.sql` の `CREATE INDEX` の式と一字一句同じでなければならない（PostgreSQL は式インデックスを同じ式のクエリでしか使わない）。片方を変えたらもう片方も変える。インデックス名 `documents_pgroonga_idx` も `install.sql`・`uninstall.sql`・`indexName` で共通。

**重み**: 配列要素ごとに title=10、body=1、previousTitles=2（標準の tsvector 重み A/D/C の比率に合わせたもの）。PGroonga は重みのない配列要素を無視するため、`maxPreviousTitles`（20）が過去タイトルの検索上限になる。

**クエリ変換（`parseQuery`）**: ユーザー入力を Groonga クエリ構文に変換する。各語は必ずエスケープしてダブルクォートで囲み、入力が Groonga の演算子として解釈されたり構文エラーになったりしないようにしている。対応構文は AND（空白・全角空白区切り）、`"フレーズ"`、`-除外`、大文字の `OR`。除外語だけのクエリは Groonga が評価できないため、除外を外して語そのものを検索する。

**スニペット（`buildSnippet`）**: 標準プロバイダーは単語境界に依存するため、日本語向けに独自実装。クエリ全体の一致を優先して抜粋位置を決め、句読点などの区切り文字で切り、切り出した後に `<b>` で強調する。正規化（全角/半角）だけで一致した語は強調されない（既知の制限）。

**インデックス存在確認（`verifyIndex`）**: 初回検索時に `pg_index` でインデックスが有効か確認し、無ければ `install.sql` の実行を促すエラーを投げる。無いまま動くと遅くスコア 0 で黙って動いてしまうため。

## SQL

- `sql/install.sql`: `CREATE INDEX CONCURRENTLY` を使うのでトランザクション内で実行できない（`--single-transaction` 不可）。トークナイザーは全文字種バイグラムの `TokenNgram`、ノーマライザーは `NormalizerNFKC150`（`pgroonga_condition` と合わせて PGroonga 3.1.6 以上が必要）。
- 動作確認済みの環境は PostgreSQL 16 + PGroonga 3.1.8。
