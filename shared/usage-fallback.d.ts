export type UsageFallbackRoute = { model: string; effort: string }
export function fallbackProvider(model: string | null | undefined): string | null
export function usageFallbackChoice(routes: UsageFallbackRoute[] | null | undefined, currentModel: string | null | undefined): UsageFallbackRoute | null
export function validateUsageFallbackRoutes(routes: unknown): UsageFallbackRoute[]
