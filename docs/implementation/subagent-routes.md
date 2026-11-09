# サブエージェント委託先の再設計

状態: 実装済み（段階0〜3、5、6）。段階4の「表示と使用量」は、右パネルのカードまで実装し、親のターン別集計への合算は未実装。結果と計画からの変更は末尾の「実装結果」にまとめた。

## 背景と決定

今の設定は委託先の系列（Claude / ChatGPT）をキーにしていて、呼び出し元のタスク種別（DSH / CL / GP）では分けられない。委託の経路も揃っていない。

| 親＼子 | DSH | CL | GP |
|---|---|---|---|
| DSH | ○ `subagent` / `subagent_claude` / `subagent_gpt` | × | × |
| CL | ○ `subagent_gpt`（GPT のみ、`gpt-subagent-mcp.js`） | △ Claude Code 組み込み（モデル・推論は指定していない） | × |
| GP | × | × | × Codex の `multi_agent` を無効にしている（`codex-runner.js`、`docs/codex.md`）。ただし 0.167.0 は gpt-6 系に独自のサブエージェントツールを渡す（「実装結果」参照） |

決定事項（利用者との合意）:

- 親3種（DSH / CL / GP）ごとに、委託先を1つ持つ。委託先は「種類・モデル・推論レベル」。
- 初期値は同種（DSH→DSH、CL→CL、GP→GP）。設定画面で委託先の種類をドラッグして置き換えられる。
- 子は子を呼べない（深さ1）。1つの親に、委託先の種類は1つ。
- 利用上限時の自動フォールバックは初版に入れない（理由は下の「やらないこと」）。

## 設計

### 設定
`settings.json` に `subagentRoutes` を足す。

```
subagentRoutes: { dsh: Route, cl: Route, gp: Route }
Route = { target: 'dsh' | 'cl' | 'gp', model: string | null, effort: string | null }
```

- `model: null` は「親と同じ」。既定は全行が `{ target: <自分>, model: null, effort: null }`。
- 検証は `settings.js` に置く。`target` は列挙、`model` は target に合うカタログ、`effort` は `workflowLevels` と同じ規則。
- DSH を委託先にするときのモデルは、接続済みでカタログにあるものを自由に選べる（GPT、Claude(API)、DeepSeek、OpenCode Go、Command Code、ローカル LLM ほか）。今の `SUBAGENT_TOOLS`（anthropic / openai-codex の2つだけ）と `settings.js` の検証は、接続先ごとの表に広げる。表には固定ツールの名前と課金の案内文を持たせ、案内文には接続先の課金（従量・サブスクリプション・無料）を載せる。`gptSubagentPatch` の `openai-codex` 固定も外す。固定ツールの本体（`agentOptions` の `provider` / `model`）に接続先の制限はない。
- 同種のままの行は、ネイティブの委託ツールをそのまま使う（DSH は `subagent`、CL は組み込み Agent）。
- 別種を選んだ行は、その親のネイティブの委託ツールを外し、仲介ツールだけにする。DSH は `BASE_SUBAGENT_TOOLS` を無効にし、CL は `--disallowedTools Agent`（`ab-runner.js` と同じ）を使う。

### 移行（旧 `subagentModels` / `subagentEfforts`）
旧キーは消さず、読み取り専用で残す。`migrateSettings` は冪等にする。

- DSH 行: ChatGPT のモデルがあればそれ、なければ Claude のモデルを採用する。両方設定済みの場合、片方は使われなくなるので CHANGELOG に明記する。
- CL 行: ChatGPT のモデルがあれば `{ target: 'dsh', model: そのモデル }`（今の `subagent_gpt` と同じ動き）、なければ同種。
- GP 行: 同種。
- `subagentsEnabled` は全体のスイッチとして残す。

### 仲介ツール（別種への委託と GP→GP）
- `server/subagent-bridge-mcp.js`: `gpt-subagent-mcp.js` を汎化する。`team-observer-mcp.js` と同じ方式で、親ごとの秘密値を付けて Agent Desk 本体に POST する。プロトコル処理は純関数にして単体試験できるようにする。
- `server/subagent-bridge.js`: 本体側の起動と管理。子の起動は既存の仕組みを使う。
  - DSH: `threads.create`（`preset` と同様の印を付け、仲介ツールを載せない）。
  - CL: `ClaudeRunner` と `abClaudeArgs`。起動前に `guardClaudeLaunch` を通し、課金確認が取れなければ起動しない。
  - GP: `codex.create`。`mcpServers` は空にする。
