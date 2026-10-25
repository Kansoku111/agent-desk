// The RPC envelope owns `id`; AB sessions travel as `runId`.
export function createAbHandlers(ab) {
  return {
    'ab.config': () => ({ config: ab.config }),
    'ab.configure': ({ config }) => ab.configure(config),
    'ab.create': (input) => ab.create(input),
    ...Object.fromEntries(['approve', 'revise', 'stop', 'remove', 'retry', 'update'].map((method) => [
      `ab.${method}`, ({ runId, ...input }) => ab[method]({ ...input, id: runId }),
    ])),
  }
}
