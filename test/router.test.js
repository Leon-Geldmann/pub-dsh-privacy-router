import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { apply, deterministicBlockReason, resolveConfig } from '../index.js'

const LOCAL = { provider: 'local-ai-test', model: 'local-model' }
const CLOUD = { provider: 'cloud-test', model: 'cloud-model' }
const VIRTUAL = { provider: 'privacy-router', model: 'auto' }
const user = (text, extra = {}) => ({ id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra })
const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result }
function classification(value = 'public') {
  return [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'classification', name: 'structured_output', arguments: JSON.stringify({ classification: value, reason: 'Test assessment.' }) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class MemorySettings extends SettingsProvider {
  writable = true
  writes = []
  async load() { return {} }
  async persist(ns, value) { this.writes.push({ ns, value: structuredClone(value) }) }
}
async function fixture(t, options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  t.after(() => ctx.fiber.dispose())
  const requests = []
  class Boundary extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 32768 }, defaultMaxTokens: 2048, reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] }, ...options.modelInfo?.[provider] }
    }
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      if (request.tools?.[0]?.name === 'structured_output') {
        if (options.onClassify) await options.onClassify(request)
        if (options.classifierError) throw new Error('classifier unavailable')
        yield* options.classifierChunks ?? classification(options.classification)
      } else {
        if (options.onGenerate) await options.onGenerate(request)
        yield* options.cloudChunks && request.provider === CLOUD.provider ? options.cloudChunks : [{ type: 'text-delta', index: 0, text: `${request.provider} answer` }, { type: 'finish', reason: { kind: 'stop' } }]
      }
    }
  }
  ctx.llm.registerAdapter([LOCAL.provider, CLOUD.provider, 'local-ai-second'], new Boundary())
  apply(ctx, options.unconfigured ? {} : { localProvider: LOCAL.provider, localModel: LOCAL.model, cloudProvider: CLOUD.provider, cloudModel: CLOUD.model, ...options.config })
  const makeAgent = (history = []) => ({ session: { id: crypto.randomUUID(), deriveMessages: () => history, requestHeader: () => ({ config: VIRTUAL }) }, options: VIRTUAL })
  const currentAgent = makeAgent()
  const controller = new AbortController()
  const payload = (extra = {}) => ({ agent: currentAgent, turn: 1, step: 1, signal: controller.signal, ...extra })
  return {
    ctx, requests, currentAgent, controller, makeAgent, payload,
    classifierRequests: () => requests.filter(r => r.tools?.[0]?.name === 'structured_output'),
    generationRequests: () => requests.filter(r => r.tools?.[0]?.name !== 'structured_output'),
    async pre(messages, extra) { return ctx.waterfall('agent/pre-step', payload({ messages, ...extra }), async () => ({ kind: 'enter', messages })) },
    async request(route = VIRTUAL, extra) { return ctx.waterfall('agent/request', payload(extra), async () => route) },
    async stream(route = VIRTUAL, extra = {}) {
      const { agent: dispatchAgent, ...requestExtra } = extra
      const signal = extra.signal ?? controller.signal
      const prepared = await ctx.llm.prepareCall(route, signal)
      const request = markAgentLoopRequest({ ...prepared.config, messages: [user('private full context')], system: 'private runtime context', tools: [{ name: 'read_file', parameters: {} }], sessionId: extra.agent?.session.id ?? currentAgent.session.id, signal, ...requestExtra })
      return collect(prepared.stream(request))
    },
  }
}

test('ordinary local and direct cloud retain request controls, messages and tools without classification', async t => {
  const f = await fixture(t)
  for (const route of [LOCAL, CLOUD]) {
    const selected = { ...route, maxTokens: 500, reasoningEffort: 'high', temperature: 0.5 }
    await f.pre([user('api_key=do-not-route-this-secret')])
    assert.deepEqual(await f.request(selected), selected)
    await f.stream(selected)
    const sent = f.generationRequests().at(-1)
    assert.equal(sent.provider, route.provider)
    assert.equal(sent.reasoningEffort, 'high')
    assert.equal(sent.maxTokens, 500)
    assert.equal(sent.tools[0].name, 'read_file')
    assert.equal(sent.messages[0].content[0].text, 'private full context')
  }
  assert.equal(f.classifierRequests().length, 0)
})

