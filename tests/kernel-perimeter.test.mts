/**
 * The hardened room profile on the docker backend (kernel/perimeter.ts, with
 * its pure builders in kernel/perimeter-core.ts).
 *
 * This proves what could otherwise be seen only during a live class: exactly
 * which `docker run` line a room gets, exactly which rules the helper installs,
 * and that the server REFUSES to start a room when the rules did not go in —
 * rather than silently starting it with an open network. There is no real
 * docker in the suite (see `_env.mts`), so docker is replaced with a function,
 * and the lines are compared whole. The live check on colima — packages,
 * refusals, a fork bomb — is described in the rollout report; it cannot be
 * repeated here.
 *
 * And the same builders for a machine's class kernels
 * (docs/architecture/remote-classes.md §7.1, §7.6): home's scripts word for
 * word as before, a machine's under names of its own, and home's mode as the
 * floor of every plan a machine installs.
 */
import './_env.mts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ownIdleMinutes, ownKernelMax, runArgs } from '../server/src/kernel/pool.js'
import {
  BLACKHOLE_DNS,
  BLOCKED_V4,
  DEFAULT_ROOM_SUBNET,
  RoomPerimeterError,
  blockedCidrsSetting,
  ensureRoomPerimeter,
  forgetPerimeter,
  helperArgs,
  helperImage,
  ipv4InCidr,
  ipv4Subnets,
  networkCreateArgs,
  ownAddresses,
  ownPidsLimit,
  perimeterProblem,
  perimeterRemovalScript,
  perimeterRules,
  perimeterScript,
  pidsLimit,
  roomHardening,
  roomHardeningArgs,
  roomNetworkMode,
  roomProfile,
  warmPerimeter,
  type DockerRun,
} from '../server/src/kernel/perimeter.js'
import * as home from '../server/src/kernel/perimeter.js'
import * as core from '../server/src/kernel/perimeter-core.js'
import { INSTANCE_LABEL } from '../server/src/runner-agent/images.js'
import { setLocaleResolver } from '../shared/i18n.js'

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  const restore = () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const out = body()
    if (out instanceof Promise) return out.finally(restore) as T
    restore()
    return out
  } catch (err) {
    restore()
    throw err
  }
}

afterEach(() => {
  forgetPerimeter()
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------ the docker run line */

test('a room on the host: its own network, a loopback port and the whole hardened profile — the full line', () => {
  const args = withEnv({ KERNEL_MEM: undefined, KERNEL_CPUS: undefined, KERNEL_PIDS: undefined }, () =>
    runArgs({
      sessionId: 'r1',
      env: 'base',
      mount: '/srv/workspace/r1',
      network: 'aulalab-rooms',
      publish: true,
      gpu: null,
    }),
  )
  const token = args[args.indexOf('-e') + 1]
  assert.match(token, /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.deepEqual(args, [
    'run', '-d', '--name', 'aulalab-room-r1',
    '--network', 'aulalab-rooms',
    '-p', '127.0.0.1:0:8888',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=512',
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    '--label', 'aulalab.profile=1',
    '-e', token,
    '-e', 'OMP_NUM_THREADS=2',
    '-e', 'MKL_NUM_THREADS=2',
    '-e', 'OPENBLAS_NUM_THREADS=2',
    '-e', 'NUMEXPR_NUM_THREADS=2',
    // How plotly hands over a figure: without this variable it decides itself,
    // and differently in different versions — 5.x adds `text/html` to the
    // figure and sends the whole plotly.js bundle as the first frame, five
    // megabytes of script nobody needs in the shared document
    // (kernel/room-spec.ts · roomRunArgs). A default, not a ban:
    // `pio.renderers.default` in a cell overrides it.
    '-e', 'PLOTLY_RENDERER=plotly_mimetype',
    // The class's one hash seed, the seventh variable (room-spec.ts ·
    // classHashSeed): the same number for r1 in every container, at home and
    // on every machine, release after release.
    '-e', 'PYTHONHASHSEED=3677742916',
    '-v', '/srv/workspace/r1:/workspace/r1',
    '--memory=4096m',
    '--memory-swap=4096m',
    '--cpus=2',
    '--restart=no',
    '--label', 'aulalab.kind=room-kernel',
    '--label', 'aulalab.session=r1',
    '--label', 'aulalab.environment=base',
    '--label', 'aulalab.role=room',
    'aulalab-kernel:base',
  ])
  // Not a single concession: no --privileged, no --cap-add, no host network.
  assert.ok(!args.some((arg) => /^--(privileged|cap-add|pid=)|^--network=host$|^host$/.test(arg)), JSON.stringify(args))
})

test('the container form: a shared network by name, the port is not published, the same profile', () => {
  const args = runArgs({
    sessionId: 'r2',
    env: 'base',
    mount: '/host/workspace/r2',
    network: 'aulalab',
    publish: false,
    gpu: null,
  })
  assert.equal(args[args.indexOf('--network') + 1], 'aulalab')
  assert.ok(!args.includes('-p'))
  for (const flag of roomHardeningArgs()) assert.ok(args.includes(flag), flag)
})

test('the process ceiling is KERNEL_PIDS, and a silly number does not lift it', () => {
  withEnv({ KERNEL_PIDS: undefined }, () => assert.equal(pidsLimit(), 512))
  withEnv({ KERNEL_PIDS: '2048' }, () => {
    assert.equal(pidsLimit(), 2048)
    assert.ok(runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'aulalab-rooms', publish: true, gpu: null }).includes('--pids-limit=2048'))
  })
  // Zero, a negative, a word, a fraction and too few for Jupyter — the
  // default, not "no ceiling" and not a room that cannot even start a kernel.
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_PIDS: bad }, () => assert.equal(pidsLimit(), 512, bad))
  }
})

