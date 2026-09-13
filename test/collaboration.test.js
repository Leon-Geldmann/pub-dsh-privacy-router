import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { apply, resolveConfig } from '../index.js'

import { hostRuntime } from './helpers/host-runtime.js'

const PRIVATE = 'PRIVATE_CANARY_9f17'
const VIRTUAL = { provider: 'privacy-router', model: 'auto', reasoningEffort: 'medium' }
const message = text => ({ id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const textChunks = text => [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]
const toolChunks = (name, args) => [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: crypto.randomUUID(), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]

class MemorySettings extends SettingsProvider {
  writable = true
  async load() { return {} }
  async persist() {}
}

async function fixture(t, responses = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-collaboration-test-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'dpr-collaboration-state-'))
  await mkdir(join(root, 'public')); await mkdir(join(root, 'private'))
  await writeFile(join(root, 'public/interface.js'), 'export const version = 1\n')
  await writeFile(join(root, 'private/secret.txt'), PRIVATE)
  let ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(MemorySettings)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }) })
  const calls = []
  const counts = { 'local-ai-test': 0, 'cloud-test': 0 }
  class Boundary extends LlmAdapter {
    async resolveModel(provider, model) {
      const ids = provider === 'cloud-test' ? ['off', 'low', 'high', 'max'] : ['off', 'low', 'medium', 'high']
      return { provider, id: model, name: model, context: { contextWindow: 64000 }, defaultMaxTokens: 2048,
        reasoning: { efforts: ids.map(id => ({ id, name: id })) } }
    }
    async *stream(request) {
      calls.push(structuredClone({ ...request, signal: undefined }))
      const index = counts[request.provider]++
      const handler = responses[request.provider]
      yield* handler ? await handler(request, index, ctx) : textChunks('Done.')
    }
  }
  ctx.llm.registerAdapter(['local-ai-test', 'cloud-test'], new Boundary())
  const config = { ...hostRuntime, localProvider: 'local-ai-test', localModel: 'qwen', cloudProvider: 'cloud-test', cloudModel: 'deepseek',
    mode: 'collaboration', projectRoot: root, stateRoot, publicPaths: ['public/'], privatePaths: ['private/'], publicBrief: 'Build the approved public API with an internal implementation.',
    integrationCommand: 'node -e "console.log(require(\'node:fs\').readFileSync(\'private/secret.txt\',\'utf8\'))"', maxAgentSteps: 16 }
  apply(ctx, config)
  const sessionId = crypto.randomUUID()
  const agent = { session: { id: sessionId, deriveMessages: () => [message(PRIVATE + ' history')], requestHeader: () => ({ config: VIRTUAL }) }, options: VIRTUAL }
  let turn = 0
  async function run(text, route = VIRTUAL, signal = new AbortController().signal) {
    const payload = { agent, turn: ++turn, step: 1, signal }
    await ctx.waterfall('agent/pre-step', { ...payload, messages: (Array.isArray(text) ? text : [text]).map(item => typeof item === 'string' ? message(item) : structuredClone(item)) }, async () => ({ kind: 'enter' }))
    const selected = await ctx.waterfall('agent/request', payload, async () => route)
    const prepared = await ctx.llm.prepareCall(selected, signal)
    const stream = prepared.stream(markAgentLoopRequest({ ...prepared.config, signal, sessionId,
      system: PRIVATE + ' runtime context', messages: [message(PRIVATE + ' full history')], tools: [{ name: 'read_file', parameters: {} }] }))
    const chunks = []; for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }
  async function restart() {
    await ctx.fiber.dispose()
    ctx = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(MemorySettings)
    ctx.llm.registerAdapter(['local-ai-test', 'cloud-test'], new Boundary())
    apply(ctx, config)
  }
  return { root, get ctx() { return ctx }, calls, run, config, restart }
}

test('collaboration validates private-by-default settings and rejects unsafe path grants', () => {
  const base = { localProvider: 'local-ai-test', localModel: 'qwen' }
  const config = resolveConfig({ ...base, mode: 'collaboration', projectRoot: '/tmp/project', publicPaths: ['public/'], privatePaths: ['public/internal/'] })
  assert.equal(config.publicBrief, '')
  assert.equal(config.integrationCommand, 'node --test')
  for (const patch of [{ mode: 'anything' }, { publicPaths: ['/home/'] }, { publicPaths: ['../'] }, { privatePaths: ['x/../y'] }, { publicPaths: ['**'] }, { maxAgentSteps: 0 }, { commandTimeoutSeconds: 301 }]) {
    assert.throws(() => resolveConfig({ ...base, ...patch }))
  }
})