test('router preserves virtual selection and sends only clean current text to cloud', async t => {
  const f = await fixture(t)
  const privateAgent = f.makeAgent([user('private history /home/test/secret')])
  const current = user('Explain HTTP/3.', { privateMetadata: 'must not leave', source: { kind: 'user', privateMetadata: 'also private' } })
  await f.pre([current], { agent: privateAgent })
  const route = await f.request(VIRTUAL, { agent: privateAgent })
  assert.deepEqual(route, VIRTUAL)
  const result = await f.stream(route, { agent: privateAgent })
  assert.equal(result[0].text, 'cloud-test answer')
  assert.match(f.classifierRequests()[0].messages[0].content[0].text, /private history/)
  const sent = f.generationRequests()[0]
  assert.deepEqual(sent.messages, [{ id: current.id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain HTTP/3.' }] }])
  assert.deepEqual(sent.tools, [])
  assert.doesNotMatch(JSON.stringify(sent), /privateMetadata|private history|private runtime|private full/)
})

test('retry and tool continuation reuse immutable decision and settings, new turn uses saved settings', async t => {
  const f = await fixture(t)
  const current = user('Explain HTTP/3.')
  await f.pre([current]); await f.request()
  await f.ctx.settings.update('privacy-router', { cloudModel: 'changed-cloud', cloudMaxTokens: 99, privacyPolicy: 'new policy' })
  current.content[0].text = 'mutated private content'
  for (const step of [1, 2]) {
    await f.pre([user('tool result', { source: { kind: 'tool' } })], { step })
    assert.deepEqual(await f.request(VIRTUAL, { step }), VIRTUAL)
    await f.stream()
  }
  assert.equal(f.classifierRequests().length, 1)
  for (const sent of f.generationRequests()) {
    assert.equal(sent.model, 'cloud-model'); assert.equal(sent.maxTokens, 8192)
    assert.equal(sent.messages[0].content[0].text, 'Explain HTTP/3.')
  }
  await f.pre([user('Explain TCP.')], { turn: 2 }); await f.request(VIRTUAL, { turn: 2 }); await f.stream()
  assert.equal(f.classifierRequests().length, 2)
  assert.equal(f.generationRequests().at(-1).model, 'changed-cloud')
  assert.equal(f.generationRequests().at(-1).maxTokens, 99)
})

test('switching away bypasses router and switching back requires a fresh admitted turn', async t => {
  const f = await fixture(t)
  await f.pre([user('Explain HTTP/3.')]); await f.request(); await f.stream()
  assert.deepEqual(await f.request(LOCAL), LOCAL); await f.stream(LOCAL)
  assert.deepEqual(await f.request(VIRTUAL), VIRTUAL); await f.stream()
  assert.equal(f.classifierRequests().length, 1)
  assert.equal(f.generationRequests().at(-1).provider, LOCAL.provider)
  await f.pre([user('Explain TCP.')], { turn: 2 }); await f.request(VIRTUAL, { turn: 2 }); await f.stream()
  assert.equal(f.generationRequests().at(-1).provider, CLOUD.provider)
})

test('concurrent agents and prepared calls cannot share candidates or settings', async t => {
  const f = await fixture(t)
  const a = f.makeAgent(); const b = f.makeAgent()
  const aSignal = new AbortController().signal; const bSignal = new AbortController().signal
  await Promise.all([f.pre([user('Public A')], { agent: a, signal: aSignal }), f.pre([user('password=secret-for-b')], { agent: b, signal: bSignal })])
  await Promise.all([f.request(VIRTUAL, { agent: a, signal: aSignal }), f.request(VIRTUAL, { agent: b, signal: bSignal })])
  const preparedA = await f.ctx.llm.prepareCall(VIRTUAL, aSignal)
  await f.ctx.settings.update('privacy-router', { cloudModel: 'changed' })
  await f.stream(VIRTUAL, { agent: b, signal: bSignal })
  await collect(preparedA.stream(markAgentLoopRequest({ ...preparedA.config, messages: [user('private full A')], sessionId: a.session.id, signal: aSignal })))
  assert.equal(f.generationRequests()[0].provider, LOCAL.provider)
  assert.equal(f.generationRequests()[1].model, 'cloud-model')
  assert.equal(f.generationRequests()[1].messages[0].content[0].text, 'Public A')
})

test('credentials, sensitive, unknown, invalid classifier and multimodal all stay local', async t => {
  const cases = [
    { text: 'api_key=not-a-real-secret' },
    { classification: 'sensitive' }, { classification: 'unknown' }, { classifierError: true },
    { classifierChunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'OFFLINE', message: 'offline' } } }] },
    { classifierChunks: [{ type: 'tool-call-delta', index: 0, name: 'structured_output', argumentsDelta: '{"classification":"public","reason":"truncated' }, { type: 'finish', reason: { kind: 'max-tokens' } }] },
    { image: true },
  ]
  for (const item of cases) await t.test(JSON.stringify(item), async t => {
    const f = await fixture(t, item)
    const candidate = user(item.text ?? 'Ambiguous request')
    if (item.image) candidate.content.push({ type: 'image', url: 'data:image/png;base64,abc' })
    await f.pre([candidate]); await f.request(); await f.stream()
    assert.equal(f.generationRequests()[0].provider, LOCAL.provider)
    assert.equal(f.generationRequests()[0].tools[0].name, 'read_file')
  })
})