- 子は仲介ツールを持たない。深さ1の保証は、起動時のツール定義の除外と、本体側で「子から来た呼び出し」を拒否する二重にする。
- 子の権限は、元のタスクの権限を超えない。
- 毎回の呼び出しで `subagentsAllowed` を確認する（`gpt-subagent-mcp.js` と同じ）。
- dsh は MCP 呼び出しを60秒で打ち切るため、`mcp-timeout-patch.js` の `TIMEOUT_ENV` を使って延ばす。
- 結果は最終回答のほかに、実行先（接続先・モデル・推論）を必ず含める。利用上限で止まったときは、接続先と「同じ設定での再試行はしない」を明記したエラーを返す。
- ツール名は `subagent_` で始め、`mcp__…` 経由の名前も `subagent-policy-plugin.js` / `claude-usage.js` の判定に合わせる。

### 表示と使用量
- DSH→DSH は既存の `SubagentTracker`（dsh のログ読み取り）のまま。
- 仲介した子は、タスクプリセットの担当カードと同じ形で右パネルに出す。
- `usage.js` の `childSessionLogs` は dsh の子しか数えない。仲介した子の使用量（失敗した試行を含む）は、親のターンとは別に集計して合算する。

### 設定画面
- `ModelsSettings.tsx` の `Subagents()` を差し替える。3行（親 → 委託先）で、各行に種類チップ・モデル・推論レベルを置く。
- 最初は種類・モデル・推論をすべて `select` で選べる形にする。ドラッグは最後に足す。HTML5 DnD と、`select` での代替を両立する。
- 補助的な説明文は増やさない。

## 段階

各段階の最後に、既存テストと追加テストを実行して区切る。

0. **検証**（使い捨て。GPT は `gpt-6-luna`・`low`、Claude Code は `haiku`・`low`）
   - Claude Code の `--agents` と `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` が CL→CL の子のモデル・推論に効くか。効かなければ CL→CL は「親と同じ」固定にし、設定は別種のときだけ有効にする。（結果は「段階0の検証結果」。モデルは効き、推論レベルはフックで効かせた。）
   - Codex が MCP ツールを呼ぶときの承認の挙動と、`tool_timeout_sec`、キャンセル。
   - 仲介の MCP が長時間呼び出しで切れないか。
   - GPT / Claude 以外の接続先（DeepSeek、OpenCode Go、Command Code、ローカル LLM）が、子の dsh で動くか。ローカル LLM のサーバーが止まっているときに、子の失敗が親へ明示的に返るか。
1. **設定モデルと移行**（挙動は変えない）: `subagentRoutes`、検証、移行、`select` だけの設定画面。DSH / CL の既存挙動が同じであることをテストで固定する。
2. **仲介ブリッジ**: MCP とサーバー側。まず CL→DSH（今の `subagent_gpt` の置き換え）で既存と同じ動きを確認する。
3. **親ごとの組み込み**: DSH（`dsh-config.js` の `homePatch`、`mcp-servers.js`）、CL（`terminals.js` の `#writeTaskMcp`）、GP（`codex-runner.js` の `mcpServers`）の順。GP→GP は GP タスクにツール定義が毎回載るので、それを docs と CHANGELOG に書く。
4. **表示と使用量**: カード、集計。
5. **ドラッグ操作**。
6. **ドキュメント**: `docs/features.md` のサブエージェント節、`docs/codex.md`、`docs/usage.md`、CHANGELOG。

## テスト
- モデルを使わないもの: 設定の検証と移行、ブリッジの純関数、3×3 の経路をモック子で通す試験、深さ1の拒否、権限、`subagentsEnabled` オフ、`SubagentTracker` の対応付けが仲介の呼び出しで乱れないこと、UI。
- 実モデルの煙試験（`scripts/smoke-task-presets.mjs` と同形式）: 利用枠を使う。モデルと推論を明示して実行する。

