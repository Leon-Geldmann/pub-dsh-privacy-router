import { AsyncLocalStorage } from 'node:async_hooks'
import { isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CLOUD_SYSTEM_PROMPT, cloudStream, errorStream } from './privacy.js'
import { runCollaboration } from './collaboration.js'

const identity = { provider: 'privacy-router', id: 'auto', name: '智能路由' }
const routerReasoning = {
  efforts: [
    { id: 'auto', name: '默认', description: '跟随本地模型的默认档位；未声明时使用中档，并映射到云端。' },
    { id: 'off', name: '关闭', description: '关闭回答推理；目标模型无法关闭时会明确提示。' },
    { id: 'low', name: '低', description: '使用低档：Qwen Low / DeepSeek Low。' },
    { id: 'medium', name: '中', description: '使用中档：Qwen Medium / DeepSeek High。' },
    { id: 'high', name: '高', description: '使用高档：Qwen High / DeepSeek Max。' },
  ],
  defaultEffort: 'auto',
}
const rankedEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const tiers = ['low', 'medium', 'high']

function rankedReasoning(info) {
  return rankedEfforts.filter(id => info.reasoning?.efforts.some(effort => effort.id === id))
}

function defaultTier(info) {
  const effort = info.reasoning?.defaultEffort
  if (effort === 'off') return 'off'
  const ranked = rankedReasoning(info)
  const index = ranked.indexOf(effort)
  if (index < 0 || ranked.length < 2) return 'medium'
  return tiers[Math.round(index * 2 / (ranked.length - 1))]
}

function mapReasoningEffort(requested, info) {
  if (info.reasoning === undefined) return undefined
  const supported = info.reasoning.efforts.map(effort => effort.id)
  if (requested === 'off') {
    if (supported.includes('off')) return 'off'
    throw new Error(`智能路由：${info.name} 不支持关闭推理，请选择其他推理等级。`)
  }
  const ranked = rankedReasoning(info)
  if (ranked.length > 0) {
    // Match relative intensity, not spelling: DeepSeek's middle tier is high.
    return ranked[Math.floor(tiers.indexOf(requested) * (ranked.length - 1) / 2)]
  }
  if (supported.includes('on')) return 'on'
  if (supported.length === 1 && supported[0] === 'off') return 'off'
  throw new Error(`智能路由：无法映射 ${info.name} 的推理等级，请直接选择该模型。`)
}

export class PrivacyRouterAdapter extends LlmAdapter {
  constructor(ctx, readSettings, admissions) {
    super()
    this.ctx = ctx
    this.readSettings = readSettings
    this.admissions = admissions
    this.streamAdmission = new AsyncLocalStorage()
  }

  admitStream(options, next) {
    const scope = { main: isAgentLoopRequest(options), sessionId: String(options.sessionId), signal: options.signal }
    const storage = this.streamAdmission
    return (async function* () {
      const iterator = next()[Symbol.asyncIterator]()
      let completed = false
      try {
        while (true) {
          const result = await storage.run(scope, () => iterator.next())
          if (result.done) { completed = true; return }
          yield result.value
        }
      } finally {
        if (!completed && iterator.return) await storage.run(scope, () => iterator.return())
      }
    })()
  }

  providerInfo() { return { id: 'privacy-router', name: '智能路由' } }
  async listModels() { return [{ ...identity, description: '隐私优先：敏感内容留在本地，公开问题交给云端。' }] }

  async modelInfo(model, config, signal) {
    if (model !== 'auto') throw new Error('privacy-router: unknown model; select auto')
    signal?.throwIfAborted()
    if (!config.localProvider) return { ...identity, reasoning: routerReasoning }
    const local = await this.ctx.llm.resolveModelInfo(config.localProvider, config.localModel, signal)
    return { ...local, ...identity, reasoning: routerReasoning }
  }

  async resolveModel(_provider, model, signal) {
    return this.modelInfo(model, this.readSettings(), signal)
  }

  async prepareCall(_provider, model, signal) {
    const decision = signal === undefined ? undefined : this.admissions.get(signal)
    const config = decision?.config ?? this.readSettings()
    return {
      model: await this.modelInfo(model, config, signal),
      stream: options => this.dispatch(options, config, decision),
    }
  }

  stream(options) {
    // Auxiliary calls use the same adapter but have no admitted main-turn boundary.
    // Capture synchronously, before async iteration or any settings changes.
    const decision = options.signal === undefined ? undefined : this.admissions.get(options.signal)
    return this.dispatch(options, decision?.config ?? this.readSettings(), decision)
  }

  async targetReasoning(provider, model, requested, signal, config) {
    let local
    if (requested === undefined || requested === 'auto') {
      local = await this.ctx.llm.resolveModelInfo(config.localProvider, config.localModel, signal)
      requested = defaultTier(local)
    }
    const isLocal = provider === config.localProvider && model === config.localModel
    const info = local && isLocal ? local : await this.ctx.llm.resolveModelInfo(provider, model, signal)
    signal?.throwIfAborted()
    const mapped = local && isLocal && local.reasoning?.defaultEffort !== undefined
      ? local.reasoning.defaultEffort : mapReasoningEffort(requested, info)
    return mapped === undefined ? {} : { reasoningEffort: mapped }
  }

  async *dispatch(options, config, decision) {
    options.signal?.throwIfAborted()
    if (!config.localProvider) {
      yield* errorStream('PRIVACY_ROUTER_SETUP_REQUIRED', 'privacy-router: configure a trusted local model in 智能路由 settings first')
      return
    }
    const scope = this.streamAdmission.getStore()
    const admitted = scope?.main && scope.signal === options.signal && options.purpose === undefined
      && scope.sessionId === String(options.sessionId) && decision?.sessionId === scope.sessionId
    if (admitted && config.mode === 'collaboration') {
      yield* runCollaboration({ ctx: this.ctx, options, decision, config,
        reasoningFor: this.targetReasoning.bind(this), readSettings: this.readSettings })
      return
    }
    if (admitted && decision.useCloud) {
      const reasoning = await this.targetReasoning(config.cloudProvider, config.cloudModel, options.reasoningEffort, options.signal, config)
      // Explicit allowlist: no runtime system context, history, tool schemas, replay
      // state, image/file blocks or private message metadata cross this boundary.
      yield* cloudStream(this.ctx.llm.stream({
        provider: config.cloudProvider, model: config.cloudModel,
        messages: structuredClone(decision.candidate.messages),
        system: CLOUD_SYSTEM_PROMPT, tools: [], maxTokens: config.cloudMaxTokens,
        ...reasoning,
        signal: options.signal,
      }))
      return
    }
    const reasoning = await this.targetReasoning(config.localProvider, config.localModel, options.reasoningEffort, options.signal, config)
    // Only the mapped target effort may cross the adapter boundary.
    const { reasoningEffort, ...localOptions } = options
    yield* this.ctx.llm.stream({ ...localOptions, provider: config.localProvider, model: config.localModel, ...reasoning })
  }
}
