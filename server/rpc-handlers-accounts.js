// RPC handlers for provider accounts (API keys and the ChatGPT sign-in) and for
// the usage page's admin key (see index.js).
import { ANTHROPIC_ADMIN_REF, ANTHROPIC_REF, DEEPSEEK_REF, LOCAL_LLM_REF, OPENCODE_GO_REF } from './credentials.js'
import { fetchCostDays } from './claude-cost.js'
import { SiwcClient } from './siwc-client.js'
import { isWorkspaceId } from './dsh-config.js'
import { anthropicKeyProblem, checkAnthropicKey, checkDeepSeekKey, checkOpenCodeGoKey } from './key-check.js'
import { discoverLocalModels, normalizeBaseUrl } from './local-llm.js'

/** The credential refs of the API keys set in 設定 → アカウント, by provider. */
const KEY_REFS = { anthropic: ANTHROPIC_REF, deepseek: DEEPSEEK_REF, opencodeGo: OPENCODE_GO_REF }
/** Key checks of the providers whose models join the catalog only with a key. */
const CATALOG_KEY_CHECKS = { deepseek: checkDeepSeekKey, opencodeGo: checkOpenCodeGoKey }

/** Handlers for accounts and usage; index.js merges them into the request table. */
export function createAccountHandlers({ appVersion, credentials, login, codexApp, getSettings, broadcast, accounts, setAnthropicWorkspace, refreshClaudeCost, updateModelCatalog, refreshChatGptUsage, getChatgptUsage, refreshUsageHistory, usageState, updateSettings, discoverModels = discoverLocalModels }) {
  return {
    // Connects (or reconnects) the local server: its models are read now and kept in the settings.
    'localLlm.set': async ({ baseURL, key }) => {
      const url = normalizeBaseUrl(baseURL)
      const typed = String(key ?? '').trim()
      if (/\s/.test(typed)) throw new Error('キーに空白や改行が含まれています。キーだけを貼り付けてください。')
      const models = await discoverModels(url, typed || (await credentials.read()).refs[LOCAL_LLM_REF] || null)
      if (typed) await credentials.setRef(LOCAL_LLM_REF, typed)
      const { settings } = await updateSettings({ localLlm: { baseURL: url, models } })
      broadcast('accounts', { accounts: await accounts() })
      return { settings, models }
    },

    'localLlm.remove': async () => {
      await credentials.unsetRef(LOCAL_LLM_REF)
      const { settings } = await updateSettings({ localLlm: { baseURL: null, models: [] } })
      broadcast('accounts', { accounts: await accounts() })
      return { settings }
    },

    'account.setKey': async ({ provider, key, force }) => {
      const ref = Object.hasOwn(KEY_REFS, provider) ? KEY_REFS[provider] : null
      if (!ref) throw new Error('不明なプロバイダーです')
      const trimmed = String(key ?? '').trim()
      if (!trimmed) throw new Error('API キーを入力してください')
      let check
      if (provider === 'anthropic') {
        const problem = anthropicKeyProblem(trimmed)
        if (problem) throw new Error(problem)
        const stored = getSettings().anthropicWorkspaceId
        check = await checkAnthropicKey(trimmed, stored)
        // A workspace id kept from an earlier key may not fit this one.
        if (stored && check.status === 'workspace-invalid') {
          check = await checkAnthropicKey(trimmed, null)
          if (check.status !== 'invalid') await setAnthropicWorkspace(null)
        }
      } else {
        check = await CATALOG_KEY_CHECKS[provider](trimmed)
      }
      if (check.status === 'invalid' && !force) {
        throw new Error('この API キーは認証に失敗しました。キーを確認してください。')
      }
      await credentials.setRef(ref, trimmed)
      const next = await accounts()
      broadcast('accounts', { accounts: next })
      if (provider === 'anthropic') void refreshClaudeCost()
      if (CATALOG_KEY_CHECKS[provider]) await updateModelCatalog()
      return { check, accounts: next }
    },

    // Re-checks a saved key, e.g. when the settings screen opens.
    'account.verify': async ({ provider }) => {
      const refs = (await credentials.read()).refs
      if (provider === 'anthropic') {
        const key = refs[ANTHROPIC_REF]
        return { check: key ? await checkAnthropicKey(key, getSettings().anthropicWorkspaceId) : null }
      }
      if (Object.hasOwn(CATALOG_KEY_CHECKS, provider)) {
        const key = refs[KEY_REFS[provider]]
        return { check: key ? await CATALOG_KEY_CHECKS[provider](key) : null }
      }
      throw new Error('不明なプロバイダーです')
    },

    'account.setWorkspace': async ({ workspaceId }) => {
      const next = workspaceId ? String(workspaceId).trim() : null
      if (next && !isWorkspaceId(next)) throw new Error('ワークスペース ID は「wrkspc_」で始まる文字列です')
      const key = (await credentials.read()).refs[ANTHROPIC_REF]
      let check = null
      if (key && next) {
        check = await checkAnthropicKey(key, next)
        if (check.status === 'workspace-invalid') throw new Error('このワークスペースは見つからないか、キーの持ち主に利用権限がありません')
        if (check.status === 'invalid') throw new Error('API キーの認証に失敗しました。キーを確認してください。')
      }
      await setAnthropicWorkspace(next)
      const accountsNow = await accounts()
      broadcast('accounts', { accounts: accountsNow })
      return { check, accounts: accountsNow }
    },

    'account.removeKey': async ({ provider }) => {
      const ref = Object.hasOwn(KEY_REFS, provider) ? KEY_REFS[provider] : null
      if (!ref) throw new Error('不明なプロバイダーです')
      await credentials.unsetRef(ref)
      const next = await accounts()
      broadcast('accounts', { accounts: next })
      if (provider === 'anthropic') void refreshClaudeCost()
      if (CATALOG_KEY_CHECKS[provider]) await updateModelCatalog()
      return { accounts: next }
    },

    'chatgpt.login': ({ method }) => {
      login.start(method === 'device' ? 'device' : 'browser')
      return { login: login.state }
    },
    'codex.login': async ({ method } = {}) => ({ codexLogin: await codexApp.loginStart(method === 'device' ? 'device' : 'browser') }),
    'codex.cancel': () => codexApp.cancelLogin(),
    'codex.account': async () => ({ account: await codexApp.account() }),
    'codex.logout': async () => {
      await codexApp.logout()
      const next = await accounts()
      broadcast('accounts', { accounts: next })
      await refreshChatGptUsage()
      return { accounts: next }
    },
    'chatgpt.code': ({ code }) => login.submitManualCode(code),
    'chatgpt.cancel': () => login.cancel(),
    'chatgpt.usage': async ({ maxAgeMs = 60_000 } = {}) => {
      const fresh = getChatgptUsage()?.fetchedAt && Date.now() - getChatgptUsage().fetchedAt < maxAgeMs
      return { usage: fresh ? getChatgptUsage() : await refreshChatGptUsage() }
    },

    'usage.get': async ({ maxAgeMs = 10 * 60_000 } = {}) => {
      await Promise.all([refreshUsageHistory(), refreshClaudeCost({ maxAgeMs })])
      return { usage: usageState() }
    },

    'usage.setAdminKey': async ({ key }) => {
      const trimmed = String(key ?? '').trim()
      if (!trimmed) throw new Error('Admin API キーを入力してください')
      if (/\s/.test(trimmed)) throw new Error('キーに空白や改行が含まれています。キーだけを貼り付けてください。')
      if (/^(apikey_|wrkspc_)/i.test(trimmed)) throw new Error('これはキー本体ではなく ID です。Admin API キーを作成したときに一度だけ表示される「sk-ant-admin…」を貼り付けてください。')
      const check = await fetchCostDays({ key: trimmed, from: Date.now() - 86_400_000, userAgent: `AgentDesk/${appVersion}` })
      if (check.status === 'invalid') throw new Error('このキーは認証に失敗しました。キーを確認してください。')
      if (check.status === 'forbidden') throw new Error(`このキーでは組織の使用量を読めません（${check.message}）。Admin API キーを使ってください。`)
      await credentials.setRef(ANTHROPIC_ADMIN_REF, trimmed)
      broadcast('accounts', { accounts: await accounts() })
      await refreshClaudeCost()
      return { check: check.status, usage: usageState() }
    },

    'usage.removeAdminKey': async () => {
      await credentials.unsetRef(ANTHROPIC_ADMIN_REF)
      broadcast('accounts', { accounts: await accounts() })
      await refreshClaudeCost()
      return { usage: usageState() }
    },

    'chatgpt.logout': async () => {
      login.cancel()
      await login.pending
      await new SiwcClient(credentials).logout()
      const next = await accounts()
      broadcast('accounts', { accounts: next })
      return { accounts: next }
    },
  }
}
