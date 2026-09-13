import { PrivacyRouterAdapter } from './src/adapter.js'
import { deepFreeze, resolveConfig, settingsSchema, validateSettings } from './src/config.js'
import { classifyLocally, contextualizeCandidate, deterministicBlockReason, readCandidate } from './src/privacy.js'

export { resolveConfig } from './src/config.js'
export { deterministicBlockReason } from './src/privacy.js'
export const name = 'privacy-router'
export const inject = ['llm', 'settings']

export function apply(ctx, inputConfig) {
  const hostConfig = resolveConfig(inputConfig)
  const settings = ctx.settings.register('privacy-router', settingsSchema, {
    base: hostConfig,
    validate: value => validateSettings(value, hostConfig),
  })
  const candidates = new WeakMap()
  const decisions = new WeakMap()
  // The host uses one AbortSignal per running turn. Weak keys release completed turns;
  // prepared calls keep their own captured value even if a later turn uses new settings.
  const admissions = new WeakMap()
  const adapter = new PrivacyRouterAdapter(ctx, () => resolveConfig(settings.get()), admissions)
  ctx.llm.registerAdapter(['privacy-router'], adapter)
  // Record official admission before host projection can replace the request object.
  ctx.on('llm/stream', (options, next) => options.provider === 'privacy-router'
    ? adapter.admitStream(options, next) : next())

  ctx.on('agent/pre-step', async (payload, next) => {
    const previous = decisions.get(payload.agent)
    if (previous?.turn !== payload.turn) {
      decisions.delete(payload.agent)
      const candidate = readCandidate(payload.messages)
      candidates.set(payload.agent, {
        turn: payload.turn,
        candidate: candidate === undefined ? undefined : deepFreeze(structuredClone(candidate)),
        history: structuredClone(payload.agent.session.deriveMessages?.() ?? []),
      })
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const proposal = await next()
    if (proposal.provider !== 'privacy-router') {
      candidates.delete(payload.agent)
      decisions.delete(payload.agent)
      if (payload.signal) admissions.delete(payload.signal)
      return proposal
    }
    if (proposal.model !== 'auto') throw new Error('privacy-router: select the auto model')
    payload.signal?.throwIfAborted()
    let decision = decisions.get(payload.agent)
    if (decision?.turn !== payload.turn) {
      const config = resolveConfig(settings.get())
      if (!config.localProvider) throw new Error('privacy-router: configure a trusted local model in 智能路由 settings first')
      const captured = candidates.get(payload.agent)
      candidates.delete(payload.agent)
      if (config.mode === 'collaboration') {
        if (!captured?.candidate) throw new Error('协作开发目前接受直接输入的文本需求；文件请放入已配置的项目目录。')
        decision = deepFreeze({ turn: payload.turn, sessionId: String(payload.agent.session.id), config, candidate: captured.candidate })
        decisions.set(payload.agent, decision)
        if (payload.signal) admissions.set(payload.signal, decision)
        return proposal.reasoningEffort === 'max' ? { ...proposal, reasoningEffort: 'high' } : proposal
      }
      const candidate = captured?.turn === payload.turn && captured.candidate !== undefined
        ? contextualizeCandidate({ deriveMessages: () => captured.history }, captured.candidate, config)
        : undefined
      let useCloud = false
      if (candidate !== undefined && deterministicBlockReason(candidate.text, config) === undefined) {
        try {
          const result = await classifyLocally(ctx, config, candidate, {
            provider: config.localProvider, model: config.localModel,
          }, payload.signal)
          useCloud = result.classification === 'public'
        } catch {
          // Provider/classification errors fail closed; cancellation is rethrown below.
        }
      }
      payload.signal?.throwIfAborted()
      decision = deepFreeze({
        turn: payload.turn, sessionId: String(payload.agent.session.id), config,
        useCloud, candidate: useCloud ? candidate : undefined,
      })
      decisions.set(payload.agent, decision)
    }
    if (payload.signal) admissions.set(payload.signal, decision)
    // Older router sessions saved a sixth "max" choice. Keep them usable with
    // the five-choice menu; direct providers returned above retain their enums.
    return proposal.reasoningEffort === 'max' ? { ...proposal, reasoningEffort: 'high' } : proposal
  })
}
