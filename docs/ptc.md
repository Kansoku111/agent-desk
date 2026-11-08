# PTCのデータ入力

[← 機能一覧](features.md)

TypeScriptのPTCでは、`run_code`の必須引数は従来どおり `code` と `description` です。任意の `data` にJSONを渡すと、プログラムから `await input.get()` で取得できます。トップレベルのツールは `run_code` 1個のままです。

## 長文ソースをコード文字列に埋めない

ファイル内容をJavaScriptの文字列やテンプレートリテラルに埋め込むと、引用符・バックスラッシュ・`${...}`などを二重に扱う必要があります。`data` に置くことで、ファイル内容はPTCプログラムのコンパイル対象から分離されます。

モデルには必須の `code`・`description` を先に、その後に任意の `data` を提示します。必須項目がない呼び出しは従来どおり拒否します。`data` だけを先に送り、次の呼び出しで実行する使い方はできません。

対象ファイルを `read` で確認した後の編集例です。編集前後の文面も `data` に置きます。

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
- 取得は引数なしの `input.get()` を使います。既存の `input.get({})` と空配列の `input.get([])` も受け付けます。返される値はその呼び出しのスナップショットです。`input` はデータ入力の名前なので、`data` を使うプログラム内で同名を宣言しないでください。
- 書き込みや編集は従来の `tools.write` / `tools.edit` で行います。既存の入力検証・読み取り専用・サンドボックス・承認は変わりません。
- データも実行詳細・引数の記録へ残ります。認証情報を隠すための機能ではありません。
- `data` なしの既存プログラムとPythonのAPIは変更しません。壊れたプログラムを推測で補正・再実行する機能ではありません。

この方式を使うようSDKで案内しますが、モデルが必ず選ぶ保証や、生成ミスが完全になくなる保証はありません。

## 最初の作業先と管理操作

PTCはセッションの作業ディレクトリで始まります。依頼に別の作業先がある場合、引き継いだ現在位置を探索するのではなく、指定先に一度移動して初回の確認をまとめるよう案内します。アプリが自由文からパスを推測して、自動で作業先や権限の範囲を変えることはしません。

```ts
await tools.working_directory({ cd: "依頼された作業フォルダー" });
const files = await tools.glob({ path: ".", pattern: "src/*.ts" });
console.log(files);
```

`tools` の呼び出しにはJSONの引数オブジェクトが必要です。現在位置の取得は `tools.working_directory({})` とし、引数を省略しません。計画・進捗だけの `todo_write` は、可能なら実作業と同じ `run_code` にまとめます。

## 反映と制約

PTCのAPIと案内は起動時の互換フックで追加します。実装は `server/ptc-sdk-patch.js`、データ境界は `server/ptc-data.js` です。引数なし取得の既定値は `server/ptc-runtime-patch.js` のワーカー境界で `input.get` だけに適用します。通常のツール引数やユーザープログラムを書き換えるものではありません。上流の対応箇所が変わった場合、部分適用せず、既存のdsh更新互換チェックで検出します。反映にはアプリの再起動が必要です。

この変更はモデル・推論レベル・認証経路を変更しません。依頼達成の自動判定や無条件の自動継続も行いません。チームの成果確認は[報告の中身](team.md)を参照してください。
