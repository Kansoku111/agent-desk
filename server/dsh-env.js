// The environment of every dsh process Agent Desk starts. Kept apart from
// runtime.js so a process that only spawns dsh (subagent-dsh.js) does not
// load the ACP client with it.

// Keys the app manages in the credential store. The launch environment would
// otherwise win over the store and silently ignore keys saved in Settings.
// Keep stripping the old OpenScale key so it isn't newly exposed to child processes.
const MANAGED_ENV = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENCODE_API_KEY', 'COMMAND_CODE_API_KEY', 'OPENSCALE_API_KEY', 'OPENAI_API_KEY', 'LOCAL_LLM_API_KEY', 'DSH_HOME', 'DSH_PERMISSION_MODE']

/** The environment every dsh process Agent Desk starts runs with. */
export function dshEnv(paths, mode, base = process.env) {
  const env = { ...base }
  for (const name of MANAGED_ENV) delete env[name]
  return Object.assign(env, {
    DSH_HOME: paths.dshHome,
    DSH_PERMISSION_MODE: mode,
    // Two separate opt-outs of dsh's OTel upload (session logs sent on /feedback):
    // the mode turns the exporter off, the second removes the plugin. Either still
    // holds if a dsh update renames the other.
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    AGENT_DESK_FAST_MODE: paths.fastMode,
    AGENT_DESK_OPENCODE_CATALOG: paths.opencodeGoCatalog,
    AGENT_DESK_SIWC_CREDENTIALS: paths.credentials,
    AGENT_DESK_SIWC_MANAGED: 'managed-by-agent-desk-siwc-hook',
  })
}
