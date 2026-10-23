# dsh と Codex の更新

[← README に戻る](../README.md)

「設定 → 情報 → 更新」は、起動時と6時間ごとに新しい版を確認します。dsh と同梱の Codex は `package.json` で版を固定しているため、アプリは自分で入れ替えません。新しい版があると「指示をコピー」が出ます。コピーした指示を、このリポジトリで作業する AI エージェントに渡してください。指示には版・リポジトリ・リリースノートだけが書かれていて、手順はこのファイルを参照します。Claude Code は「更新」ボタンで `claude update` を実行します。

以下は、指示を受けたエージェント向けの手順です。

## 共通

- 指示に書かれた版に上げます。作業中に、それより新しい版が出ていても上げません。
- 始める前に `git status` を見て、自分の変更と元からある変更を区別できるようにします。
- 互換性の問題で進められない場合は、自分の変更をすべて戻して `npm ci` し、原因と、該当するリリースノートの箇所を報告します。
- 終わったら `npm test`、`npm run typecheck`、`npm run build` を通し、`CHANGELOG.md` の `[Unreleased]` に一行追加してコミットします。
- 版番号が書かれているドキュメントは、古い版の文字列で検索して直します（`README.md`、`README.en.md`、`SECURITY.md`、`THIRD_PARTY_NOTICES.md`、`docs/` など）。

## dsh

`@deepseek-ai/dsh` と `@deepseek-ai/dsh-atomic-write` は、必ず同じ版にします。

1. リリースノートで、ACP・モデル定義（pi-ai）・設定ファイルの形式に関わる変更を確認します。
2. `npm install --save-exact --no-audit --no-fund @deepseek-ai/dsh@<版> @deepseek-ai/dsh-atomic-write@<版>`
3. `node --test test/*-patch.test.js test/dsh-compatibility.test.js` を実行します。Agent Desk は dsh のソースに独自のフック（`server/*-patch.js`）を当てています。上流のコードが変わると、ここが失敗します。パッチの正規表現を新しいソースに合わせてください。フックの目的は各 `*-patch.js` の冒頭のコメントにあります。
4. `node scripts/check-dsh.mjs` で、新しい dsh が実際に起動し、セッションを作ってモデルを選べることを確かめます。最後の行に `"ok":true` が出れば成功です。
5. 「共通」の確認とコミットをします。

## Codex

1. `package.json` の `@openai/codex` と、`server/codex-app-server.js` の `CODEX_VERSION` を同じ版にします。
2. `npm install --save-exact --no-audit --no-fund @openai/codex@<版>`
3. リリースノートで、app-server の JSON-RPC（`server/codex-client.js`、`server/codex-app-server.js`）、画像生成（`server/imagegen.js`）、利用上限（`server/chatgpt-usage.js`）に関わる変更を確認し、必要なら合わせます。
4. `node --test test/codex-*.test.js test/imagegen.test.js test/chatgpt-usage.test.js` を実行します。
5. 「共通」の確認とコミットをします。

## 更新のあと

新しい版は、Agent Desk を起動し直すと使われます。
