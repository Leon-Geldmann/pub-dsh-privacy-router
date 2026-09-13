import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

function createReactHarness() {
  const state = []
  const effects = []
  let cursor = 0
  let component
  let tree

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props ?? {}),
          ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
        },
      }
    },
    useState(initial) {
      const at = cursor++
      if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial
      return [state[at], next => {
        state[at] = typeof next === 'function' ? next(state[at]) : next
        render()
      }]
    },
    useEffect(effect, dependencies) {
      const at = cursor++
      const previous = state[at]
      const changed = previous === undefined
        || dependencies === undefined
        || dependencies.some((value, index) => !Object.is(value, previous[index]))
      state[at] = dependencies
      if (changed) effects.push(effect)
    },
  }

  function render() {
    cursor = 0
    tree = component()
    while (effects.length > 0) effects.shift()()
    return tree
  }

  return {
    React,
    mount(nextComponent) {
      component = nextComponent
      return render()
    },
    tree: () => tree,
  }
}

function childrenOf(node) {
  if (node == null || typeof node !== 'object') return []
  const children = node.props?.children
  return children === undefined ? [] : Array.isArray(children) ? children : [children]
}

function allNodes(root) {
  const nodes = []
  const visit = node => {
    if (node == null || typeof node === 'boolean') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') {
      visit(node.type(node.props))
      return
    }
    nodes.push(node)
    childrenOf(node).forEach(visit)
  }
  visit(root)
  return nodes
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return childrenOf(node).map(textOf).join('')
}

function findByLabel(root, label) {
  const node = allNodes(root).find(candidate => candidate.props?.['aria-label'] === label)
  assert.ok(node, `expected a control labelled ${label}`)
  return node
}

function findButton(root, label) {
  const node = allNodes(root).find(candidate => candidate.type === 'button' && textOf(candidate) === label)
  assert.ok(node, `expected a button named ${label}`)
  return node
}

function optionValues(select) {
  return allNodes(select).filter(node => node.type === 'option').map(node => node.props.value)
}

function namespaceView(overrides = {}) {
  return {
    ns: 'privacy-router',
    value: {
      localProvider: 'ollama',
      localModel: 'qwen3:8b',
      cloudProvider: 'deepseek-official',
      cloudModel: 'deepseek-chat',
      privacyPolicy: '敏感内容留在本机。',
      sensitiveTerms: ['内部代号'],
      blockEmails: true,
      blockPhones: true,
      blockLocalPaths: true,
      maxPromptBytes: 32768,
      classifierMaxTokens: 128,
      cloudMaxTokens: 8192,
      mode: 'routing',
      projectRoot: '',
      publicPaths: [],
      privatePaths: [],
      publicBrief: '',
      maxAgentSteps: 16,
      commandTimeoutSeconds: 60,
      integrationCommand: 'node --test',
      trustedProviders: ['ollama'],
      trustedProviderPrefixes: ['local-'],
      ...overrides,
    },
    base: {},
    user: {},
    revision: 7,
    applies: 'live',
    schema: {},
    secrets: [],
  }
}

