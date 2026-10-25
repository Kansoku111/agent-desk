// Test-only Vite entry: isolated RPC mocks live in ab-ui.tsx, images are local fixtures.
import { createServer } from 'vite'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const server = await createServer({ configFile: 'web/vite.config.ts', server: { port: 5175 }, plugins: [{
  name: 'ab-ui-test-images', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith('/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png')) return next()
      res.setHeader('Content-Type', 'image/png'); res.end(png)
    })
  },
}] })
await server.listen()
console.log(`AB UI fixture: http://127.0.0.1:5175/@fs/${process.cwd().replaceAll('\\', '/')}/test/fixtures/ab-ui.html?t=fixture`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