test('auxiliary and resumed virtual requests without admission fall back local', async t => {
  const f = await fixture(t)
  await f.pre([user('Public question')]); await f.request()
  await collect(f.ctx.llm.stream({ ...VIRTUAL, sessionId: f.currentAgent.session.id, signal: f.controller.signal, purpose: 'session-title', messages: [user('private title data')] }))
  await f.stream(VIRTUAL, { signal: new AbortController().signal })
  assert.deepEqual(f.generationRequests().map(r => r.provider), [LOCAL.provider, LOCAL.provider])
})

test('abort during classification prevents any generation and a later signal gets a fresh decision', async t => {
  let f
  f = await fixture(t, { onClassify: () => f.controller.abort() })
  await f.pre([user('Public question')])
  await assert.rejects(f.request(), /abort/i)
  assert.equal(f.generationRequests().length, 0)
  const signal = new AbortController().signal
  await f.pre([user('password=keep-local')], { turn: 2, signal }); await f.request(VIRTUAL, { turn: 2, signal }); await f.stream(VIRTUAL, { signal })
  assert.equal(f.generationRequests().at(-1).provider, LOCAL.provider)
})

test('cloud tool calls are refused and errors never silently reroute', async t => {
  for (const cloudChunks of [[{ type: 'block-start', index: 0, blockType: 'tool-call' }], [{ type: 'finish', reason: { kind: 'error', failure: { code: 'OFFLINE', message: 'offline' } } }]]) await t.test('cloud boundary', async t => {
    const f = await fixture(t, { cloudChunks })
    await f.pre([user('Public question')]); await f.request(); const chunks = await f.stream()
    assert.equal(chunks.some(c => c.blockType === 'tool-call'), false)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(f.generationRequests().length, 1)
    assert.equal(f.generationRequests()[0].provider, CLOUD.provider)
  })
})

test('settings validation refuses recursive, untrusted, incomplete, oversized and invalid settings before persistence', async t => {
  const f = await fixture(t)
  for (const patch of [{ localProvider: 'cloud-test' }, { localProvider: 'privacy-router' }, { cloudProvider: 'privacy-router' }, { localModel: '' }, { localProvider: '' }, { maxPromptBytes: 0 }, { cloudMaxTokens: 1.5 }, { blockEmails: 'no' }, { trustedProviders: ['cloud-test'] }, { trustedProviderPrefixes: [''] }, { privacyPolicy: 'x'.repeat(16385) }, { sensitiveTerms: [''] }]) {
    await assert.rejects(f.ctx.settings.update('privacy-router', patch))
  }
  assert.equal(f.ctx.settings.writes.length, 0)
  assert.equal(f.ctx.settings.get('privacy-router').localProvider, LOCAL.provider)
  await f.ctx.settings.update('privacy-router', { blockEmails: false, blockPhones: false, blockLocalPaths: false })
  const config = f.ctx.settings.get('privacy-router')
  assert.equal(deterministicBlockReason('test@example.com /home/me/file 13800138000', config), undefined)
  assert.equal(deterministicBlockReason('password=mandatory-secret', config), 'assigned-secret')
  await assert.rejects(f.ctx.settings.update('privacy-router', { cloudMaxTokens: 55 }, 0), /conflict|revision/i)
})

