# 開発

[← README に戻る](../README.md)

```sh
npm run dev        # サーバーと Vite の開発サーバーを起動（表示された dev UI の URL を開く）
npm test           # 単体テスト
npm run typecheck  # 画面側の型チェック
npm run build      # 画面のビルド（npm start 時は必要なら自動で実行）
```

スマホの画面は、Tailscale がなくても `AGENT_DESK_REMOTE_ADDRESSES=127.0.0.2` を付けて起動すれば、PC のブラウザで `http://127.0.0.2:47131/?t=…` を開いて確かめられます（Tailscale の検出の代わりに、指定したアドレスで待ち受けます）。確認のときは `AGENT_DESK_HOME` に別のフォルダを指定してください。

子の文脈予算は `node --test test/team-child-compaction.test.js test/team-child-runtime.test.js test/team-child-compaction-runtime.test.js` で検証します。会社名に依存しない開始目安、従来の早い基準の維持、保持量・再試行設定、古いツール結果の削減、並行ルート・容量変更・再開、実dshローダーでの親子分離を確認します。模擬応答だけを使い、実モデル・利用枠は消費しません。[設計記録](team-context-budget.md)。

主な責務は、設定の検証・保存順序が `server/settings.js`、更新互換性が `server/dsh-compatibility.js`、タスクの受領記録とライフサイクルが `server/threads.js`、ブラウザの送信待ちが `web/src/outbox.ts`、接続ごとのリクエスト管理が `web/src/rpc-client.ts` に分かれています。送信の回帰テストは実モデルを呼ばず、更新の回帰テストも実際の npm 更新を行いません。`test/single-instance-successor.test.js` は一時データフォルダと模擬HTTPサーバーで、旧インスタンス消滅後の後継起動と二重起動の防止を確認します。`test/release-inputs.test.js` は一時コピーで実際にZIPを作り、共有モジュールの同梱とビルド入力・コード指紋の追跡を検査します。

PTCの回帰検証は `node --test test/ptc.test.js test/ptc-runtime.test.js test/dsh-compatibility.test.js test/subagents.test.js test/ab.test.js test/ab-runtime.test.js test/teams.test.js test/execution.test.js` で実行できます。`ptc-runtime.test.js` は一時ホームとローカルの模擬Chat Completions応答で実際のdsh/ACP/PTCを起動します。通常→PTC→通常のツール定義と会話履歴、同一プロセス内の別セッション、再開、内部ツール結果、タイムアウト・キャンセル後の実行プロセス終了と再実行、読み取り専用／ワークスペースの直接Node書き込みと登録ツール書き込みを検査します。AB・チームの実際の実行プロファイルでもPTCを動かし、読み取り専用担当の直接Node書き込み拒否、実装担当の登録ツール書き込み、委任ツールの非公開と通常方式への復帰を確認します。ecoの調査→実装についても通常方式とPTCで同じセッションの調査指示・ツール結果の保持、切り替え後と再起動後の書き込み、別の調査セッションの読み取り専用維持を検査します。マネージャーのテストではAB全段階への継承、TM・eco親子の切り替え・再開・保存、ecoの差し戻しを検査します。`thread-research-transition.test.js` は要約や新規セッションへの退避がないことと、移行・保存・削除時の失敗処理を確認します。外部モデルAPIや権限昇格の承認は使いません。この検証は実モデルによる会話継続やOS全体の完全隔離を保証するものではありません。

Planの回帰検証は `node --test test/plan.test.js` と `node --test --test-name-pattern="Plan suffix|legacy Plan restores" test/ptc-runtime.test.js` で実行できます。模擬応答と実dshで、全3権限×通常方式／PTCの末尾指示・同一ID／プロセス・履歴・ツール定義の維持を確認します。意図的に指示に従わない模擬応答を使い、Planが書き込みを追加制限せず、通常の権限だけが適用されることも検査します。単体テストは初回送信・画像・予約・割り込み・重複送信と、旧強制方式からの権限復元・失敗時の停止を確認します。

`scripts/probe-acp.mjs` は、dsh の ACP 応答を直接確かめるための診断用スクリプトです。`scripts/check-dsh.mjs` は、dsh を更新したあとの動作確認スクリプトです（`node scripts/check-dsh.mjs`、[更新](updating.md) を参照）。

