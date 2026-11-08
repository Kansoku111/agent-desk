# PTCのデータ入力

[← 機能一覧](features.md)

TypeScriptのPTCでは、`run_code`の必須引数は従来どおり `code` と `description` です。任意の `data` にJSONを渡すと、プログラムから `await input.get()` で取得できます。トップレベルのツールは `run_code` 1個のままです。

## 長文ソースをコード文字列に埋めない

ファイル内容をJavaScriptの文字列やテンプレートリテラルに埋め込むと、引用符・バックスラッシュ・`${...}`などを二重に扱う必要があります。`data` に置くことで、ファイル内容はPTCプログラムのコンパイル対象から分離されます。

モデルには必須の `code`・`description` を先に、その後に任意の `data` を提示します。必須項目がない呼び出しは従来どおり拒否します。`data` だけを先に送り、次の呼び出しで実行する使い方はできません。

以下は標準のTypeScript関数本体形式の例です。対象ファイルを `read` で確認した後に編集します。編集前後の文面も `data` に置きます。

```json
{
  "code": "return await tools.edit(await input.get());",
  "description": "Edit a file from literal data",
  "data": {
    "file_path": "src/example.txt",
    "old_string": "old text",
    "new_string": "new text"
  }
}
```

ファイル作成と進捗更新も1回の `run_code` にまとめられます。`todos` には現在の全リストを渡し、まだ実行していない検証を完了扱いにしません。

```json
{
  "code": "const {files,todos} = await input.get(); for (const file of files) await tools.write(file); return await tools.todo_write({todos});",
  "description": "Write files and update the current task list",
  "data": {
    "files": [
      {
        "file_path": "src/example.cjs",
        "content": "const name = 'world';\nconsole.log(`hello ${name}`);\n"
      }
    ],
    "todos": [
      {
        "content": "Implement changes",
        "status": "in_progress"
      },
      {
        "content": "Verify changes",
        "status": "pending"
      }
    ]
  }
}
```

- `data` は文字列・配列・オブジェクト・数値・真偽値・nullを渡せます。関数、undefined、非有限数、循環参照など、情報を保ったJSONでない値は拒否します。
- 取得は引数なしの `input.get()` を使います。既存の `input.get({})` と空配列の `input.get([])` も受け付けます。返される値はその呼び出しのスナップショットです。`data` を指定しない呼び出しには、この取得用の `input` は提供されません。`input` はデータ入力の名前なので、`data` を使うプログラム内で同名を宣言しないでください。
- 書き込みや編集は従来の `tools.write` / `tools.edit` で行います。既存の入力検証・読み取り専用・サンドボックス・承認は変わりません。
- データも実行詳細・引数の記録へ残ります。認証情報を隠すための機能ではありません。
- `data` なしの既存プログラムとPythonのAPIは変更しません。壊れたプログラムを推測で補正・再実行する機能ではありません。

PTC用の案内でこの方式を推奨しますが、モデルが必ず選ぶ保証や、生成ミスが完全になくなる保証はありません。

## 最初の作業先と管理操作

PTCはセッションの作業ディレクトリで始まります。依頼に別の作業先がある場合、引き継いだ現在位置を探索するのではなく、指定先に一度移動して初回の確認をまとめるよう案内します。アプリが自由文からパスを推測して、自動で作業先や権限の範囲を変えることはしません。

```ts
await tools.working_directory({ cd: "依頼された作業フォルダー" });
const files = await tools.glob({ path: ".", pattern: "src/*.ts" });
console.log(files);
```

`tools` の呼び出しにはJSONの引数オブジェクトが必要です。現在位置の取得は `tools.working_directory({})` とし、引数を省略しません。計画・進捗だけの `todo_write` は、可能なら実作業と同じ `run_code` にまとめます。

## 反映と制約

### 公開APIと内部フックの境界

| 対象 | Agent Desk側の実装 | dshとの接続 |
|---|---|---|
| バッチ案内・完成形例 | [`ptc-guidance.js`](../server/ptc-guidance.js) の `withPtcGuidance` | 公開 `ToolExecutor.sections` API。SDKの案内文は置換しない |
| `run_code.data`・入力バインディング・SDK型の軽量化 | [`ptc-sdk-patch.js`](../server/ptc-sdk-patch.js)、[`ptc-data.js`](../server/ptc-data.js) | PTC実行器の内部ソースへの互換フック |
| 引数なしの `input.get()`・構文エラーの診断 | [`ptc-runtime-patch.js`](../server/ptc-runtime-patch.js) | Node実行基盤とワーカーへの互換フック |
| ツール結果の軽量化 | [`ptc-results-patch.js`](../server/ptc-results-patch.js) | PTCの結果変換への互換フック |
| PTC切替・内部ツール履歴のACP連携 | [`ptc-patch.js`](../server/ptc-patch.js)、[`ptc-bridge.js`](../server/ptc-bridge.js) | ACP内部への互換フックと公開実行器API |

案内はAgent DeskがPTCを選択した実行器に結び付け、`agent-desk:ptc-guidance` 節として追加します。全セッション共通の固定文面にしないのは、nativeモードや別セッションへの混入を避けるためです。

- 案内はTypeScriptのみ。完成形例は標準の関数本体形式のみです。
- 各ステップに公開されるツールに合わせ、`edit` があれば編集例、`write` と `todo_write` があれば作成・進捗例を表示します。例の表示自体は実行許可を与えません。
- PTC解除時には案内も外します。スキーマと実行は元の実行器へ委譲し、既存の入力検証・権限制限は維持します。

案内の文言変更にはdshソースの追従修正は不要ですが、公開APIの破壊変更には対応が必要です。`data` などの実行機能には内部依存が残り、すべての互換フックを除去したわけではありません。

### 更新・反映時の確認

フックは起動時のロード処理で適用し、インストール済みのdshファイルを直接上書きしません。変更したコードの反映にはアプリの再起動が必要です。依存更新の手順は[更新手順のdsh節](updating.md#dsh)に集約します。

更新時には、次の契約を保ちます。

1. 案内が重複せず届き、nativeモード・別セッションへ混入しない。モード切替とセッション再開後も同じ条件で表示される。
2. `data` の取得・編集が実行でき、同じ呼び出しに添付されていないデータを暗黙に持ち越さない。
3. 読み取り専用・サンドボックス・承認の境界を維持する。案内やデータ入力で権限を広げない。
4. 残る内部フックについて、対象ソース・構文・実際のロード結果が互換チェックに一致する。

通常起動では、一部のホスト側フックは不一致を警告して元のdsh処理へ戻ります。一方、PTCワーカーの入力フックには不一致をエラーにする経路もあります。**「起動できた」だけでは改善機能の維持を確認できません。** 更新時の互換チェックは不一致を失敗にするため、検証に失敗した版をそのまま採用せず、フックを追従修正するか更新を見送ります。

ローカル回帰は実行契約の確認です。モデルが `data` を選ぶ頻度や速度の効果は、条件をそろえた別の実モデル評価で扱います。試行条件・結果は検証レポートに残し、一時的な秒数や成功件数を恒久的な仕様にはしません。

この変更はモデル・推論レベル・認証経路を変更しません。依頼達成の自動判定や無条件の自動継続も行いません。チームの成果確認は[報告の中身](team.md)を参照してください。
