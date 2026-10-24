# Agent Desk への貢献

Agent Desk に関心を持っていただき、ありがとうございます。

> English note: Agent Desk is developed mainly in Japanese. Issues and pull requests in Japanese or English are both fine. Please run the checks below before opening a PR. Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## 開発環境のセットアップ

必要なもの: Node.js 22.19 以上、または 24 以上（[必要なもの](README.md#必要なもの)）。

```sh
npm install        # 依存パッケージのインストール
npm run dev        # サーバーと Vite の開発サーバーを起動（表示された dev UI の URL を開く）
npm test           # 単体テスト（node --test）
npm run typecheck  # 画面側（web/）の型チェック
npm run build      # 画面のビルド
```

- `npm start` の前には `scripts/ensure-build.mjs` が走り、画面のソースが新しければ自動でビルドします。
- 動作確認でサーバーを起動するときは、`AGENT_DESK_HOME` に一時フォルダを指定してください。普段使いのデータフォルダを避けるためです（詳しくは [開発](docs/development.md) を参照）。

## コードスタイル

- ESM（`import` / `export`）で書きます（`package.json` は `"type": "module"`）。
- セミコロンは付けません。
- インデントは半角スペース 2 つです。
- 文字列はシングルクォートで囲みます。
- コメントは既存のコードの密度と言語に合わせてください。

迷ったら、近くの既存のファイルに合わせてください。`server/` と `scripts/` のファイルは、`test/syntax.test.js` で構文チェックされます。

## テスト

- テストは `test/` にあり、Node.js の組み込みテストランナー（`node --test`）で動きます。ファイル名は `*.test.js` です。
- 変更したら `npm test` を実行し、すべてのテストが通ることを確認してください。既存のテストを壊したまま PR を出さないでください。
- `steer-patch.test.js`、`retry-patch.test.js`、`goal-patch.test.js` などの `*-patch.test.js` は、dsh 本体の更新で独自フックが合わなくなると失敗します。失敗したときは dsh の版との互換性を確認してください（[更新](docs/updating.md) を参照）。
- 画面（`web/`）を変えたときは、`npm run typecheck` と `npm run build` も通してください。

## プルリクエストの流れ

1. 大きな変更は、先に Issue で相談してください。小さな修正は、そのまま PR で構いません。
2. リポジトリを fork し、`main` から作業ブランチを切ります。
3. 変更を加え、`npm test` と（画面を変えた場合は）`npm run typecheck`、`npm run build` を実行します。
4. PR を作成し、テンプレートの項目を埋めます。動作確認の手順と結果を書いてください。
5. メンテナーがレビューします。指摘を直すときは、同じブランチに追加のコミットを積んでください。

利用者向けの説明（機能や設定の変更など）を変えたときは、README と `docs/` も更新してください。

セキュリティに関わる問題は、Issue ではなく [SECURITY.md](SECURITY.md) の手順で報告してください。

## ライセンス

この PR で貢献するコードは、[MIT ライセンス](LICENSE) のもとで公開されることに同意したものとします。
