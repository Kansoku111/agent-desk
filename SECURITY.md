# セキュリティポリシー / Security Policy

## 脆弱性の報告 / Reporting a vulnerability

セキュリティ上の問題は、公開の Issue や PR に書かないでください。GitHub の非公開の脆弱性報告（Security Advisories）から報告してください。

https://github.com/Kansoku111/agent-desk/security/advisories/new

Please do not report security vulnerabilities in public issues or pull requests. Use GitHub's private vulnerability reporting at the link above.

報告には、次の内容を含めてください。

- 影響を受けるバージョン（Agent Desk のバージョンまたはコミット ID）と OS
- 再現手順、または概念実証（PoC）
- 想定される影響（例: ほかの Web ページからの接続、トークンや API キーの漏えい）

報告を受けたら、内容を確認して対応を検討します。

## 対象のバージョン / Supported versions

最新の版だけを対象にします（現在は 0.1.0）。
Only the latest release (currently 0.1.0) is supported.

## セキュリティに関わる設計 / Security-relevant design

Agent Desk は、この PC の上で動くローカルのアプリです。次の点に注意してください（詳しくは [仕組みとデータの保存場所](docs/architecture.md#データの保存場所)、[スマホから使う](docs/remote.md)、[既知の制約](docs/known-issues.md) を参照）。

- **ローカルサーバー:** サーバーは `127.0.0.1` で待ち受けます。起動ごとのトークンと Origin の検査で、ほかの Web ページからの接続を拒否します。
- **認証情報の保存:** API キーと公式 SIWC の登録・トークンは、データフォルダの `dsh-home/.credentials.yaml` に保存します（SIWC は `agent-desk/chatgpt-siwc`）。旧 Codex OAuth レコードは再ログイン案内の検出にだけ使い、チャット・検索・画像・上限の認証へ流用しません。Claude の Admin API キーも同ファイルです。Codex app-server の認証は別の専用 `codex-home` に保存され、SIWC トークンを渡しません。保存ファイルはローカル平文で、OS のユーザー権限とデータフォルダの保護が必要です。
- **公式 SIWC:** Agent Desk 自身の名前、PKCE/state/nonce、loopback callback、公開JWKSによるID token検証を使います。access/refresh/ID token、認可コード、ID token hint入りURLはUIやログに出しません。回転refresh tokenはプロセス間ロックとatomic保存で更新し、GPT実行ごとに最新のaccess tokenを注入します。送信先は公開Responses endpointに固定し、任意URLへの資格情報送信を拒否します。
- **Codex app-server の隔離:** 同梱 `@openai/codex` 0.164.0の実行ファイルを解決し、PATHのcodexやユーザーの `~/.codex` は使いません。専用CODEX_HOME、空のcwd、read-only sandbox、最小ツール構成を使います。シェル/ファイル変更等の追加承認を自動許可しません。画像生成の入力・参照画像はOpenAIへ送信されます。5分idleまたは終了時にプロセスを停止します。これはプロセス全体をOSレベルで完全隔離するものではありません。
- **スマホからの接続（Tailscale）:** 「設定 → スマホ」で「スマホから使う」をオンにすると、この PC の Tailscale のアドレス（100.64.0.0/10）でも待ち受けます。QR コードのリンクには専用のトークンが入っており、リンクを知っている人は PC のエージェントを操作できます。トークンはデータフォルダの `remote.json` に保存されます。「新しいリンクを作る」を押すと、古いリンクは使えなくなります。
- **Chrome のデバッグポート:** 127.0.0.1 だけで待ち受けます。
- **デスクトップ操作（Windows）:** 権限モードに関係なく、承認なしで実際の画面を操作します。使うときだけオンにしてください。
- **サンドボックス:** dsh の権限モードのサンドボックスは完全な隔離ではありません。Windows の読み取り専用モードは、一部の経路を防ぎきれません。
