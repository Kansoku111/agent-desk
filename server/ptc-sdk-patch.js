/** Share only byte-identical output types; arguments, docs, keys and their order stay intact. */
export function shareOutputTypes(entries, indent = '  ') {
  const counts = new Map()
  for (const [, type] of entries) counts.set(type, (counts.get(type) ?? 0) + 1)
  const aliasByType = new Map(), aliases = []
  for (const [type, count] of counts) {
    if (count < 2) continue
    const alias = 'SharedOutput' + (aliases.length + 1)
    // Require a clear size win, including the new declaration and references.
    if ((count - 1) * (type.length - alias.length) <= type.length + alias.length + 11) continue
    aliasByType.set(type, alias)
    aliases.push('type ' + alias + ' = ' + type + ';')
  }
  return { aliases, members: entries.map(([name, type]) => indent + name + ': ' + (aliasByType.get(type) ?? type) + ';') }
}

const LOOP = "\tconst outputMembers = [];\n\tfor (const schema of sorted) {\n\t\targsMembers.push(...docLines$1(schema.description, 1));\n\t\targsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);\n\t\toutputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);\n\t}"
const SHARED_LOOP = "\tconst outputTypes = [];\n\tfor (const schema of sorted) {\n\t\targsMembers.push(...docLines$1(schema.description, 1));\n\t\targsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);\n\t\toutputTypes.push([renderKey(schema.name), jsonSchemaToTs(schema.output, 1)]);\n\t}\n\tconst shared = agentDeskShareOutputs(outputTypes, pad$1(1));"
const OUTPUT = "\t\t`interface ToolOutputMap {${outputMembers.length > 0 ? `\\n${outputMembers.join(\"\\n\")}\\n` : \"\"}}`,"
const SHARED_OUTPUT = "\t\t...(shared.aliases.length > 0 ? [shared.aliases.join(\"\\n\\n\")] : []),\n\t\t`interface ToolOutputMap {${shared.members.length > 0 ? `\\n${shared.members.join(\"\\n\")}\\n` : \"\"}}`,"

export function patchPtcSdkSource(source) {
  if (source.includes('agentDeskShareOutputs') || source.split('outputMembers').length !== 5
    || [LOOP, OUTPUT].some(anchor => source.split(anchor).length !== 2)) return null
  const imports = 'import { shareOutputTypes as agentDeskShareOutputs } from ' + JSON.stringify(new URL('./ptc-sdk-patch.js', import.meta.url).href) + ';\n'
  return imports + source.replace(LOOP, SHARED_LOOP).replace(OUTPUT, SHARED_OUTPUT)
}
