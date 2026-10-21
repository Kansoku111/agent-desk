// Retired. Agent Desk never sends private ChatGPT HTTP requests or uses pi-ai Codex OAuth.
// GPT/search: siwc-client.js. Images/limits/account: codex-app-server.js.
export { parseSse, responseProblem as codexProblem } from './responses-events.js'
export class CodexClient {
  constructor() { throw new Error('Private Codex transport retired. Use official SIWC or bundled Codex app-server.') }
}
