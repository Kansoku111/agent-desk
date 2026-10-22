# Agent Desk

[日本語版 README](README.md)

Agent Desk is a Codex-style desktop agent app built on DeepSeek Harness (`dsh`). It runs a coding agent that works on a local workspace, using a ChatGPT subscription (GPT models), Claude API keys, and/or the Claude Code installed on this PC (your Claude sign-in).

> The detailed documentation is currently written in Japanese only. The UI labels are also in Japanese (for example, 設定 = Settings).

## Features

- **GPT via ChatGPT subscription:** Agent Desk uses its own official Sign in with ChatGPT registration and the public Responses API for chat and web search. Existing users must sign in again.
- **Claude and DeepSeek via API keys:** Choosing Claude in a regular task uses an Anthropic API key you register. A DeepSeek API key is optional. Claude Code tasks and team Claude children take the separate route below.
- **Codex-style UI:** Per-workspace task list, command and diff views, and approval cards.
- **Claude Code tasks (CL):** Run the Claude Code installed on this PC in the app's terminal. Authentication and billing are Claude Code's own (for example a subscription); API keys registered in Agent Desk are not used.
- **Agent teams (TM):** A leader splits the work among GPT, Claude, and DeepSeek child agents. A Claude leader or child runs as the Claude Code on this PC (`claude -p`), not through the Claude API.
- **Restore changes:** Return the workspace to its state before a request.
- **Usage display:** Per-turn token counts, estimated cost for Claude and DeepSeek, and ChatGPT usage limits. The team panel also shows the Claude five-hour and weekly limits, read from what the team's Claude prints (no extra requests).
- **Phone access:** View and control tasks from a phone browser over Tailscale.
- **Permission modes:** Read-only, workspace, or full access, chosen per task.
- **Browser and desktop control:** Available when turned on in Settings. Windows desktop control is off by default.
- **More:** Image generation, web search, subagents on other models, fast mode, and custom instructions.

## Requirements

- Node.js 22.19 or later, or 24 or later
- Windows 10/11, macOS, or Linux
- Microsoft Edge or Google Chrome for the app window (if neither is installed, the default browser is used)

## Install and launch

```sh
git clone https://github.com/Kansoku111/agent-desk.git
cd agent-desk
npm install
npm start
```

On Windows, you can also double-click `AgentDesk.cmd`. The first run installs the dependencies. To add a Start menu shortcut, run this in PowerShell from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
```

## Quick start

1. Open Settings (設定) and select the Account (アカウント) tab.
2. Click **Continue with ChatGPT** in the official GPT chat/web-search card and approve Agent Desk and plan usage in your browser. For images and Codex usage limits, sign in separately in the 「画像生成と利用上限（Codex）」 card.
3. To use Claude, paste an Anthropic API key that starts with `sk-ant-api` and save it. The app checks that the key works when you save it. The `apikey_…` shown in the Console is an ID, not a key.
4. On the home screen, choose a workspace folder, type your request, and send it.

SIWC uses a local 127.0.0.1 callback; cancel and retry if it does not complete. The separate Codex connection also offers a device-code fallback. Images and Codex limits use the official bundled `@openai/codex` 0.163.0 app-server with an app-owned CODEX_HOME, never your PATH codex or ~/.codex. Images remain enabled by default but require that separate connection. GPT fast mode is unavailable on SIWC; Claude fast mode is unchanged. Codex limits are not the SIWC app-specific allowance; check [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). Tokens stay local; requests/reference images are sent to the relevant OpenAI service. No paid upgrade is required to use SIWC.

## Documentation (Japanese)

- [機能の詳細](docs/features.md): all features and permission modes
- [エージェントチーム](docs/team.md): agent teams (TM)
- [スマホから使う](docs/remote.md): phone access over Tailscale
- [使用量の表示](docs/usage.md): usage and cost display
- [変更を戻す](docs/restore.md): restoring the workspace
- [dsh のアップデート](docs/dsh-update.md): updating dsh and recovery
- [仕組みとデータの保存場所](docs/architecture.md): architecture and where data is stored
- [既知の制約](docs/known-issues.md): known limitations
- [開発](docs/development.md): development commands and main files

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)

## Disclaimer

- Agent Desk is an unofficial project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, or DeepSeek.
- You are responsible for complying with each provider's terms of service, including when you sign in with a ChatGPT subscription or use Claude or DeepSeek API keys.
- Claude Code tasks and team Claude children simply launch the `claude` command you installed on this PC. Agent Desk does not read, store, or send your Claude sign-in tokens. Whether using a Claude subscription this way is allowed is up to Anthropic's terms, so check the current terms before you use it.
- Desktop control (Windows) operates this PC's real screen with the mouse and keyboard, without asking for approval. Browser control (Chrome) operates a Chrome instance launched on this PC. Both act on your real machine, so turn them on only when you need them, and back up important data beforehand.
- Costs calculated by Agent Desk are estimates. Check your provider's console for the exact billed amounts.
- This software is provided "AS IS", under the MIT License, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. The authors and contributors are not liable for any claim or damages arising from the use of this software.
- ChatGPT, Codex, Claude, DeepSeek, Chrome, Tailscale, and other product names are trademarks of their respective owners.

## License

DeepSeek Harness is MIT licensed. Dependencies are licensed under their own licenses.

Agent Desk is released under the MIT License (Copyright (c) 2026 Kansoku111). See [LICENSE](LICENSE).