test('the personal notebooks container: the same profile, but without a GPU, with its own label and its own ceiling', () => {
  const room = runArgs({
    sessionId: 'r3', env: 'base-gpu', mount: '/srv/workspace/r3',
    network: 'aulalab-rooms', publish: true, gpu: '0',
  })
  const own = withEnv({ KERNEL_OWN_PIDS: undefined }, () =>
    runArgs({
      sessionId: 'r3', env: 'base-gpu', mount: '/srv/workspace/r3',
      network: 'aulalab-rooms', publish: true, gpu: '0', role: 'own',
    }),
  )

  // The name and the label — so that cleanup, `aulalab status` and slice
  // allocation can tell them apart.
  assert.equal(own[own.indexOf('--name') + 1], 'aulalab-room-r3-own')
  assert.ok(own.includes('aulalab.role=own'), JSON.stringify(own))
  assert.ok(room.includes('aulalab.role=room'), JSON.stringify(room))

  /*
   * No card, no slice label, no shared memory for it — and this is not a
   * setting but the design: a GPU is given to a container whole, and a
   * student removes `CUDA_VISIBLE_DEVICES` with one line. The slice is passed
   * on purpose: a caller's mistake must not be able to hand the card to the
   * drafts.
   */
  assert.ok(room.includes('--gpus'), 'the room was left without a card')
  assert.ok(!own.includes('--gpus'), JSON.stringify(own))
  assert.ok(!own.some((arg) => /^--label$/.test(arg) && false))
  assert.ok(!own.some((arg) => arg.startsWith('aulalab.gpu=')), JSON.stringify(own))
  assert.ok(!own.some((arg) => arg.startsWith('--shm-size')), JSON.stringify(own))

  // Its own process ceiling: it holds dozens of kernels, and the room's 512
  // would not be enough.
  assert.ok(own.includes('--pids-limit=2048'), JSON.stringify(own))
  assert.ok(room.includes('--pids-limit=512'), JSON.stringify(room))

  // Everything else is the same: image, network, class folder, profile, numbers.
  assert.equal(own.at(-1), room.at(-1))
  assert.equal(own[own.indexOf('--network') + 1], 'aulalab-rooms')
  assert.equal(own[own.indexOf('-v') + 1], '/srv/workspace/r3:/workspace/r3')
  for (const flag of ['--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges']) {
    assert.ok(own.includes(flag), flag)
  }
  assert.equal(
    own.find((arg) => arg.startsWith('--memory=')),
    room.find((arg) => arg.startsWith('--memory=')),
  )

  // It has ITS OWN token: otherwise a line from a draft would open the
  // lecture's Jupyter.
  const tokenOf = (args: string[]) => args.find((arg) => arg.startsWith('JUPYTER_TOKEN='))
  assert.match(tokenOf(own) ?? '', /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.notEqual(tokenOf(own), tokenOf(room))
})

test('the process ceiling of the personal notebooks container is KERNEL_OWN_PIDS, and junk does not lift it', () => {
  withEnv({ KERNEL_OWN_PIDS: undefined }, () => assert.equal(ownPidsLimit(), 2048))
  withEnv({ KERNEL_OWN_PIDS: '4096' }, () => {
    assert.equal(ownPidsLimit(), 4096)
    const args = runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'aulalab-rooms', publish: true, gpu: null, role: 'own' })
    assert.ok(args.includes('--pids-limit=4096'), JSON.stringify(args))
  })
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_OWN_PIDS: bad }, () => assert.equal(ownPidsLimit(), 2048, bad))
  }
  // And the ceiling on LIVE kernels in it is a separate number, read by the
  // same rule.
  // Sixty since the instance settings (it was forty); the panel moves it without a restart.
  withEnv({ KERNEL_OWN_MAX: undefined }, () => assert.equal(ownKernelMax(), 60))
  withEnv({ KERNEL_OWN_MAX: '4' }, () => assert.equal(ownKernelMax(), 4))
  for (const bad of ['0', '-1', 'сорок', '1.5', '']) {
    withEnv({ KERNEL_OWN_MAX: bad }, () => assert.equal(ownKernelMax(), 60, bad))
  }

  /*
   * The idle time of a personal kernel is a third number, and for it `0` IS
   * MEANINGFUL.
   *
   * For the ceilings zero is meaningless and reads as junk; here it is a switch
   * for someone whose class is organised differently, and mixing them up
   * would quietly turn the sweep on where it was turned off.
   */
  withEnv({ KERNEL_OWN_IDLE_MIN: undefined }, () => assert.equal(ownIdleMinutes(), 30))
  withEnv({ KERNEL_OWN_IDLE_MIN: '5' }, () => assert.equal(ownIdleMinutes(), 5))
  withEnv({ KERNEL_OWN_IDLE_MIN: ' 0 ' }, () => assert.equal(ownIdleMinutes(), 0))
  for (const bad of ['-1', 'полчаса', '1.5', '']) {
    withEnv({ KERNEL_OWN_IDLE_MIN: bad }, () => assert.equal(ownIdleMinutes(), 30, bad))
  }
})

test('AULALAB_ROOM_NETWORK: only the word open opens it, a typo does not open the network', () => {
  assert.equal(roomNetworkMode({}), 'blocked')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: 'blocked' }), 'blocked')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: ' Open ' }), 'open')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: 'opne' }), 'blocked')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: '1' }), 'blocked')
})

test('the rooms network: its own subnet, no ICC and no IPv6', () => {
  assert.deepEqual(networkCreateArgs(DEFAULT_ROOM_SUBNET), [
    'network', 'create', '--driver=bridge', '--subnet=10.213.0.0/22', '--ipv6=false',
    '-o', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'aulalab.kind=room-network',
    'aulalab-rooms',
  ])
  // The subnet is taken — docker picks one itself, everything else is the same.
  assert.ok(!networkCreateArgs(null).some((arg) => arg.startsWith('--subnet')))
})

/* ---------------------------------------------------------------- addresses */

test('addresses and subnets are computed honestly', () => {
  assert.equal(ipv4InCidr('10.213.3.255', '10.213.0.0/22'), true)
  assert.equal(ipv4InCidr('10.213.4.0', '10.213.0.0/22'), false)
  assert.equal(ipv4InCidr('192.168.1.64', '192.168.0.0/16'), true)
  assert.equal(ipv4InCidr('172.32.0.1', '172.16.0.0/12'), false)
  assert.equal(ipv4InCidr('1.2.3.4', '0.0.0.0/0'), true)
  assert.equal(ipv4InCidr('300.1.1.1', '0.0.0.0/0'), false)
  assert.equal(ipv4InCidr('fe80::1', '0.0.0.0/0'), false)
  // docker prints subnets separated by spaces, with v6 alongside — we drop it.
  assert.deepEqual(ipv4Subnets('172.19.0.0/16 fd00:dead::/64 '), ['172.19.0.0/16'])
  assert.deepEqual(ipv4Subnets(''), [])
})

test("the only exemption is the server's own addresses inside the rooms subnet", () => {
  const nic = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({
    address, family, internal, netmask: '', mac: '', cidr: null,
  }) as never
  const found = ownAddresses(['172.19.0.0/16'], {
    lo: [nic('127.0.0.1', 'IPv4', true)],
    eth0: [nic('172.18.0.5'), nic('fe80::1', 'IPv6')],
    eth1: [nic('172.19.0.2')],
  })
  assert.deepEqual(found, ['172.19.0.2'])
})

/* ------------------------------------------------------------- rules */

test('rules: replies, exemptions and DNS pass, private ranges and the host itself are refused; full lines', () => {
  const rules = perimeterRules({ subnets: ['172.19.0.0/16'], exempt: ['172.19.0.2'] })
  const deny = BLOCKED_V4.map((range) => `-A AULALAB-ROOMS-FWD -s 172.19.0.0/16 -d ${range} -j AULALAB-ROOMS-DENY`)
  assert.equal(
    rules,
    [
      '*filter',
      ':AULALAB-ROOMS-FWD - [0:0]',
      ':AULALAB-ROOMS-IN - [0:0]',
      ':AULALAB-ROOMS-DENY - [0:0]',
      '-A AULALAB-ROOMS-DENY -p tcp -j REJECT --reject-with tcp-reset',
      '-A AULALAB-ROOMS-DENY -j REJECT --reject-with icmp-admin-prohibited',
      '-A AULALAB-ROOMS-FWD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A AULALAB-ROOMS-FWD -s 172.19.0.2/32 -j RETURN',
      '-A AULALAB-ROOMS-FWD -p udp -m udp --dport 53 -j RETURN',
      '-A AULALAB-ROOMS-FWD -p tcp -m tcp --dport 53 -j RETURN',
      '-A AULALAB-ROOMS-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A AULALAB-ROOMS-IN -s 172.19.0.2/32 -j RETURN',
      '-A AULALAB-ROOMS-IN -p udp -m udp --dport 53 -j RETURN',
      '-A AULALAB-ROOMS-IN -p tcp -m tcp --dport 53 -j RETURN',
      ...deny,
      '-A AULALAB-ROOMS-IN -s 172.19.0.0/16 -j AULALAB-ROOMS-DENY',
      'COMMIT',
      '',
    ].join('\n'),
  )
  // The list of what is closed is exactly what was promised to the owner and
  // in the documentation.
  assert.deepEqual([...BLOCKED_V4], [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
  ])
})

