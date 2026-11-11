// Character limits of the free-text settings, shared by the server's
// validation and the settings screen's counters.

/** 設定 → パーソナライズ: read by every task, so it may be long. */
export const INSTRUCTIONS_MAX = 10_000

/**
 * 設定 → エージェントチーム (server/team-harness.js). Every turn of every
 * agent on that side carries the whole text, and a team runs up to 12
 * children at once, so the child harness is the shortest.
 */
export const HARNESS_MAX = { parent: 4_000, child: 2_000 }
