import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runAgent, tool } from './agent-loop.js'
import { authorizationKey, digest, openStore, withProjectLock } from './collaboration-store.js'
import { createWorkspace } from './workspace.js'
import { deterministicBlockReason } from './privacy.js'

const textMessage = text => createUserMessage({ source: { kind: 'plugin', plugin: 'privacy-router' }, content: [{ type: 'text', text }] })
const string = (description, maxLength = 2_097_152) => ({ type: 'string', description, maxLength })
const FILE_TOOLS = [
  tool('list_files', 'List readable project files in your isolated workspace.'),
  tool('read_file', 'Read one project file using a relative path.', { path: string('Relative project path', 4096) }),
  tool('write_file', 'Create or replace a writable project file. Read existing files before editing.', { path: string('Relative project path', 4096), content: string('Complete UTF-8 file contents') }),
  tool('run_command', 'Run a command in your isolated project view, with network disabled and no host home or credentials. Do not attempt to bypass a denied operation.', { command: string('Shell command', 4096) }),
]
const CLOUD_TOOLS = [...FILE_TOOLS,
  tool('delegate_private_task', 'Request implementation behind the public contract by the local worker. Its private instruction is supplied locally. The receipt is independent of outcome; inspect no private files or results.', { task: string('Task expressed only using public context', 16384) }),
  tool('run_integration', 'Request the user-configured full integration check locally. The command is fixed by user settings. Only a fixed receipt returns here; detailed results are displayed locally.'),
]
const CLOUD_SYSTEM = [
  'You are the online development lead in a private/public collaboration.',
  'Develop the overall architecture, public interfaces and allowed public modules using your workspace tools.',
  'Your filesystem contains only explicitly shareable project files. Work at /workspace using relative paths.',
  'Private requirements, source and local results are unavailable to you. Do not infer or request their content.',
  'Delegate private module work through delegate_private_task using public interface contracts.',
  'A new private instruction may exist; the local worker receives it automatically. Do not ask it to disclose the instruction.',
  'A private task or integration receipt does not assert success. Report public work accurately and leave private outcomes to the local report.',
  'Do not embed data-extraction probes in public code or tests. Respect the isolation boundary.',
  'Run public checks when useful, request local integration and finish with a concise report in the user\'s language.',
].join('\n')
const LOCAL_SYSTEM = [
  'You are the local private-module developer. All of this conversation and your results stay on this machine.',
  'Implement the current private instruction within the public architecture and interface contract.',
  'Read the project files needed for the task, edit private files and run appropriate local tests.',
  'You can read public interfaces but cannot edit, create or delete public-policy files, even through shell commands.',
  'Never transfer private data into a public interface, summary, file, log or outbound request.',
  'Tools run at /workspace in an offline sandbox without the host home. Dependency caches and credential files are unavailable.',
  'If a public interface change is required, explain it to the human in your closing report; do not publish it yourself.',
  'Report actual changes, tests and unresolved failures. A model response alone does not prove task success.',
].join('\n')

function publicSafe(value, config) {
  // Inspect original strings: JSON serialization inserts backslashes before
  // quotes and would disguise assignments such as api_key = "secret-value".
  let bytes = 0
  const scan = item => {
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item)
      const reason = item.trim() ? deterministicBlockReason(item, {
        ...config, maxPromptBytes: 33_554_432, blockEmails: false, blockPhones: false, blockLocalPaths: false,
      }) : undefined
      if (reason || bytes > 33_554_432) throw new Error('可外发内容命中凭证、敏感词或长度规则，已阻止发送。')
    } else if (Array.isArray(item)) item.forEach(scan)
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { scan(key); scan(child) }
  }
  scan(value)
  return value
}

function boundedHistory(turns, contextWindow, maxTokens) {
  const budget = Math.max(8192, Math.min(16_777_216, ((contextWindow ?? 32768) - maxTokens) * 2))
  const kept = []
  let bytes = 0
  for (const turn of [...turns].reverse()) {
    const size = Buffer.byteLength(JSON.stringify(turn))
    if (bytes + size > budget) break
    kept.unshift(turn); bytes += size
  }
  return kept.flat()
}