test('the fallback set without REJECT differs only in the refusal action', () => {
  const plan = { subnets: ['10.213.0.0/22'], exempt: [] }
  const reject = perimeterRules(plan, 'reject').split('\n')
  const drop = perimeterRules(plan, 'drop').split('\n')
  assert.deepEqual(drop.filter((line) => line.startsWith('-A AULALAB-ROOMS-DENY')), ['-A AULALAB-ROOMS-DENY -j DROP'])
  assert.deepEqual(
    drop.filter((line) => !line.startsWith('-A AULALAB-ROOMS-DENY')),
    reject.filter((line) => !line.startsWith('-A AULALAB-ROOMS-DENY')),
  )
})

test('the helper script touches only its own and names the reason for a refusal', () => {
  const script = perimeterScript({ subnets: ['10.213.0.0/22'], exempt: [] })
  // iptables of the same dockerd, in its mount namespace.
  assert.match(script, /nsenter -t "\$pid" -m -- "\$@"/)
  assert.match(script, /readlink "\$p\/ns\/net"/)
  // Atomically and without flushing anyone else's rules.
  assert.match(script, /iptables-restore -w --noflush/)
  assert.ok(!/iptables(-restore)? [^\n]*(-F|--flush)( |$)/m.test(script), 'the install script flushes something')
  // Jumps — once, after a check, with our comment.
  assert.match(script, /-C DOCKER-USER -m comment --comment aulalab-rooms -j AULALAB-ROOMS-FWD/)
  assert.match(script, /-I DOCKER-USER 1 -m comment --comment aulalab-rooms -j AULALAB-ROOMS-FWD/)
  assert.match(script, /-I INPUT 1 -m comment --comment aulalab-rooms -j AULALAB-ROOMS-IN/)
  for (const code of [20, 21, 22, 23]) assert.match(script, new RegExp(`exit ${code}`))
  assert.match(script, /say ok\n$/)

  const removal = perimeterRemovalScript()
  // Exactly what was inserted is removed — by the same line — and only our chains.
  assert.match(removal, /-D DOCKER-USER -m comment --comment aulalab-rooms -j AULALAB-ROOMS-FWD/)
  assert.match(removal, /-D INPUT -m comment --comment aulalab-rooms -j AULALAB-ROOMS-IN/)
  for (const line of removal.split('\n').filter((l) => / -[FX] /.test(l))) {
    assert.match(line, /for chain in AULALAB-ROOMS-FWD AULALAB-ROOMS-IN AULALAB-ROOMS-DENY; do fw iptables -w -[FX] "\$chain"/)
  }
})

test('the helper is privileged, but lives for a second and does not pull an image', () => {
  assert.deepEqual(helperArgs('aulalab-kernel:base', 'echo hi'), [
    'run', '--rm', '--privileged', '--pid=host', '--network=host', '--user=0:0',
    '--pull=never', '--no-healthcheck', '--label', 'aulalab.kind=room-perimeter',
    '--entrypoint=sh', 'aulalab-kernel:base', '-c', 'echo hi',
  ])
})

/* ------------------------------------------------------------ installation */

interface Call { args: string[] }

/** A docker that remembers calls and answers by the test's rules. */
function fakeDocker(answer: (args: string[]) => { code: number; out: string }): { docker: DockerRun; calls: Call[] } {
  const calls: Call[] = []
  const docker: DockerRun = async (args) => {
    calls.push({ args })
    return answer(args)
  }
  return { docker, calls }
}

const isHelper = (args: string[]) => args[0] === 'run' && args.includes('--privileged')
const helperScript = (args: string[]) => args[args.length - 1]

function standardAnswers(helper: (script: string) => { code: number; out: string }) {
  return (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'inspect') return { code: 0, out: '10.213.0.0/22 ' }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 0, out: 'sha256:abc' }
    if (isHelper(args)) return helper(helperScript(args))
    return { code: 1, out: `unexpected: docker ${args.join(' ')}` }
  }
}

test('the rules went in — the room proceeds, and for a minute the helper is not called again', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: ok' })))
    const target = { network: 'aulalab-rooms', create: true }
    await ensureRoomPerimeter(docker, target, 'aulalab-kernel:base')
    await ensureRoomPerimeter(docker, target, 'aulalab-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args))
    assert.equal(helpers.length, 1, 'the helper is called on every start')
    assert.match(helperScript(helpers[0].args), /-A AULALAB-ROOMS-IN -s 10\.213\.0\.0\/22 -j AULALAB-ROOMS-DENY/)
    assert.equal(perimeterProblem(), null)
  })
})

test('the rules did not go in — a refusal with translated text and a way out, not an open network', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const said = 'aulalab-perimeter: no DOCKER-USER chain: Docker does not manage iptables on this host'
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 21, out: said })))
    const target = { network: 'aulalab-rooms', create: true }

    setLocaleResolver(() => 'ru')
    const ru = await ensureRoomPerimeter(docker, target, 'aulalab-kernel:base').then(
      () => assert.fail('the room started without the block'),
      (err: unknown) => err,
    )
    assert.ok(ru instanceof RoomPerimeterError)
    assert.match(ru.message, /Комнату не запустить/)
    assert.match(ru.message, /no DOCKER-USER chain/)
    assert.match(ru.message, /AULALAB_ROOM_NETWORK=open/)
    assert.equal(perimeterProblem(), ru.message)

    // A refusal is not remembered as a success: the next start tries again —
    // and says the same thing in English.
    setLocaleResolver(() => 'en')
    const en = await ensureRoomPerimeter(docker, target, 'aulalab-kernel:base').then(
      () => assert.fail('the second start went through without the block'),
      (err: unknown) => err,
    )
    assert.ok(en instanceof RoomPerimeterError)
    assert.match(en.message, /The room cannot start/)
    assert.match(en.message, /AULALAB_ROOM_NETWORK=open/)
  })
})

test('the helper cannot be started (no rights for --privileged) — a refusal too', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const { docker } = fakeDocker(
      standardAnswers(() => ({ code: 125, out: 'docker: Error response from daemon: privileged mode is not allowed.' })),
    )
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base'), (err: unknown) => {
      assert.ok(err instanceof RoomPerimeterError)
      assert.match(err.reason, /privileged mode is not allowed/)
      return true
    })
  })
})

test('an answer without "ok" is not a success, even with a zero code', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 0, out: '' })))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base'), RoomPerimeterError)
  })
})

test('AULALAB_ROOM_NETWORK=open: rules are not installed, old ones are removed, no refusal', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: 'open' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: removed' })))
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args)).map((call) => helperScript(call.args))
    assert.equal(helpers.length, 1, 'the old rules must be removed once per launch')
    assert.ok(!/iptables-restore/.test(helpers[0]), 'the block was installed in open mode')
    assert.match(helpers[0], /-D DOCKER-USER/)
    assert.equal(perimeterProblem(), null)
  })
})

