import { defaultUrlTransform } from 'react-markdown'

/**
 * react-markdown empties links whose scheme it does not know, which turns
 * `[a.zip](F:\dir\a.zip)` (the "scheme" is the drive letter) and `file://` links
 * into dead text. Those two forms are kept: they only ever reach FileRef, which
 * resolves them on the server and never navigates the page. Everything else
 * (javascript:, data:, …) still goes through the default filter.
 *
 * By the time this runs, markdown has percent-encoded the link: a backslash
 * arrives as `%5C`, so `F:\dir` is `F:%5Cdir`.
 */
export function linkTransform(url: string) {
  if (/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(url) || /^file:\/\//i.test(url)) return url
  return defaultUrlTransform(url)
}
