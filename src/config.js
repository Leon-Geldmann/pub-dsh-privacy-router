import Schema from '@deepseek-ai/schemastery'

const DEFAULT_PRIVACY_POLICY = [
  'Treat personal data, credentials, local paths, unpublished source code,',
  'internal project details, and confidential business information as sensitive.',
  'Classify as public only when the complete request is both safe to send to an external cloud model',
  'and self-contained without private conversation history.',
].join(' ')

function requireObject(value, label) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function requireString(value, label, fallback) {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return resolved.trim()
}

function requireStringArray(value, label, fallback = []) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`)
  }
  return value.map(item => item.trim())
}

function requirePositiveInteger(value, label, fallback, maximum) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`)
  }
  return resolved
}

function requireBoolean(value, label, fallback) {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return resolved
}

export function resolveConfig(input) {
  const config = requireObject(input, 'privacy router config')
  const known = new Set([
    'cloudProvider',
    'cloudModel',
    'trustedProviders',
    'trustedProviderPrefixes',
    'privacyPolicy',
    'sensitiveTerms',
    'maxPromptBytes',
    'classifierMaxTokens',
    'cloudMaxTokens',
    'localProvider', 'localModel', 'blockEmails', 'blockPhones', 'blockLocalPaths',
  ])
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new TypeError(`unknown privacy router config key: ${key}`)
  }

  const trustedProviders = requireStringArray(config.trustedProviders, 'trustedProviders')
  const trustedProviderPrefixes = requireStringArray(
    config.trustedProviderPrefixes,
    'trustedProviderPrefixes',
    ['local-ai-'],
  )
  if (trustedProviders.length === 0 && trustedProviderPrefixes.length === 0) {
    throw new TypeError('trustedProviders and trustedProviderPrefixes cannot both be empty')
  }

  const privacyPolicy = requireString(config.privacyPolicy, 'privacyPolicy', DEFAULT_PRIVACY_POLICY)
  if (Buffer.byteLength(privacyPolicy) > 16_384) {
    throw new TypeError('privacyPolicy must be at most 16384 UTF-8 bytes')
  }

  const localProvider = config.localProvider === undefined ? '' : config.localProvider
  const localModel = config.localModel === undefined ? '' : config.localModel
  if (typeof localProvider !== 'string' || typeof localModel !== 'string') throw new TypeError('localProvider and localModel must be strings')
  if (Boolean(localProvider.trim()) !== Boolean(localModel.trim())) throw new TypeError('localProvider and localModel must both be configured')
  const resolved = {
    localProvider: localProvider.trim(), localModel: localModel.trim(),
    cloudProvider: requireString(config.cloudProvider, 'cloudProvider', 'deepseek-official'),
    cloudModel: requireString(config.cloudModel, 'cloudModel', 'deepseek-flash'),
    trustedProviders,
    trustedProviderPrefixes,
    privacyPolicy,
    sensitiveTerms: requireStringArray(config.sensitiveTerms, 'sensitiveTerms'),
    maxPromptBytes: requirePositiveInteger(config.maxPromptBytes, 'maxPromptBytes', 32_768, 1_048_576),
    classifierMaxTokens: requirePositiveInteger(
      config.classifierMaxTokens,
      'classifierMaxTokens',
      128,
      1_024,
    ),
    cloudMaxTokens: requirePositiveInteger(config.cloudMaxTokens, 'cloudMaxTokens', 8_192, 65_536),
    blockEmails: requireBoolean(config.blockEmails, 'blockEmails', true),
    blockPhones: requireBoolean(config.blockPhones, 'blockPhones', true),
    blockLocalPaths: requireBoolean(config.blockLocalPaths, 'blockLocalPaths', true),
  }
  if (resolved.localProvider === 'privacy-router' || resolved.cloudProvider === 'privacy-router') throw new TypeError('privacy-router cannot target itself')
  if (resolved.localProvider && !isTrustedProvider(resolved.localProvider, resolved)) throw new TypeError('localProvider must be a trusted local provider')
  return deepFreeze(resolved)
}


export function isTrustedProvider(provider, config) {
  return provider !== 'privacy-router' && (config.trustedProviders.includes(provider)
    || config.trustedProviderPrefixes.some(prefix => provider.startsWith(prefix)))
}

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

export const settingsSchema = Schema.object({
  localProvider: Schema.string(), localModel: Schema.string(),
  cloudProvider: Schema.string(), cloudModel: Schema.string(),
  privacyPolicy: Schema.string(), sensitiveTerms: Schema.array(Schema.string()),
  blockEmails: Schema.boolean(), blockPhones: Schema.boolean(), blockLocalPaths: Schema.boolean(),
  maxPromptBytes: Schema.number(), classifierMaxTokens: Schema.number(), cloudMaxTokens: Schema.number(),
  trustedProviders: Schema.array(Schema.string()), trustedProviderPrefixes: Schema.array(Schema.string()),
})

export function validateSettings(value, hostConfig) {
  const resolved = resolveConfig(value)
  for (const key of ['trustedProviders', 'trustedProviderPrefixes']) {
    if (JSON.stringify(resolved[key]) !== JSON.stringify(hostConfig[key])) {
      throw new TypeError(`${key} is controlled by the host configuration`)
    }
  }
}
