// Official Sign in with ChatGPT public-client token/session and inference transport.
import fs from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { SIWC_RECORD } from './credentials.js'
import { explainSiwcUsage } from './siwc-usage-error.js'
export const SIWC_ISSUER = 'https://auth.openai.com'
export const SIWC_RESOURCE = 'https://api.openai.com/v1'
export const SIWC_TOKEN_URL = `${SIWC_ISSUER}/api/accounts/oauth/token`
export const SIWC_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const SIWC_USAGE_URL = 'https://chatgpt.com/settings/usage'
export const SIWC_KEY_REF = 'AGENT_DESK_SIWC_MANAGED'
export const SIWC_KEY_PLACEHOLDER = 'managed-by-agent-desk-siwc-hook'
export function redactSiwc(value, credential = {}) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    if (credential[key]) text = text.split(credential[key]).join('[REDACTED]')
  }
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[JWT REDACTED]')
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]*/g, '$1[REDACTED]')
}
export async function tokenRequest(fields, {
  fetch: fetcher = fetch,
  signal
} = {}) {
  const response = await fetcher(SIWC_TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams({
      ...fields,
      resource: SIWC_RESOURCE
    }),
    signal: signal ?? AbortSignal.timeout(30000)
  })
  const body = await response.json()
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : body.error?.code ?? 'token_request_failed'
    // Do not log the raw token response (even an OAuth error may contain secrets).
    const error = new Error(`ChatGPT token HTTP ${response.status}: ${code}`)
    error.code = code
    throw error
  }
  if (!body.access_token || !body.refresh_token || !Number.isFinite(body.expires_in)
    || body.expires_in <= 0 || body.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('ChatGPT returned an invalid token set')
  }
  return body
}
let jwks
export async function verifySiwcIdToken(idToken, clientId, {
  nonce,
  previous,
  keySet
} = {}) {
  jwks ??= createRemoteJWKSet(new URL(`${SIWC_ISSUER}/.well-known/jwks.json`))
  const {
    payload
  } = await jwtVerify(idToken, keySet ?? jwks, {
    issuer: SIWC_ISSUER,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
    algorithms: ['RS256', 'ES256']
  })
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error('ChatGPT ID token nonce mismatch')
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('ChatGPT ID token missing subject')
  if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    || (payload.azp !== undefined && payload.azp !== clientId)) {
    throw new Error('ChatGPT ID token authorized-party mismatch')
  }
  if (previous?.subject && (previous.subject !== payload.sub
    || previous.issuer !== payload.iss || previous.client_id !== clientId)) {
    throw new Error('ChatGPT account identity changed; previous connection preserved')
  }
  return payload
}
export function siwcCredential(tokens, {
  clientId,
  hostId,
  identity,
  previous,
  now = Date.now()
}) {
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? []
  return {
    issuer: identity.iss,
    subject: identity.sub,
    email: identity.email ?? previous?.email ?? null,
    client_id: clientId,
    ext_agent_host_id: hostId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token ?? previous?.id_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    saved_at: new Date(now).toISOString(),
    expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    earliest_refresh_at: tokens.earliest_refresh_at,
    scopes
  }
}
export async function withSiwcSessionLock(store, work) {
  await fs.mkdir(path.dirname(store.file), {
    recursive: true
  })
  return withFileLock(`${store.file}.siwc-refresh`, work, {
    waitMs: 45000
  })
}
export class SiwcClient {
  constructor(store, {
    fetch: fetcher = fetch,
    verify = verifySiwcIdToken,
    now = Date.now
  } = {}) {
    this.store = store
    this.fetch = fetcher
    this.verify = verify
    this.now = now
  }
  async auth() {
    const read = async () => (await this.store.read()).records?.[SIWC_RECORD]?.payload
    let current = await read()
    if (!current?.access_token || !current.client_id || current.client_id === 'dynamic_agent_client') {
      throw new Error('ChatGPT: sign in again (official) in Settings → Accounts')
    }
    const usable = credential => Number.isFinite(Date.parse(credential.expires_at))
      && Date.parse(credential.expires_at) > this.now() + 60000
    if (!usable(current)) {
      await fs.mkdir(path.dirname(this.store.file), {
        recursive: true
      })
      // Separate from the store writer lock: the network exchange and rotation are serialized across all runtimes.
      current = await withSiwcSessionLock(this.store, async () => {
        const latest = await read()
        if (!latest?.refresh_token) throw new Error('ChatGPT: sign in again (official); refresh session unavailable')
        if (usable(latest)) return latest
        let tokens
        try {
          tokens = await tokenRequest({
            grant_type: 'refresh_token',
            client_id: latest.client_id,
            refresh_token: latest.refresh_token
          }, {
            fetch: this.fetch
          })
        } catch (error) {
          if ([
            'invalid_grant', 'invalid_refresh_token', 'token_expired',
            'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
          ].includes(error.code)) {
            await this.store.setGrant(SIWC_RECORD, {
              ...latest,
              access_token: null,
              refresh_token: null,
              id_token: null
            })
          }
          throw error
        }
        const identity = tokens.id_token ? await this.verify(tokens.id_token, latest.client_id, {
          previous: latest
        }) : {
          sub: latest.subject,
          iss: latest.issuer,
          email: latest.email
        }
        const updated = siwcCredential(tokens, {
          clientId: latest.client_id,
          hostId: latest.ext_agent_host_id,
          identity,
          previous: latest,
          now: this.now()
        })
        await this.store.setGrant(SIWC_RECORD, updated)
        return updated
      })
    }
    if (!current.scopes?.includes('chatgpt.tokens.use.direct')) {
      throw new Error('ChatGPT plan usage not enabled; authorize it in Settings → Accounts')
    }
    return current
  }
  async models() {
    const auth = await this.auth()
    const response = await this.fetch(`${SIWC_RESOURCE}/models`, {
      redirect: 'error',
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) throw new Error(`ChatGPT models HTTP ${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body.models)) throw new Error('ChatGPT model catalog did not contain models[]')
    return body.models
  }
  async post(body, {
    signal
  } = {}) {
    const auth = await this.auth()
    const response = await this.fetch(`${SIWC_RESOURCE}/responses`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'Agent-Desk-SIWC/0.1'
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(180000)
    })
    const explained = await explainSiwcUsage(response)
    const text = await explained.text()
    return {
      ok: response.ok,
      status: response.status,
      text: redactSiwc(text, auth)
    }
  }
  async logout() {
    return withSiwcSessionLock(this.store, () => this.logoutLocked())
  }
  async logoutLocked() {
    const old = (await this.store.read()).records?.[SIWC_RECORD]?.payload
    if (old?.refresh_token) {
      const discovery = await this.fetch(`${SIWC_ISSUER}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10000)
      })
      const config = await discovery.json()
      const endpoint = new URL(config.revocation_endpoint)
      if (endpoint.origin !== SIWC_ISSUER) throw new Error('Unexpected ChatGPT revocation endpoint')
      const response = await this.fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          token: old.refresh_token,
          token_type_hint: 'refresh_token',
          client_id: old.client_id
        }),
        signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) throw new Error(`ChatGPT revocation HTTP ${response.status}; retry disconnect`)
    }
    // Retain client/identity/host mapping for reauthorization, but not tokens.
    if (old) await this.store.setGrant(SIWC_RECORD, {
      ...old,
      access_token: null,
      refresh_token: null,
      id_token: null
    })
  }
}
