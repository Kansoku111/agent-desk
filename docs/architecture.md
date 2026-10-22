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
- **画像・Codex利用上限:** bundled Codex 0.163.0 app-serverとstdio JSON-RPCで通信し、別のChatGPT managed sign-inを使います。専用 `codex-home` と空のcwdを持ち、ユーザーの `~/.codex` は使いません。
- **会話記録:** ACP はセッション再開時に履歴を返さないため、画面用の記録は Agent Desk が保存します。
- **モデル一覧:** GPTは公式SIWCのアカウント別 `models[].slug/display_name/visibility` と能力情報を使います。未接続時の既定値・他providerの定義はpi-ai/`server/catalog-extras.json`/更新カタログを元にし、追加分を含むモデル定義をアプリ所有のDSHホーム設定に書きます。node_modulesのカタログJSONを起動時に書き換える方式は廃止しました。アカウント切替時は別アカウントのキャッシュを使わず、未提供の旧モデルは再選択が必要です。

## データの保存場所

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\AgentDesk` |
| macOS | `~/Library/Application Support/AgentDesk` |
| Linux | `~/.config/agent-desk` |

環境変数 `AGENT_DESK_HOME` で変更できます。中の `dsh-home` が dsh 専用のホームなので、普段使いの `~/.dsh` には触れません。
API キーと公式 SIWC の登録・トークンは `dsh-home/.credentials.yaml` に保存されます。Codex app-serverの認証・設定・画像ターンは別の `codex-home` 内です。両方の資格情報を相互に転用しません。GPTモデルの能力は公式SIWCカタログから選択したフィールドだけを保存し、モデルが返すCodexのinstructions等をAgent Deskの指示として採用しません。

## 読み取るデータと保存するデータ

- **Claude のログイン情報（トークン）:** 読み取りません。保存も送信もしません。Claude Code のログインは Claude Code 自身が管理します。Agent Desk がチームの Claude を起動する前に呼ぶ `claude auth status` は、ログインの種類（サブスクリプションか API キーか）を答えるだけで、モデルには何も頼みません。その答えにはメールアドレスや組織名も含まれますが、Agent Desk が見るのはログインの種類だけで、残りは保存しません。
- **Claude Code（CL）の会話:** 画面に表示し、再開するために、Claude Code が自分で保存した会話記録（`~/.claude/projects` の中）を読みます。この PC の中だけで扱い、書き換えません。
- **チームの Claude の子:** 起動した `claude -p` の出力（返答・ツールの実行と結果・利用上限の情報）を読み、直近60ターンぶんを、データフォルダの `team-agents/` に保存します。
- **Agent Desk 自身の通信先:** OpenAI（ChatGPT・Codex のサインインと利用）、DeepSeek と Anthropic の API（それぞれの API キーを登録して使うときや、キーの確認・料金の取得）です。Claude Code の通信は Claude Code 自身が行います。
- **スマホから使う設定:** 有効にすると、会話の内容は Tailscale 経由で、あなたの端末に表示されます。
- **保存先:** 上の表のデータフォルダだけです。リポジトリ（ソースコード）の中には保存しません。`AGENT_DESK_HOME` をリポジトリの中に向けた場合に備えて、`.gitignore` でデータフォルダの中身を除外しています。