## やらないこと
- **自動フォールバック。** 次の2点を確認できていない。
  - GP の子と dsh の子が、利用上限を確実に判定できるか。
  - 同種の子（DSH→DSH、CL→CL）はネイティブの委託ツールが起動するため、Agent Desk がやり直させられない。
  - 初版は「上限の明示エラー」と「実行先の記録」まで。`docs/usage-fallback.md` の対象外の記述はそのまま正しい。
  - 後から足す場合は、既存の共通フォールバック一覧を再利用する。設定の形式は変わらない。
- 孫への再委託、1つの親に複数種の委託先、`workflow` ツール。

## 着手前に確認すること
1. 別種を選んだ行で、その親のネイティブの委託ツールを外してよいか。CL では組み込みの Explore / Plan などの Agent が使えなくなる。
2. DSH で Claude と ChatGPT の両方を設定済みの既存ユーザーに、ChatGPT を残す移行でよいか。
3. GP→GP を初期でオンにしてよいか（既存の GP タスクにツール定義が追加される）。

## 実装結果

### 着手前に確認すること（採用した答え）
1. 別種を選んだ行は、その親のネイティブの委託ツールを外す。ただしモデルを選ぶまでは外さない（ドラッグだけで委託手段がなくなるのを防ぐ）。
2. 移行は ChatGPT を残す。課金先を黙って変えないため。
3. GP→GP は初期でオン。GP の行は常に仲介ツールを載せる。（当初は「GP は組み込みの委託ツールを持たない」と考えたが誤りだった。下の「Codex 自身のサブエージェント」を参照。）

### 段階0の検証結果（GPT は `gpt-6-luna`・`low`、Claude Code は `haiku`・`low`）
- CL→CL: `CLAUDE_CODE_SUBAGENT_MODEL` と `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` で、組み込みエージェント全部のモデルを強制できた。推論レベルは、当初「親と同じ」と考えて設定画面から外したが誤りだった。モックの API で子のリクエストを見ると、親が `--effort high` でも、モデルを強制した子はそのモデルの既定（Sonnet 5.5 なら `xhigh`）で動く。そこで PreToolUse フック（`Agent|Task`）が `updatedInput` に `effort` を足して渡す（`server/subagent-effort-hook.js`）。低（`low`）・最大（`max`）を指定して子の `output_config.effort` がそのとおりになること、未指定ならフックは何も返さず既定のままになることを確認した。親のレベルは変わらない。
  - 採らなかった案: `--agents` の `effort` は、同名の組み込みエージェントを上書きしてプロンプトごと差し替えてしまう。`CLAUDE_CODE_EFFORT_LEVEL` は親も含めて全部に効くので使えない。
- Codex の MCP 呼び出し: ワークスペース編集モードでは `mcpServer/elicitation/request`（`codex_approval_kind: mcp_tool_call`）で承認を求めてくる。`CodexRunner` は未知の要求を拒否するため、そのままだと「user rejected MCP tool call」で失敗した。仲介ツールのサーバー名だけを自動承認する `trustedMcp` を足して解決した（他の MCP と、AB・子の記録は従来どおり拒否）。`tool_timeout_sec` は設定として受け付けられ、ツールが使えることを確認した。
- 長時間の呼び出し: 本体への HTTP は 15 秒ごとの空行で保ち、dsh は `TIMEOUT_ENV` を延ばす。実際に何時間も動かす試験はしていない。
- 実モデルでの通し確認（Agent Desk を起動せず、スクリプトで）: DSH→Claude Code（haiku）、GP→DSH（luna）、Claude Code→GP（`claude -p` から MCP ツールを呼ぶ）、GP→GP（Codex から MCP ツール）、DSH→GP（dsh のセッションから MCP ツール）。いずれも `Ran on:` 付きで答えが返った。
- 未確認: DeepSeek・OpenCode Go・Command Code・ローカル LLM を子の dsh で動かすこと（接続情報がないため）。Claude Code の対話画面で、仲介ツールを承認する操作。

