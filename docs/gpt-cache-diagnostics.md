# GPTキャッシュ診断

SIWCのResponses呼出で、送信内容の変化と生usageの項目有無を確認するための開発用診断です。キャッシュの設定や通常の使用量計算は変えません。過去に記録しなかった送信内容や使用量は復元できません。

## 有効にする範囲

既定はOFFです。比較用プロセスの起動前に、環境変数 `AGENT_DESK_GPT_CACHE_DIAGNOSTICS` へローカル出力フォルダーの絶対パスを渡します。相対パス・URL・UNC形式は受け付けません。環境変数はモジュール読込時に取得し、稼働中の設定変更には追従しません。

通常のアプリやユーザー環境へ常設せず、比較ランチャーが起動するプロセスだけに設定してください。`dshEnv` はこの値を子へ引き継ぎます。出力はフォルダー内の `gpt-cache-<pid>-<random>.jsonl` です。比較ランチャーと有料試行の上限は、計画の次の段階で用意します。

HTTPの対象は `withSiwc` を通るResponses試行です。これに加え、同じ環境変数を渡したDSHのACPプロセスではprompt単位の本文通知の時刻も記録します。モデル一覧・認証用HTTP・別経路の検索・他プロバイダー・Codex側の通信をすべて記録する機能ではありません。設定が無いときは診断用のJSON再解析・HMAC計算・ファイル書込をしません。

## 記録するもの

1行1JSONで、同じファイル内の `id` により `request` と `result` を対応付けます。`at` は記録時のミリ秒時刻です。

- `request`: 実送信するJSONを対象に、指示・ツール・設定・cache key・入力のHMACと、入力項目数を記録します。鍵はランダム生成して保存しません。本文、tool引数、encrypted_content、認証ヘッダー、セッションIDの原文は書きません。
- `series` / `groupSource`: SDKのsessionIdをHMAC化して系列を分けます。sessionIdが無い場合は非空のcache keyで代用し、両方無ければ前回比較をしません。cache keyだけを使う場合、キー変更を同じ会話の変更とは追跡できません。
- `prefix`: 同じ系列の直前に観測した入力との先頭一致**項目数**、最初の変更indexと種別、指示・ツール・設定・cache keyの一致を示します。token数やbyte数ではなく、同じ項目の内部で何文字目が変わったかは分かりません。
- `appendOnly` は入力の追記性だけで、完全に同じ入力の再送もtrueになります。伸びたかどうかは `inputItems` と `prefix.previousItems` の差、その他の変更は各一致フラグで確認してください。`previousPending: true` は直前の試行が未終了のまま重なったことを示し、直前の入力がすでにcacheへ格納されたとは仮定できません。
- `result`: 観測した終了状態と、終端SSEの生usageを記録します。生inputはcache分を含み、出力は推論分を含むため、推論をもう一度足しません。通常のSDK後の未cache入力とは定義が異なります。

usageの個別項目は、正数の `value`、明示0の `zero`、項目なしの `missing`、負数・文字列・null等の `invalid` に分けます。`value` / `zero` だけに数値が付きます。上位の `usage.state` が `unobserved` のときは、終端usage自体を未取得です。HTTPエラーや中断では、サーバーが内訳を返さなかったと断定しないでください。

非2xxはヘッダー時点のHTTPエラーを優先して記録し、その後のエラー本文でのtimeout・取消では結果を書き換えません。本文の読み取り失敗自体は従来どおり呼出元へ伝わります。HTTPエラーの本文や例外のmessage/stackは記録しません。キャンセルは上流へ伝わったキャンセルの観測であり、人が操作したことまで意味しません。

## 遅延の切り分け

`request` には固定の経路名 `official_responses`、実送信JSONの `reasoningEffort` と `serviceTier` も記録します。値は許可リスト内のものだけで、未指定は `absent`、想定外の値は `invalid` です。SIWCで削除されるservice tierは `absent` になり、上流が実際に適用した優先度までは分かりません。

`request.reasoningContext` は推論履歴の指定（`auto`・`current_turn`・`all_turns`）、`request.parallelToolCalls` はツールの並列呼出指定（boolean）です。どちらも未指定は `absent`、想定外の値は `invalid` です。Codexとのモック比較で送信指定の差が見つかったため、effortと別に観測します。指定を書き換える機能ではありません。

`result.reasoningContext` は終端応答の `reasoning.context` にある実適用値（`current_turn`・`all_turns`）です。項目が無ければ `absent`、想定外の値は `invalid`、終端未取得は `unobserved` です。要求が未指定でも実適用値は返り得るため、両者を同じ値とみなしません。過去のログにこの項目が無い場合は未記録であり、特定のmodeが適用された証拠には使えません。[公式の推論履歴仕様](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls)も、未指定時はモデル既定を使い、応答で実適用値を確認するよう説明しています。

`result.transport` は応答を受け取った通信路で、`websocket` か `http` です。WebSocketから切り替えた試行は `http` になります。WebSocketの `headersMs` は最初のイベントを受けた時点で、HTTPのレスポンスヘッダーとは意味が異なるため、通信路をまたぐ比較には `terminalMs` か `firstTextMs` を使ってください。