test('no rooms network — one is created; the subnet is taken — docker picks one itself', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined, KERNEL_ROOM_SUBNET: undefined }, async () => {
    let created = false
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return created ? { code: 0, out: '172.30.0.0/16' } : { code: 1, out: 'Error: No such network: aulalab-rooms' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('--subnet=10.213.0.0/22')) return { code: 1, out: 'Error response from daemon: Pool overlaps with other one on this address space' }
        created = true
        return { code: 0, out: 'abc' }
      }
      if (args[0] === 'image') return { code: 0, out: 'sha256:abc' }
      if (isHelper(args)) return { code: 0, out: 'aulalab-perimeter: ok' }
      return { code: 1, out: 'unexpected' }
    })
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    const creates = calls.filter((call) => call.args[1] === 'create')
    assert.equal(creates.length, 2)
    assert.ok(!creates[1].args.some((arg) => arg.startsWith('--subnet')))
    // The rules follow the subnet the network actually got.
    const script = helperScript(calls.find((call) => isHelper(call.args))!.args)
    assert.match(script, /-s 172\.30\.0\.0\/16 -d 192\.168\.0\.0\/16/)
  })
})

test('an explicitly named subnet is not silently replaced', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined, KERNEL_ROOM_SUBNET: '10.99.0.0/24' }, async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args[1] === 'inspect' && args[0] === 'network') return { code: 1, out: 'No such network' }
      if (args[1] === 'create') return { code: 1, out: 'Pool overlaps with other one on this address space' }
      return { code: 1, out: 'unexpected' }
    })
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, null), RoomPerimeterError)
    assert.equal(calls.filter((call) => call.args[1] === 'create').length, 1)
    assert.ok(calls.some((call) => call.args.includes('--subnet=10.99.0.0/24')))
  })
})

test('the server does not create the shared compose network: if it is missing — a refusal', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(() => ({ code: 1, out: 'Error: No such network: aulalab' }))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab', create: false }, 'aulalab-kernel:base'), RoomPerimeterError)
    assert.ok(!calls.some((call) => call.args[1] === 'create'))
  })
})

test('there is no kernel image at all — a refusal, the helper is not called', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === 'network') return { code: 0, out: '10.213.0.0/22' }
      if (args[0] === 'image') return { code: 1, out: 'No such image' }
      if (args[0] === 'images') return { code: 0, out: '' }
      return { code: 1, out: 'unexpected' }
    })
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base'), /aulalab-kernel image/)
    assert.ok(!calls.some((call) => isHelper(call.args)))
  })
})

test('the personal notebooks container takes ITS OWN numbers if the class named them', () => {
  /*
   * The teacher sets the class "Memory" field for their own work — for the
   * dataset they load during the lecture. They did not sign up to hand the
   * same amount to thirty drafts, and on the machine that is exactly twice
   * the memory.
   */
  const args = (memoryMb: number | null, cpus: number | null) =>
    runArgs({
      sessionId: 'r4', env: 'base', mount: '/m', network: 'aulalab-rooms',
      publish: true, gpu: null, role: 'own', memoryMb, cpus,
    })
  const mine = args(2048, 1)
  assert.ok(mine.includes('--memory=2048m'), JSON.stringify(mine))
  assert.ok(mine.includes('--memory-swap=2048m'), JSON.stringify(mine))
  assert.ok(mine.includes('--cpus=1'), JSON.stringify(mine))
  // numpy and torch threads are counted by the ALLOCATED cores, not by the
  // machine's cores: otherwise one core would get thirty threads on it.
  assert.ok(mine.includes('OMP_NUM_THREADS=1'), JSON.stringify(mine))

  // Not named — the old behaviour: the same as the room.
  const same = withEnv({ KERNEL_MEM: undefined, KERNEL_CPUS: undefined }, () => args(null, null))
  assert.ok(same.includes('--memory=4096m'), JSON.stringify(same))
  assert.ok(same.includes('--cpus=2'), JSON.stringify(same))
})

/* --------------------------------------------- none, extra ranges, helper image */

/*
 * University installs (Sep 2026): IT decides whether student code reaches the
 * internet and campus services at all. AULALAB_ROOM_NETWORK=none cuts a room
 * off entirely, KERNEL_BLOCKED_CIDRS adds ranges to the private ones, and the
 * privileged helper no longer runs from the image teachers edit.
 */

test('AULALAB_ROOM_NETWORK=none is its own mode, and it also marks and changes the container', () => {
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: 'none' }), 'none')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: ' NONE ' }), 'none')
  assert.equal(roomNetworkMode({ AULALAB_ROOM_NETWORK: 'non' }), 'blocked', 'a typo never loosens')
  assert.equal(roomProfile({}), '1')
  assert.equal(roomProfile({ AULALAB_ROOM_NETWORK: 'open' }), '1')
  assert.equal(roomProfile({ AULALAB_ROOM_NETWORK: 'none' }), '1-none')

  // The resolver's upstream is an address the rules refuse, so not even DNS
  // leaves through the daemon's own namespace; both containers of a room get it.
  for (const role of ['room', 'own'] as const) {
    const none = withEnv({ AULALAB_ROOM_NETWORK: 'none' }, () =>
      runArgs({ sessionId: 'n1', env: 'base', mount: '/m', network: 'aulalab-rooms', publish: true, gpu: null, role }),
    )
    assert.ok(none.includes(`--dns=${BLACKHOLE_DNS}`), JSON.stringify(none))
    assert.ok(none.includes('aulalab.profile=1-none'), JSON.stringify(none))
  }
  assert.equal(BLACKHOLE_DNS, '192.0.2.1')
  for (const mode of [undefined, 'open', 'blocked']) {
    const args = withEnv({ AULALAB_ROOM_NETWORK: mode }, () => roomHardeningArgs())
    assert.ok(!args.some((arg) => arg.startsWith('--dns')), `${mode}: ${JSON.stringify(args)}`)
    assert.ok(args.includes('aulalab.profile=1'), `${mode}: ${JSON.stringify(args)}`)
  }
})

test('none: replies and the server pass, everything a room starts is refused, DNS included; full lines', () => {
  const rules = perimeterRules({ subnets: ['172.19.0.0/16'], exempt: ['172.19.0.2'], mode: 'none' })
  assert.equal(
    rules,
    [
      '*filter',
      ':AULALAB-ROOMS-FWD - [0:0]',
      ':AULALAB-ROOMS-IN - [0:0]',
      ':AULALAB-ROOMS-DENY - [0:0]',
      '-A AULALAB-ROOMS-DENY -p tcp -j REJECT --reject-with tcp-reset',
      '-A AULALAB-ROOMS-DENY -j REJECT --reject-with icmp-admin-prohibited',
      // The server reaches Jupyter inside: its NEW connection comes from the
      // host or from its own exempt address, and the room's answer is ESTABLISHED.
      '-A AULALAB-ROOMS-FWD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A AULALAB-ROOMS-FWD -s 172.19.0.2/32 -j RETURN',
      '-A AULALAB-ROOMS-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A AULALAB-ROOMS-IN -s 172.19.0.2/32 -j RETURN',
      '-A AULALAB-ROOMS-FWD -s 172.19.0.0/16 -j AULALAB-ROOMS-DENY',
      '-A AULALAB-ROOMS-IN -s 172.19.0.0/16 -j AULALAB-ROOMS-DENY',
      'COMMIT',
      '',
    ].join('\n'),
  )
  assert.ok(!/--dport 53/.test(rules), 'none let DNS out')
  // The fallback without REJECT is the same set with DROP.
  const drop = perimeterRules({ subnets: ['10.213.0.0/22'], exempt: [], mode: 'none' }, 'drop')
  assert.match(drop, /-A AULALAB-ROOMS-DENY -j DROP\n/)
  assert.match(drop, /-A AULALAB-ROOMS-FWD -s 10\.213\.0\.0\/22 -j AULALAB-ROOMS-DENY\n/)
})

