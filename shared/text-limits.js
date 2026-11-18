// Character limits of the free-text settings, shared by the server's
// validation and the settings screen's counters.

/** 設定 → パーソナライズ: combined length of the item bodies, including disabled items. */
export const INSTRUCTIONS_MAX = 10_000
export const INSTRUCTION_TITLE_MAX = 100

/**
 * 設定 → エージェントチーム (server/team-harness.js). Every turn of every
 * agent on that side carries the whole text, and a team runs up to 12
 * children at once, so the child harness is the shortest.
 */
export const HARNESS_MAX = { parent: 4_000, child: 2_000 }