### 計画からの変更
- 仲介の子は、DSH をスレッドとして作らず、ヘッドレスの dsh（`subagent-dsh.js`）を直接起動する。親ごとの層は `dshChildPatch`（`gptSubagentPatch` の後継）。
- 子のセッション（Claude Code は専用の `ClaudeRunner`、Codex は `subagent` 印つきの記録）はタスク一覧・通知に出さず、完了後に削除する。起動時に残りを掃除する。
- 子が使う Claude Code の権限: Claude Code にはサンドボックスがないので、子はフルアクセスか読み取り専用の親からだけ起動する。Claude Code の親は、仲介ツールの承認を Claude Code に任せるので、フルアクセス扱い。
- チームの GPT リーダーが GPT 以外のサブエージェントを起動したら止める。従来の「Claude だけ」の判定を、固定ツールが増えたため広げた。

### Codex 自身のサブエージェント
- 実際の GP タスクで「サブエージェントを呼んでみて」と頼むと、モデルは仲介ツールではなく Codex 自身の `spawn_agent`（`subAgentActivity`・`collabAgentToolCall`）を使い、設定の委託先（例: GP→DSH の DeepSeek）が無視された。右パネルにも何も出ない。
- Codex 0.167.0 は、アプリサーバーの起動引数とスレッド設定の両方で `features.multi_agent=false` にしても、gpt-6 系のモデルのメタデータ（`multiAgentVersion`）に従って `collaboration.spawn_agent` などをツール定義（`additional_tools`）に入れる。`features.multi_agent_v2=false`、`agents.max_depth=0`、`features.multi_agent_v2.enabled=false` も効かなかった（`gpt-6-luna`・`low`）。
- 採用: 仲介ツールをマウントした GP タスクの開発者向け指示に、Codex 自身のサブエージェントを使わず `exec` から `tools.mcp__agent_desk_subagent__subagent({ prompt })` を呼ぶことを毎回加える（`CODEX_BRIDGE_GUIDANCE`、`CodexRunner` の `mcpGuidance`）。同じ依頼で仲介ツールが呼ばれ、カードが出ることを確認した。
- 代替案: モデルカタログを差し替えて `multiAgentVersion` を外す（Codex の更新ごとに壊れやすい）、`spawn_agent` の開始を検知して中断する（モデルへ理由を返せない）。どちらも採らなかった。
- 限界: 指示による誘導で、強制ではない。サブエージェントをオフにした設定（仲介ツールが載らない）の GP タスクでは、Codex 自身のサブエージェントが使えるまま。

### 右パネルのカード（段階4の表示）
- 当初は dsh のログを読む既存のパネル（`SubagentTracker`）に頼る想定だったが、仲介した子は dsh のセッションではない（Claude Code・Codex の子はそもそもログが別）うえ、パネル自体が DSH の画面にしかなかった。そこで `SubagentBridge` が子ごとに同じ形のカードを持ち、`change` を `subagent` フレームとして親タスクの id で配信する。`subagents.list` は DSH タスクのログ由来の子に、仲介した子を足して返す。DSH・GP・Claude Code のどの画面も同じパネルを使う。
- Claude Code と Codex の子は、ランナーの `turn` イベントの項目（ツール・回答・使用量）をそのまま映す。DSH の子はヘッドレスの dsh が標準出力に回答しか出さないため、終了時に回答を 1 件入れるだけにした。途中経過も見せるには、子の dsh のセッションログを探して読む必要がある（セッション id を呼び出し側が知る手段がない）。
- 一覧はメモリ上で、親タスクごとに新しい 30 件まで。タスクの削除で消え、再起動でも消える。保存しない理由は、子のセッション自体を完了後に削除する設計で、パネルだけ残しても開き直せる情報が回答と項目に限られるため。会話中のツール行からのリンクは、MCP の呼び出しに呼び出し id が付かないため付けていない。

### 未解決
- **使用量（段階4の残り）。** 親のターン別集計への合算は未実装。履歴の合計は dsh のセッションログを読むため、dsh の子は数えられるが、親のターンとは結びつかない。Claude Code と Codex の子が履歴にどう入るかは確認していない。
- **Codex のサンドボックスが使えない環境。** 検証した PC では、読み取り専用・ワークスペース編集のどちらでも Codex がコマンドを実行できず、ファイルを読めなかった（通常の GP タスクは承認カードを出す）。無人の子は承認を出せないので、親をフルアクセスにする必要がある。原因は未調査。
- 設定を変えた直後の、実行中の dsh タスクへの反映は、実行環境の更新後（既存と同じ）。
