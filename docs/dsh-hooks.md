# dsh への読み込み時フック

[← README に戻る](../README.md)

Agent Desk は dsh（と dsh が使う pi-ai）の挙動の一部を、インストール済みのファイルを書き換えずに変えています。Node.js の読み込み時フック（`registerHooks` の `load`）で、対象のファイルが読み込まれる瞬間にだけ、ソースの決まった箇所を差し替えます。`node_modules` を直接書き換えると更新や再インストールで消えるため、変更は Agent Desk のコード側に置いています。

dsh の版を上げる手順そのものは[更新](updating.md#dsh)にあります。このページは、フックの一覧と、合わなくなったときの直し方・判断の基準です。

## 仕組み

- 一覧は `server/dsh-compatibility.js` の `HOOKS` です。dsh を起動するとき（`server/runtime.js`、`server/subagent-dsh.js`）、この順に `server/<名前>-hook.js` を `--import` で読み込みます。
- 多くのフックは2つのファイルに分かれています。`<名前>-hook.js` は対象ファイルの判定（`TARGET` の正規表現）と読み込み時の差し替え、`*-patch.js` は差し替えの中身です。patch は決まった文字列（アンカー）がちょうど1回現れるときだけ置き換え、そうでなければ `null` を返します。
- 通常の起動で置き換えが当たらないときは、警告を出して元の dsh のまま動きます（PTC ワーカーの入力フックなど、一部は失敗にします）。**起動できたことは、フックが効いていることの確認になりません。**
- 更新時の検査（`verifyDshCompatibility`、`scripts/check-dsh.mjs` から呼ばれます）は、すべての patch が新しいソースに当たること、置き換え後の構文、実際のフックを通した読み込み結果が一致することを確かめ、ひとつでも合わなければ失敗にします。

## 一覧

| フック | 書き換え先 | 目的 | 主なテスト |
|---|---|---|---|
| `fast-mode` | pi-ai `dist/api/` の3つの API | Claude の高速モード（`speed: "fast"`）をリクエスト本文に足す。Anthropic のサーバー側フォールバック（`allowedFallbackModels`）を外す | `fast-mode.test.js` |
| `opencode-catalog` | pi-ai の OpenCode Go モデル一覧（JSON） | Agent Desk が検証した追加分をメモリ上で足す | `opencode-go-catalog.test.js` |
| `steer` | `dsh-acp` | 実行中のターンにメッセージを追加する（ACP は2つ目の `session/prompt` を拒否するため） | `steer-patch.test.js` |
| `acp-image` | `dsh-acp` | 数MBの画像添付の検証で JavaScript のスタック上限に達しないようにする。画像データの検証は維持する | `acp-image-patch.test.js`、`command-code-runtime.test.js`（アップロードから模擬APIまで） |
| `mcp-image` | `dsh-mcp-client` | MCP ツールが返す数MBの画像も、同じ検証エラーでテキストに置き換わらないようにする | `mcp-image-patch.test.js` |
| `retry` | `dsh-llm-pi-ai` | pi-ai が一時的と判断するエラーと、ストリームの無通信タイムアウトを dsh の再試行に回す | `retry-patch.test.js`、`retry-hook.test.js` |
| `context-overflow` | `dsh-llm-pi-ai` | 文脈サイズを選べる ChatGPT／Claude 経路で、ローカルの予算を超えただけの正常な応答を超過エラーにしない | `context-overflow-patch.test.js` |
| `reasoning-usage` | `dsh-llm-pi-ai` | pi-ai が報告した推論トークン数を使用量に引き継ぐ | `reasoning-usage-patch.test.js` |
| `compaction` | `dsh-compaction-basic` | 巨大な先頭メッセージで要約範囲が作れないときに保持量を減らして要約する。要約に直前の推論レベルを渡す | `compaction-patch.test.js` |
| `goal` | `dsh-acp` | goal の自動継続中は `session/prompt` を終わらせない（作業中の表示と停止ボタンを保つ） | `goal-patch.test.js` |
| `goal-wait` | `dsh-goal-round-driver` | 自動継続を止めている間（チームの親が外部の作業を待つときなど）は、次のラウンドを始めない | `goal-driver-wait.test.js` |
| `goal-tool` | `dsh-tool-goal` | `create_goal` を出さない（goal は `/goal` でだけ始める）。`update_goal` の引数説明を補う | `goal-tool-patch.test.js` |
| `mcp-timeout` | `dsh-acp` | Agent Desk が載せる MCP サーバーごとに呼び出しの時間制限を設定できるようにする（画像生成が60秒で切れないように） | `mcp-timeout-patch.test.js` |
| `mcp-startup` | `dsh-acp` | 組み込みの MCP（chrome・desktop・history・imagegen）だけを並列に起動する | `mcp-startup.test.js` |
| `output-speed` | `dsh-acp` | 出力速度の表示のため、モデルの応答ストリームを観測する | `dsh-compatibility.test.js` |
| `ptc` | `dsh-acp` | PTC の切り替えとチーム単位のパーソナライズオンオフ、プログラム内のツール呼び出し履歴を ACP に出す | `ptc.test.js`、`team-personalize.test.js` |
| `ptc-errors` | `dsh-ptc-runtime-node`（`index.js`・`process.js`） | 型の除去と構文エラーの診断、ワーカーへの `input.get()` の受け渡し | `ptc-diagnostics.test.js` |
| `ptc-sdk` | `dsh-tool-executor-ptc` | `run_code.data`、SDK の型宣言の共有化、結果の描画 | `ptc-sdk.test.js` |
| `ptc-results` | `dsh-tool-executor-ptc` | `edit`・`write`・`apply_patch` の結果からファイル全文を外し、`read` の行の表示を短くする | `ptc-results.test.js` |
| `fs-search` | `dsh-tool-fs-search` | 大きな検索出力を打ち切り、部分結果として返す | `fs-search-patch.test.js` |
| `fs-read` | `dsh-tool-fs` | `read` の `limit` の説明に上限を明記する | `fs-read-patch.test.js` |

どのフックも `test/dsh-compatibility.test.js` で、更新時の検査が合わないソースを拒否することを確かめています。理由と経緯の詳細は各 `*-patch.js`（`fast-mode` は `fast-mode.js`、`opencode-catalog` は `opencode-go-catalog.js`）の冒頭コメントにあります。PTC 関係の公開 API との境目は [PTC の「反映と制約」](ptc.md#反映と制約)を見てください。

### フックごとの補足

- **`fs-search`:** 検索出力を最大1 MiB・glob 1,000行／grep 5,000レコードで打ち切り、完全な行だけを部分結果として返します。部分結果では総件数を断定せず、全件リストとして保存しません。通常の検索・全件リストの保存と、本当のエラー・キャンセルの扱いは維持します。glob の更新日時順は維持するため、結果収集の打ち切りであり、ディレクトリ走査時間そのものを保証する上限ではありません。
- **`fs-read`:** 説明に「既定値が受け付ける最大値でもある」と書き足すだけです。上限と検査は dsh のままです。
- **`goal-tool`:** `update_goal` の未使用の項目は省略し、全項目が必要な経路では `objective: ""`・`max_goal_rounds: 0`・`blocked_reason: ""` を使うよう案内します。0.2.1-rc.5 までは、`edit` 以外で渡された不要な項目を dsh が拒否し、このフックがエラー文を「問題の項目と修正した呼び出し例」に書き換えていました。0.2.2-rc.1 以降は dsh が不要な項目を無視するため、エラー文の書き換えはしません（`test/goal-tool-patch.test.js` が、無視されることを確かめます。再び拒否されるようになったら、そのテストが失敗します）。権限・リビジョン・停止条件の検証は変更しません。
- **`retry`:** pi-ai の一時的エラー分類は、dsh が実際に読み込んだ `dsh-llm-pi-ai` 配下の pi-ai のものを使います（アプリ直下の別の版は使いません）。タイムアウトの上限や中止操作は変えず、再試行の上限に達するとエラーにします。再試行の分だけ待ち時間が延び、プロバイダーによっては追加の利用量が発生することがあります。`test/interrupted-usage-runtime.test.js` で模擬サーバーによる実行を確認します。
- **`reasoning-usage`:** 欠落とゼロを区別できない値は記録せず、出力総数や料金には加算しません。`test/reasoning-usage-runtime.test.js` でも確認します。
- **`compaction`・`context-overflow`:** API が返した超過エラーと出力ゼロの長さ制限は維持します。`test/context-compaction-runtime.test.js` でも確認します。

## 合わなくなったときの直し方

1. **どのフックが合わないかを特定する。** 互換性テストは最初に合わなかったものしか報告しません。新しい版をインストールした場所で、`HOOKS` の順に各 patch を新しいソースへ当て、当たる／当たらないを1本ずつ確かめると早く分かります。新しい版を入れたフォルダーを `verifyDshCompatibility({ root })` に渡せば、作業ツリーを作らずに数秒で全体の合否が分かります。
2. **旧版と新版の対象ファイルを比べる。** dsh のリリースノートは取得できないことがあります。インストール済みの旧版と新版の `lib/index.js` を差分で比べ、アンカーの周りで何が変わったかを読みます。
3. **下の「判断の基準」でどう直すかを決める。**
4. 直したら `node --test test/*-patch.test.js test/dsh-compatibility.test.js`、続けて[更新](updating.md#dsh)の残りの手順（`scripts/check-dsh.mjs`、全テスト）を通します。

## 判断の基準

上から順に検討します。

1. **dsh に公開 API ができた:** フックをやめて公開 API に移します。例：PTC の案内は、ソースの置き換えではなく公開の `ToolExecutor.sections` で足しています。
2. **dsh 側で同じ問題が直った:** フックの該当部分を外します。上流の挙動はテストで固定し、元に戻ったら気づけるようにします。例：0.2.2-rc.1 で dsh が `update_goal` の不要な項目を拒否しなくなったため、`goal-tool` のエラー文の書き換えを外し、無視されることをテストで確かめています。
3. **処理が別のパッケージ・関数へ移った:** `TARGET` の正規表現、`resolveCompatibilityModules` の解決先と入口ファイルの確認、`test/dsh-compatibility.test.js` の仮のパッケージを、移った先に合わせます。例：0.2.2-rc.1 で PTC の SDK 描画が `dsh-tools` から `dsh-tool-executor-ptc` へ移りました（`ptc-sdk`）。
4. **文字列が少し変わっただけ:** アンカーを新しいソースに合わせます。そのとき、周りの処理の意味が変わっていないかを差分で確かめます。意味が変わっていれば、合わせるだけでは済みません。
5. **対応する処理がなくなった、または設計が大きく変わった:** そのフックが守っていた目的（一覧の「目的」と patch の冒頭コメント）が新しい dsh でも必要かを見直します。作り直せないまま更新すると、その機能がなくなったり挙動が変わったりします。その場合は更新を見送るか、機能を外してよいかを利用者に確認します。

PTC ワーカーの入力フックのように、対象がいくつかの箇所に分かれているものは、箇所の数が変わっても失敗するように作っています（`ptc-runtime-patch.js` の冒頭コメント）。新しい実行方式が増えたときなどに、人が確かめるためです。

## フックを足すとき

- まず dsh の公開 API や設定で実現できないかを確かめます。フックは最後の手段です。
- `<名前>-patch.js`（アンカーが1回だけ現れるときだけ置き換え、そうでなければ `null`）と `<名前>-hook.js`（対象の判定と、当たらないときの警告）に分けます。patch の冒頭に、なぜ必要か（測った事実や起きた不具合）と、何を変えないかを書きます。
- `server/dsh-compatibility.js` の `HOOKS` に足します。新しいパッケージが対象なら、`composeCompatibilityPatches` の引数、`resolveCompatibilityModules`（解決・入口ファイルの確認・戻り値）、`verifyActualHookChain` の対象、`verifyDshCompatibility` で読むソースにも足します。
- テストは `test/<名前>-patch.test.js`（置き換えの結果と、実際のフックを通した読み込み）を作り、`test/dsh-compatibility.test.js` の仮の構成・フックの順序・合成結果・上流の変更を拒否するテスト・実際のフックを観測するテストに加えます。
- この表に1行足し、`CHANGELOG.md` に書きます。
- 外せる条件（dsh 側の何が変われば要らなくなるか）が分かっていれば、patch の冒頭に書いておきます。