test('host sandbox configuration defaults and accepts local paths with pinned image references', () => {
  const defaults = resolveConfig()
  assert.equal(defaults.sandboxBackend, 'auto')
  assert.equal(defaults.dockerPath, '')
  assert.equal(defaults.dockerSocket, '')
  assert.equal(defaults.dockerImage, 'node:22-bookworm-slim')
  assert.equal(defaults.pythonPath, '')

  const configured = resolveConfig({
    sandboxBackend: 'docker',
    dockerPath: '/Applications/Docker.app/Contents/Resources/bin/docker',
    dockerSocket: '/Users/test/.colima/default/docker.sock',
    dockerImage: 'registry.example.com/team/runtime:node-22',
    pythonPath: '/opt/homebrew/bin/python3',
  })
  assert.equal(configured.sandboxBackend, 'docker')
  assert.equal(configured.dockerPath, '/Applications/Docker.app/Contents/Resources/bin/docker')
  assert.equal(configured.dockerSocket, '/Users/test/.colima/default/docker.sock')
  assert.equal(configured.dockerImage, 'registry.example.com/team/runtime:node-22')
  assert.equal(configured.pythonPath, '/opt/homebrew/bin/python3')
  assert.equal(resolveConfig({ dockerImage: `sha256:${'a'.repeat(64)}` }).dockerImage, `sha256:${'a'.repeat(64)}`)
  assert.equal(resolveConfig({ dockerImage: `node@sha256:${'b'.repeat(64)}` }).dockerImage, `node@sha256:${'b'.repeat(64)}`)
  const boundedImage = `${'a'.repeat(127)}/${'b'.repeat(124)}:tag`
  assert.equal(boundedImage.length, 256)
  assert.equal(resolveConfig({ dockerImage: boundedImage }).dockerImage, boundedImage)
})

test('host sandbox configuration rejects unsupported sandbox backends', () => {
  assert.throws(() => resolveConfig({ sandboxBackend: 'podman' }), /sandboxBackend/)
})

test('host executable and socket paths reject relative paths, URLs and control characters', () => {
  for (const patch of [
    { dockerPath: 'docker' },
    { dockerPath: '/usr/local/bin/\ndocker' },
    { dockerSocket: 'tcp://127.0.0.1:2375' },
    { dockerSocket: '/var/run/\0docker.sock' },
    { pythonPath: 'https://example.com/python3' },
    { pythonPath: '/usr/bin/\x7fpython3' },
  ]) {
    assert.throws(() => resolveConfig(patch), /Path|Socket/)
  }
})

test('Docker images require a bounded tagged reference or SHA-256 identity', () => {
  for (const dockerImage of [
    '',
    'node',
    '-node:22',
    'node:bad tag',
    'node:\x01tag',
    'https://registry.example.com/node:22',
    `${'a'.repeat(127)}/${'b'.repeat(125)}:tag`,
    `node@sha256:${'a'.repeat(63)}`,
    'UPPER/repository:tag',
    'registry..example.com/team/runtime:tag',
  ]) {
    assert.throws(() => resolveConfig({ dockerImage }), /dockerImage/)
  }
})

test('settings cannot change host-controlled sandbox configuration', async t => {
  const f = await fixture(t)
  for (const [key, value] of Object.entries({
    sandboxBackend: f.config.sandboxBackend === 'docker' ? 'bwrap' : 'docker',
    dockerPath: `${f.config.dockerPath || '/test/docker'}-settings-override`,
    dockerSocket: `${f.config.dockerSocket || '/test/docker.sock'}-settings-override`,
    dockerImage: f.config.dockerImage === 'alpine:3.20' ? 'alpine:3.21' : 'alpine:3.20',
    pythonPath: `${f.config.pythonPath}-settings-override`,
  })) {
    await assert.rejects(f.ctx.settings.update('privacy-router', { [key]: value }), new RegExp(`${key}.*host configuration`))
  }
})