累計API換算額の画面検証は `node test/fixtures/serve-ab-ui.mjs` を起動し、表示URLの `ab-ui.html` を `usage-score-ui.html` に替えて開きます。DevToolsで `await usageScoreTest.run('USD')` と `await usageScoreTest.run('JPY')` を実行すると、通常・TM・Eco・Claude親・AB、小額・既知のゼロ・未算定・旧履歴を検証し、実際に開いた詳細の課金額・手動レート・フォーカス復帰も確認します。`await usageScoreTest.runCommand()` では Command Code の既定・明示レベルの切り替え、未確認モデルの扱いと利用量詳細も確認します。`await usageScoreTest.renderSettings()` で一般設定、`usageScoreTest.failSave()` で次の保存失敗を再現できます。375px幅でも実行でき、実モデルや本番データは使いません。

AB・TM・ecoのPTC画面検証は同じViteフィクスチャサーバーの `ptc-ui.html` を開き、DevToolsで `await ptcTest.run()` を実行します。各開始画面の選択・設定保存・送信値、既存AB／チームの保存失敗・二重操作防止・実行中の無効化・通知後の表示更新を確認します。同じ画面で `await ptcTest.runTeamFree()` を実行すると、TM自由モードの推論レベル別の追加、開始・保存・再表示、選択解除とフォーカスを確認できます。`await ptcTest.runCommandTeam()` では Command Code の3モデルの推論レベルと開始時の送信値を確認します。375px幅でも実行でき、本番データや実モデルは使いません。

`/goal` の回帰確認は `node --test test/goal-command.test.js` と `node --test --test-name-pattern="explicit /goal" test/ptc-runtime.test.js` です。初回作成・通常送信・予約・重複排除、人間の入力と内部報告の区別、未対応の役割やPlanの拒否を確認します。通常方式／PTCの実dshとローカル模擬応答で、モデル呼び出し前の直接登録、既存目標の保護、待機、再起動後の保持と自動継続解除、明示再開、実goal roundによる完了、停止を確認します。外部モデルや本番データは使いません。専用メタデータはアプリが受理した人間のコマンドだけに付け、ACPの初期応答でフックの対応を確認できなければ呼び出しません。会話への指示追加だけではgoal登録を保証できないため、既存フックでdshのgoalドメインを直接使っています。保存形式は変更せず、既存セッションの移行も不要です。

TM・eco共通の親の自動継続待機は `test/goal-driver-wait.test.js`・`test/goal-patch.test.js`・`test/thread-goal-wait.test.js`・`test/teams.test.js` で、予約前／実行直前の再確認、ターン終了、設定の適用確認、報告の配送順序を検査します。`test/ptc-runtime.test.js` は通常方式・PTCの実dshで、待機中にgoal roundのモデル要求が増えないこと、目標のactive／armed状態と残り回数、明示入力の受領、キャンセル、同一プロセスの通常セッションの自動継続を確認します。`wait` の並行作業指定より質問・停止・未配送の報告を優先すること、送信失敗・重複再送・内部報告が質問待ちを解除しないこと、休止中の親のキャンセル、停止と送信の競合も検査します。実dshでは質問への割り込み受理と待機解除の原子性、終了済みターンへの割り込みが管理外のモデル要求を開始しないことを確認します。`goal-wait` と steering の実フック合成も更新時の互換性ゲートに含みます。TM・ecoのdshの子は `test/team-child-runtime.test.js` と `test/ptc-runtime.test.js` でgoalツールとドライバーの無効化を確認します。通常方式・PTCの実dshとローカル模擬応答で、保存済みgoalを持つ子が外部待ちを報告した後に自動ラウンドを起こさず、同じ会話に再依頼でき、保存済みgoalも保持されることを検査します。

設定の回帰確認は同じフィクスチャサーバーの `settings-bug-audit-ui.html` で `await settingsAudit.run()` を実行します。候補が後から届くClaudeワークスペースの選択・送信と、検証行の削除→追加→保存を実コンポーネントで確認します。`usage-pricing-ui.html` の `await usagePricingTest.run()` は、未算定・一部未算定・非課金・利用なし・既知ゼロをタイル、モデル行、グラフのツールチップで確認します。どちらもRPCは模擬応答で、本番データや実モデルを使いません。

## コンテキスト圧縮

`node --test test/compaction-patch.test.js test/context-overflow-patch.test.js test/context-compaction-runtime.test.js test/dsh-compatibility.test.js` で検証します。巨大な先頭メッセージと短い最近の会話を模擬し、実dsh／ACPで要約・続行・プロセス再起動後の再開を親子両方で確認します。ローカル模擬APIだけを使い、実モデルの要約品質や実際の最大入力容量を検証するものではありません。