function catalog() {
  return {
    groups: [
      { id: 'ollama', name: 'Ollama', models: [{ id: 'qwen3:8b', name: 'Qwen 3 8B' }] },
      { id: 'local-lmstudio', name: 'LM Studio', models: [{ id: 'heretic', name: 'Heretic' }] },
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
      { id: 'privacy-router', name: '智能路由', models: [{ id: 'auto', name: '智能路由' }] },
      { id: 'offline', name: 'Offline', models: [{ id: 'nope', name: 'Unavailable' }] },
    ],
    default: { provider: 'deepseek-official', model: 'deepseek-chat' },
    routableProviders: ['ollama', 'local-lmstudio', 'deepseek-official', 'privacy-router'],
    failures: [],
  }
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

async function loadFixture({ view = namespaceView(), describe, save } = {}) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const harness = createReactHarness()
  let definition
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
  }, { filename: CLIENT_PATH.pathname })
  assert.equal(definition.id, 'dsh-privacy-router')

  const exports = definition.factory(id => {
    assert.equal(id, 'react')
    return harness.React
  })
  let registration
  let describeCalls = 0
  let catalogCalls = 0
  const updates = []
  const ctx = {
    remote: {
      settings: {
        async describe() {
          describeCalls += 1
          return describe?.(describeCalls) ?? { ok: true, value: { writable: true, namespaces: [view] } }
        },
        async update(...args) {
          updates.push(args)
          return save?.(...args) ?? { ok: true, value: namespaceView({ ...view.value, ...args[1] }) }
        },
      },
      session: {
        async modelCatalog() {
          catalogCalls += 1
          return { ok: true, value: catalog() }
        },
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section')
        callback()
      },
      register(options, Component) {
        registration = { options, Component }
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  harness.mount(() => registration.Component(registration.options.inject()))
  await flush()
  return {
    exports,
    harness,
    registration,
    updates,
    describeCalls: () => describeCalls,
    catalogCalls: () => catalogCalls,
  }
}

test('shows an initial load error and retries into the settings form', async () => {
  const fixture = await loadFixture({
    describe: async attempt => attempt === 1
      ? { ok: false, error: { code: 'gateway/internal', message: 'settings unavailable' } }
      : { ok: true, value: { writable: true, namespaces: [namespaceView()] } },
  })

  assert.match(textOf(fixture.harness.tree()), /settings unavailable/)
  assert.doesNotMatch(textOf(fixture.harness.tree()), /正在加载设置/)
  await findButton(fixture.harness.tree(), '重试').props.onClick()
  await flush()

  assert.equal(fixture.describeCalls(), 2)
  assert.equal(findByLabel(fixture.harness.tree(), '隐私规则').props.value, '敏感内容留在本机。')
})

test('registers the 智能路由 settings section and constrains local choices to trusted routable providers', async () => {
  const fixture = await loadFixture()

  assert.deepEqual(Array.from(fixture.exports.inject), ['slots', 'remote', 'remote.settings', 'remote.session'])
  assert.equal(fixture.registration.options.id, 'privacy-router')
  assert.equal(fixture.registration.options.label(), '智能路由')
  assert.deepEqual(optionValues(findByLabel(fixture.harness.tree(), '本地模型')), [
    'ollama/qwen3%3A8b',
    'local-lmstudio/heretic',
  ])
  assert.deepEqual(optionValues(findByLabel(fixture.harness.tree(), '云端模型')), [
    'deepseek-official/deepseek-chat',
  ])
})

test('shows collaboration controls only in collaboration mode and explains each sharing boundary', async () => {
  const fixture = await loadFixture()

  const mode = findByLabel(fixture.harness.tree(), '工作模式')
  assert.deepEqual(optionValues(mode), ['routing', 'collaboration'])
  assert.equal(mode.props.value, 'routing')
  assert.equal(allNodes(fixture.harness.tree()).some(node => node.props?.['aria-label'] === '项目根目录'), false)

  mode.props.onChange({ target: { value: 'collaboration' } })

  assert.equal(findByLabel(fixture.harness.tree(), '项目根目录').props.value, '')
  const explanation = textOf(fixture.harness.tree())
  assert.match(explanation, /公开路径前缀是明确的共享授权/)
  assert.match(explanation, /私密路径前缀优先/)
  assert.match(explanation, /未知内容保留在本地/)
  assert.match(explanation, /\/公开.*当前这一条消息/)
  assert.match(explanation, /公开项目简介.*发送给云端/)
})

test('round-trips collaboration settings and converts path lines to arrays', async () => {
  const fixture = await loadFixture({
    view: namespaceView({
      mode: 'collaboration',
      projectRoot: '/home/test/Projects/example',
      publicPaths: ['public/'],
      privatePaths: ['private/', 'secrets.txt'],
      publicBrief: '只包含可公开的接口说明。',
      maxAgentSteps: 24,
      commandTimeoutSeconds: 90,
    }),
  })

  assert.equal(findByLabel(fixture.harness.tree(), '公开路径（每行一个）').props.value, 'public/')
  assert.equal(findByLabel(fixture.harness.tree(), '私密路径（每行一个）').props.value, 'private/\nsecrets.txt')
  findByLabel(fixture.harness.tree(), '公开路径（每行一个）').props.onChange({
    target: { value: 'public/\n\n  contracts/api.json  \npublic/' },
  })

  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  assert.equal(fixture.updates.length, 1)
  const patch = fixture.updates[0][1]
  assert.deepEqual(Array.from(patch.publicPaths), ['public/', 'contracts/api.json'])
  assert.deepEqual(Array.from(patch.privatePaths), ['private/', 'secrets.txt'])
  assert.equal(patch.mode, 'collaboration')
  assert.equal(patch.projectRoot, '/home/test/Projects/example')
  assert.equal(patch.publicBrief, '只包含可公开的接口说明。')
  assert.equal(patch.maxAgentSteps, 24)
  assert.equal(patch.commandTimeoutSeconds, 90)
})

test('round-trips the locally configured integration command and explains its fixed cloud receipt', async () => {
  const fixture = await loadFixture({
    view: namespaceView({
      mode: 'collaboration',
      integrationCommand: 'npm run integration',
    }),
  })

  const command = findByLabel(fixture.harness.tree(), '集成测试命令')
  assert.equal(command.props.value, 'npm run integration')
  const explanation = textOf(fixture.harness.tree())
  assert.match(explanation, /仅在本地隔离环境执行，原始输出留在本地/)
  assert.match(explanation, /在线模型不能.*指定.*命令/)
  assert.match(explanation, /云端.*固定执行回执，完整结果只在本地显示/)

  command.props.onChange({ target: { value: 'node --test test/integration.test.js' } })
  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  assert.equal(fixture.updates.length, 1)
  assert.equal(fixture.updates[0][1].integrationCommand, 'node --test test/integration.test.js')
})

test('saving a routing field preserves loaded collaboration settings', async () => {
  const collaboration = {
    mode: 'routing',
    projectRoot: '/home/test/Projects/example',
    publicPaths: ['public/'],
    privatePaths: ['private/'],
    publicBrief: '公开说明',
    maxAgentSteps: 32,
    commandTimeoutSeconds: 120,
  }
  const fixture = await loadFixture({ view: namespaceView(collaboration) })
  findByLabel(fixture.harness.tree(), '隐私规则').props.onChange({ target: { value: '更新后的规则' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  const patch = fixture.updates[0][1]
  for (const [key, value] of Object.entries(collaboration)) {
    if (Array.isArray(value)) assert.deepEqual(Array.from(patch[key]), value)
    else assert.equal(patch[key], value)
  }
})

test('rejects unsafe collaboration path rules before persistence', async () => {
  const invalidPaths = ['/absolute/public', '../private', 'public/*', 'safe/../../private']
  for (const invalidPath of invalidPaths) {
    const fixture = await loadFixture({ view: namespaceView({ mode: 'collaboration' }) })
    findByLabel(fixture.harness.tree(), '公开路径（每行一个）').props.onChange({ target: { value: invalidPath } })

    await findButton(fixture.harness.tree(), '保存').props.onClick()

    assert.equal(fixture.updates.length, 0, invalidPath)
    assert.match(textOf(fixture.harness.tree()), /公开路径.*相对文件路径或以 \/ 结尾的目录/)
  }
})

test('rejects collaboration limits outside their supported ranges before persistence', async () => {
  const fixture = await loadFixture({ view: namespaceView({ mode: 'collaboration' }) })
  findByLabel(fixture.harness.tree(), '代理最大步骤数').props.onChange({ target: { value: '65' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()

  assert.equal(fixture.updates.length, 0)
  assert.match(textOf(fixture.harness.tree()), /代理最大步骤数 必须是 1 到 64 之间的整数/)

  findByLabel(fixture.harness.tree(), '代理最大步骤数').props.onChange({ target: { value: '16' } })
  findByLabel(fixture.harness.tree(), '命令超时（秒）').props.onChange({ target: { value: '0' } })
  await findButton(fixture.harness.tree(), '保存').props.onClick()

  assert.equal(fixture.updates.length, 0)
  assert.match(textOf(fixture.harness.tree()), /命令超时（秒） 必须是 1 到 300 之间的整数/)
})

test('rejects classifier output above the backend limit before it reaches settings.update', async () => {
  const fixture = await loadFixture()
  findByLabel(fixture.harness.tree(), '分类器最大输出 token').props.onChange({ target: { value: '1025' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()

  assert.equal(fixture.updates.length, 0)
  assert.match(textOf(fixture.harness.tree()), /分类器最大输出 token 必须是 1 到 1024 之间的整数/)
})

test('saves only editable fields with the read revision and adopts the returned revision', async () => {
  let returnedRevision = 8
  const fixture = await loadFixture({
    save: async (_ns, patch) => ({
      ok: true,
      value: { ...namespaceView({ ...namespaceView().value, ...patch }), revision: returnedRevision },
    }),
  })
  findByLabel(fixture.harness.tree(), '隐私规则').props.onChange({ target: { value: '只允许公开资料进入云端。' } })
  findByLabel(fixture.harness.tree(), '敏感词（每行一个）').props.onChange({ target: { value: '客户甲\n\n  项目乙  \n客户甲' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  assert.equal(fixture.updates.length, 1)
  const [namespace, patch, revision] = fixture.updates[0]
  assert.equal(namespace, 'privacy-router')
  assert.equal(revision, 7)
  assert.equal(patch.privacyPolicy, '只允许公开资料进入云端。')
  assert.deepEqual(Array.from(patch.sensitiveTerms), ['客户甲', '项目乙'])
  assert.equal(Object.hasOwn(patch, 'trustedProviders'), false)
  assert.equal(Object.hasOwn(patch, 'trustedProviderPrefixes'), false)
  assert.match(textOf(fixture.harness.tree()), /设置已保存，将从下一轮对话开始生效/)

  returnedRevision = 9
  await findButton(fixture.harness.tree(), '保存').props.onClick()
  assert.equal(fixture.updates[1][2], 8)
})

test('keeps the unsaved draft and explains a stale-revision refusal', async () => {
  const fixture = await loadFixture({
    save: async () => ({
      ok: false,
      error: { code: 'settings/conflict', message: 'expected revision 7, actual 8' },
    }),
  })
  findByLabel(fixture.harness.tree(), '隐私规则').props.onChange({ target: { value: '我的未保存规则' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  assert.equal(findByLabel(fixture.harness.tree(), '隐私规则').props.value, '我的未保存规则')
  assert.match(textOf(fixture.harness.tree()), /设置已在其他位置更改.*重新加载/)
})

test('shows a server refusal without discarding the draft', async () => {
  const fixture = await loadFixture({
    save: async () => ({
      ok: false,
      error: { code: 'settings/rejected', message: 'cloud provider is not routable' },
    }),
  })
  findByLabel(fixture.harness.tree(), '隐私规则').props.onChange({ target: { value: '保留这段草稿' } })

  await findButton(fixture.harness.tree(), '保存').props.onClick()
  await flush()

  assert.equal(findByLabel(fixture.harness.tree(), '隐私规则').props.value, '保留这段草稿')
  assert.match(textOf(fixture.harness.tree()), /保存失败：cloud provider is not routable/)
})

test('reload replaces the draft from a fresh host snapshot', async () => {
  const fixture = await loadFixture()
  findByLabel(fixture.harness.tree(), '隐私规则').props.onChange({ target: { value: '临时草稿' } })

  await findButton(fixture.harness.tree(), '重新加载').props.onClick()
  await flush()

  assert.equal(fixture.describeCalls(), 2)
  assert.equal(fixture.catalogCalls(), 2)
  assert.equal(findByLabel(fixture.harness.tree(), '隐私规则').props.value, '敏感内容留在本机。')
})
