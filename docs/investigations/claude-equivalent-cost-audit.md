# Claude API換算額の過大表示調査

調査日: 2026-11-03。調査時点のコードとローカル保存記録に対する結果であり、実請求の監査ではない。表示仕様は[使用量の表示](../usage.md#回答末尾の累計api換算額)を参照。

追加調査: 提示されたベンチマークは非対話のチーム担当で実行されており、以下の1,660応答の横断照合とは別の対象だった。[ベンチ固有の調査](claude-benchmark-cost-audit.md)で、出力使用量の過小計上を確認した。以下の結果をClaudeの全経路へ一般化しないこと。

## 結論

- **同梱単価に誤りがある。** `server/catalog-extras.json` の Claude Sonnet 5.5 の `cost.cacheRead` は $0.20 / 100万トークン。調査時点の公式料金は $0.10 であり、この定義が採用される構成ではキャッシュ読込分を2倍に見積もる。全額が2倍になるという意味ではない。
- **確認した保存済み算定額には、その誤単価の適用を認めなかった。** 算定可能な1,660応答（Opus 5.5・Sonnet 5.5・Haiku 5.5）の保存済み使用量を公式料金の独立した式で計算し、すべて一致した。合成エラー応答6件は料金検証対象から除外した。
- 高額な4セッションを元ログから読み取り専用で再生し、保存済みの金額・算定応答数と一致した。検証した範囲では、応答ブロックの重複加算や過去分の再加算を再現しなかった。

今回は調査のみ。アプリの計算処理・同梱単価・設定・保存済み使用量は変更していない。

## 単価誤りの適用条件と再現

`server/model-catalog.js:applyCatalogAdditions` はインストール済みカタログにないモデルを同梱定義で追加する。`configuredModelCatalog` はその料金を計算用に渡す。さらに `server/index.js:syncModelCatalog` の処理では、取得済みの `modelUpdater.fetched.pricing` を優先する。

調査環境の取得済み単価および保存済みSonnet 5.5応答の単価は `cacheRead: 0.1` だった。同梱の `0.2` だけを見て、現在の表示すべてが過大と判断してはいけない。更新済み単価がない状態で同梱定義が採用される場合に問題となる。

同梱定義から `applyCatalogAdditions` と `server/usage.js:responseCost` を使って、次をメモリー上で再現した。

| 仮の使用量 | 値 |
| --- | ---: |
| 未キャッシュ入力 | 2 |
| 出力 | 1,000 |
| キャッシュ読込 | 100,000 |
| キャッシュ作成 | 0 |

- 同梱単価: **$0.030004**。
- 公式の読込単価 $0.10 を適用: **$0.020004**。
- 差額: **$0.01**（この例では全額の約50%過大）。

## 高く見える要因と確認した計算

1. **1時間キャッシュ作成。** 調査した算定可能な保存応答では、キャッシュ作成トークンは1時間TTLとして報告されていた。公式料金は通常入力の2倍で、5分TTLの1.25倍とは異なる。Opus 5.5は $8、Sonnet 5.5は $4 / 100万トークンになる。`server/claude-usage.js:claudeUsage` はCLIのTTL内訳を渡し、`responseCost` は1時間分を5分分から差し引くため、両方の単価を二重には加算していない。
2. **キャッシュ読込も毎回課金。** 同じ会話履歴でも、各モデル呼び出しのキャッシュ読込料金は累積する。キャッシュは無料ではない。
3. **回答末尾はターン料金ではなく累計。** `web/src/components/UsageCost.tsx` と `shared/usage-score.js` はタスクの累計を表示する。横のトークン数はそのターン分なので、これだけで金額を割り戻すと不一致に見える。
4. **思考トークンの二重加算なし。** Claudeの `output_tokens` を出力料金に使い、`thinking_tokens` を別途加算する処理はない。
5. **高速料金の誤適用なし。** Claude Code経路はCLIの `usage.speed` に従う。確認した算定可能な保存応答にfastはなかった。dshの高速設定をClaude Codeへ適用していない。
6. **丸めで上乗せしない。** ptの固定換算は保存値との互換用で、USDへ戻すと元の算定額になる。表示は小数点以下最大2桁の切り捨て。

## 根拠

- [Anthropic公式料金](https://platform.claude.com/docs/en/about-claude/pricing)（[Markdown原文](https://platform.claude.com/docs/en/about-claude/pricing.md)）: Sonnet 5.5のキャッシュ読込 $0.10、Opus 5.5の $0.20、TTL別の作成単価、Haiku 5.5の100,000入力トークン境界を確認。
- [公式プロンプトキャッシュ仕様](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)（[Markdown原文](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)）: `input_tokens` はキャッシュ読込・作成を含まない。`cache_creation_input_tokens` は5分・1時間の作成トークンの合計。
- 実装: `server/claude-usage.js:claudeUsage`、`server/usage.js:responseCost`、`server/claude-transcript.js:ClaudeConversation`、`server/claude-runner.js` の応答ID別置換処理。

## 検証と未解決事項

次の既存テストは **57件成功、失敗0件**。

```powershell
node --test test/claude-usage-score.test.js test/claude-transcript.test.js test/usage-score.test.js test/usage.test.js test/claude-runner.test.js
```

既存テストが成功していても、同梱Sonnet 5.5の具体的な読込単価の誤りは検出されない。修正時には同梱定義を使う回帰テストを追加するのが妥当。

- 未修正: 同梱Sonnet 5.5の `cacheRead: 0.2`。修正候補は `0.1` への限定的な変更。
- 過去分は初回算定時の単価を保存するため、カタログを直すだけで確定済み金額は変わらない。ただし今回の保存記録では誤単価での算定は確認しておらず、一括再計算する根拠はない。
- 全ログ・全課金経路を監査したわけではない。元ログとの再生比較は高額4セッション、独立式の照合は保存記録のある算定可能な応答が対象。使用量不明・別ログに委託された分は未算定のまま。
- Anthropicの請求API・管理画面とは比較していない。サブスクのAPI換算額と実請求額は別物であり、調査日の公式料金との一致は、過去の実請求との一致を保証しない。
- モデルの実呼び出し、アプリ再起動、認証情報の変更は行っていない。個別タスクの本文・識別子・利用額はこの記録に含めていない。
