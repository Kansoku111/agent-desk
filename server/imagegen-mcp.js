#!/usr/bin/env node
// The image tool's MCP server, as dsh launches it for each session.
//
// `generate_image` has a GPT model on the user's ChatGPT subscription draw the
// image (see imagegen.js), so a Claude task can make images too. The image is
// saved in the workspace, and a copy goes to Agent Desk's attachments folder
// so the task view can show it.
//
// Usage: node imagegen-mcp.js --codex-home <dir> --settings <file> --workspace <dir> --previews <dir>
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { CodexAppServer } from './codex-app-server.js'
import {
  BACKGROUNDS, FORMATS, MAX_REFERENCES, QUALITIES, SIZES,
  generateImage,
} from './imagegen.js'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const OUTPUT_DIR = 'generated-images'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

if (!option('codex-home')) throw new Error('--codex-home is required; the user Codex home is never used')
const codex = new CodexAppServer({ home: option('codex-home') })
const workspace = path.resolve(option('workspace') ?? process.cwd())
const previews = option('previews')

// ------------------------------------------------------------------ request

async function imageEnabled() {
  const file = option('settings')
  if (!file) return false
  try { return JSON.parse(await fs.readFile(file, 'utf8')).imageTool !== false } catch { return false }
}

// ------------------------------------------------------------------ tool

const TOOL = {
  name: 'generate_image',
  description: 'Generate an image with OpenAI\'s image model (GPT on the user\'s ChatGPT subscription) and save it in the workspace. '
    + 'Use it whenever the user asks for an illustration, picture, icon, photo-like image or other raster artwork, '
    + 'including when they ask for GPT to draw it: call it yourself, since subagents cannot. '
    + 'Write a detailed prompt in English (subject, style, composition, colors, any text to draw). '
    + 'Pass reference_images to edit an existing image or keep a subject consistent. One call makes one image and takes 20-90 seconds. '
    + 'The result gives the saved path; open it with an image-reading tool if you need to check it.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw, in detail.' },
      filename: { type: 'string', description: `File name (without folder) for the image, e.g. "cat-watercolor". Saved under ${OUTPUT_DIR}/ in the workspace; an existing file is never overwritten.` },
      size: { type: 'string', enum: SIZES, description: 'Image size. auto (default) lets the model choose.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Rendering quality. Higher is slower and uses more of the ChatGPT allowance.' },
      background: { type: 'string', enum: BACKGROUNDS, description: 'transparent needs png or webp.' },
      format: { type: 'string', enum: FORMATS, description: 'File format (default png).' },
      reference_images: { type: 'array', items: { type: 'string' }, maxItems: MAX_REFERENCES, description: 'Paths (relative to the workspace or absolute) of images to edit or use as references.' },
    },
    required: ['prompt'],
  },
}

async function generate(args) {
  return generateImage(args, { client: codex, workspace, previews, enabled: imageEnabled })
}

// ------------------------------------------------------------------ MCP over stdio

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return // notifications: initialized, cancelled
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-desk-imagegen', version: '0.1.0' },
        },
      })
    }
    if (method === 'ping') return send({ id, result: {} })
    if (method === 'tools/list') {
      return send({ id, result: { tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.inputSchema }] } })
    }
    if (method === 'tools/call') {
      if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      try {
        return send({ id, result: { content: await generate(params.arguments ?? {}) } })
      } catch (error) {
        const reason = error.name === 'TimeoutError' ? 'the image request timed out' : error.message
        return send({ id, result: { content: [{ type: 'text', text: reason }], isError: true } })
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } })
  }
}

// MCP requests are accepted independently; CodexAppServer serializes image turns.
const pending = new Set()
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const run = handle(message).finally(() => pending.delete(run))
  pending.add(run)
}).on('close', () => {
  void Promise.allSettled([...pending]).then(() => codex.stop()).then(() => process.exit(0))
})
