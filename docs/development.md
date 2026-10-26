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

PTCの回帰検証は `node --test test/ptc.test.js test/ptc-runtime.test.js test/dsh-compatibility.test.js test/subagents.test.js test/ab.test.js test/ab-runtime.test.js test/teams.test.js test/execution.test.js` で実行できます。`ptc-runtime.test.js` は一時ホームとローカルの模擬Chat Completions応答で実際のdsh/ACP/PTCを起動します。通常→PTC→通常のツール定義と会話履歴、同一プロセス内の別セッション、再開、内部ツール結果、タイムアウト・キャンセル後の実行プロセス終了と再実行、読み取り専用／ワークスペースの直接Node書き込みと登録ツール書き込みを検査します。AB・チームの実際の実行プロファイルでもPTCを動かし、読み取り専用担当の直接Node書き込み拒否、実装担当の登録ツール書き込み、委任ツールの非公開と通常方式への復帰を確認します。ecoの調査→実装についても通常方式とPTCで同じセッションの調査指示・ツール結果の保持、切り替え後と再起動後の書き込み、別の調査セッションの読み取り専用維持を検査します。マネージャーのテストではAB全段階への継承、TM・eco親子の切り替え・再開・保存、ecoの差し戻しを検査します。`thread-research-transition.test.js` は要約や新規セッションへの退避がないことと、移行・保存・削除時の失敗処理を確認します。外部モデルAPIや権限昇格の承認は使いません。この検証は実モデルによる会話継続やOS全体の完全隔離を保証するものではありません。

`scripts/probe-acp.mjs` は、dsh の ACP 応答を直接確かめるための診断用スクリプトです。`scripts/check-dsh.mjs` は、dsh を更新したあとの動作確認スクリプトです（`node scripts/check-dsh.mjs`、[更新](updating.md) を参照）。

累計API換算額の画面検証は `node test/fixtures/serve-ab-ui.mjs` を起動し、表示URLの `ab-ui.html` を `usage-score-ui.html` に替えて開きます。DevToolsで `await usageScoreTest.run('USD')` と `await usageScoreTest.run('JPY')` を実行すると、通常・TM・Eco・Claude親・AB、小額・既知のゼロ・未算定・旧履歴を検証し、実際に開いた詳細の課金額・手動レート・フォーカス復帰も確認します。`await usageScoreTest.renderSettings()` で一般設定、`usageScoreTest.failSave()` で次の保存失敗を再現できます。375px幅でも実行でき、実モデルや本番データは使いません。

AB・TM・ecoのPTC画面検証は同じViteフィクスチャサーバーの `ptc-ui.html` を開き、DevToolsで `await ptcTest.run()` を実行します。各開始画面の選択・設定保存・送信値、既存AB／チームの保存失敗・二重操作防止・実行中の無効化・通知後の表示更新を確認します。本番データや実モデルは使いません。

TM・eco共通の親の自動継続待機は `test/goal-driver-wait.test.js`・`test/goal-patch.test.js`・`test/thread-goal-wait.test.js`・`test/teams.test.js` で、予約前／実行直前の再確認、ターン終了、設定の適用確認、報告の配送順序を検査します。`test/ptc-runtime.test.js` は通常方式・PTCの実dshで、待機中にgoal roundのモデル要求が増えないこと、目標のactive／armed状態と残り回数、明示入力の受領、キャンセル、同一プロセスの通常セッションの自動継続を確認します。`wait` の並行作業指定より質問・停止・未配送の報告を優先すること、送信失敗・重複再送・内部報告が質問待ちを解除しないこと、休止中の親のキャンセル、停止と送信の競合も検査します。実dshでは質問への割り込み受理と待機解除の原子性、終了済みターンへの割り込みが管理外のモデル要求を開始しないことを確認します。`goal-wait` と steering の実フック合成も更新時の互換性ゲートに含みます。

## リリース

アプリの「更新」ボタンは、GitHub のリリースを配信元にします（[更新](updating.md)）。

1. `npm version <版> --no-git-tag-version` で `package.json` と `package-lock.json` の版を上げ、`CHANGELOG.md` の `[Unreleased]` を `## [<版>] - <日付>` にしてコミットし、`main` に push します。
2. `git tag v<版>` を作って push します。

タグを push すると `.github/workflows/release.yml` がテストし、`AgentDesk-<版>.zip`（`scripts/pack-release.mjs`。UI はビルド済み、依存パッケージは含まない）を付けたリリースを公開します。リリースノートは CHANGELOG のその版の節です。先に手でリリースを作っておくと、そのノートのまま zip だけを付けます。下書きとプレリリースは、アプリの更新の対象になりません。

更新を手元で試すときは、`AGENT_DESK_HOME` に別のフォルダを指定し、zip から入れたコピーで起動してください。`AGENT_DESK_UPDATE_REPO=<owner>/<name>` を付けると、別のリポジトリのリリースを見ます。