test('cloud develops public files while private input, code, local output and integration logs remain local', async t => {
  const f = await fixture(t, {
    'cloud-test': async (_request, index) => [
      toolChunks('read_file', { path: 'public/interface.js' }),
      toolChunks('write_file', { path: 'public/app.js', content: 'export const publicFeature = true\n' }),
      toolChunks('delegate_private_task', { task: 'Implement the private module behind the public API.' }),
      toolChunks('run_integration', {}),
      textChunks('Public architecture is ready.'),
    ][index],
    'local-ai-test': async (_request, index) => [
      toolChunks('read_file', { path: 'private/secret.txt' }),
      toolChunks('write_file', { path: 'private/module.js', content: `export const internalValue = '${PRIVATE}'\n` }),
      textChunks(`Private implementation uses ${PRIVATE}.`),
    ][index],
  })
  const chunks = await f.run(`Implement the internal business rule: ${PRIVATE}`)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(await readFile(join(f.root, 'public/app.js'), 'utf8'), /publicFeature/)
  assert.match(await readFile(join(f.root, 'private/module.js'), 'utf8'), new RegExp(PRIVATE))
  const cloud = f.calls.filter(call => call.provider === 'cloud-test')
  assert.equal(cloud.length, 5)
  assert.ok(cloud.every(call => call.reasoningEffort === 'high'))
  assert.doesNotMatch(JSON.stringify(cloud), new RegExp(PRIVATE))
  assert.doesNotMatch(JSON.stringify(cloud), /private\/secret\.txt|runtime context|full history/)
  assert.match(JSON.stringify(cloud), /recorded_locally/)
  assert.match(JSON.stringify(chunks), new RegExp(PRIVATE))
  assert.ok(f.calls.filter(call => call.provider === 'local-ai-test').every(call => call.reasoningEffort === 'medium'))
})

test('only explicitly public current text enters cloud and revoked policy drops previous cloud history', async t => {
  const f = await fixture(t)
  await f.run('/公开 Create PUBLIC_TURN_ONE in the public module.')
  await f.run(`Private follow-up ${PRIVATE}`)
  let cloud = f.calls.filter(call => call.provider === 'cloud-test')
  assert.match(JSON.stringify(cloud.at(-1)), /PUBLIC_TURN_ONE/)
  assert.doesNotMatch(JSON.stringify(cloud), new RegExp(PRIVATE))
  await f.ctx.settings.update('privacy-router', { publicBrief: 'A changed approved brief.' })
  await f.run('/公开 PUBLIC_TURN_THREE')
  cloud = f.calls.filter(call => call.provider === 'cloud-test')
  assert.doesNotMatch(JSON.stringify(cloud.at(-1)), /PUBLIC_TURN_ONE/)
  assert.match(JSON.stringify(cloud.at(-1)), /PUBLIC_TURN_THREE/)
})

test('private task failures do not disclose provider diagnostics to cloud', async t => {
  const f = await fixture(t, {
    'cloud-test': async (_request, index) => index === 0 ? toolChunks('delegate_private_task', { task: 'Implement the internal module.' }) : textChunks('Public work done.'),
    'local-ai-test': async () => { throw new Error(`Internal failure: ${PRIVATE}`) },
  })
  const chunks = await f.run(PRIVATE)
  assert.doesNotMatch(JSON.stringify(f.calls.filter(c => c.provider === 'cloud-test')), new RegExp(PRIVATE))
  assert.match(JSON.stringify(chunks), new RegExp(PRIVATE))
})

test('a queued public message never authorizes a separate unmarked private message', async t => {
  const f = await fixture(t)
  await f.run(['/公开 Build the PUBLIC_BATCH_API.', `Unmarked private requirement ${PRIVATE}`])
  const cloud = f.calls.filter(call => call.provider === 'cloud-test')
  assert.match(JSON.stringify(cloud), /PUBLIC_BATCH_API/)
  assert.doesNotMatch(JSON.stringify(cloud), new RegExp(PRIVATE))
  assert.match(JSON.stringify(f.calls.filter(call => call.provider === 'local-ai-test')), new RegExp(PRIVATE))
})

