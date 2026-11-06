# OpenScale の推論レベル（2026-11-06）

DeepSeek V4.1 Flash の推論レベルを Low / High の 2 つから広げられるかを調べ、Low / High / Max にした記録です。

## 背景

- OpenScale の DeepSeek Harness 向けセットアップ手順は Anthropic Messages 経路（`https://api.openscale.so/anthropic`）を指定し、推論レベルの設定は載せていません。Low / High はアプリが決めた値でした。
- GLM 5.3 Flash は OpenScale のドキュメントに「low と high の 2 段階、medium は high 扱い」とあります。DeepSeek にはこの記述がありません。
- Anthropic 経路の `output_config.effort` に使える値は、ドキュメントにありませんでした。

## 測定

契約プラン用のキーで、`deepseek/deepseek-v4.1-flash` に非ストリームで 1 件ずつ送りました（出力文は保存していません）。

- 受け付ける値: 両経路とも `none, minimal, low, medium, high, xhigh, max, ultra`。それ以外は 400 で、この一覧がエラーに返ります。ドキュメントは `xhigh` までしか載せていません。
- 簡単な確率の問題（各 1 回）では、Anthropic 経路の `low` から `xhigh` はほぼ同じ思考量（約 400 文字）で、`max` だけ約 1.6 倍（636 文字）でした。
- 数え上げの問題（各 2 回、出力トークン）:

| 指定 | Anthropic 経路 | Chat Completions 経路 |
|---|---|---|
| low | 1555 / 2064 | 6397 / 5977 |
| high | 3241 / 2782 | 1827 / 2755 |
| xhigh | 1782 / 2055 | 5522 / 2715 |
| max | 6107 / 4322 | 3411 / 2767 |
| ultra | 150 秒で未完 ×2 | 3743 / 5601 |

## 決定

- 経路は Anthropic Messages のまま変えません。Chat Completions はレベルと思考量に対応が見えず（`low` が最大の回もありました）、変える利点がありませんでした。OpenScale が動作確認した経路から外れる負担も避けられます。
- DeepSeek は Low / High / Max を出します。`low < high < max` が 2 回とも重なりなく並んだ範囲です。GLM は Low / High のままです。
- 出さなかったレベル:
  - `xhigh`: `low` と同程度でした。
  - `medium`: `low` と差が出ませんでした。
  - `ultra`: 150 秒で終わらず、測れていません。
  - `minimal`: 測っていません。
- 同じレベルでも結果は 1.5 倍ほど振れ、各レベル 2 回ずつの測定です。除外したレベルが本当に効かないとは言い切れません。再測定して差が出たら足せます。

## 代替案

- Chat Completions（`reasoning_effort`）に切り替える: 値は公式に書かれていますが、上のとおり効果が見えず、既存タスクの再開確認も要るため見送りました。
- 受け付ける値をすべて出す: 効かないレベルが選べて誤解を招くため見送りました。

## 運用

- 出すレベルを変えたら `server/index.js` の `openscaleReasoningLearn` を上げます。保存済みの推論レベルが古いと判定され、次の起動で再学習されます。
