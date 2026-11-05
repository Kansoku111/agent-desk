// Only Agent Desk's disjoint built-in namespaces opt into concurrent startup.
// Custom/team servers retain the upstream order and startup side effects.
const BUILT_INS = new Set(['chrome', 'desktop', 'history', 'imagegen'])

export async function mountMcpServers(ctx, configs, Client) {
  if (configs.length < 2 || !configs.every(config => BUILT_INS.has(config.serverName))) {
    for (const config of configs) await ctx.plugin(Client, config)
    return
  }
  const fibers = [], starts = []
  try {
    for (const config of configs) {
      const fiber = ctx.plugin(Client, config)
      fibers.push(fiber)
      starts.push(Promise.resolve(fiber))
    }
    await Promise.all(starts)
  } catch (error) {
    // Observe every rejection before awaiting teardown. Otherwise a slow sibling
    // can keep connecting/registering after session creation has already failed.
    const settled = Promise.allSettled(starts)
    await Promise.allSettled(fibers.map(async fiber => fiber.dispose()))
    await settled
    throw error
  }
}
