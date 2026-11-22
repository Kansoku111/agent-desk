// dsh-acp and dsh-mcp-client repeat a four-character group that can exhaust
// V8's regexp stack on valid multi-megabyte prompts and tool images. Keep the
// alphabet check flat; the existing decode/re-encode check still enforces the
// exact grouping, padding and pad bits. Remove this once upstream handles large inputs.
const ANCHOR = `/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;`
const REPLACEMENT = `/** Base64 alphabet and optional padding; the decoder checks canonical form. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;`

export function patchImageBase64Source(source) {
  if (source.split(ANCHOR).length !== 2
    || !source.includes('if (data.toString("base64") !== block.data)')) return null
  return source.replace(ANCHOR, REPLACEMENT)
}
