# Skills の読み込み

DSH タスクの Skills 選択欄とエージェントの `skill` ツールは、同じファイルシステムプロバイダーを使います。ただし選択欄と設定画面の一覧は既定の探索設定を使うため、Harness 側で独自に設定した `customSkillDirs` は反映されません。

## 保存先と優先順位

同名の skill は、次の順に優先します。

1. プロジェクトの `.dsh/skills`
2. プロジェクトの `.agents/skills`
3. プロジェクトの `.codex/skills` → `.claude/skills`
4. Harness の `customSkillDirs`
5. Agent Desk の DSH ホームの `skills`
6. ユーザーの `~/.agents/skills`（`DSH_AGENTS_HOME` 指定時はその配下）
7. ユーザーの `~/.codex/skills` → `~/.claude/skills`
8. Harness の同梱 skills

プロジェクトは作業ディレクトリから最も近い `.git` のあるフォルダーです。なければ作業ディレクトリを使います。
Agent Desk の DSH ホームは通常の `~/.dsh` とは分離しています。既存のファイルをコピー・移動する必要はありません。

各保存先の直下にある `<skill>/SKILL.md` または単体の Markdown ファイルが対象です。子フォルダーを再帰的には探索しません。
Codex・Claude の互換保存先では `.system` を除外し、`.archive/<skill>/SKILL.md` や Claude の `synced` 配下も再帰的には取り込みません。
`SKILL.md` には YAML frontmatter の `name` と `description` が必要です。不正な YAML・名前・呼び出し設定は Harness の検証で除外されます。

`user-invocable: false` は選択欄に出しません。`disable-model-invocation: true` はモデルの自動選択から除外し、ユーザーによる明示呼び出しは維持します。

## 設定 → Skills

「設定 → Skills」では、選んだプロジェクトで読み込まれる skill を、プロジェクト・ユーザー・組み込みに分けて確認できます。取得元のフォルダー（例: `.claude/skills`）を併記し、フォルダーボタンで SKILL.md の場所を開きます（PC のみ）。
同名で優先順位に負けた skill は薄く表示し「上書きされています」と示します。`user-invocable: false` は「自動のみ」、`disable-model-invocation: true` は「手動のみ」です。両方が指定されている場合は「呼び出し不可」と表示します。
不正な frontmatter の skill は Harness が除外するため、この一覧にも出ません。

説明が日本語でない skill があるときだけ「日本語にする」が出ます。押すと Claude Code（`haiku`・推論 `low`、ツールなし）が説明を翻訳し、`skill-translations.json`（Agent Desk のデータフォルダー）に説明文ごとに保存します。自動では実行せず、課金の可能性を確認したうえで「エージェントチーム」で確認済みの Claude Code の認証方法でのみ動きます（未確認なら確認を促すメッセージが出ます）。1回につき最大40件、各説明の先頭600文字を翻訳します。翻訳は表示だけで、SKILL.md は書き換えません。保存済みデータの移行は不要です。

ゴミ箱ボタンは、確認のあと skill のフォルダー（単体の Markdown ならそのファイル）を完全に削除します。元に戻せません。一覧に出ている skill だけが対象で、組み込みの skill には出ません。確認後に削除対象のパスが変わった場合は削除しません。シンボリックリンクはリンク自体だけを消し、リンク先は残します。`~/.claude/skills` など他のツールと共有している保存先でも、同じように削除されます。

## 反映と検証

この探索範囲の修正を反映するには Agent Desk を再起動してください。保存済みセッション・設定の移行は不要です。
一覧にない名前を指示するだけでは skill は作成されません。`unknown or no longer available` が続く場合は、上記の保存先に該当ファイルが存在するか、frontmatter の名前が一致しているかを確認してください。

回帰テスト:

```sh
node --test test/skills.test.js test/key-check.test.js
node --test --test-name-pattern="Codex and Claude skills" test/ptc-runtime.test.js
```

単体テストはプロジェクト／ユーザーの探索、優先順位、本文とリソースパス、呼び出しポリシー、不正メタデータ、除外範囲を検査します。
結合テストは一時ホームとローカルの模擬応答で実際の DSH/ACP を起動し、通常方式と PTC の双方で一覧への提示と `skill` ツールによる本文取得を検査します。外部モデル API や本番データは変更しません。
