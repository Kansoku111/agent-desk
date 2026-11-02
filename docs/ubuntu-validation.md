# Ubuntu の検証手順

Ubuntu の対象版・CPU・利用形態は未確定です。この手順や WSL2 での成功は、通常の Ubuntu デスクトップを含む対応保証ではありません。正式な対象が決まったら、その版の CI と実環境で確認します。Windows 用 CI は維持します。

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

## 合否を分けて記録する

- 起動・終了・再起動、設定とセッションの復元、日本語と空白を含むワークスペース、ファイル操作と内蔵ターミナルを確認する。対象プロバイダーの認証と応答はテスト用データで確認し、認証情報を記録に残さない。
- `node --test --test-name-pattern="real PTC direct Node writes respect" test/ptc-runtime.test.js` は模擬モデルと実 DSH を使い、読み取り、読み取り専用での書き込み拒否、ワークスペースへの書き込み、範囲外への書き込み拒否を検査する。対象環境の実際の権限モードと使用方式も別途確認する。
- DSH の Linux サンドボックスは bwrap、次いで Landlock を検査し、使用できなければ fail-closed とする設計。方式・enforcement が full／partial のどちらかと、隔離不能時に無制限実行へ移らないことを対象環境で実測する。OS の保護や権限モードを変更して合格扱いにしない。
- デスクトップ対象では通常の Ubuntu デスクトップ（VM でも可）でブラウザ／アプリウィンドウ、フォルダー選択と権限制御を確認する。WSLg の結果とは分ける。
- 更新は使い捨てのインストール先で ZIP 展開、適用、再起動、失敗時の復旧を確認する。単体テストだけでは実際の更新成功を保証しない。

実モデルの確認では GPT は `gpt-6-luna`・推論レベル `low`、Claude Code は `haiku`・推論レベル `low` を明示し、使えない場合は別のモデルや課金経路に切り替えず未実施と記録します。
