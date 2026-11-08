import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

export const PTC_DATA_DESCRIPTION = 'Optional lossless JSON data, available through await input.get({}) inside TypeScript programs. Put literal file contents here instead of embedding them in executable code strings. Data is not executed; use the normal tools to write or edit files.'
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
      get: async (options) => {
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length) {
          throw new TypeError('input.get takes an empty arguments object: input.get({})')
        }
        return snapshotJsonValue(value)
      },
    },
  }]
}
