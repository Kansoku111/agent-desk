import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { linkTransform } from '../web/src/link-transform.ts'

/** The href the `a` component receives for a markdown link, through the real parser. */
function hrefOf(target) {
  let seen
  const a = ({ href, children }) => {
    seen = href
    return React.createElement('a', null, children)
  }
  renderToStaticMarkup(React.createElement(ReactMarkdown, { urlTransform: linkTransform, components: { a } }, `[x](${target})`))
  return seen
}

test('Windows paths and file URLs survive markdown, so they can open in Explorer', () => {
  assert.equal(decodeURIComponent(hrefOf('F:\\Agent-Desk-DSH\\release\\a.zip')), 'F:\\Agent-Desk-DSH\\release\\a.zip')
  assert.equal(decodeURIComponent(hrefOf('c:/Users/me/a.zip')), 'c:/Users/me/a.zip')
  assert.match(hrefOf('file:///F:/a.zip'), /^file:\/\/\/F:/)
})

test('other links keep the default filtering', () => {
  assert.equal(hrefOf('src/app.ts'), 'src/app.ts')
  assert.equal(hrefOf('https://example.com'), 'https://example.com')
  assert.equal(hrefOf('javascript:alert(1)'), '')
  assert.equal(hrefOf('data:text/html,x'), '')
})