test('extra ranges are refused after the private ones, and DNS still passes before them', () => {
  const rules = perimeterRules({ subnets: ['10.213.0.0/22'], exempt: [], extra: ['203.0.113.0/24', '198.51.100.7/32'] }).split('\n')
  const dns = rules.indexOf('-A AULALAB-ROOMS-FWD -p udp -m udp --dport 53 -j RETURN')
  const campus = rules.indexOf('-A AULALAB-ROOMS-FWD -s 10.213.0.0/22 -d 203.0.113.0/24 -j AULALAB-ROOMS-DENY')
  const host = rules.indexOf('-A AULALAB-ROOMS-FWD -s 10.213.0.0/22 -d 198.51.100.7/32 -j AULALAB-ROOMS-DENY')
  const lastPrivate = rules.indexOf('-A AULALAB-ROOMS-FWD -s 10.213.0.0/22 -d 240.0.0.0/4 -j AULALAB-ROOMS-DENY')
  assert.ok(dns >= 0 && lastPrivate > dns && campus === lastPrivate + 1 && host === campus + 1, rules.join('\n'))
  // No extra ranges: exactly the old set.
  assert.equal(
    perimeterRules({ subnets: ['10.213.0.0/22'], exempt: [], extra: [] }),
    perimeterRules({ subnets: ['10.213.0.0/22'], exempt: [] }),
  )
})

test('KERNEL_BLOCKED_CIDRS: addresses and ranges, normalised; v6 has nothing to act on; junk is named', () => {
  assert.deepEqual(blockedCidrsSetting({}), { cidrs: [], ignored: [], invalid: [] })
  assert.deepEqual(
    blockedCidrsSetting({ KERNEL_BLOCKED_CIDRS: ' 203.0.113.0/24, 198.51.100.7\n10.1.2.3/8 203.0.113.9/24,,2001:db8::/32 ' }),
    {
      // A bare address is that address; host bits are cleared; a repeat and a
      // built-in range (10/8) are not written twice.
      cidrs: ['203.0.113.0/24', '198.51.100.7/32'],
      ignored: ['2001:db8::/32'],
      invalid: [],
    },
  )
  const junk = blockedCidrsSetting({ KERNEL_BLOCKED_CIDRS: 'campus.example.edu,10.0.0.0/33,300.1.1.1,1.2.3,10.0.0.0/8/1,203.0.113.0/24' })
  assert.deepEqual(junk.invalid, ['campus.example.edu', '10.0.0.0/33', '300.1.1.1', '1.2.3', '10.0.0.0/8/1'])
  assert.deepEqual(junk.cidrs, ['203.0.113.0/24'])
})

test('a broken KERNEL_BLOCKED_CIDRS refuses the room with its own text; the helper is not even called', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined, KERNEL_BLOCKED_CIDRS: '203.0.113.0/24, campus' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: ok' })))
    setLocaleResolver(() => 'en')
    const err = await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base').then(
      () => assert.fail('the room started with a broken blocklist'),
      (e: unknown) => e,
    )
    assert.ok(err instanceof RoomPerimeterError)
    assert.match(err.message, /KERNEL_BLOCKED_CIDRS/)
    assert.match(err.message, /\(campus\)/)
    assert.equal(perimeterProblem(), err.message)
    assert.ok(!calls.some((call) => isHelper(call.args)))
    setLocaleResolver(() => 'ru')
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base'), /KERNEL_BLOCKED_CIDRS/)
  })
})

test('a good KERNEL_BLOCKED_CIDRS goes into the rules; in the none and open modes it has nothing to add and refuses nothing', async () => {
  await withEnv({ AULALAB_ROOM_NETWORK: undefined, KERNEL_BLOCKED_CIDRS: '203.0.113.0/24' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: ok' })))
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    const script = helperScript(calls.find((call) => isHelper(call.args))!.args)
    assert.match(script, /-A AULALAB-ROOMS-FWD -s 10\.213\.0\.0\/22 -d 203\.0\.113\.0\/24 -j AULALAB-ROOMS-DENY/)
  })
  forgetPerimeter()
  await withEnv({ AULALAB_ROOM_NETWORK: 'none', KERNEL_BLOCKED_CIDRS: 'campus' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: ok' })))
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    const script = helperScript(calls.find((call) => isHelper(call.args))!.args)
    assert.match(script, /-A AULALAB-ROOMS-FWD -s 10\.213\.0\.0\/22 -j AULALAB-ROOMS-DENY/)
    assert.ok(!/--dport 53/.test(script), 'none let DNS out')
    assert.ok(!/-d 10\.0\.0\.0\/8/.test(script), 'none wrote per-range rules')
  })
  forgetPerimeter()
  await withEnv({ AULALAB_ROOM_NETWORK: 'open', KERNEL_BLOCKED_CIDRS: 'campus' }, async () => {
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: removed' })))
    await ensureRoomPerimeter(docker, { network: 'aulalab-rooms', create: true }, 'aulalab-kernel:base')
    assert.equal(perimeterProblem(), null)
  })
})

test('switching between blocked and none rewrites the rules at once, without waiting out the minute', async () => {
  const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'aulalab-perimeter: ok' })))
  const target = { network: 'aulalab-rooms', create: true }
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, () => ensureRoomPerimeter(docker, target, 'aulalab-kernel:base'))
  await withEnv({ AULALAB_ROOM_NETWORK: 'none' }, () => ensureRoomPerimeter(docker, target, 'aulalab-kernel:base'))
  const scripts = calls.filter((call) => isHelper(call.args)).map((call) => helperScript(call.args))
  assert.equal(scripts.length, 2)
  assert.match(scripts[0], /--dport 53/)
  assert.ok(!/--dport 53/.test(scripts[1]))
})

/* ----------------------------------------------------------- helper image */

const SELF = `sha256:${'5'.repeat(64)}`
const PINNED = `sha256:${'7'.repeat(64)}`

function imageAnswers(extra: (args: string[]) => { code: number; out: string } | null = () => null) {
  return (args: string[]) => {
    const special = extra(args)
    if (special) return special
    if (args[0] === 'network' && args[1] === 'inspect') return { code: 0, out: '172.19.0.0/16 ' }
    if (args[0] === 'inspect' && args.includes('container')) return { code: 0, out: SELF }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 0, out: 'sha256:abc' }
    if (isHelper(args)) return { code: 0, out: 'aulalab-perimeter: ok' }
    return { code: 1, out: `unexpected: docker ${args.join(' ')}` }
  }
}
const helperImageOf = (args: string[]) => args[args.indexOf('--entrypoint=sh') + 1]

