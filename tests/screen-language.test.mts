import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { messages } from '../shared/i18n.js'
import { collectClientKeys } from '../web/scripts/entry-messages.js'
import config from '../web/vite.config.js'

const root = path.resolve(import.meta.dirname, '..')
const folder = path.join(root, 'web/src/lib/messages')
const plugin = (config as any).plugins.find((item: any) => item.name === 'aulalab-screen-language')

function built(area: string): Record<string, Record<string, unknown>> {
  const file = path.join(folder, `${area}-en.ts`)
  const code = plugin.load.call({ addWatchFile() {} }, file) as string
  assert.match(code, /^import \{ registerMessages \} from '@shared\/i18n-runtime'/)
  return JSON.parse(code.slice(code.indexOf('registerMessages(') + 'registerMessages('.length, code.lastIndexOf(')')))
}

test('only English screen catalogs are shipped', () => {
  const files = fs.readdirSync(folder).sort()
  assert.deepEqual(files, ['admin-en.ts', 'competitions-en.ts', 'reader-en.ts', 'room-en.ts'])
  const loader = fs.readFileSync(path.join(root, 'web/src/lib/screen-language.ts'), 'utf8')
  for (const file of files) assert.ok(loader.includes(`./messages/${file.replace(/\.ts$/, '')}`), file)
  assert.doesNotMatch(loader, /-ru/)
})

test('each screen catalog contains English text and only the keys it needs', () => {
  const room = built('room')
  const admin = built('admin')
  const reader = built('reader')
  const competitions = built('competitions')
  for (const [name, catalog] of Object.entries({ room, admin, reader, competitions })) {
    for (const pair of Object.values(catalog)) assert.deepEqual(Object.keys(pair), ['en'], `${name} includes another locale`)
  }
  assert.ok(room['room.ui.0'] && room['common.reload'] && room['activity.title'])
  assert.equal(room['admin.teaching'], undefined)
  assert.ok(admin['admin.teaching'] && admin['room.ui.0'])
  assert.ok(reader['room.ui.0'])
  assert.equal(reader['admin.teaching'], undefined)
  assert.ok(competitions['competitions.state.live'] && competitions['common.reload'])
  assert.equal(competitions['room.ui.0'], undefined)
  assert.equal(competitions['admin.teaching'], undefined)
  assert.equal(room['room.ui.0'].en, messages['room.ui.0'].en)
})

test('the room bundle remains smaller than the full shared dictionary', () => {
  const whole = Buffer.byteLength(JSON.stringify(messages))
  const room = Buffer.byteLength(JSON.stringify(built('room')))
  assert.ok(room * 3 < whole, `room ${room} B against the shared dictionary ${whole} B`)
})

test('the room contains the server words looked up by browser code', () => {
  const client = collectClientKeys(root, messages, 'server')
  const room = built('room')
  for (const key of client) assert.ok(room[key], `${key} did not reach the room`)
  assert.equal(room['server.zip.footer'], undefined)
})