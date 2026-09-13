import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { digest, openStore, withProjectLock } from '../src/collaboration-store.js'

async function fixture(t) {
  const base = await fs.mkdtemp(join(tmpdir(), 'collaboration-store-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return { base, config: { stateRoot: join(base, 'state'), projectRoot: join(base, 'project'), mode: 'collaboration',
    publicPaths: ['public/'], privatePaths: ['private/'], publicBrief: 'Public contract', localProvider: 'local',
    localModel: 'qwen', cloudProvider: 'cloud', cloudModel: 'deepseek', sensitiveTerms: ['CANARY'],
    blockEmails: true, blockPhones: true, blockLocalPaths: true, integrationCommand: 'node --test' } }
}
const record = text => ({ version: 1, turns: [[{ role: 'user', text }]], runs: {} })
async function publicFile(config) { return join(config.stateRoot, (await fs.readdir(config.stateRoot)).find(name => name.endsWith('.public.json'))) }

// Catches shared filenames, world-readable persistence, and non-durable writes.
test('public and private histories survive restart in separate owner-only files', async t => {
  const { config } = await fixture(t)
  const store = await openStore(config, 'session')
  await store.write('public', record('public contract'))
  await store.write('private', record('PRIVATE_CANARY'))
  const names = await fs.readdir(config.stateRoot)
  assert.equal(names.length, 2)
  assert.equal((await fs.stat(config.stateRoot)).mode & 0o777, 0o700)
  for (const name of names) assert.equal((await fs.stat(join(config.stateRoot, name))).mode & 0o777, 0o600)
  assert.doesNotMatch(await fs.readFile(await publicFile(config), 'utf8'), /PRIVATE_CANARY/)
  const reopened = await openStore(config, 'session')
  assert.equal((await reopened.read('public')).turns[0][0].text, 'public contract')
  assert.equal((await reopened.read('private')).turns[0][0].text, 'PRIVATE_CANARY')
})

// Catches old cloud context being reused after a policy, route or session change.
test('authorization and session changes discard previous history', async t => {
  const { config } = await fixture(t)
  await (await openStore(config, 'session')).write('public', record('old authorization'))
  for (const change of [
    { mode: 'routing' }, { projectRoot: '/different/project' }, { publicPaths: ['contract/'] }, { privatePaths: ['secret/'] },
    { publicBrief: 'New contract' }, { localProvider: 'other' }, { localModel: 'other' }, { cloudProvider: 'other' },
    { cloudModel: 'other' }, { sensitiveTerms: ['NEW'] }, { blockEmails: false }, { blockPhones: false },
    { blockLocalPaths: false }, { integrationCommand: 'node check.js' },
  ]) assert.deepEqual((await (await openStore({ ...config, ...change }, 'session')).read('public')).turns, [], JSON.stringify(change))
  assert.deepEqual((await (await openStore(config, 'different-session')).read('public')).turns, [])
})

for (const kind of ['symlink', 'hardlink', 'readable']) test(`rejects ${kind} history before reading it`, async t => {
  const { config, base } = await fixture(t)
  const store = await openStore(config, 'session')
  await store.write('public', record('safe'))
  const filename = await publicFile(config)
  if (kind === 'readable') await fs.chmod(filename, 0o644)
  else {
    const other = join(base, 'other.json')
    await fs.writeFile(other, JSON.stringify(record('UNTRUSTED')), { mode: 0o600 })
    await fs.unlink(filename)
    await fs[kind === 'symlink' ? 'symlink' : 'link'](other, filename)
  }
  await assert.rejects(store.read('public'))
})

test('rejects a symlink anywhere in state-root ancestry before creating records', async t => {
  const { config, base } = await fixture(t)
  const actual = join(base, 'actual')
  await fs.mkdir(join(actual, 'nested'), { recursive: true, mode: 0o700 })
  await fs.symlink(actual, join(base, 'alias'))
  const unsafe = { ...config, stateRoot: join(base, 'alias', 'nested', 'state') }
  await assert.rejects(openStore(unsafe, 'session'))
  await assert.rejects(withProjectLock(unsafe, undefined, () => assert.fail('unsafe lock acquired')))
  await assert.rejects(fs.stat(join(actual, 'nested', 'state')), { code: 'ENOENT' })
})

