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

`scripts/probe-acp.mjs` は、dsh の ACP 応答を直接確かめるための診断用スクリプトです。`scripts/check-dsh.mjs` は、dsh を更新したあとの動作確認スクリプトです（`node scripts/check-dsh.mjs`、[dsh と Codex の更新](updating.md) を参照）。
