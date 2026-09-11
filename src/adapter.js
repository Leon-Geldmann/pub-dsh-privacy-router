import { AsyncLocalStorage } from 'node:async_hooks'
import { isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CLOUD_SYSTEM_PROMPT, cloudStream, errorStream } from './privacy.js'

const identity = { provider: 'privacy-router', id: 'auto', name: '智能路由' }

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
    if (!config.localProvider) return { ...identity }
    const local = await this.ctx.llm.resolveModelInfo(config.localProvider, config.localModel, signal)
    return { ...local, ...identity }
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

  async *dispatch(options, config, decision) {
    options.signal?.throwIfAborted()
    if (!config.localProvider) {
      yield* errorStream('PRIVACY_ROUTER_SETUP_REQUIRED', 'privacy-router: configure a trusted local model in 智能路由 settings first')
      return
    }
    const scope = this.streamAdmission.getStore()
    const admitted = scope?.main && scope.signal === options.signal && options.purpose === undefined
      && scope.sessionId === String(options.sessionId) && decision?.sessionId === scope.sessionId
    if (admitted && decision.useCloud) {
      // Explicit allowlist: no runtime system context, history, tool schemas, replay
      // state, image/file blocks or private message metadata cross this boundary.
      yield* cloudStream(this.ctx.llm.stream({
        provider: config.cloudProvider, model: config.cloudModel,
        messages: structuredClone(decision.candidate.messages),
        system: CLOUD_SYSTEM_PROMPT, tools: [], maxTokens: config.cloudMaxTokens,
        signal: options.signal,
      }))
      return
    }
    yield* this.ctx.llm.stream({ ...options, provider: config.localProvider, model: config.localModel })
  }
}
