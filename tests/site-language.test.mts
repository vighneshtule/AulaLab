import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (name: string) => readFileSync(path.join(root, name), 'utf8')

test('the public home page is English-only and links to the English docs', () => {
  for (const file of ['site/index.html', 'site/en/index.html']) {
    const page = read(file)
    assert.match(page, /<html[^>]*lang="en"/i, `${file} must declare English`)
    assert.doesNotMatch(page, /[А-Яа-яЁё]/, `${file} contains translated Russian text`)
    assert.doesNotMatch(page, /hreflang="ru"|href="\/ru\//i, `${file} links to a removed Russian page`)
    assert.match(page, /href="\/docs\//, `${file} should link to the English docs`)
  }
  assert.equal(existsSync(path.join(root, 'site/ru/index.html')), false)
})

test('all scenes referenced by the home page exist and are English assets', () => {
  const page = read('site/index.html')
  const refs = [...page.matchAll(/(?:src|data-src)="(\/img\/scenes\/[^\"]+\.svg)"/g)].map((m) => m[1])
  assert.ok(refs.length >= 5, `expected the homepage scenes, found ${refs.length}`)
  for (const ref of refs) {
    assert.doesNotMatch(ref, /-ru-/)
    assert.equal(existsSync(path.join(root, 'site', ref.slice(1))), true, `${ref} is missing`)
  }
})

test('Russian translated scene assets are absent', () => {
  for (const name of ['council', 'lecture', 'oracle', 'room', 'run']) {
    assert.equal(existsSync(path.join(root, `site/img/scenes/${name}-ru-light.svg`)), false)
    assert.equal(existsSync(path.join(root, `site/img/scenes/${name}-ru-dark.svg`)), false)
  }
})