import readline from 'node:readline'
import fs from 'node:fs/promises'
import path from 'node:path'
const home = process.env.CODEX_HOME
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const notify = (method, params) => send({
  method,
  params
})
let logged = await fs.access(path.join(home, 'mock-auth')).then(() => true, () => false)
let initialized = false
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})) {
  const {
    id,
    method,
    params = {}
  } = JSON.parse(line)
  await fs.appendFile(path.join(home, 'mock-methods.jsonl'), JSON.stringify({
    method,
    ...(['initialize', 'thread/start'].includes(method) ? {
      params
    } : {})
  }) + '\n')
  if (id === undefined) continue
  const reply = result => send({
    id,
    result
  })
  if (method === 'initialize') {
    initialized = true
    reply({
      userAgent: 'mock'
    })
  } else if (!initialized) send({
    id,
    error: {
      message: 'Not initialized'
    }
  })
  else if (method === 'account/read') reply({
    account: logged ? {
      type: 'chatgpt',
      email: 'test@example.com',
      planType: 'plus'
    } : null
  })
  else if (method === 'account/login/start') {
    reply(params.type === 'chatgptDeviceCode' ? {
      type: params.type,
      loginId: 'login',
      userCode: 'TEST-CODE',
      verificationUrl: 'https://auth.openai.com/codex/device'
    } : {
      type: 'chatgpt',
      loginId: 'login',
      authUrl: 'https://auth.openai.com/mock'
    })
    setTimeout(async () => {
      logged = true
      await fs.writeFile(path.join(home, 'mock-auth'), 'mock')
      notify('account/login/completed', {
        loginId: 'login',
        success: true
      })
      notify('account/updated', {
        authMode: 'chatgpt'
      })
    }, 20)
  } else if (method === 'account/logout') {
    logged = false
    await fs.rm(path.join(home, 'mock-auth'), {
      force: true
    })
    reply({})
    notify('account/updated', {
      authMode: null
    })
  } else if (method === 'account/rateLimits/read') {
    const rateLimits = {
      limitId: 'codex',
      planType: 'plus',
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1900000000
      },
      secondary: {
        usedPercent: 50,
        windowDurationMins: 10080,
        resetsAt: 1900100000
      }
    }
    reply({
      rateLimits
    })
    notify('account/rateLimits/updated', {
      rateLimits
    })
  } else if (method === 'model/list') reply({
    data: [{
      model: 'gpt-6-luna',
      isDefault: true
    }]
  })
  else if (method === 'thread/start') reply({
    thread: {
      id: 'thread-mock'
    }
  })
  else if (method === 'turn/start') {
    const imageDir = path.join(home, 'generated_images', params.threadId)
    await fs.mkdir(imageDir, {
      recursive: true
    })
    const savedPath = path.join(imageDir, 'circle.png')
    await fs.writeFile(savedPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'))
    reply({
      turn: {
        id: 'turn-mock',
        status: 'inProgress',
        items: []
      }
    })
    const item = {
      type: 'imageGeneration',
      id: 'image-mock',
      status: 'completed',
      fileId: 'file-generated-image',
      savedPath,
      inputImages: [],
      revisedPrompt: 'A small blue circle.'
    }
    notify('item/completed', {
      threadId: params.threadId,
      item
    })
    notify('thread/tokenUsage/updated', {
      threadId: params.threadId,
      turnId: 'turn-mock',
      tokenUsage: {
        total: {
          inputTokens: 24000,
          outputTokens: 20,
          totalTokens: 24020,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0
        },
        last: {
          inputTokens: 24000,
          outputTokens: 20,
          totalTokens: 24020,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0
        }
      }
    })
    notify('turn/completed', {
      threadId: params.threadId,
      turn: {
        id: 'turn-mock',
        status: 'completed',
        items: [item]
      }
    })
  } else reply({})
}
