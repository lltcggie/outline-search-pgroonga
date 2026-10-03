# Outline 日本語検索プラグイン（PGroonga）

Outline v1.10.1 の検索プロバイダー機構（`SEARCH_PROVIDER`）に載せる、PGroonga ベースの検索プロバイダーです。本文の途中にある日本語も部分一致で見つかるようになります。

- Outline 本体のコードは変更しません。コンパイル済みプラグインをコンテナにマウントするだけです。
- 検索インデックスは今の PostgreSQL の中に作られ、文書の更新に自動で追随します。別の検索サーバーは不要です。
- 閲覧権限の絞り込み・フィルター・タイトル検索・コレクション検索は、Outline 標準プロバイダーの実装をそのまま使います。

## 中身

コンパイル済みのプラグインは [Releases](https://github.com/lltcggie/outline-search-pgroonga/releases) に Outline のバージョンごとに置いています。リポジトリにあるのはソースだけです。

| パス | 内容 |
|---|---|
| `plugin/search-pgroonga/` | ソースとテスト、`sql/install.sql` |
| `OUTLINE_VERSION` | 対応している Outline のバージョン |
| `build.sh` | 自分でコンパイルする場合のビルドスクリプト（結果は `dist/` に出る） |
| `.github/workflows/build.yml` | ビルドと Release の作成 |
| `docker-compose.override.example.yml` | Compose の設定例 |

## 導入手順（Docker Compose の場合）

所要時間の大半は 3 の DB イメージ差し替えです。先に DB のバックアップを取ってください。

### 1. プラグインを入手する

[Releases](https://github.com/lltcggie/outline-search-pgroonga/releases) から、**使っている Outline と同じバージョン用**のアーカイブ（`search-pgroonga-outline-<バージョン>.tar.gz`）を、`docker-compose.yml` と同じディレクトリに取ってきて展開します。同じバージョン用が複数ある場合（`outline-1.10.1-r2` など）は新しいものを使ってください。

```sh
curl -fsSLO https://github.com/lltcggie/outline-search-pgroonga/releases/download/outline-1.10.1/search-pgroonga-outline-1.10.1.tar.gz
curl -fsSLO https://github.com/lltcggie/outline-search-pgroonga/releases/download/outline-1.10.1/search-pgroonga-outline-1.10.1.tar.gz.sha256
sha256sum -c search-pgroonga-outline-1.10.1.tar.gz.sha256
tar xzf search-pgroonga-outline-1.10.1.tar.gz
```

`search-pgroonga/` ディレクトリができます（中身はコンパイル済みのプラグイン、`sql/`、`LICENSE`、`NOTICE`、`OUTLINE_VERSION`）。

### 2. バックアップ

```sh
docker compose exec postgres pg_dump -U user outline > outline-backup.sql
```

### 3. PostgreSQL を PGroonga 入りのイメージに替える

`postgres` サービスの `image` を `groonga/pgroonga` に替えます。**メジャーバージョンとベース OS は今と同じもの**を選んでください（データディレクトリをそのまま使うため）。

| 今のイメージ | 替えるイメージ |
|---|---|
| `postgres:16` | `groonga/pgroonga:latest-debian-16` |
| `postgres:16-alpine` | `groonga/pgroonga:latest-alpine-16` |

今のメジャーバージョンは `docker compose exec postgres postgres --version` で確認できます。タグの一覧は Docker Hub の `groonga/pgroonga` にあります。

```sh
docker compose up -d postgres
```

Docker を使っていない場合は、PGroonga 公式のインストール手順で PostgreSQL に PGroonga パッケージを追加してください。

### 4. インデックスを作る

スーパーユーザーで `install.sql` を流します（Outline 公式の Compose 例のユーザーはスーパーユーザーです）。

```sh
docker compose exec -T postgres psql -U user -d outline \
  < search-pgroonga/sql/install.sql
```

`CREATE INDEX CONCURRENTLY` なので、作成中も Outline は普通に使えます。

### 5. プラグインをマウントして有効化する

`docker-compose.override.example.yml` を参考に、`outline` サービスへ次を追加します。

```yaml
    environment:
      SEARCH_PROVIDER: pgroonga
    volumes:
      - ./search-pgroonga:/opt/outline/build/plugins/search-pgroonga:ro
```

（`docker.env` を使っている場合は `SEARCH_PROVIDER=pgroonga` をそちらに書いても同じです。）

```sh
docker compose up -d outline
```

### 6. 確認

文の途中にある語（これまで見つからなかったもの）で検索してください。

- プラグインが読み込まれていない場合、検索時に `Search provider "pgroonga" not found` というエラーがログに出ます。マウント先のパスを確認してください。
- インデックスが無い場合は、`install.sql` を実行するよう促すエラーが出ます。

## 検索の書き方

| 入力 | 意味 |
|---|---|
| `設計書 認証` | 両方を含む（全角スペースでも可） |
| `"出張の記録"` | そのままの並びで含む |
| `出張 -東京` | 「東京」を含むものを除く |
| `東京 OR 福岡` | どちらかを含む（`OR` は大文字） |

- 1 文字（例: `税`）でも検索できます。
- 全角/半角、大文字/小文字、半角カナは区別しません（`ＰｏｓｔｇｒｅＳＱＬ` は `postgresql` で見つかる）。
- タイトルの一致は本文の 10 倍、過去のタイトルの一致は 2 倍の重みで順位付けします。

## 標準の検索との違い・制限

- **英語は語幹一致ではなく部分一致になります。** `postgre` で `PostgreSQL` が見つかる一方、`art` で `start` も見つかり、`run` で `ran` は見つかりません。
- 過去のタイトルは 1 文書につき 20 個まで検索対象です。
- 全角/半角の違いだけで一致した場合、結果の抜粋に太字のハイライトが付きません（検索自体は当たります）。
- ひらがなとカタカナは区別します。同一視したい場合は `install.sql` 内のコメントを参照してください。
- インデックスの分、DB のディスク使用量が増えます。
- PGroonga のインデックスは既定ではクラッシュセーフではありません。DB が異常終了したあと検索がおかしい場合は `REINDEX INDEX CONCURRENTLY documents_pgroonga_idx;` で作り直せます。
- バックアップを別の DB へリストアする場合、リストア先にも PGroonga が必要です。
- リードレプリカ（`DATABASE_READ_ONLY_URL`）を使っている場合は、PGroonga のレプリケーション設定が別途必要です。

## Outline をアップグレードするとき

コンパイル済みファイルは Outline 本体のモジュールを参照しているので、**Outline と同じバージョン用のプラグインが必要**です。

1. Releases に新しいバージョン用（`outline-<新しいバージョン>`）があるか確認します。
2. あれば、導入手順 1 と同じように取ってきて `search-pgroonga/` を置き換え、Outline をアップグレードします（インデックスはそのまま使えます）。
3. まだ無いときは、`SEARCH_PROVIDER` を外して標準検索に戻してからアップグレードすれば安全です。対応版が出たら戻してください。

Release を待たずに自分でコンパイルすることもできます（git、Node.js、corepack か yarn 4 が必要）。このリポジトリを clone して次を実行すると `dist/search-pgroonga/` ができるので、それを使います。

```sh
./build.sh 1.11.0   # 新しいバージョン番号
```

`build.sh` は指定バージョンの Outline に対して型チェックをしてからコンパイルします。このプラグインは標準プロバイダーの内部メソッド（`buildWhere` など）を再利用しているため、Outline 側でそれらが変わると**ここで型エラーになって止まります**（黙って壊れることはありません）。ただし型チェックが通っても、標準プロバイダーの挙動の変更までは検出できません。

## 新しい Outline への対応とリリース（メンテナー向け）

1. **ビルドを試す**: GitHub の Actions で「Build」ワークフローを手動実行（Run workflow）し、`outline_version` に新しいバージョンを入れます。型チェックが通れば、コンパイル結果が実行結果のアーティファクトとして取れます（ローカルで `./build.sh <バージョン>` でも同じ）。
2. **標準プロバイダーの差分を見る**: 型チェックが通っても、移植した部分（[NOTICE](NOTICE) に一覧あり）が古いままになっていないか確認します。

   ```sh
   git clone https://github.com/outline/outline.git && cd outline
   git diff v1.10.1 v1.11.0 -- plugins/search-postgres server/utils/BaseSearchProvider.ts
   ```

   特に `searchForTeam` 内の「Kept in step with…」ブロック、`buildRankedOrder`、`buildSnippet`、`PGroongaSearchProvider.parity.test.ts` を差分に合わせて直します。
3. **テストする**: 新しいバージョンの Outline のソースの `plugins/` にこのプラグインをコピーし、PGroonga を入れたテスト用 DB で Outline のテスト（vitest）を実行します。Docker 上でこれを行うスクリプトが [.claude/skills/release/scripts/](.claude/skills/release/scripts/) にあります（使い方は同じ場所の `testing.md`）。
4. **バージョンを上げる**: `OUTLINE_VERSION` を新しいバージョンにし、`LICENSE` をそのバージョンの Outline のものに差し替え、`NOTICE` のバージョンと Change Date を合わせます。README 中のバージョン表記も更新します。
5. **リリースする**: コミットして push し、`outline-<バージョン>` のタグを push すると、Actions がビルドして Release を作ります。

   ```sh
   git tag outline-1.11.0
   git push origin outline-1.11.0
   ```

Outline のバージョンはそのままでプラグインだけ直した場合は、`outline-1.10.1-r2`、`-r3`… のようにタグを付けます。タグのバージョンと `OUTLINE_VERSION` が違うとビルドは失敗します。

## 元に戻す

1. `SEARCH_PROVIDER` を削除（または `postgres`）して Outline を再起動。これだけで標準検索に戻ります。標準検索用のインデックスには手を付けていません。
2. 完全に消す場合は `search-pgroonga/sql/uninstall.sql` を実行し、ボリュームのマウントを外します。

## ライセンス

[Business Source License 1.1](LICENSE)（Outline 本体と同じ条件）。

このプラグインは Outline 1.10.1 の標準検索プロバイダー（`plugins/search-postgres`）を継承し、その一部のコードとテストを移植しています。Outline は BSL 1.1 で公開されており、派生物にも同じライセンスが適用されるため、このリポジトリ全体も同じ条件で配布します。どの部分が Outline 由来かは [NOTICE](NOTICE) にまとめています。

- 自社内での利用（本番含む）は可能です。Outline を「Document Service」（第三者がチームや文書を作れる商用サービス）として提供する用途には使えません。
- 2030-09-09（Change Date）以降は Apache License 2.0 に切り替わります。
- 新しい Outline のバージョンに対応したときは、`LICENSE` もそのバージョンのものに差し替えます（Change Date はバージョンごとに異なります）。

## テスト状況

Outline v1.10.1 のソース上で、次の 2 つの DB で確認済みです（2026-10-04）。

| DB | 結果 |
|---|---|
| PostgreSQL 16.2 + PGroonga 3.1.8 | 以下すべて成功 |
| PostgreSQL 18.6 + PGroonga 4.0.9 | 以下すべて成功 |

- 標準プロバイダーのテスト（権限・共有・フィルター・並び替え・ページング）をこのプロバイダーに差し替えて実行: 53 件
- 日本語・記号・演算子、絞り込み・並び替え後のスコア、実行計画（`EXPLAIN`）の追加テスト: 15 件
- 一致 6,000 件でのページング・件数・並び替え（PostgreSQL 16 + PGroonga 3.1.8 で確認。テスト環境で 1 回の検索は 30〜90 ms 程度）

あわせて、GitHub Actions で Outline v1.10.1 に対する型チェックとコンパイルが通ることを確認しています。使っている機能（`pgroonga_condition`、`NormalizerNFKC150`）は PGroonga 3.1.6 以降にあるものです。

未確認の点:

- 本番ビルド（`build/`）からプラグインが読み込まれ、`SEARCH_PROVIDER=pgroonga` で検索できることは、検索を 1 本の SQL にまとめる前の実装で確認したもので、変更後は確認していません。
- 数万件以上の文書が一致する語での速度は測っていません。
- Docker イメージの差し替えとボリュームマウントそのもの（導入手順の 3 と 5）は試していません。