metadataの後に明示的な`error`イベントが届いた場合、ヘッダーが既に200でも結果は`failed`です。例外にはサービスが報告したstatus/codeを残して再試行を判断しますが、診断ファイルへエラー本文は保存しません。終端応答を伴わないため、この場合のusageは`unobserved`、`terminal`は`null`のままです。単なる途中切断と、明示的な拒否を分けて解釈してください。

`result.startedAt` は試行観測開始の壁時計時刻です。`result.timing` は指紋記録直後・認証情報の取得前を起点とする単調時計の経過ミリ秒で、未到達の地点は `null` です。

| 項目 | 観測地点 |
|---|---|
| `authReadyMs` | 認証情報を取得した後。更新やロック待ちがあれば含む |
| `sendMs` | Responses用fetchの呼出直前 |
| `headersMs` | fetchがResponseを返した直後 |
| `firstByteMs` | 非空のbody chunkを最初に読み取った時点 |
| `firstEventMs` | 既存SSEパーサが最初のJSONイベントを解析した時点 |
| `firstTextMs` / `lastTextMs` | 最初／最後の非空 `response.output_text.delta` を解析した時点 |
| `terminalMs` | completed・failed・incompleteの終端イベントを解析した時点 |
| `finishedMs` | ストリーム終了、または失敗を観測した時点 |

これらはクライアント側の観測であり、サーバーの純粋な推論時間やTCP上の到着時刻ではありません。heartbeat・推論・ツール引数は本文deltaとは分けます。HTTP非2xxではヘッダー時点で結果を確定するため、その後のエラー本文の受信時刻は採取しません。認証段階で失敗した場合も `auth_error` を残し、送信時刻は `null` です。

`delivery` は、HTTP試行とは別のprompt単位の記録です。`startedAt` を起点に、DSHで受け取った最初／最後の本文delta（`firstTextMs` / `lastTextMs`）、最初／最後の非空本文通知の呼出（`firstNotifyMs` / `lastNotifyMs`）、最後に通知関数が正常復帰した時刻（`lastNotifyReturnedMs`）、prompt処理の終了（`finishedMs`）を記録します。空の速度表示用通知は本文に数えません。

ACPの通知関数は内部で送信エラーを捕捉するため、正常復帰しても送信・UI描画の成功は確認できません。`deliveryStatus` は通常 `unconfirmed`、通知関数自体から例外が出た場合だけ `notify_rejected` です。本文は複製配信せず、通知やHTTPの例外伝播も維持します。

各spanは起点が異なります。同じプロセスのsession由来HMACが一致すれば `series` を参考にできますが、SDKのsessionIdとACPのsessionIdの一致、リトライや並行実行をまたぐHTTP試行との1対1対応は保証しません。別プロセスの単調時計を直接減算せず、壁時計・系列は参考の相関にとどめてください。既存ログに無かった時刻は復元できません。

## 上限と失敗時の扱い

1診断インスタンス（環境変数による利用では1プロセス）につき最大200HTTP試行（認証段階の失敗を含む）、200件のACP prompt計測、合計出力1MiBです。ACP側はSIWC以外のDSH promptも上限を消費します。上限後は `limited` と停止通知を確認し、欠測を0として扱わないでください。保持する比較用snapshotは最大16系列、入力4,096項目までで、本文ではなくHMACです。入力上限を超えた試行は `fingerprintComplete: false` とし、その入力との前回比較はしません。

書込は非同期で、ログの遅延・失敗を会話へ伝播しません。書込失敗後は新しい採取を止めます。設定不正、書込失敗、上限で採取を止める場合は、本文・例外詳細・保存先の原文を含まない `gpt-cache-diagnostics-stopped` JSONをstderrへ出します。上限と書込失敗はそれぞれ一度だけ通知します。比較側はstderrも収集し、停止通知があるデータを完備した総消費として扱わないでください。強制終了・出力上限等によりresultが無い場合、消費0ではなく未取得として扱ってください。通常のファイル権限に加え、共有する場合もtoken数・時刻などのメタデータは残る点に注意してください。

テストや比較コードで `createCacheDiagnostics` を直接注入した場合は、対象の通信・取消伝播が完了してから `await diagnostics.flush()` を呼ぶと、そこまでに投入済みの書込と `failed` / `limited` を確認できます。flushは将来のイベントや実行中の通信を待つものではありません。

## 検証

次のコマンドはモック通信またはローカルの偽HTTP／stdioサーバーを使い、実プロバイダーや有料モデルを呼びません。

```powershell
node --test test/gpt-cache-diagnostics*.test.js test/gpt-latency.test.js test/siwc*.test.js test/output-speed*.test.js test/mcp-startup*.test.js
```

実送信の正規化、UTF-8とSSEの分割、診断OFF/ONの送受信一致、実SDKによるusage正規化、欠落/0/不正値、中断・timeout・エラー、非漏洩・上限・書込失敗を検証します。

この診断で確認できるのはクライアントが送ったJSON、受け取ったusageと、上記のクライアント側の観測時刻です。上流の実際のtoken化・非公開指示・処理先・cache状態・利用枠の計上条件までは分かりません。同じ入力で明示的な0が続く場合も、上流原因を断定するのではなく次の調査候補を絞る材料として使います。