test('the server in a container runs the helper from its OWN image, found by AULALAB_CONTAINER or the hostname', async () => {
  const { docker, calls } = fakeDocker(imageAnswers())
  const inContainer = () => true
  assert.equal(await helperImage(docker, 'aulalab-kernel:base', { env: { AULALAB_CONTAINER: 'aulalab' }, inContainer }), SELF)
  assert.deepEqual(calls[0].args, ['inspect', '--type', 'container', '--format', '{{.Image}}', 'aulalab'])
  forgetPerimeter()
  calls.length = 0
  assert.equal(await helperImage(docker, 'aulalab-kernel:base', { env: {}, inContainer, hostname: () => '3f2a9c1b7d4e' }), SELF)
  assert.equal(calls[0].args.at(-1), '3f2a9c1b7d4e')
  // Once found, remembered: a running container never changes its image.
  await helperImage(docker, 'aulalab-kernel:base', { env: {}, inContainer, hostname: () => '3f2a9c1b7d4e' })
  assert.equal(calls.length, 1)
  // Never a kernel image, which teachers edit from the panel.
  assert.ok(!calls.some((call) => call.args.includes('aulalab-kernel:base') || call.args[0] === 'images'))

  // The whole install: the helper's image is the server's ID, not the room's tag.
  forgetPerimeter()
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, () =>
    ensureRoomPerimeter(docker, { network: 'aulalab', create: false }, 'aulalab-kernel:base', { env: {}, inContainer, hostname: () => 'self' }),
  )
  const helper = calls.find((call) => isHelper(call.args))!
  assert.equal(helperImageOf(helper.args), SELF)
})

test('a server in a container that cannot find itself refuses, rather than falling back to the kernel image', async () => {
  const { docker, calls } = fakeDocker(imageAnswers((args) =>
    args[0] === 'inspect' && args.includes('container') ? { code: 1, out: 'Error: No such container: renamed-host' } : null,
  ))
  setLocaleResolver(() => 'en')
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, async () => {
    const err = await ensureRoomPerimeter(docker, { network: 'aulalab', create: false }, 'aulalab-kernel:base', {
      env: {}, inContainer: () => true, hostname: () => 'renamed-host',
    }).then(() => assert.fail('the helper ran without a trusted image'), (e: unknown) => e)
    assert.ok(err instanceof RoomPerimeterError)
    assert.match(err.message, /AULALAB_CONTAINER/)
    assert.match(err.message, /renamed-host/)
  })
  assert.ok(!calls.some((call) => isHelper(call.args)))
})

test('AULALAB_HELPER_IMAGE wins everywhere and runs by its ID; one that is not on the machine is a refusal, never a pull', async () => {
  const { docker, calls } = fakeDocker(imageAnswers((args) =>
    args[0] === 'image' && args.includes('registry.example.edu/tools/nsenter:1') ? { code: 0, out: PINNED } : null,
  ))
  for (const inContainer of [() => true, () => false]) {
    calls.length = 0
    forgetPerimeter()
    const env = { AULALAB_HELPER_IMAGE: 'registry.example.edu/tools/nsenter:1', AULALAB_CONTAINER: 'aulalab' }
    assert.equal(await helperImage(docker, 'aulalab-kernel:base', { env, inContainer }), PINNED)
    assert.ok(!calls.some((call) => call.args.includes('container')), 'looked for itself despite the override')
  }
  const missing = fakeDocker(imageAnswers((args) =>
    args[0] === 'image' && args.includes('ghcr.io/example/helper:2') ? { code: 1, out: 'Error: No such image' } : null,
  ))
  setLocaleResolver(() => 'en')
  await assert.rejects(
    helperImage(missing.docker, 'aulalab-kernel:base', { env: { AULALAB_HELPER_IMAGE: 'ghcr.io/example/helper:2' }, inContainer: () => true }),
    (err: unknown) => err instanceof RoomPerimeterError && /docker pull/.test(err.message) && /ghcr\.io\/example\/helper:2/.test(err.message),
  )
  assert.ok(!missing.calls.some((call) => call.args[0] === 'pull'))
})

test('on a teacher laptop (server on the host) the helper keeps using the kernel image, as before', async () => {
  const { docker, calls } = fakeDocker(imageAnswers())
  assert.equal(await helperImage(docker, 'aulalab-kernel:base', { env: {}, inContainer: () => false }), 'aulalab-kernel:base')
  assert.ok(!calls.some((call) => call.args.includes('container')))
  const none = fakeDocker((args) => {
    if (args[0] === 'image') return { code: 1, out: 'No such image' }
    if (args[0] === 'images') return { code: 0, out: 'aulalab-kernel:<none>\naulalab-kernel:kaggle-base\n' }
    return { code: 1, out: 'unexpected' }
  })
  assert.equal(await helperImage(none.docker, 'aulalab-kernel:base', { env: {}, inContainer: () => false }), 'aulalab-kernel:kaggle-base')
})

test('at server start in a container the block goes up even before any kernel image is built', async () => {
  const { docker, calls } = fakeDocker(imageAnswers((args) =>
    args[0] === 'image' || args[0] === 'images' ? { code: 1, out: 'No such image' } : null,
  ))
  await withEnv({ AULALAB_ROOM_NETWORK: undefined }, () =>
    warmPerimeter(docker, { network: 'aulalab', create: false }, 'aulalab-kernel:base', { env: {}, inContainer: () => true, hostname: () => 'self' }),
  )
  const helper = calls.find((call) => isHelper(call.args))
  assert.ok(helper, 'no helper at start')
  assert.equal(helperImageOf(helper.args), SELF)
  assert.equal(perimeterProblem(), null)
})

/* ------------------------------------------------- the core, home and machines */

/*
 * The builders live in perimeter-core.ts, pure, so that a machine's agent
 * installs the very rules home does (docs/architecture/remote-classes.md
 * §7.1). Home's scripts stay word for word what the tests above pin; a
 * machine's are the same lines under names of its own.
 */

/** A machine's instance label, in the agent's shape (runner-agent/images.ts · INSTANCE_LABEL). */
const MACHINE_LABEL = 'ru.aulalab.competition-instance=a1b2c3d4e5f60718'
const MACHINE = core.machinePerimeter(MACHINE_LABEL)

test('every name perimeter.ts always exported is still there, and the builders among them are the core\'s own', () => {
  const moved = [
    'BLACKHOLE_DNS', 'BLOCKED_V4', 'DEFAULT_ROOM_SUBNET', 'PERIMETER_KIND', 'PERIMETER_TAG', 'ROOM_NETWORK', 'ROOM_PROFILE',
    'blockedCidrsSetting', 'helperArgs', 'ipv4InCidr', 'ipv4Subnets', 'networkCreateArgs', 'ownAddresses', 'parseCidr',
    'parseIpv4', 'perimeterRemovalScript', 'perimeterRules', 'perimeterScript', 'roomNetworkMode', 'roomProfile', 'roomSubnetSetting',
  ] as const
  // One binding, not a copy: what home installs and what a machine installs cannot drift apart.
  for (const name of moved) assert.equal(home[name], core[name], name)
  // What stays home's: the ceilings from the instance settings, the installation, the refusal in words.
  for (const name of ['pidsLimit', 'ownPidsLimit', 'roomHardening', 'roomHardeningArgs', 'ensureRoomPerimeter', 'warmPerimeter', 'helperImage',
    'perimeterProblem', 'perimeterStale', 'forgetPerimeter', 'RoomPerimeterError'] as const) {
    assert.equal(typeof home[name], 'function', name)
  }
  assert.ok(!('pidsLimit' in core) && !('RoomPerimeterError' in core), 'the core reads a setting or speaks home\'s words')
})

