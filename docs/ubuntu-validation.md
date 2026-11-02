# Ubuntu の検証手順

検証対象は Ubuntu 24.04 LTS・x86_64（AMD64、Ryzen を含む）です。デスクトップ／サーバーの利用形態は未確定です。Windows と Ubuntu 24.04 の Node.js 22・24 を [CI](../.github/workflows/ci.yml) の検証対象にしています。CI 設定の追加や WSL2 での成功は、通常の Ubuntu デスクトップを含む対応保証ではありません。GUI・実プロバイダー・更新を含む受け入れ確認は別途必要です。

## Ubuntu 24.04 での準備

Linux x64 用 Node.js 24 LTS を用意します（[公式ダウンロード](https://nodejs.org/en/download)）。Windows の Node.js や Ubuntu 標準の古い Node.js を流用せず、`node -v` と `npm -v` を確認してください。

```sh
sudo apt-get update
sudo apt-get install -y git build-essential python3 bubblewrap inotify-tools unzip
```

`bubblewrap` は DSH の隔離実行に使います。利用不能時に OS の保護を無効にして通すのではなく、実際に選ばれる方式と拒否動作を確認します。eco のコマンド検証は `inotify-tools` の `inotifywait` を使い、作成後すぐに削除されたファイルも記録します。監視が起動できなければコマンドを実行せずエラーにし、監視が途中で失われた検証は合格にしません。

デスクトップでブラウザやフォルダー選択を使う場合は、別途次を導入します。GUI の表示環境とブラウザも必要です。

```sh
sudo apt-get install -y xdg-utils zenity
```

リリース ZIP を作る開発環境・全テストの実行環境には `zip` も必要です。CI ではこれらのテスト用依存を明示的に導入します。

## 独立した環境

WSL2 または Ubuntu の Linux ファイルシステムに別の作業ツリーを用意し、Windows の `node_modules` やネイティブバイナリはコピーしません。稼働中の本体では `npm ci` を実行しないでください。Node.js と npm は Linux 用を使い、Node.js の条件は [package.json](../package.json) の `engines` を参照します。`node-pty` などのネイティブ依存の導入にはビルドツールが必要になる場合があります。実行中の Node.js とアプリは `/tmp` の外に置いてください。DSH の bwrap の `workspace-write` では `/tmp` が一時領域に置き換わり、そこに置いた実行ファイルが見えなくなります。

`xdg-open`（Ubuntu の `xdg-utils`）は既定ブラウザやファイルを開く際に、`zenity` はフォルダー選択時に必要です。フォルダー選択は現在、キャンセルと起動失敗を区別しません。外部ターミナル起動と Windows の画面操作ツールは Linux 対象外です。ZIP 更新の展開には `unzip`、リリース ZIP の作成には `zip` を使います。GUI 操作は表示環境とブラウザも必要です。必要に応じて OS のパッケージを導入してください。

検証用のホームとワークスペースを用意してから、Linux の作業ツリーで実行します。

```sh
export AGENT_DESK_HOME="$(mktemp -d "$HOME/agent-desk-test-XXXXXX")"
mkdir "$AGENT_DESK_HOME/tmp"
export TMPDIR="$AGENT_DESK_HOME/tmp"
npm ci
npm run typecheck
npm run build
npm test
npm run serve
```

`serve` は自動でブラウザを開きません。表示されたローカル URL を使い、公開設定や認証制御を緩めないでください。通常の保存先は `AGENT_DESK_HOME` が優先され、未設定の Linux では `$XDG_CONFIG_HOME/agent-desk`、さらに未設定なら `~/.config/agent-desk` です。

## 2026-11-02 の探索的検証

対象版の決定ではなく、Windows 11 の WSL2 Ubuntu 26.04 x86_64、独立ツリーと Linux 用 Node.js 24.14.0／npm 11.9.0 で確認しました。`npm ci`・型検査・ビルド、`--no-open` での起動、HTTP 応答と終了は成功しました。ブラウザとファイル操作の `xdg-open` 不在テストは成功しました。

ファイル表示の修正前に実行した全テストは 1,727 件中 36 件失敗、8 件スキップでした。修正後の対象テストは別途実行しました。`zip` 不在のリリーステスト、Git の stdin の EPIPE、権限テストなどが含まれます。チェックポイントの一件は単独実行で成功しましたが、全体の原因は確定していません。最初の権限テストは `workspace-write` で失敗しました。診断では `/tmp` に置いた Node.js が bwrap 内で見えず、`sandbox-unavailable` と報告されました。Node.js・アプリ・テスト用一時領域を Linux ホーム側に移して同じ権限テストを再実行すると、読み取り専用・`workspace-write` の両ケースが成功しました。`bwrap --ro-bind / / -- /usr/bin/true` の単純な起動も成功しました。サンドボックスが全く利用できない場合の fail-closed は未確認です。GUI、実プロバイダー、更新の実操作は未検証です。

## 対象確定後の検証

2026-11-02 に、Windows 11 に別の WSL2 Ubuntu 24.04 を追加し、x86_64・非 root の検証ユーザーで独立した作業ツリーを用意しました。Ubuntu 26.04 での既存検証とは区別しています。

Linux の再帰 `fs.watch` は短命ファイルを見落とし、削除済みのディレクトリを生成物として正しく分類できませんでした。Node.js 24.14.0 と 24.22.1 で既存の検証テストが失敗することを確認し、Linux のみネイティブの inotify イベントを使う実装に変更しました。Windows の監視方式は変更していません。Git が stdin を読み切る前に終了した場合の未処理 EPIPE も回帰テストで再現して修正しました。ターミナル送信と Tailscale 再確認のテストでは、拒否の受け取り遅れと固定待ち時間への依存を修正し、従来のアサーションは維持しています。

リポジトリからのスモーク確認は、上記の独立環境で次を実行します。実プロバイダーへの認証やモデルへの依頼は行わず、新しく作った一時保存先だけを使います。

```sh
node test/manual/ubuntu-smoke.mjs
```

このスモークは起動・HTTP 配信・既存の認証付き WebSocket RPC・設定と日本語／空白を含むワークスペースの保存と再起動後の復元・終了・実 PTY の `/bin/sh` 入出力を確認します。ブラウザの画面表示や内蔵ターミナル UI の確認ではありません。

### 2026-11-02 の結果

| 環境・確認 | 結果 |
| --- | --- |
| WSL2 Ubuntu 24.04.5 LTS・x86_64、Node.js 24.22.1 | Linux 側でのクリーンな `npm ci`、型検査、ビルドに成功。Windows の `node_modules` は未使用 |
| 同環境の最終 `npm test` | 1,792 件中 1,784 成功、失敗 0、8 スキップ |
| 同環境の `node test/manual/ubuntu-smoke.mjs` | 成功 |
| 実 DSH を使う PTC 権限テスト | 全体テスト内で読み取り専用と workspace-write の両ケースが成功。許可された読み書きと禁止書き込み・範囲外書き込みの拒否を検査 |
| Windows 11、Node.js 24.22.1 | 型検査・ビルドに成功。変更関連 7 ファイルのテストは 66 成功、失敗 0、4 スキップ |
| Windows の全体検証 | 不合格。後述の失敗とワーカー残留があり、正常完走ではない。失敗した 3 ファイルは単独実行で 27 件成功 |
| GitHub Actions、Node.js 22 | CI の設定・YAML を確認したのみ。実際の CI と Node.js 22 のローカル検証は未実施 |

Windows の通常の `npm test` は長時間停滞したため中断しました。続く `node --test --test-timeout=180000 "test/**/*.test.js"` では、`runtime-restart.test.js` の残留ワーカーとその子プロセスを所有確認後に強制終了し、1,782 成功・6 失敗・4 スキップという集計を回収しました。成功した全テスト実行とは扱いません。失敗は `account-catalog.test.js` の 2 件（SQLite の EBUSY、カタログ収束待ち）、`local-llm.test.js` の 1 件（SQLite の EBUSY）、`runtime-restart.test.js` の 3 件（ACP 接続切断、起動期限）です。同じ 3 ファイルを `a5b823b` 上で単独実行すると 27 件すべて成功しました。今回の変更（Linux 専用の監視、Git の stdin、テスト 3 件）はこれらの領域に触れていないため、今回の回帰ではなく、全体を並列実行したときの負荷・競合による既存の不安定さと判断しています。原因の修正は未着手です。

Ubuntu の全体実行で再現したテストの競合を修正した後に全体を再実行した結果を表に記載しています。ターミナルの待機期限は単調時計を使い、壁時計の補正によって待機時間が変わらないようにしました。テストの一括スキップや期待結果の緩和はしていません。

通常の Ubuntu デスクトップでの GUI、実プロバイダーの認証・応答、実セッションの復元、アプリ内更新・復旧は未実施です。サンドボックスの方式・enforcement の実測記録と、すべての隔離方式が利用不能な場合の fail-closed も未確認です。WSL2 の成功からこれらの対応済みを判断しないでください。

## 合否を分けて記録する

- 起動・終了・再起動、設定とセッションの復元、日本語と空白を含むワークスペース、ファイル操作と内蔵ターミナルを確認する。対象プロバイダーの認証と応答はテスト用データで確認し、認証情報を記録に残さない。
- `node --test --test-name-pattern="real PTC direct Node writes respect" test/ptc-runtime.test.js` は模擬モデルと実 DSH を使い、読み取り、読み取り専用での書き込み拒否、ワークスペースへの書き込み、範囲外への書き込み拒否を検査する。対象環境の実際の権限モードと使用方式も別途確認する。
- DSH の Linux サンドボックスは bwrap、次いで Landlock を検査し、使用できなければ fail-closed とする設計。方式・enforcement が full／partial のどちらかと、隔離不能時に無制限実行へ移らないことを対象環境で実測する。OS の保護や権限モードを変更して合格扱いにしない。
- デスクトップ対象では通常の Ubuntu デスクトップ（VM でも可）でブラウザ／アプリウィンドウ、フォルダー選択と権限制御を確認する。WSLg の結果とは分ける。
- 更新は使い捨てのインストール先で ZIP 展開、適用、再起動、失敗時の復旧を確認する。単体テストだけでは実際の更新成功を保証しない。

実モデルの確認では GPT は `gpt-6-luna`・推論レベル `low`、Claude Code は `haiku`・推論レベル `low` を明示し、使えない場合は別のモデルや課金経路に切り替えず未実施と記録します。