test('catalog advertises virtual choice, proxies local capabilities, and unset local target has setup diagnostic', async t => {
  const f = await fixture(t)
  const info = await f.ctx.llm.resolveModelInfo('privacy-router', 'auto')
  assert.equal(info.name, '智能路由'); assert.equal(info.context.contextWindow, 32768)
  assert.equal((await f.ctx.llm.listModels('privacy-router'))[0].id, 'auto')
  const unset = await fixture(t, { unconfigured: true })
  assert.equal((await unset.ctx.llm.listModels('privacy-router'))[0].name, '智能路由')
  await assert.rejects(unset.request(), /local|本地|settings/i)
  assert.equal(resolveConfig().localProvider, '')
})

test('host replay-state cleanup cannot erase main-turn admission', async t => {
  const f = await fixture(t)
  await f.pre([user('Explain HTTP/3.')]); await f.request()
  const chunks = await f.stream(VIRTUAL, { messages: [
    { id: 'prior', role: 'assistant', source: { kind: 'model', ...LOCAL, replayState: { private: 'provider cache' } }, content: [{ type: 'text', text: 'private prior response' }] },
    user('Explain HTTP/3.'),
  ] })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(f.generationRequests()[0].provider, CLOUD.provider)
  assert.equal(f.generationRequests()[0].messages.length, 1)
})

test('settings changed while classification is in flight cannot change its turn target', async t => {
  let release; let began
  const started = new Promise(resolve => { began = resolve })
  const pause = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { onClassify: async () => { began(); await pause } })
  await f.pre([user('Public question')])
  const pending = f.request()
  await started
  await f.ctx.settings.update('privacy-router', { cloudModel: 'changed-cloud' })
  release(); await pending; await f.stream()
  assert.equal(f.generationRequests()[0].model, 'cloud-model')
})

test('prompt byte limit counts whitespace that would actually be sent to cloud', async t => {
  const f = await fixture(t, { config: { maxPromptBytes: 32 } })
  await f.pre([user(' '.repeat(100) + 'Public question')]); await f.request(); await f.stream()
  assert.equal(f.classifierRequests().length, 0)
  assert.equal(f.generationRequests()[0].provider, LOCAL.provider)
})


test('overlapping auxiliary calls cannot borrow an admitted main stream on the same signal', async t => {
  let began; let release
  const started = new Promise(resolve => { began = resolve })
  const pause = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { onGenerate: async request => {
    if (request.provider === CLOUD.provider) { began(); await pause }
  } })
  await f.pre([user('Public question')]); await f.request()
  const main = f.stream()
  await started
  const aux = await collect(f.ctx.llm.stream({ ...VIRTUAL, messages: [user('private auxiliary')],
    sessionId: f.currentAgent.session.id, signal: f.controller.signal }))
  assert.equal(aux[0].text, 'local-ai-test answer')
  release(); await main
  assert.deepEqual(f.generationRequests().map(request => request.provider), ['cloud-test', 'local-ai-test'])
})

test('local tool continuations preserve the original target and tools after a settings edit', async t => {
  const f = await fixture(t)
  await f.pre([user('password=local-secret')]); await f.request(); await f.stream()
  await f.ctx.settings.update('privacy-router', { localProvider: 'local-ai-second', localModel: 'second-model' })
  await f.pre([user('private tool result', { source: { kind: 'tool' } })], { step: 2 })
  await f.request(VIRTUAL, { step: 2 }); await f.stream()
  assert.equal(f.generationRequests().at(-1).provider, 'local-ai-test')
  assert.equal(f.generationRequests().at(-1).tools[0].name, 'read_file')
  await f.pre([user('password=next-turn-secret')], { turn: 2 }); await f.request(VIRTUAL, { turn: 2 }); await f.stream()
  assert.equal(f.generationRequests().at(-1).provider, 'local-ai-second')
})

const reasoningInfo = (ids, defaultEffort) => ({
  reasoning: { efforts: ids.map(id => ({ id, name: id })), ...(defaultEffort ? { defaultEffort } : {}) },
})