test('home\'s hardening is the core\'s, with the numbers home reads for each role', () => {
  for (const mode of [undefined, 'none', 'open', 'blocked']) {
    withEnv({ AULALAB_ROOM_NETWORK: mode, KERNEL_PIDS: undefined, KERNEL_OWN_PIDS: undefined }, () => {
      for (const role of ['room', 'own', 'council'] as const) {
        const numbers = roomHardening(process.env, role)
        assert.deepEqual(numbers, {
          pids: role === 'room' ? 512 : 2048,
          mode: roomNetworkMode(),
          profile: core.profileFor(roomNetworkMode()),
        }, `${mode} ${role}`)
        assert.deepEqual(roomHardeningArgs(process.env, role), core.roomHardeningArgs(numbers), `${mode} ${role}`)
      }
    })
  }
  // The core lays out whatever it is given, with nothing read on the side.
  assert.deepEqual(core.roomHardeningArgs({ pids: 77, mode: 'none', profile: '1-none' }), [
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=77',
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1', '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    '--dns=192.0.2.1', '--label', 'aulalab.profile=1-none',
  ])
  assert.deepEqual(['blocked', 'open', 'none'].map((mode) => core.profileFor(mode as core.RoomNetworkMode)), ['1', '1', '1-none'])
})

test('home\'s scope is the one its rooms always lived under, and it is every builder\'s default', () => {
  assert.deepEqual({ ...core.HOME_PERIMETER, labels: [...core.HOME_PERIMETER.labels] }, {
    network: 'aulalab-rooms', chains: 'AULALAB-ROOMS', tag: 'aulalab-rooms', labels: ['aulalab.kind=room-network'],
  })
  for (const plan of [
    { subnets: ['172.19.0.0/16'], exempt: ['172.19.0.2'] },
    { subnets: ['10.213.0.0/22'], exempt: [], mode: 'none' as const },
    { subnets: ['10.213.0.0/22'], exempt: [], extra: ['203.0.113.0/24'] },
  ]) {
    for (const deny of ['reject', 'drop'] as const) assert.equal(perimeterRules(plan, deny), core.perimeterRules(plan, deny, core.HOME_PERIMETER))
    assert.equal(perimeterScript(plan), core.perimeterScript(plan, core.HOME_PERIMETER))
  }
  assert.equal(perimeterRemovalScript(), core.perimeterRemovalScript(core.HOME_PERIMETER))
  assert.deepEqual(networkCreateArgs(DEFAULT_ROOM_SUBNET), core.networkCreateArgs(DEFAULT_ROOM_SUBNET, core.HOME_PERIMETER))
})

test('a machine\'s perimeter is named by six hex characters of the agent\'s label: its bridge, its chains, its comment', () => {
  assert.deepEqual(MACHINE, {
    i6: 'a1b2c3',
    network: 'aulalab-mrooms-a1b2c3',
    chains: 'AULALAB-MRa1b2c3',
    tag: 'aulalab-mrooms-a1b2c3',
    labels: ['aulalab.kind=class-network', MACHINE_LABEL],
  })
  // iptables holds 28 characters of a chain's name.
  for (const chain of ['FWD', 'IN', 'DENY']) assert.ok(`${MACHINE.chains}-${chain}`.length <= 28)
  // The agent's real label has that shape.
  const real = core.machinePerimeter(INSTANCE_LABEL)
  assert.equal(real.network, `aulalab-mrooms-${INSTANCE_LABEL.split('=')[1]!.slice(0, 6)}`)
  // §7.1's spelling, `AULALAB-MR<i6>`: the six characters as the label has them, the same in every name.
  assert.equal(real.chains, `AULALAB-MR${real.i6}`)
  for (const name of [MACHINE.network, MACHINE.chains, MACHINE.tag]) assert.ok(name.endsWith(MACHINE.i6), name)
  // A label of another shape is a caller's mistake: a perimeter named by a guess could be another agent's.
  for (const bad of ['', 'a1b2c3', 'aulalab.kind=class-kernel', 'ru.aulalab.competition-instance=a1b2c', 'ru.aulalab.competition-instance=A1B2C3D4', 'x=a1b2c3 ']) {
    assert.throws(() => core.machinePerimeter(bad), /not an agent instance label/, bad)
  }
})

test('a machine\'s rules are home\'s lines under its own chains — full lines', () => {
  const plan = { subnets: ['10.214.0.0/22'], exempt: [], extra: ['203.0.113.0/24'] }
  const rules = core.perimeterRules(plan, 'reject', MACHINE)
  const deny = [...BLOCKED_V4, '203.0.113.0/24'].map((range) => `-A AULALAB-MRa1b2c3-FWD -s 10.214.0.0/22 -d ${range} -j AULALAB-MRa1b2c3-DENY`)
  assert.equal(rules, [
    '*filter',
    ':AULALAB-MRa1b2c3-FWD - [0:0]',
    ':AULALAB-MRa1b2c3-IN - [0:0]',
    ':AULALAB-MRa1b2c3-DENY - [0:0]',
    '-A AULALAB-MRa1b2c3-DENY -p tcp -j REJECT --reject-with tcp-reset',
    '-A AULALAB-MRa1b2c3-DENY -j REJECT --reject-with icmp-admin-prohibited',
    '-A AULALAB-MRa1b2c3-FWD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    '-A AULALAB-MRa1b2c3-FWD -p udp -m udp --dport 53 -j RETURN',
    '-A AULALAB-MRa1b2c3-FWD -p tcp -m tcp --dport 53 -j RETURN',
    '-A AULALAB-MRa1b2c3-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
    '-A AULALAB-MRa1b2c3-IN -p udp -m udp --dport 53 -j RETURN',
    '-A AULALAB-MRa1b2c3-IN -p tcp -m tcp --dport 53 -j RETURN',
    ...deny,
    // The agent reaches its rooms from the host: the IN chain refuses the rooms subnet to it.
    '-A AULALAB-MRa1b2c3-IN -s 10.214.0.0/22 -j AULALAB-MRa1b2c3-DENY',
    'COMMIT',
    '',
  ].join('\n'))
  // Home's very lines, only the chains renamed: the same rules by construction, in every mode and fallback.
  for (const p of [plan, { subnets: ['10.214.0.0/22'], exempt: [], mode: 'none' as const }]) {
    for (const action of ['reject', 'drop'] as const) {
      assert.equal(core.perimeterRules(p, action, MACHINE), perimeterRules(p, action).replaceAll('AULALAB-ROOMS-', 'AULALAB-MRa1b2c3-'))
    }
  }
})

test('a machine\'s helper hooks and unhooks only its own chains, by its own comment, and names its refusals as home\'s does', () => {
  const plan = { subnets: ['10.214.0.0/22'], exempt: [] }
  const script = core.perimeterScript(plan, MACHINE)
  assert.match(script, /-C DOCKER-USER -m comment --comment aulalab-mrooms-a1b2c3 -j AULALAB-MRa1b2c3-FWD/)
  assert.match(script, /-I DOCKER-USER 1 -m comment --comment aulalab-mrooms-a1b2c3 -j AULALAB-MRa1b2c3-FWD/)
  assert.match(script, /-I INPUT 1 -m comment --comment aulalab-mrooms-a1b2c3 -j AULALAB-MRa1b2c3-IN/)
  for (const code of [20, 21, 22, 23]) assert.match(script, new RegExp(`exit ${code}`))
  const removal = core.perimeterRemovalScript(MACHINE)
  assert.match(removal, /-D DOCKER-USER -m comment --comment aulalab-mrooms-a1b2c3 -j AULALAB-MRa1b2c3-FWD/)
  assert.match(removal, /-D INPUT -m comment --comment aulalab-mrooms-a1b2c3 -j AULALAB-MRa1b2c3-IN/)
  assert.match(removal, /for chain in AULALAB-MRa1b2c3-FWD AULALAB-MRa1b2c3-IN AULALAB-MRa1b2c3-DENY; do fw iptables -w -F "\$chain"/)
  // Not a word of home's: neither home's chains nor home's comment, so neither script can touch a home's rooms.
  for (const text of [script, removal]) {
    assert.ok(!/AULALAB-ROOMS|aulalab-rooms/.test(text), text)
  }
  // And otherwise home's scripts, line for line.
  const rename = (text: string) => text.replaceAll('AULALAB-ROOMS-', 'AULALAB-MRa1b2c3-').replaceAll('--comment aulalab-rooms ', '--comment aulalab-mrooms-a1b2c3 ')
  assert.equal(script, rename(perimeterScript(plan)))
  assert.equal(removal, rename(perimeterRemovalScript()))
})