保持量を下げるのは、従来の範囲選択が圧縮不能を返す場合だけです。最小の安全な先頭範囲を要約し、システム先頭と少なくとも最後の1ノードを残し、ツール呼び出しと結果の組を分断しません。安全な境界がない会話は無理に切りません。予算を一律に広げる方法や履歴の切り捨ては採らず、上流の要約・保存・キャンセル処理を維持します。

`context-overflow` フックは、コンテキストサイズを選べる ChatGPT／Claude 経路の正常終了だけを、入力usageとローカル予算の比較による超過判定から除きます。APIが返す超過エラー、出力ゼロの長さ制限、他経路のサイレント超過検出は維持します。`compaction` フックとともに更新時のソース一致・構文・実ロード結果を検査します。設定・セッション形式・モデル・課金経路は変えず、移行操作は不要です。実行中のdshには遡及適用されないため、利用にはAgent Deskの再起動が必要です。

## 利用上限時のフォールバック

回帰確認は node --test test/usage-fallback.test.js test/usage-fallback-settings-ui.test.js test/normal-fallback-handoff.test.js test/thread-usage-fallback.test.js test/ab.test.js test/teams.test.js test/terminals.test.js test/outbox.test.js test/claude-hook.test.js です。模擬ランタイム・PTYで優先順、旧設定、認証、指定モデルの適用、停止・競合・再起動時のフェンスを確認します。実モデル・本番データは使いません。

候補を接続先別に保持するのは、一つのモデルを全ソースの代替にすると、そのモデルの接続先が制限されたときに同じ経路を再選択してしまうためです。起動中に共通設定を書き換えて課金経路を変えないよう、通常はターンごと、AB・TM・ecoは実行ごとに候補を控えます。旧設定を自動で全モードに広げる代替案は、利用者が認めていない課金経路を有効にし得るため採らず、明示保存までは従来設定を残します。実行方式をまたぐときは非公開の対象と元へのリンクを先に保存し、送信結果や中断が不明なら自動再実行しません。詳細・対象外は[利用上限時のフォールバック](usage-fallback.md)を正とします。

## Claude Code の質問カード

回帰確認は `node --test test/terminals.test.js test/terminal-dialog-ui.test.js test/rpc-handlers-terminals.test.js test/terminal-send-regressions.test.js test/terminal-input-delivery.test.js test/claude-login-ui.test.js` です。模擬PTYと実コンポーネントで自由入力・改行・明示的確定・複数選択用キー・古い質問・二重操作・制御文字の拒否・失敗時の入力保持を検査します。ブラウザ検証は `node test/fixtures/serve-ab-ui.mjs` のURLを `terminal-dialog-ui.html` に替え、DevToolsで `await terminalDialogTest.run()` を実行します。375px幅でも確認でき、実モデルや本番データは使いません。実IMEの変換や全CLIバージョンでの動作を保証する検証ではありません。

設計上、質問の決定権は改造していないCLIに残します。既存の画面読み取りを拡張し、選択肢以外の画面にはテキスト表示と明示的なキー／貼り付け操作を用意します。CLI内部のAPIへの依存や質問ツールの置き換えを避けるためです。質問の画面指紋・プロセス固有値・入力世代を含む一時IDを操作前に照合し、同じ選択肢の別質問・別クライアントの操作・再起動後の古い操作を拒否します。自由入力とEnterは別操作で、通常メッセージ送信のEnter再送を流用しません。既存の `terminal.choose` のID省略形式は互換のため維持し、新しいチャットは必ずIDを付けます。新しい `terminal.respond` はID必須です。保存形式・セッション・認証・モデル・課金経路は変更せず、移行操作は不要です。

## リリース

アプリの「更新」ボタンは、GitHub のリリースを配信元にします（[更新](updating.md)）。

1. `npm version <版> --no-git-tag-version` で `package.json` と `package-lock.json` の版を上げ、`CHANGELOG.md` の `[Unreleased]` を `## [<版>] - <日付>` にしてコミットし、`main` に push します。
2. `git tag v<版>` を作って push します。

タグを push すると `.github/workflows/release.yml` がテストし、`AgentDesk-<版>.zip`（`scripts/pack-release.mjs`。UI はビルド済み、依存パッケージは含まない）を付けたリリースを公開します。リリースノートは CHANGELOG のその版の節です。先に手でリリースを作っておくと、そのノートのまま zip だけを付けます。下書きとプレリリースは、アプリの更新の対象になりません。

更新を手元で試すときは、`AGENT_DESK_HOME` に別のフォルダを指定し、zip から入れたコピーで起動してください。`AGENT_DESK_UPDATE_REPO=<owner>/<name>` を付けると、別のリポジトリのリリースを見ます。
