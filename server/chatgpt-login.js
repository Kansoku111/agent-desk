// Official SIWC dynamic registration. Codex images have a separate managed login.
import { createServer } from 'node:http'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SIWC_HOST, SIWC_RECORD, SIWC_REGISTRATION } from './credentials.js'
import {
  SIWC_ISSUER, SIWC_SCOPES, SIWC_RESOURCE, tokenRequest,
  verifySiwcIdToken, siwcCredential, withSiwcSessionLock,
} from './siwc-client.js'
const random = () => randomBytes(32).toString('base64url')
const same = (a, b) => typeof a === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export class ChatGptLogin {
  constructor({
    store,
    onState,
    openUrl = () => {},
    fetch: fetcher = fetch,
    verify = verifySiwcIdToken
  }) {
    this.store = store
    this.onState = onState
    this.openUrl = openUrl
    this.fetch = fetcher
    this.verify = verify
    this.state = {
      phase: 'idle'
    }
    this.abort = null
  }
  set(state) {
    this.state = state
    this.onState(state)
  }
  get running() {
    return this.abort !== null
  }
  start() {
    if (this.running) throw new Error('ChatGPT sign-in already running')
    const abort = new AbortController()
    this.abort = abort
    this.set({
      phase: 'starting',
      method: 'browser'
    })
    this.pending = this.run(abort).then(() => {
      if (!abort.signal.aborted) this.set({
        phase: 'done'
      })
    }).catch(error => {
      if (this.abort === abort) this.set(abort.signal.aborted ? {
        phase: 'idle'
      } : {
        phase: 'error',
        message: error.code
          ? `ChatGPT sign-in: ${error.code}`
          : 'ChatGPT sign-in failed. Retry Continue with ChatGPT; previous credentials were preserved.'
      })
    }).finally(() => {
      if (this.abort === abort) this.abort = null
    })
    return this.pending
  }
  async run(abort) {
    const {
      signal
    } = abort
    await fs.mkdir(path.dirname(this.store.file), {
      recursive: true
    })
    let hostId
    await withFileLock(`${this.store.file}.siwc-host`, async () => {
      hostId = (await this.store.read()).records?.[SIWC_HOST]?.payload?.ext_agent_host_id
      if (!hostId) {
        hostId = `urn:uuid:${randomUUID()}`
        await this.store.setGrant(SIWC_HOST, {
          ext_agent_host_id: hostId
        })
      }
    }, {
      waitMs: 15000
    })
    const snapshot = (await this.store.read()).records
    const previous = snapshot?.[SIWC_RECORD]?.payload
    const clientId = previous?.client_id ?? snapshot?.[SIWC_REGISTRATION]?.payload?.client_id ?? 'dynamic_agent_client'
    const fresh = clientId === 'dynamic_agent_client'
    const state = random(),
      nonce = random(),
      verifier = randomBytes(64).toString('base64url')
    let resolve,
      reject,
      consumed = false
    const callback = new Promise((yes, no) => {
      resolve = yes
      reject = no
    })
    callback.catch(() => {})
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname !== '/auth/callback') return response.writeHead(404).end('Not found')
      if (consumed) return response.writeHead(409).end('Attempt already consumed')
      consumed = true
      if (request.method !== 'GET' || !same(url.searchParams.get('state'), state)) {
        response.writeHead(400).end('Sign-in could not be verified')
        return reject(new Error('state mismatch'))
      }
      if (url.searchParams.has('error')) {
        response.writeHead(400).end('Authorization was not completed')
        return reject(new Error('authorization denied'))
      }
      const issued = url.searchParams.get('client_id') ?? (fresh ? null : clientId)
      const code = url.searchParams.get('code')
      if (!code || !issued || issued === 'dynamic_agent_client' || !fresh && issued !== clientId) {
        response.writeHead(400).end('Incomplete registration')
        return reject(new Error('client mismatch'))
      }
      response.end('Authorization received. Return to Agent Desk for validation status. You may close this tab.')
      resolve({
        code,
        clientId: issued
      })
    })
    await new Promise((yes, no) => {
      server.once('error', no)
      server.listen(0, '127.0.0.1', yes)
    })
    const timeout = setTimeout(() => reject(new Error('Sign-in timed out')), 600000)
    const onAbort = () => reject(new Error('Sign-in cancelled'))
    signal.addEventListener('abort', onAbort, {
      once: true
    })
    try {
      signal.throwIfAborted()
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`
      const url = new URL(`${SIWC_ISSUER}/api/accounts/authorize`)
      url.search = new URLSearchParams({
        client_id: clientId,
        ext_agent_host_id: hostId,
        ...(fresh ? {
          agent_name_hint: 'Agent Desk'
        } : {}),
        ...(!fresh && previous?.id_token ? {
          id_token_hint: previous.id_token
        } : {}),
        response_type: 'code',
        redirect_uri: redirect,
        scope: SIWC_SCOPES,
        resource: SIWC_RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url')
      }).toString()
      // Never broadcast an authorize URL: returning URLs can contain an ID-token hint.
      this.set({
        phase: 'browser',
        method: 'browser'
      })
      await this.openUrl(url.href)
      const result = await callback
      signal.throwIfAborted()
      await this.store.setGrant(SIWC_REGISTRATION, {
        client_id: result.clientId
      })
      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: result.clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirect
      }, {
        fetch: this.fetch,
        signal
      })
      if (!tokens.id_token) throw new Error('Missing ID token')
      const identity = await this.verify(tokens.id_token, result.clientId, {
        nonce,
        previous
      })
      signal.throwIfAborted()
      await withSiwcSessionLock(this.store, async () => {
        signal.throwIfAborted()
        const current = (await this.store.read()).records?.[SIWC_RECORD]?.payload
        if (current?.subject && (!previous?.subject || current.subject !== previous.subject
          || current.client_id !== previous.client_id)) {
          throw new Error('Selected account changed during sign-in')
        }
        await this.store.setGrant(SIWC_RECORD, siwcCredential(tokens, {
          clientId: result.clientId,
          hostId,
          identity,
          previous
        }))
      })
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      server.closeAllConnections()
      await new Promise(yes => server.close(yes))
    }
  }
  submitManualCode() {
    throw new Error('Official sign-in uses the local browser callback; retry Continue with ChatGPT')
  }
  cancel() {
    this.abort?.abort()
    this.set({
      phase: 'idle'
    })
  }
}
