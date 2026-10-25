# 仕組みとデータの保存場所

[← README に戻る](../README.md)

## 仕組み

```
ブラウザ画面 (React)  ⇄ WebSocket ⇄  Agent Desk サーバー (Node)  ⇄ ACP (stdio) ⇄  dsh --profile acp
                                         │                                        │
                                         └─ タスク記録・設定                     └─ ツール・サンドボックス・セッション
```

- **サーバー（`server/`）:** `127.0.0.1` で待ち受けます。起動ごとのトークンと Origin の検査で、他の Web ページからの接続を拒否します。スマホからの接続をオンにしたときだけ、この PC の Tailscale のアドレスでも待ち受けます（`server/remote.js`）。
- **エンジン:** dsh を Agent Client Protocol のモードで子プロセスとして起動します。dsh は権限モードを起動時に固定するため、モードごとに1つずつ起動します。
- **モデル設定:** dsh のホーム設定に経路を書き込みます。`openai-codex` は保存済みモデル選択との互換性のための内部キーで、実際の GPT API は `openai-responses`、送信先は `https://api.openai.com/v1` です。専用の資格情報参照とリクエストhookが、Agent Deskの公式SIWC tokenだけを送信直前に注入・排他更新します。旧Codex grantは認証に使いません。`anthropic` は従来のAPIキー経路です。
- **画像・Codex利用上限:** bundled Codex 0.164.0 app-serverとstdio JSON-RPCで通信し、別のChatGPT managed sign-inを使います。専用 `codex-home` と空のcwdを持ち、ユーザーの `~/.codex` は使いません。
- **会話記録:** ACP はセッション再開時に履歴を返さないため、画面用の記録は Agent Desk が保存します。
- **出力速度:** `≈ … t/s` は本文・見える思考テキストの推定受信速度です。現行 DSH の ACP `chunk` は応答確定後の文章なので計測には使わず、所有するルート Agent の `agent/assistant-stream` を読み込み時フックで観測し、数値だけを ACP の拡張メタデータで渡します（インストール済みパッケージは変更しません）。チームの Claude Code 子は `--include-partial-messages` の差分を同じ計測器へ渡します。現在のモデル応答の平均を300ms間隔で更新します（速度更新だけではターン全体を再送せず、小さな専用イベントで送ります）。最初の塊を除いた推定トークン数を、最初の受信から現在までの時間で割り、応答内の無受信時間も含めます。実際の受信時刻の幅が1秒未満なら表示しません。ツール待ちは非表示、次の応答でリセットし、完了後は最後の応答の最終受信時刻で確定した平均だけを残します。最後が計測不能でも以前の応答の値を代用しません。隠れた思考やツール引数を含み得る課金トークン数で実測扱いに補正しません。一括応答・過去の履歴・通常の CL 端末には速度を捏造しません。
- **モデル一覧:** GPTは公式SIWCのアカウント別 `models[].slug/display_name/visibility` と能力情報を使います。未接続時の既定値・他providerの定義はpi-ai/`server/catalog-extras.json`/更新カタログを元にし、追加分を含むモデル定義をアプリ所有のDSHホーム設定に書きます。node_modulesのカタログJSONを起動時に書き換える方式は廃止しました。アカウント切替時は別アカウントのキャッシュを使わず、未提供の旧モデルは再選択が必要です。

OpenCode Go は提供中のIDを `/inference/go/v1/models` から取得し、pi-aiの定義と照合します。定義が足りない場合は [OpenCode の構造化カタログ](https://models.opencode.ai/api.json)から、IDが完全一致し、通信方式・接続先・トークン上限などを検証できるものだけ補完します。モデル名や `-free` の有無から別IDを推測しません。補完定義は `opencode-go-definitions.json` に保存し、取得失敗時は直近の有効な定義を保持します。未対応IDや定義取得の失敗が残るときは更新画面に警告を出し、同期完了のチェックを付けません。

設定更新の確定順序・更新経路と保証しないリソース境界は [設定更新の整合性](settings-consistency.md) を参照してください。

## データの保存場所

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\AgentDesk` |
| macOS | `~/Library/Application Support/AgentDesk` |
| Linux | `~/.config/agent-desk` |

環境変数 `AGENT_DESK_HOME` で変更できます。中の `dsh-home` が dsh 専用のホームなので、普段使いの `~/.dsh` には触れません。
API キーと公式 SIWC の登録・トークンは `dsh-home/.credentials.yaml` に保存されます。Codex app-serverの認証・設定・画像ターンは別の `codex-home` 内です。両方の資格情報を相互に転用しません。GPTモデルの能力は公式SIWCカタログから選択したフィールドだけを保存し、モデルが返すCodexのinstructions等をAgent Deskの指示として採用しません。

## 読み取るデータと保存するデータ

- **Claude Code の認証:** Claude Code のサインイントークンを抽出・保存・送信しません。ログインは Claude Code 自身が管理します。チームのリーダーと子も通常の認証環境・設定を引き継ぎ、本人の API キーやクラウド認証をサブスクリプション専用のフィルターで除去・拒否しません。Agent Desk に登録した API キーを Claude Code に自動で転用しません。
- **チームの認証状態と課金同意:** 開始画面・チーム設定の `claude auth status` はモデルを呼びません。サーバーはその結果から必要な認証方式だけを取り出し、トークン・メールアドレス・組織などのアカウント情報を除いた説明を画面に返します。生の認証状態出力やアカウント情報は保存せず、確認した認証方式と明示的な課金同意だけを保存します。同意は認証方式ごとで、同じ方式ならほかのチーム・フォルダにも使われます。リーダー・子の CLI 起動・再開と子の各ターンの前に再検査し、方式の変更では再同意を求めます。不明な方式では別の明示的なリスク同意も必要で、ログアウト状態は実行を拒否します。通常の CL タスクにはこのチーム用の確認を追加しません。
- **チームの実行方式と互換性:** Claude（API）の子は dsh で動き、Claude Code とは実行方式・履歴を分離します。既存のチームの選択・モデル・履歴はそのまま残し、自動移行・有効化・フォールバックは行いません。
- **Claude Code（CL）の会話:** 画面に表示し、再開するために、Claude Code が自分で保存した会話記録（`~/.claude/projects` の中）を読みます。この PC の中だけで扱い、書き換えません。作業中の表示が終わらないときのために、Claude Code が自分の状態（作業中か待機中か）を書く `~/.claude/sessions` のファイルも、その確認のためだけに読みます。
- **チームの Claude の子:** 起動した `claude -p` の出力（返答・ツールの実行と結果・利用上限の情報）を読み、直近60ターンぶんを、データフォルダの `team-agents/` に保存します。
- **Agent Desk 自身の通信先:** OpenAI（ChatGPT・Codex のサインインと利用）、DeepSeek・Anthropic・OpenCode Go の API（それぞれの API キーを登録して使うときや、キーの確認・料金の取得）です。OpenCode Go のモデル定義補完では `models.opencode.ai` の公開JSONも取得しますが、APIキー・会話・プロンプトは送信しません。Claude Code の通信は Claude Code 自身が行います。
- **スマホから使う設定:** 有効にすると、会話の内容は Tailscale 経由で、あなたの端末に表示されます。
- **保存先:** 上の表のデータフォルダだけです。リポジトリ（ソースコード）の中には保存しません。`AGENT_DESK_HOME` をリポジトリの中に向けた場合に備えて、`.gitignore` でデータフォルダの中身を除外しています。