async function perform({ ctx, options, decision, config, reasoningFor, readSettings, signal, emit }) {
  if (!config.projectRoot || !config.publicBrief.trim() || !config.publicPaths.length) {
    throw new Error('请在设置 → 智能路由中填写项目目录、允许外发的文件范围和在线项目说明。其他内容默认留在本地。')
  }
  const permission = authorizationKey(config)
  const assertCurrent = () => {
    signal.throwIfAborted()
    if (authorizationKey(readSettings()) !== permission) throw new Error('协作设置已变更，本轮已停止；下一条消息使用新权限。')
  }
  return withProjectLock(config, signal, async () => {
    assertCurrent()
    const store = await openStore(config, options.sessionId)
    const publicRecord = await store.read('public')
    const privateRecord = await store.read('private')
    const candidate = decision.candidate
    const input = candidate?.text ?? ''
    const inputKey = digest(candidate?.messages.map(message => message.id) ?? [decision.turn, decision.sessionId])
    const previous = privateRecord.runs?.[inputKey]
    if (previous?.state === 'completed') { emit(previous.report); return }
    if (previous) throw new Error('这条需求的上次执行已中断，已保存的文件保留。请发送一条新消息继续，避免重复执行修改。')
    privateRecord.runs ??= {}
    privateRecord.runs[inputKey] = { state: 'started' }
    await store.write('private', privateRecord)
    // A queued batch may contain both public and private user messages. One
    // explicit sharing marker authorizes its own message, never its neighbors.
    const releases = candidate?.messages.map(message => message.content.map(block => block.text).join('\n')
      .match(/^\/公开(?:[ \t\r\n]+)([\s\S]*)$/)?.[1]) ?? []
    const publicInputs = releases.filter(text => text !== undefined)
    const shared = publicInputs.length ? publicInputs.join('\n\n') : undefined
    const hasPrivateInput = releases.some(text => text === undefined)
    if (shared !== undefined) publicSafe(shared, config)
    publicSafe(config.publicBrief, config)
    const workspace = await createWorkspace(config, { stateRoot: join(store.root, 'workspaces'), signal })
    let localHandled = false
    const reports = []
    const report = text => { reports.push(text); emit(text) }
    try {
      const cloudInfo = await ctx.llm.resolveModelInfo(config.cloudProvider, config.cloudModel, signal)
      const localInfo = await ctx.llm.resolveModelInfo(config.localProvider, config.localModel, signal)
      const cloudRoute = { provider: config.cloudProvider, model: config.cloudModel, maxTokens: config.cloudMaxTokens,
        ...await reasoningFor(config.cloudProvider, config.cloudModel, options.reasoningEffort, signal, config) }
      const localRoute = { provider: config.localProvider, model: config.localModel, maxTokens: options.maxTokens ?? 8192,
        ...await reasoningFor(config.localProvider, config.localModel, options.reasoningEffort, signal, config) }
      const fileOperation = async (scope, name, args) => {
        assertCurrent()
        if (name === 'list_files') return workspace.list(scope)
        if (name === 'read_file') return workspace.read(scope, args.path)
        if (name === 'write_file') return workspace.write(scope, args.path, args.content)
        if (name === 'run_command') return workspace.run(scope, args.command, { signal, timeoutMs: config.commandTimeoutSeconds * 1000 })
        throw new Error('Unsupported operation')
      }
      const privateTask = async task => {
        localHandled = true
        try {
          assertCurrent(); await workspace.commit('public'); await workspace.refreshPrivate()
          report('\n\n**本地 Qwen：正在开发私有模块**\n')
          const current = textMessage(JSON.stringify({ currentPrivateInstruction: input, publicTask: task,
            publicProjectBrief: config.publicBrief, privateFileRules: config.privatePaths }))
          const before = boundedHistory(privateRecord.turns, localInfo.context?.contextWindow, localRoute.maxTokens)
          const result = await runAgent({ llm: ctx.llm, route: localRoute, system: LOCAL_SYSTEM,
            messages: [...before, current], tools: FILE_TOOLS,
            execute: (name, args) => fileOperation('private', name, args), maxSteps: config.maxAgentSteps,
            signal, assertCurrent, progress: (kind, name) => { if (kind === 'tool') emit(`本地正在执行：${name}\n`) } })
          assertCurrent(); await workspace.commit('private')
          privateRecord.turns.push(result.messages.slice(before.length))
          privateRecord.turns = privateRecord.turns.slice(-32)
          await store.write('private', privateRecord)
          report(`\n**本地结果（仅在本机显示）**\n${result.text}\n`)
        } catch (error) {
          signal.throwIfAborted(); assertCurrent()
          report(`\n**本地任务未完成（仅在本机显示）**\n${String(error.message).slice(0, 8192)}\n`)
        }
        // Neither provider errors nor success/failure may become an oracle.
        return { receipt: 'recorded_locally' }
      }
      const integration = async () => {
        try {
          assertCurrent(); await workspace.commit('public'); await workspace.refreshPrivate()
          emit('\n正在本地执行集成测试。\n')
          const result = await workspace.run('private', config.integrationCommand, { signal, timeoutMs: config.commandTimeoutSeconds * 1000 })
          report(`\n**本地集成测试：${result.exitCode === 0 ? '通过' : '未通过'}**\n${result.stdout || ''}${result.stderr || ''}\n`)
        } catch (error) {
          signal.throwIfAborted(); assertCurrent()
          report(`\n**本地集成测试未完成**\n${String(error.message).slice(0, 8192)}\n`)
        }
        return { receipt: 'recorded_locally' }
      }
      const before = boundedHistory(publicRecord.turns, cloudInfo.context?.contextWindow, cloudRoute.maxTokens)
      const current = textMessage(shared !== undefined ? shared : 'Continue the approved public project. A private instruction is held locally; delegate the private implementation behind the public interfaces.')
      const cloudMessages = [...before, current]
      publicSafe(cloudMessages, config)
      emit('**在线模型：正在推进架构与可外发模块**\n')
      const result = await runAgent({ llm: ctx.llm, route: cloudRoute, system: `${CLOUD_SYSTEM}\n\nAPPROVED PROJECT BRIEF:\n${config.publicBrief}`,
        messages: cloudMessages, tools: CLOUD_TOOLS, maxSteps: config.maxAgentSteps, signal, assertCurrent,
        progress: (kind, name) => { if (kind === 'tool') emit(`在线正在执行：${name}\n`) },
        execute: async (name, args) => {
          if (name === 'delegate_private_task') return privateTask(args.task)
          if (name === 'run_integration') return integration()
          return publicSafe(await fileOperation('public', name, args), config)
        } })
      assertCurrent(); await workspace.commit('public')
      publicRecord.turns.push(result.messages.slice(before.length))
      publicRecord.turns = publicRecord.turns.slice(-64)
      await store.write('public', publicRecord)
      report(`\n**在线结果**\n${result.text}\n`)
      if (!localHandled && hasPrivateInput) await privateTask(result.text)
      privateRecord.runs[inputKey] = { state: 'completed', report: reports.join('') }
      const keys = Object.keys(privateRecord.runs)
      for (const key of keys.slice(0, -32)) delete privateRecord.runs[key]
      await store.write('private', privateRecord)
    } finally { await workspace.dispose() }
  })
}

export async function* runCollaboration(args) {
  const controller = new AbortController()
  const signal = args.options.signal ? AbortSignal.any([args.options.signal, controller.signal]) : controller.signal
  const queue = []
  let wake, done = false, failure
  const task = perform({ ...args, signal, emit: text => { queue.push(text); wake?.(); wake = undefined } })
    .catch(error => { failure = error })
    .finally(() => { done = true; wake?.(); wake = undefined })
  try {
    while (!done || queue.length) {
      if (queue.length) yield { type: 'text-delta', index: 0, text: queue.shift() }
      else await new Promise(resolve => { wake = resolve })
    }
    if (failure) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PRIVACY_COLLABORATION_FAILED', message: failure.message } } }
    else yield { type: 'finish', reason: { kind: 'stop' } }
  } finally { controller.abort(); await task }
}