for (const contents of ['{broken', 'null', '{"version":2,"turns":[]}', '{"version":1,"turns":{}}']) {
  test(`corrupt history fails closed: ${contents}`, async t => {
    const { config } = await fixture(t)
    const store = await openStore(config, 'session')
    await store.write('public', record('safe'))
    await fs.writeFile(await publicFile(config), contents)
    await assert.rejects(store.read('public'))
  })
}

test('oversized history fails closed for reads and writes', async t => {
  const { config } = await fixture(t)
  const store = await openStore(config, 'session')
  await store.write('public', record('safe'))
  const filename = await publicFile(config)
  await fs.truncate(filename, 33_554_433)
  await assert.rejects(store.read('public'))
  await assert.rejects(store.write('public', record('x'.repeat(33_554_433))))
  assert.equal((await fs.stat(filename)).size, 33_554_433)
})

test('rejects invalid scopes instead of crossing public and private records', async t => {
  const { config } = await fixture(t)
  const store = await openStore(config, 'session')
  for (const scope of ['unknown', '../private', '', undefined]) {
    await assert.rejects(store.read(scope))
    await assert.rejects(store.write(scope, record('PRIVATE_CANARY')))
  }
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('project lock serializes concurrent callers and aborts queued work', async t => {
  const { config } = await fixture(t)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let active = 0, maximum = 0, completed = 0
  const first = withProjectLock(config, undefined, async () => { active++; maximum = Math.max(maximum, active); entered(); await barrier; active--; completed++ })
  await started
  const controller = new AbortController()
  const queued = withProjectLock(config, controller.signal, () => assert.fail('aborted callback ran'))
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  controller.abort()
  await rejected
  const followers = Array.from({ length: 12 }, () => withProjectLock(config, undefined, async () => {
    active++; maximum = Math.max(maximum, active); await delay(5); active--; completed++
  }))
  release()
  await Promise.all([first, ...followers])
  assert.equal(maximum, 1)
  assert.equal(completed, 13)
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('project lock recovers after its owner process exits', async t => {
  const { config } = await fixture(t)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withProjectLock } from ${JSON.stringify(new URL('../src/collaboration-store.js', import.meta.url).href)};
    await withProjectLock(${JSON.stringify(config)}, undefined, async () => process.exit(0));
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.equal((await fs.readdir(config.stateRoot)).length, 1)
  const signal = AbortSignal.timeout(3000)
  assert.equal(await withProjectLock(config, signal, () => 'recovered'), 'recovered')
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('successive large turns evict oldest complete turns and remain usable after restart', async t => {
  const { config } = await fixture(t)
  const store = await openStore(config, 'session')
  const history = { version: 1, turns: [], runs: {} }
  await store.write('private', record('PRIVATE_CANARY'))
  for (let i = 0; i < 17; i++) {
    history.turns.push([{ text: `turn-${i}:` + 'x'.repeat(2_097_152) }, { text: `end-${i}` }])
    await store.write('public', history)
  }
  const reopened = await openStore(config, 'session')
  const saved = await reopened.read('public')
  assert.ok(saved.turns.length < 17)
  assert.deepEqual(saved.turns.map(turn => turn[1].text), history.turns.map(turn => turn[1].text))
  assert.equal(saved.turns.at(-1)[1].text, 'end-16')
  assert.equal((await reopened.read('private')).turns[0][0].text, 'PRIVATE_CANARY')
  assert.doesNotMatch(await fs.readFile(await publicFile(config), 'utf8'), /PRIVATE_CANARY/)
})

test('storage pressure evicts old completed reports while preserving newest retry guard', async t => {
  const { config } = await fixture(t)
  const store = await openStore(config, 'session')
  const history = { version: 1, turns: [], runs: {} }
  for (let i = 0; i < 17; i++) history.runs[`run-${i}`] = { state: 'completed', report: 'x'.repeat(2_097_152) }
  history.runs.current = { state: 'started' }
  await store.write('private', history)
  const saved = await (await openStore(config, 'session')).read('private')
  assert.deepEqual(saved.runs.current, { state: 'started' })
  assert.ok(Object.keys(saved.runs).length < 18)
  assert.equal(saved.runs['run-0'], undefined)
  assert.equal(saved.runs['run-16'].state, 'completed')
  assert.deepEqual(Object.keys(history.runs), Object.keys(saved.runs))
})

test('concurrent stale-lock recovery keeps project callbacks serialized', async t => {
  const { config } = await fixture(t)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withProjectLock } from ${JSON.stringify(new URL('../src/collaboration-store.js', import.meta.url).href)};
    await withProjectLock(${JSON.stringify(config)}, undefined, async () => process.exit(0));
  `], { stdio: 'ignore' })
  assert.equal((await once(child, 'exit'))[0], 0)
  let active = 0, maximum = 0
  const signal = AbortSignal.timeout(5000)
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => withProjectLock(config, signal, async () => {
    active++; maximum = Math.max(maximum, active); await delay(10); active--
  })))
  assert.equal(maximum, 1)
  assert.deepEqual(results.map(result => result.status), Array(12).fill('fulfilled'))
})

test('multiple processes recover a killed owner without overlapping callbacks', { timeout: 20000 }, async t => {
  const { config, base } = await fixture(t)
  const moduleURL = new URL('../src/collaboration-store.js', import.meta.url).href
  const children = []
  const launch = source => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    const closed = once(child, 'close').then(([code, signal]) => ({ code, signal, stderr }))
    return { child, closed }
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'close')))
  })
  const owner = launch(`
    import { withProjectLock } from ${JSON.stringify(moduleURL)};
    await withProjectLock(${JSON.stringify(config)}, undefined, async () => {
      setInterval(() => {}, 1000);
      process.send('locked');
      await new Promise(() => {});
    });
  `)
  assert.deepEqual(await once(owner.child, 'message'), ['locked', undefined])
  const workers = Array.from({ length: 12 }, () => launch(`
    import fs from 'node:fs/promises';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { withProjectLock } from ${JSON.stringify(moduleURL)};
    const start = once(process, 'message');
    process.send('ready');
    await start;
    for (let turn = 0; turn < 3; turn++) {
      await withProjectLock(${JSON.stringify(config)}, AbortSignal.timeout(12000), async () => {
        const marker = await fs.open(${JSON.stringify(join(base, 'active'))}, 'wx');
        try {
          await delay(10);
          await fs.appendFile(${JSON.stringify(join(base, 'completed'))}, 'done\\n');
        } finally {
          await marker.close();
          await fs.unlink(${JSON.stringify(join(base, 'active'))});
        }
      });
    }
    process.disconnect();
  `))
  await Promise.all(workers.map(({ child }) => once(child, 'message')))
  owner.child.kill('SIGKILL')
  assert.equal((await owner.closed).signal, 'SIGKILL')
  for (const { child } of workers) child.send('start')
  const results = await Promise.all(workers.map(worker => worker.closed))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assert.equal((await fs.readFile(join(base, 'completed'), 'utf8')).trim().split('\n').length, 36)
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

for (const [name, contents] of [['unknown', ''], ['owner.json', '{"pid":null}'], ['owner.json', '{broken']]) {
  test(`unknown lock ownership fails closed: ${name} ${contents}`, async t => {
    const { config } = await fixture(t)
    await openStore(config, 'session')
    const lock = join(config.stateRoot, `${digest(config.projectRoot)}.lock`)
    await fs.mkdir(lock, { mode: 0o700 })
    await fs.writeFile(join(lock, name), contents, { mode: 0o600 })
    await assert.rejects(withProjectLock(config, AbortSignal.timeout(500), () => assert.fail('unknown owner replaced')), error => {
      assert.notEqual(error.name, 'TimeoutError')
      assert.notEqual(error.name, 'AbortError')
      return true
    })
    assert.equal(await fs.readFile(join(lock, name), 'utf8'), contents)
  })
}

test('lock disappearing between EEXIST and lstat is retried', async t => {
  const { config } = await fixture(t)
  const entered = Promise.withResolvers()
  const barrier = Promise.withResolvers()
  const first = withProjectLock(config, undefined, async () => { entered.resolve(); await barrier.promise })
  await entered.promise
  const lstat = fs.lstat.bind(fs)
  let intercepted = false
  t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0].endsWith('.lock') && !intercepted) {
      intercepted = true
      barrier.resolve()
      await first
    }
    return lstat(...args)
  })
  assert.equal(await withProjectLock(config, AbortSignal.timeout(3000), () => 'retried'), 'retried')
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('delayed owner publication cannot enter a recovered replacement lock', { timeout: 5000 }, async t => {
  const { config } = await fixture(t)
  const lock = join(config.stateRoot, `${digest(config.projectRoot)}.lock`)
  const publishing = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const replacementEntered = Promise.withResolvers()
  const releaseReplacement = Promise.withResolvers()
  const checked = Promise.withResolvers()
  const writeFile = fs.writeFile.bind(fs)
  const readdir = fs.readdir.bind(fs)
  let paused = false, resumed = false, active = 0, maximum = 0
  t.mock.method(fs, 'writeFile', async (...args) => {
    if (args[0].startsWith(`${lock}/`) && !paused) {
      paused = true
      publishing.resolve()
      await resume.promise
      resumed = true
    }
    return writeFile(...args)
  })
  t.mock.method(fs, 'readdir', async (...args) => {
    const names = await readdir(...args)
    if (args[0] === lock && resumed) checked.resolve()
    return names
  })
  const first = withProjectLock(config, AbortSignal.timeout(4000), () => {
    active++; maximum = Math.max(maximum, active); active--; checked.resolve()
  })
  await publishing.promise
  const old = new Date(Date.now() - 60000)
  await fs.utimes(lock, old, old)
  const replacement = withProjectLock(config, AbortSignal.timeout(4000), async () => {
    active++; maximum = Math.max(maximum, active); replacementEntered.resolve()
    await releaseReplacement.promise
    active--
  })
  await replacementEntered.promise
  resume.resolve()
  await checked.promise
  releaseReplacement.resolve()
  await Promise.all([first, replacement])
  assert.equal(maximum, 1)
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('callback failure releases ownership for the next caller', async t => {
  const { config } = await fixture(t)
  const failure = new Error('callback failed')
  await assert.rejects(withProjectLock(config, undefined, () => { throw failure }), error => error === failure)
  assert.equal(await withProjectLock(config, AbortSignal.timeout(3000), () => 'next'), 'next')
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('concurrent recovery of a legacy dead owner preserves the replacement', async t => {
  const { config } = await fixture(t)
  await openStore(config, 'session')
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  assert.equal((await once(child, 'exit'))[0], 0)
  const lock = join(config.stateRoot, `${digest(config.projectRoot)}.lock`)
  await fs.mkdir(lock, { mode: 0o700 })
  await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'legacy' }), { mode: 0o600 })
  let active = 0, maximum = 0
  await Promise.all(Array.from({ length: 12 }, () => withProjectLock(config, AbortSignal.timeout(5000), async () => {
    active++; maximum = Math.max(maximum, active); await delay(10); active--
  })))
  assert.equal(maximum, 1)
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})

test('an old lock with a live owner is not stolen and waiting is abortable', async t => {
  const { config } = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const first = withProjectLock(config, undefined, async () => { entered.resolve(); await release.promise })
  await entered.promise
  const lock = join(config.stateRoot, `${digest(config.projectRoot)}.lock`)
  const old = new Date(Date.now() - 60000)
  await fs.utimes(lock, old, old)
  try {
    await assert.rejects(withProjectLock(config, AbortSignal.timeout(250), () => assert.fail('live lock stolen')), { name: 'AbortError' })
  } finally {
    release.resolve()
    await first
  }
  assert.deepEqual(await fs.readdir(config.stateRoot), [])
})
