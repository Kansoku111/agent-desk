// dsh-tool-fs-search buffers the entire rg output before applying its inline
// caps. Broad searches can overflow the 20 MB transport and fail. Replace only
// that transport and propagate an explicit partial result through the existing
// schema/render/spill paths. Small searches keep upstream behavior unchanged.

export function patchFsSearchSource(source) {
  const start = source.indexOf('async function runRipgrep(')
  const end = source.indexOf('\n}\n', start) + 2
  if (start === -1 || end < start || !source.slice(start, end).includes('stdout: completeStdout(toolName, stdout, rawOutputMaxBytes)')) return null
  let patched = source.slice(0, start) + `async function runRipgrep(ctx, exec, toolName, argv, rawOutputMaxBytes, graceMs, stderrMaxBytes) {
\treturn runBoundedSearch(ctx, exec, toolName, argv, rawOutputMaxBytes, graceMs, stderrMaxBytes, { resolveRgPath, SearchError, classifyRunFailure });
}` + source.slice(end)
  const replacements = [
    ['Use the glob tool — not shell find — to discover files by path pattern.', 'Use the glob tool — not shell find — to discover files by path pattern. Start with a relevant directory and a specific filename or extension pattern; expand only as needed. A bare * searches recursively, not just the root. Discover a path before assuming it exists. Partial results do not establish absence: narrow the search instead of repeating the same broad request.'],
    ['Use the grep tool — not shell grep or rg — to search file contents.', 'Use the grep tool — not shell grep or rg — to search file contents. Start in the relevant directory with an appropriate include filter, then expand only as needed. Omit include when unused; do not pass an empty string. Partial results do not establish absence: narrow the search instead of repeating the same broad request.'],
    ['and reports where the complete list was saved.', 'and reports where the complete list was saved. If the search output limit is reached, it returns explicitly partial results with an unknown total; narrow the search to continue.'],
    ['a larger result reports where the complete match list was saved.', 'a larger result reports where the complete match list was saved. If the search output limit is reached, it returns explicitly partial results with an unknown total; narrow the search to continue.'],
    ['\t\t\t\t\troot: {', '\t\t\t\t\tpartial: { type: "boolean" },\n\t\t\t\t\troot: {'],
    ['properties: { matches: {', 'properties: { partial: { type: "boolean" }, matches: {'],
    ['\t\t\t\tpaths: all\n', '\t\t\t\tpaths: all,\n\t\t\t\tpartial: run.partial\n'],
    ['return { matches: all };', 'return { matches: all, partial: run.partial };'],
    ['text: renderGlobPaths(value.paths, caps, value.root)', 'text: value.partial ? partialSearchText(value.paths.slice(0, caps.maxResults).join("\\n"), Math.min(value.paths.length, caps.maxResults), "paths") : renderGlobPaths(value.paths, caps, value.root)'],
    ['\t\t\tpresentationMeta: (_args, value) => {\n', '\t\t\tpresentationMeta: (_args, value) => {\n\t\t\t\tif (value.partial) return { partial: true };\n'],
    ['text: formatRetainedGrep(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes))', 'text: value.partial ? partialSearchText(formatGrepMatches(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes).items), Math.min(value.matches.length, caps.maxMatches), "matches") : formatRetainedGrep(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes))'],
    ['presentationMeta: (_args, value) => grepSearchMeta(', 'presentationMeta: (_args, value) => value.partial ? { partial: true } : grepSearchMeta('],
    ['\t\tconst paths = value.paths;\n', '\t\tif (value.partial) return decision; // Never label a partial artifact as the full sorted result.\n\t\tconst paths = value.paths;\n'],
    ['\t\tconst matches = value.matches;\n', '\t\tif (value.partial) return decision; // A stopped search has no complete result to spill.\n\t\tconst matches = value.matches;\n'],
  ]
  for (const [before, after] of replacements) {
    const at = patched.indexOf(before)
    if (at === -1 || patched.indexOf(before, at + 1) !== -1) return null
    patched = patched.slice(0, at) + after + patched.slice(at + before.length)
  }
  return `import { runBoundedSearch, partialSearchText } from ${JSON.stringify(new URL('./fs-search.js', import.meta.url).href)};\n${patched}`
}