test('quoted credentials are blocked in explicit public input and public file contents', async t => {
  const credential = 'sensitive_credential_12345'
  const input = await fixture(t)
  const chunks = await input.run(`/公开 api_key = "${credential}"`)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(input.calls.filter(call => call.provider === 'cloud-test').length, 0)
  const files = await fixture(t, { 'cloud-test': async (_request, index) => index === 0
    ? toolChunks('read_file', { path: 'public/credential.js' }) : textChunks('Cannot read the blocked file.') })
  await writeFile(join(files.root, 'public/credential.js'), `const api_key = "${credential}";`)
  await files.run('/公开 Review the public file.')
  const cloud = files.calls.filter(call => call.provider === 'cloud-test')
  assert.equal(cloud.length, 2)
  assert.doesNotMatch(JSON.stringify(cloud), new RegExp(credential))
  assert.match(JSON.stringify(cloud.at(-1)), /operation_denied_or_failed/)
})

test('restart preserves public history and completed request replay does not repeat edits', async t => {
  const f = await fixture(t, { 'cloud-test': async (_request, index) => index === 0
    ? toolChunks('write_file', { path: 'public/durable.js', content: 'export const durable = true\n' }) : textChunks('Public work completed.') })
  const request = message('/公开 Add PUBLIC_SESSION_MEMORY to the project.')
  await f.run([request])
  await f.restart()
  const replay = await f.run([request])
  assert.equal(replay.at(-1).reason.kind, 'stop')
  assert.equal(f.calls.filter(call => call.provider === 'cloud-test').length, 2)
  assert.match(await readFile(join(f.root, 'public/durable.js'), 'utf8'), /durable/)
  await f.run('/公开 Continue the approved project.')
  const cloud = f.calls.filter(call => call.provider === 'cloud-test')
  assert.equal(cloud.length, 3)
  assert.match(JSON.stringify(cloud.at(-1)), /PUBLIC_SESSION_MEMORY/)
  assert.doesNotMatch(JSON.stringify(cloud), new RegExp(PRIVATE))
})

test('revoking public scope mid-turn prevents pending edits and further cloud calls', async t => {
  const f = await fixture(t, { 'cloud-test': async (_request, _index, ctx) => {
    await ctx.settings.update('privacy-router', { publicPaths: [] })
    return toolChunks('write_file', { path: 'public/forbidden.js', content: 'must not be committed' })
  } })
  const result = await f.run('/公开 Make a change.')
  assert.equal(result.at(-1).reason.kind, 'error')
  assert.match(result.at(-1).reason.failure.message, /设置已变更/)
  assert.equal(f.calls.filter(call => call.provider === 'cloud-test').length, 1)
  await assert.rejects(readFile(join(f.root, 'public/forbidden.js')), { code: 'ENOENT' })
})

test('cancelling a model call prevents uncommitted public changes from reaching the project', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { 'cloud-test': async (_request, index) => {
    if (index === 0) return toolChunks('write_file', { path: 'public/cancelled.js', content: 'not committed' })
    controller.abort()
    return textChunks('Completed after cancellation')
  } })
  const result = await f.run('/公开 Make a cancellable change.', VIRTUAL, controller.signal)
  assert.equal(result.at(-1).reason.kind, 'error')
  await assert.rejects(readFile(join(f.root, 'public/cancelled.js')), { code: 'ENOENT' })
  assert.equal(f.calls.filter(call => call.provider === 'local-ai-test').length, 0)
})

test('incomplete tool streams never execute their pending mutations', async t => {
  const f = await fixture(t, { 'cloud-test': async () => toolChunks('write_file', { path: 'public/truncated.js', content: 'not committed' }).slice(0, 1) })
  const result = await f.run('/公开 Make a change.')
  assert.equal(result.at(-1).reason.kind, 'error')
  await assert.rejects(readFile(join(f.root, 'public/truncated.js')), { code: 'ENOENT' })
})

test('direct local model retains original context and tools in collaboration mode', async t => {
  const f = await fixture(t)
  await f.run(PRIVATE, { provider: 'local-ai-test', model: 'qwen', reasoningEffort: 'low' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].provider, 'local-ai-test')
  assert.equal(f.calls[0].reasoningEffort, 'low')
  assert.match(f.calls[0].system, new RegExp(PRIVATE))
  assert.equal(f.calls[0].tools[0].name, 'read_file')
})
