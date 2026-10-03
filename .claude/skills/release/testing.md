# テストの実行

プラグインのテストは、Outline のソースツリーの中で、PGroonga 入りの PostgreSQL に対して動く。CI では動かないため、WSL（ディストリビューション `Ubuntu`）の Docker で手元実行する。手順は [scripts/](scripts/) のスクリプトにまとまっている。

## 本番の保護

WSL の Docker では本番の Outline（`outline-*` のコンテナ、`outline_*` のボリューム）などが動いている。触ってよいのは `containers.sh` が作り、ラベル `outline-search-pgroonga.test=true` が付いたコンテナだけ。ほかのコンテナ・ボリューム・Compose プロジェクトは、状態を見るだけにとどめる。`containers.sh` のコンテナ名（`outline-search-pgroonga-test-*`）とポート（25432・26379、Windows の動的ポート範囲の外）は本番と重ならないように選んである。それでも既存のコンテナや使用中のポートを理由に止まったら、それは本番とみなす。名前やポートを変えて回避したり、相手を止めたりはせず、ユーザーに状況を伝えて判断を仰ぐ。

## 手順

スクリプトは PowerShell から `wsl -d Ubuntu -- bash <スクリプトの WSL パス> <引数>` で呼ぶ（このリポジトリが `D:\Repositories\outline-search-pgroonga` なら `/mnt/d/Repositories/outline-search-pgroonga/.claude/skills/release/scripts/...`）。`setup.sh` と scale の実行は数分以上かかるので、バックグラウンドで実行する。作業場所は WSL の `~/pgroonga-test/` で、版ごとに `outline-<版>` ができる。

1. `setup.sh <版>`: Outline `v<版>` の clone、その `.nvmrc` のメジャー版の Node.js、`yarn install`。2 回目以降は差分だけ。
2. 次の 2 つの DB それぞれで、`containers.sh <イメージ>` → `run-tests.sh <版>` を実行する。`containers.sh` は PostgreSQL と PGroonga の版を表示するので控えておく。
   - `groonga/pgroonga:3.1.8-debian-16`（サポートする下限側）。この DB では続けて `run-tests.sh <版> plugins/search-pgroonga-scale/` も実行する（一致 6,000 件の規模確認。1 回の検索の所要時間がログに出る）。
   - `groonga/pgroonga:latest-debian-18`（最新側）
3. `teardown.sh` でテスト用コンテナを消す。

`run-tests.sh` は、このリポジトリの作業ツリーの `plugin/search-pgroonga/` をそのままコピーして実行する（コミット前の変更も含まれる）。詳しいログは WSL の `~/pgroonga-test/vitest.log` と `migrate.log` にある。

## 完了条件

- 2 つの DB で `PGroongaSearchProvider.test.ts` と `PGroongaSearchProvider.parity.test.ts` が全件成功し、scale の確認も成功している。
- README の「テスト状況」に書くための値を控えてある: 日付、Outline の版、各 DB の PostgreSQL・PGroonga の版、テストファイルごとの件数、scale の検索時間の幅。
- `docker ps -a --filter label=outline-search-pgroonga.test=true` が空で、ほかのコンテナの状態は実行前と同じ。
