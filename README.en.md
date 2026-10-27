# Agent Desk

[日本語版 README](README.md)

Agent Desk is a Codex-style desktop agent app built on DeepSeek Harness (`dsh`). It runs a coding agent that works on a local workspace, using a ChatGPT subscription (GPT models), Claude API keys, and/or the Claude Code installed on this PC (your Claude sign-in).

> The detailed documentation is currently written in Japanese only. The UI labels are also in Japanese (for example, 設定 = Settings).

## Features

- **GPT via ChatGPT subscription:** Agent Desk uses its own official Sign in with ChatGPT registration and the public Responses API for chat and web search. Existing users must sign in again.
- **Claude, DeepSeek and OpenCode Go via API keys:** Choosing Claude in a regular task uses an Anthropic API key you register. DeepSeek and OpenCode Go (a flat-rate subscription to GLM, Kimi, Qwen and other models) API keys are optional. Claude Code tasks and team Claude children take the separate route below.
- **Codex-style UI:** Per-workspace task list, command and diff views, and approval cards.
- **Claude Code tasks (CL):** Run the Claude Code installed on this PC in the app's terminal. Authentication and billing are Claude Code's own (for example a subscription); API keys registered in Agent Desk are not used.
- **Agent teams (TM):** Choose a leader from the model picker; it splits work among GPT, Claude, DeepSeek, and OpenCode Go children. Team Claude Code leaders and children inherit Claude Code's normal authentication, including your own subscription, API key, or cloud credentials; API/cloud authentication is not filtered out or rejected. For automatic team processing, **Claude (API) through dsh is recommended**: it uses your registered Anthropic API key and has a separate runtime and history from Claude Code. All child types are off by default. Existing choices, models, and histories stay intact: there is no automatic API migration, enabling, or fallback.
  - Team start/settings inspect `claude auth status` without calling a model and show only a sanitized authentication descriptor. Claude Code requires explicit billing confirmation, saved once per authentication mode and reused by every team (not tokens or account data). Authentication is rechecked before every CLI process launch/resume and every child turn; a changed mode requires confirmation again. Unknown authentication needs a separate explicit unknown-risk acknowledgement as well; logged-out authentication blocks execution. Regular CL tasks are unchanged.
  - API/cloud usage is metered; parallel children and long turns can incur substantial charges. Set spending controls in your provider's console before use. **Agent Desk does not enforce a hard USD spending cap.** Any credits depend on the provider's current plan conditions.
- **Eco mode (eco):** A separate parent/low-cost-child workflow, opened to the left of TM. The app runs project verification commands, records source state and logs, and handles bounded repairs before reporting to the parent. Writes are serialized through review; read-only investigation may run in parallel. [Usage and limits (Japanese)](docs/execution.md).
- **AB (consult, decide, implement):** Sends the original request directly to two independent models, then asks a separate leader to assess both reports. Only after human approval does the selected implementation model—or the leader model itself—implement the plan. Post-delegation review and lean consultation tools are configurable. [Usage and boundaries (Japanese)](docs/ab.md).
- **Restore changes:** Return the workspace to its state before a request.
- **Usage display:** Cumulative API-price-equivalent USD/JPY in regular/CL tasks and Eco/TM/AB workflows, alongside per-turn tokens. General settings selects the display currency and a manual USD/JPY rate; recorded USD values stay unchanged. Click or tap the amount for metered-cost details; ChatGPT usage limits stay separate. API-equivalent amounts are not bills or subscription-quota estimates. [Scope and unpriced usage (Japanese)](docs/usage.md). The team panel also shows the Claude five-hour and weekly limits, read from what the team's Claude prints (no extra requests).
- **Phone access:** View and control tasks from a phone browser over Tailscale.
- **Plan:** Turn it on in the dsh chat composer to consult without file edits for those messages. [Scope and limitations (Japanese)](docs/features.md).
- **Permission modes:** Read-only, workspace, or full access, chosen per task.
- **Browser and desktop control:** Available when turned on in Settings. Windows desktop control is off by default.
- **More:** Image generation, web search, subagents on other models, fast mode, and custom instructions.

## Requirements

- Node.js 22.19 or later, or 24 or later
- Windows 10/11. Testing and CI run on Windows only; macOS and Linux are untested and some features may not work there.
- Microsoft Edge or Google Chrome for the app window (if neither is installed, the default browser is used)

## Install and launch

```sh
git clone https://github.com/Kansoku111/agent-desk.git
cd agent-desk
npm install
npm start
```

