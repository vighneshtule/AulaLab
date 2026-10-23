import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')

test('the repository documents one English README', () => {
  assert.equal(existsSync(path.join(root, 'README.ru.md')), false)
  assert.match(readme, /Quick start/i)
  assert.match(readme, /Room rules/i)
  assert.doesNotMatch(readme, /README\.ru\.md|\[Русский\]/i)
})

test('the README room rules refer to implementation source', () => {
  assert.ok(existsSync(path.join(root, 'web/src/lib/rule-rows.ts')))
  assert.match(readme, /room rules/i)
})