test('one virtual reasoning selection maps to both actual target capability sets', async t => {
  const choices = [
    { selected: undefined, local: 'low', cloud: 'high' },
    { selected: 'auto', local: 'low', cloud: 'high' },
    { selected: 'off', local: 'off', cloud: 'off' },
    { selected: 'low', local: 'low', cloud: 'low' },
    { selected: 'medium', local: 'medium', cloud: 'low' },
    { selected: 'high', local: 'high', cloud: 'high' },
    { selected: 'max', local: 'high', cloud: 'max' },
  ]
  for (const choice of choices) for (const cloud of [false, true]) await t.test(`${choice.selected ?? 'unset'} -> ${cloud ? 'cloud' : 'local'}`, async t => {
    const f = await fixture(t, { modelInfo: {
      [LOCAL.provider]: reasoningInfo(['off', 'low', 'medium', 'high'], 'low'),
      [CLOUD.provider]: reasoningInfo(['off', 'low', 'high', 'max'], 'high'),
    } })
    const selected = { ...VIRTUAL, ...(choice.selected ? { reasoningEffort: choice.selected } : {}) }
    await f.pre([user(cloud ? 'Explain HTTP/3.' : 'test@example.com')])
    const route = await f.request(selected)
    assert.deepEqual(route, selected)
    const chunks = await f.stream(route)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const sent = f.generationRequests()[0]
    assert.equal(sent.provider, cloud ? CLOUD.provider : LOCAL.provider)
    assert.equal(sent.reasoningEffort, cloud ? choice.cloud : choice.local)
    if (cloud) {
      assert.equal(f.classifierRequests()[0].reasoningEffort, 'off')
      assert.deepEqual(sent.tools, [])
      assert.doesNotMatch(JSON.stringify(sent), /private runtime|private full/)
    }
  })
})

test('models without reasoning controls receive no reasoning parameter on either route', async t => {
  for (const cloud of [false, true]) await t.test(cloud ? 'cloud' : 'local', async t => {
    const f = await fixture(t, { modelInfo: { [cloud ? CLOUD.provider : LOCAL.provider]: { reasoning: undefined } } })
    await f.pre([user(cloud ? 'Explain HTTP/3.' : 'test@example.com')])
    const route = await f.request({ ...VIRTUAL, reasoningEffort: 'high' })
    const chunks = await f.stream(route)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const sent = f.generationRequests()[0]
    assert.equal(sent.provider, cloud ? CLOUD.provider : LOCAL.provider)
    assert.equal(Object.hasOwn(sent, 'reasoningEffort'), false)
  })
})

test('turning reasoning off never silently enables it on a reasoning-only target', async t => {
  for (const cloud of [false, true]) await t.test(cloud ? 'cloud' : 'local', async t => {
    const f = await fixture(t, { modelInfo: { [cloud ? CLOUD.provider : LOCAL.provider]: reasoningInfo(['low', 'high'], 'high') } })
    await f.pre([user(cloud ? 'Explain HTTP/3.' : 'test@example.com')])
    const route = await f.request({ ...VIRTUAL, reasoningEffort: 'off' })
    const chunks = await f.stream(route)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /关闭|off/i)
    assert.equal(f.generationRequests().length, 0)
  })
})

test('ranked and binary targets map supported intensities without inventing provider values', async t => {
  const cases = [
    { ids: ['off', 'minimal', 'xhigh'], selected: 'low', want: 'minimal' },
    { ids: ['off', 'minimal', 'xhigh'], selected: 'max', want: 'xhigh' },
    { ids: ['off', 'high'], selected: 'low', want: 'high' },
    { ids: ['off', 'on'], selected: 'medium', want: 'on' },
    { ids: ['off'], selected: 'high', want: 'off' },
    { ids: ['adaptive'], selected: 'auto', want: 'adaptive' },
  ]
  for (const row of cases) await t.test(`${row.ids.join('/')} ${row.selected}`, async t => {
    const f = await fixture(t, { modelInfo: { [CLOUD.provider]: reasoningInfo(row.ids, row.ids.at(-1)) } })
    await f.pre([user('Explain HTTP/3.')])
    const route = await f.request({ ...VIRTUAL, reasoningEffort: row.selected })
    const chunks = await f.stream(route)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(f.generationRequests()[0].reasoningEffort, row.want)
  })
})

test('unknown target intensity semantics reject explicit levels but preserve model defaults', async t => {
  const f = await fixture(t, { modelInfo: { [CLOUD.provider]: reasoningInfo(['adaptive'], 'adaptive') } })
  await f.pre([user('Explain HTTP/3.')])
  const route = await f.request({ ...VIRTUAL, reasoningEffort: 'high' })
  const chunks = await f.stream(route)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /推理|reasoning/i)
  assert.equal(f.generationRequests().length, 0)
})
