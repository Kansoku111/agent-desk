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

バッチ実行の案内と完成形例は `server/ptc-guidance.js` で管理します。Agent DeskがPTCを選択したとき、dshの公開 `ToolExecutor.sections` APIを使って独立したシステムプロンプト節へ追加します。通常のnativeモードやPythonには追加しません。各ステップで渡される利用可能ツールに合わせて例を選び、モード解除時に案内も外します。dshのSDK内の案内文を探して置き換える処理はありません。全セッションへ固定文面を追加する方式ではnativeモードや別セッションへ案内が混ざるため、選択中の実行器に結び付けています。

`data` APIとSDK型の軽量化は、引き続き `server/ptc-sdk-patch.js` の互換フックを使います。データ境界は `server/ptc-data.js`、引数なし取得の既定値は `server/ptc-runtime-patch.js` のワーカー境界で `input.get` だけに適用します。実行・スキーマ・権限制限は元の実行器へ委譲し、ユーザープログラムは書き換えません。残る上流内部への依存は、更新時の互換チェックと実PTCの回帰テストで確認します。反映にはアプリの再起動が必要です。

この変更はモデル・推論レベル・認証経路を変更しません。依頼達成の自動判定や無条件の自動継続も行いません。チームの成果確認は[報告の中身](team.md)を参照してください。
