# 開発

[← README に戻る](../README.md)

```sh
npm run dev        # サーバーと Vite の開発サーバーを起動（表示された dev UI の URL を開く）
npm test           # 単体テスト
npm run typecheck  # 画面側の型チェック
npm run build      # 画面のビルド（npm start 時は必要なら自動で実行）
```

スマホの画面は、Tailscale がなくても `AGENT_DESK_REMOTE_ADDRESSES=127.0.0.2` を付けて起動すれば、PC のブラウザで `http://127.0.0.2:47131/?t=…` を開いて確かめられます（Tailscale の検出の代わりに、指定したアドレスで待ち受けます）。確認のときは `AGENT_DESK_HOME` に別のフォルダを指定してください。

主な責務は、設定の検証・保存順序が `server/settings.js`、更新互換性が `server/dsh-compatibility.js`、タスクの受領記録とライフサイクルが `server/threads.js`、ブラウザの送信待ちが `web/src/outbox.ts`、接続ごとのリクエスト管理が `web/src/rpc-client.ts` に分かれています。送信の回帰テストは実モデルを呼ばず、更新の回帰テストも実際の npm 更新を行いません。`test/server-recovery.test.js` は一時データフォルダで復旧待ちのサーバーを起動し、エンジンを起動せずに RPC の接続を確認します。

`scripts/probe-acp.mjs` は、dsh の ACP 応答を直接確かめるための診断用スクリプトです。`scripts/check-dsh.mjs` は、dsh を更新したあとの動作確認スクリプトです（`node scripts/check-dsh.mjs`、[更新](updating.md) を参照）。

累計API換算額の画面検証は `node test/fixtures/serve-ab-ui.mjs` を起動し、表示URLの `ab-ui.html` を `usage-score-ui.html` に替えて開きます。DevToolsで `await usageScoreTest.run('USD')` と `await usageScoreTest.run('JPY')` を実行すると、通常・TM・Eco・Claude親・AB、小額・既知のゼロ・未算定・旧履歴を検証し、実際に開いた詳細の課金額・手動レート・フォーカス復帰も確認します。`await usageScoreTest.renderSettings()` で一般設定、`usageScoreTest.failSave()` で次の保存失敗を再現できます。375px幅でも実行でき、実モデルや本番データは使いません。

## リリース

アプリの「更新」ボタンは、GitHub のリリースを配信元にします（[更新](updating.md)）。

1. `npm version <版> --no-git-tag-version` で `package.json` と `package-lock.json` の版を上げ、`CHANGELOG.md` の `[Unreleased]` を `## [<版>] - <日付>` にしてコミットし、`main` に push します。
2. `git tag v<版>` を作って push します。

タグを push すると `.github/workflows/release.yml` がテストし、`AgentDesk-<版>.zip`（`scripts/pack-release.mjs`。UI はビルド済み、依存パッケージは含まない）を付けたリリースを公開します。リリースノートは CHANGELOG のその版の節です。先に手でリリースを作っておくと、そのノートのまま zip だけを付けます。下書きとプレリリースは、アプリの更新の対象になりません。

更新を手元で試すときは、`AGENT_DESK_HOME` に別のフォルダを指定し、zip から入れたコピーで起動してください。`AGENT_DESK_UPDATE_REPO=<owner>/<name>` を付けると、別のリポジトリのリリースを見ます。