test('a machine\'s bridge: its own name and labels, no ICC, no IPv6', () => {
  assert.deepEqual(core.networkCreateArgs('10.214.0.0/22', MACHINE), [
    'network', 'create', '--driver=bridge', '--subnet=10.214.0.0/22', '--ipv6=false',
    '-o', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'aulalab.kind=class-network',
    '--label', MACHINE_LABEL,
    'aulalab-mrooms-a1b2c3',
  ])
  assert.ok(!core.networkCreateArgs(null, MACHINE).some((arg) => arg.startsWith('--subnet')))
})

test('home\'s mode is the floor: a machine may be stricter and block more ranges, never fewer', () => {
  const subnets = ['10.214.0.0/22']
  const blocked = (blockedCidrs: string[] = []) => ({ mode: 'blocked' as const, blockedCidrs })
  // Home's ranges arrive with the intent; the machine adds its own, normalised, without repeats or built-in ones.
  assert.deepEqual(core.machinePerimeterPlan(subnets, blocked(['203.0.113.0/24'])), { subnets, exempt: [], mode: 'blocked', extra: ['203.0.113.0/24'] })
  assert.deepEqual(
    core.machinePerimeterPlan(subnets, blocked(['203.0.113.0/24']), blocked(['198.51.100.7', '203.0.113.9/24', '10.1.2.3/8', '2001:db8::/32'])),
    { subnets, exempt: [], mode: 'blocked', extra: ['203.0.113.0/24', '198.51.100.7/32'] },
  )
  assert.deepEqual(core.machinePerimeterPlan(subnets, blocked()), { subnets, exempt: [], mode: 'blocked' })
  // Nothing a machine says takes one of home's ranges away.
  for (const own of [[], ['198.51.100.0/24'], ['203.0.113.0/25']]) {
    const plan = core.machinePerimeterPlan(subnets, blocked(['203.0.113.0/24', '192.0.2.10']), blocked(own))
    for (const range of ['203.0.113.0/24', '192.0.2.10/32']) assert.ok(plan.extra?.includes(range), `${own}: ${JSON.stringify(plan)}`)
    // And the machine's script refuses each of them.
    const script = core.perimeterScript(plan, MACHINE)
    assert.match(script, /-A AULALAB-MRa1b2c3-FWD -s 10\.214\.0\.0\/22 -d 203\.0\.113\.0\/24 -j AULALAB-MRa1b2c3-DENY/)
  }
  // The stricter mode wins, either way round; `open` is no mode for a machine, whoever asks for it.
  const modes = ['open', 'blocked', 'none'] as const
  for (const homeMode of modes) {
    for (const machineMode of modes) {
      const plan = core.machinePerimeterPlan(subnets, { mode: homeMode, blockedCidrs: [] }, { mode: machineMode, blockedCidrs: [] })
      const expected = homeMode === 'none' || machineMode === 'none' ? 'none' : 'blocked'
      assert.equal(plan.mode, expected, `${homeMode} + ${machineMode}`)
      assert.ok(core.atLeastAsStrict(plan.mode!, homeMode) && core.atLeastAsStrict(plan.mode!, machineMode), `${homeMode} + ${machineMode}`)
    }
  }
  // None refuses everything a room starts: the ranges have nothing to add, and are not read.
  assert.deepEqual(core.machinePerimeterPlan(subnets, { mode: 'none', blockedCidrs: ['campus'] }, blocked(['203.0.113.0/24'])), { subnets, exempt: [], mode: 'none' })
  // A range that is not one is a refusal, from either side: a typo would leave exactly that range open.
  assert.throws(() => core.machinePerimeterPlan(subnets, blocked(['203.0.113.0/24', 'campus'])), /not an IPv4 address or range: campus/)
  assert.throws(() => core.machinePerimeterPlan(subnets, blocked(), blocked(['10.0.0.0/33'])), /10\.0\.0\.0\/33/)
})

test('a plan that would fence nothing is refused, never installed: no subnet, or one that is not a range', () => {
  const homePolicy = { mode: 'blocked' as const, blockedCidrs: ['203.0.113.0/24'] }
  // A bridge read before it exists has no subnet: the chains would go in empty, and the helper would still say ok.
  for (const mode of ['blocked', 'none'] as const) {
    assert.throws(() => core.machinePerimeterPlan([], { ...homePolicy, mode }), /no rooms subnet fences nothing/, mode)
  }
  // An address without its prefix fences one host of the bridge, a v6 range nothing at all, and what is not a
  // range at all must never reach the root helper's script.
  for (const bad of ['10.214.0.0', 'fd00::/64', '10.214.0.0/33', 'aulalab-mrooms-a1b2c3', '10.214.0.0/22\nAULALAB_RULES\nid']) {
    assert.throws(() => core.machinePerimeterPlan(['10.214.0.0/22', bad], homePolicy), /not an IPv4 rooms subnet/, JSON.stringify(bad))
  }
  // The same below the plan, in either scope: no rules body fences nothing, home's included.
  for (const scope of [MACHINE, core.HOME_PERIMETER]) {
    for (const plan of [{ subnets: [], exempt: [] }, { subnets: [], exempt: [], mode: 'none' as const }, { subnets: ['10.214.0.0'], exempt: [] }]) {
      const what = `${scope.chains} ${JSON.stringify(plan)}`
      assert.throws(() => core.perimeterRules(plan, 'reject', scope), /no rooms subnet fences nothing|not an IPv4 rooms subnet/, what)
      assert.throws(() => core.perimeterScript(plan, scope), /no rooms subnet fences nothing|not an IPv4 rooms subnet/, what)
    }
  }
  // What the bridge has is laid out as a range, normalised as the blocked ranges are, and fenced in full.
  const plan = core.machinePerimeterPlan(['10.214.1.9/22'], homePolicy)
  assert.deepEqual(plan.subnets, ['10.214.0.0/22'])
  const rules = core.perimeterRules(plan, 'reject', MACHINE)
  assert.match(rules, /^-A AULALAB-MRa1b2c3-IN -s 10\.214\.0\.0\/22 -j AULALAB-MRa1b2c3-DENY$/m)
  // Every built-in range and home's one beyond the host, and the host itself.
  assert.equal(rules.split('\n').filter((line) => line.endsWith('-j AULALAB-MRa1b2c3-DENY')).length, BLOCKED_V4.length + 2)
})

test('how strict a mode is: none refuses more than blocked, which refuses more than open', () => {
  const table = (['open', 'blocked', 'none'] as const).map((mode) => (['open', 'blocked', 'none'] as const).map((floor) => core.atLeastAsStrict(mode, floor)))
  assert.deepEqual(table, [
    [true, false, false],
    [true, true, false],
    [true, true, true],
  ])
})
