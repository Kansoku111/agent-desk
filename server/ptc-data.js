import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

export const PTC_DATA_DESCRIPTION = 'Optional lossless JSON data for this call. Always supply code and description in the same call, before data; data alone does not stage input for a later call. Read it with await input.get() inside TypeScript programs. Put literal file contents here instead of embedding them in executable code strings; use the normal tools to write or edit files.'
export const PTC_DATA_PARAMETERS = { data: { type: 'json', description: PTC_DATA_DESCRIPTION } }

export function ptcDataParameters(runtime) {
  return runtime.language === 'typescript' ? PTC_DATA_PARAMETERS : {}
}

// A separate binding keeps file contents out of the compiler entirely. Do not
// rewrite source, interpolate templates, or bypass the guarded tool pipeline.
export function ptcDataBindings(args, runtime) {
  if (!Object.hasOwn(args, 'data')) return []
  if (runtime.language !== 'typescript') throw new Error('run_code.data requires the TypeScript runtime')
  let value
  try { value = snapshotJsonValue(args.data) } catch { /* Reject getters and invalid values without printing the data. */ }
  if (value === undefined) throw new TypeError('run_code.data must be lossless JSON')
  return [{
    global: 'input',
    functions: {
      get: async (options = {}) => {
        if (!options || typeof options !== 'object' || Object.keys(options).length) {
          throw new TypeError('input.get takes no options: input.get()')
        }
        return snapshotJsonValue(value)
      },
    },
  }]
}
