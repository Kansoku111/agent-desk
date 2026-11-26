// Shared ACP extension names; importing these never loads dsh or installs hooks.
export const CUSTOM_INSTRUCTIONS_CONFIG = 'agent_desk_custom_instructions'
export const CUSTOM_INSTRUCTIONS_MODES = ['on', 'off']

export function assertCustomInstructionsMode(mode) {
  if (!CUSTOM_INSTRUCTIONS_MODES.includes(mode)) throw new Error('不明なパーソナライズ設定です')
}

export function customInstructionsOption(options) {
  return options?.find((option) => option.id === CUSTOM_INSTRUCTIONS_CONFIG)
}

export function assertCustomInstructionsApplied(options, mode) {
  if (customInstructionsOption(options)?.currentValue !== mode) {
    throw new Error('パーソナライズ設定を実行環境で確認できません。Agent Desk を再起動するか dsh との互換性を確認してください（送信は停止しました）')
  }
}
