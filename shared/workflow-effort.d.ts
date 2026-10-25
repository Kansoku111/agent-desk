type Catalog = { effortsByModel: Record<string, { value: string }[]> }
export const CLAUDE_WORKFLOW_EFFORTS: string[]
export function workflowLevels(catalog: Catalog, model: string): string[] | undefined
export function workflowEffort(wanted: string | null | undefined, levels: string[] | undefined, modelChanged?: boolean): string
export function workflowOptions(wanted: string, levels: string[] | undefined): string[]
export function assertWorkflowEffort(wanted: string, parsed: { efforts: { value: string }[] }, label: string): void
export function assertWorkflowApplied(wanted: string, parsed: { currentEffort: string | null }, label: string): void
export function workflowTeamEfforts(config: unknown, catalog: Catalog, leaderModel: string | undefined, providers: Record<string, string>): void