Without git, unpack `AgentDesk-<version>.zip` from the [releases](https://github.com/Kansoku111/agent-desk/releases) instead. Either way, later versions install from Settings → About → "更新" in the app.

On Windows, you can also double-click `AgentDesk.cmd`. The first run installs the dependencies. To add a Start menu shortcut, run this in PowerShell from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
```

## Quick start

1. Open Settings (設定) and select the Account (アカウント) tab.
2. Click **Continue with ChatGPT** in the official GPT chat/web-search card and approve Agent Desk and plan usage in your browser. For images and Codex usage limits, sign in separately in the 「画像生成と利用上限（Codex）」 card.
3. To use Claude, paste an Anthropic API key that starts with `sk-ant-api` and save it. The app checks that the key works when you save it. The `apikey_…` shown in the Console is an ID, not a key.
4. On the home screen, choose a workspace folder, type your request, and send it.

SIWC uses a local 127.0.0.1 callback; cancel and retry if it does not complete. The separate Codex connection also offers a device-code fallback. Images and Codex limits use the official bundled `@openai/codex` 0.164.0 app-server with an app-owned CODEX_HOME, never your PATH codex or ~/.codex. Images remain enabled by default but require that separate connection. GPT fast mode is unavailable on SIWC; Claude fast mode is unchanged. Codex limits are not the SIWC app-specific allowance; check [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). Tokens stay local; requests/reference images are sent to the relevant OpenAI service. No paid upgrade is required to use SIWC.

## Documentation (Japanese)

- [機能の詳細](docs/features.md): all features and permission modes
- [エージェントチーム](docs/team.md): agent teams (TM)
- [スマホから使う](docs/remote.md): phone access over Tailscale
- [使用量の表示](docs/usage.md): usage and cost display
- [変更を戻す](docs/restore.md): restoring the workspace
- [更新](docs/updating.md): the in-app update of Agent Desk itself, and the steps an AI agent follows to update dsh and Codex
- [仕組みとデータの保存場所](docs/architecture.md): architecture and where data is stored
- [既知の制約](docs/known-issues.md): known limitations
- [開発](docs/development.md): development commands and main files

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)

## Disclaimer

- Agent Desk is an unofficial project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, DeepSeek, or OpenCode.
- You are responsible for complying with each provider's terms of service, including when you sign in with a ChatGPT subscription or use Claude, DeepSeek, or OpenCode Go API keys.
- Claude Code tasks and team Claude Code children simply launch the `claude` command you installed on this PC. Agent Desk does not read, store, or send your Claude sign-in tokens. It does read conversation records and `claude -p` output to display them, and it saves team children's history in its data folder (see docs/architecture.md, in Japanese). Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page permits offering the unmodified binary with users' own subscription, API, or third-party cloud credentials subject to conditions. Unless otherwise agreed, a provider running Claude Code in its product/service must agree to the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), must not remove, disable, or restrict built-in authentication methods, and must not pay for, resell, or intermediate end-user usage. Users authenticate through the appropriate provider flow and are billed under their own agreements. Developers may not collect, store, or intermediate Claude.ai credentials/session tokens or route requests through users' subscription credentials outside the permitted Claude Code arrangement. These conditions are not a guarantee that every Agent Desk use complies; applicable terms, usage policies, and provider interpretations still govern. Neither this disclaimer nor billing confirmation grants permission or guarantees compliance. Check the current terms before use and use only your own authorized credentials. Do not extract your Claude sign-in tokens and use them in another app, lend or share the account with others, resell or intermediate your usage, or work around usage limits. The team's Claude Code children are off until you turn them on; if you are unsure, leave them off and use "Claude (API)" children (they run on an API key).
- Desktop control (Windows) operates this PC's real screen with the mouse and keyboard, without asking for approval. Browser control (Chrome) operates a Chrome instance launched on this PC. Both act on your real machine, so turn them on only when you need them, and back up important data beforehand.
- Costs calculated by Agent Desk are estimates. Check your provider's console for the exact billed amounts.
- This software is provided "AS IS", under the MIT License, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. The authors and contributors are not liable for any claim or damages arising from the use of this software.
- ChatGPT, Codex, Claude, DeepSeek, OpenCode, Chrome, Tailscale, and other product names are trademarks of their respective owners.

## License

DeepSeek Harness is MIT licensed. Dependencies are licensed under their own licenses.

Agent Desk is released under the MIT License (Copyright (c) 2026 Kansoku111). See [LICENSE](LICENSE).
