# サブエージェント委託先の再設計

状態: 計画（未実装）。実装前に、末尾の「着手前に確認すること」を決める。

## 背景と決定

今の設定は委託先の系列（Claude / ChatGPT）をキーにしていて、呼び出し元のタスク種別（DSH / CL / GP）では分けられない。委託の経路も揃っていない。

| 親＼子 | DSH | CL | GP |
|---|---|---|---|
| DSH | ○ `subagent` / `subagent_claude` / `subagent_gpt` | × | × |
| CL | ○ `subagent_gpt`（GPT のみ、`gpt-subagent-mcp.js`） | △ Claude Code 組み込み（モデル・推論は指定していない） | × |
| GP | × | × | × Codex の `multi_agent` を無効にしている（`codex-runner.js`、`docs/codex.md`） |

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
   - Claude Code の `--agents` と `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` が CL→CL の子のモデル・推論に効くか。効かなければ CL→CL は「親と同じ」固定にし、設定は別種のときだけ有効にする。
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
