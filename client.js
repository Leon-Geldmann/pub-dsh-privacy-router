window.__ModuleLoader__.load({
  id: 'dsh-privacy-router',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NAMESPACE = 'privacy-router'
    const EDITABLE_FIELDS = [
      'localProvider',
      'localModel',
      'cloudProvider',
      'cloudModel',
      'privacyPolicy',
      'sensitiveTerms',
      'blockEmails',
      'blockPhones',
      'blockLocalPaths',
      'maxPromptBytes',
      'classifierMaxTokens',
      'cloudMaxTokens',
    ]
    const LIMITS = {
      maxPromptBytes: { label: '最大提示词字节数', maximum: 1048576 },
      classifierMaxTokens: { label: '分类器最大输出 token', maximum: 1024 },
      cloudMaxTokens: { label: '云端最大输出 token', maximum: 65536 },
    }
    const styles = `
      .dpr-section{box-sizing:border-box;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px;padding:0 0 24px}
      .dpr-section *{box-sizing:border-box}
      .dpr-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
      .dpr-intro,.dpr-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
      .dpr-card{display:flex;flex-direction:column;gap:13px;padding:16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-module-platform)}
      .dpr-card-title{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dpr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
      .dpr-field{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
      .dpr-input{width:100%;min-width:0;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
      .dpr-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
      .dpr-input:disabled{cursor:default;opacity:.55}
      .dpr-textarea{height:auto;min-height:86px;padding:9px 10px;resize:vertical}
      .dpr-terms{min-height:110px;font-family:var(--ds-font-family-code,monospace)}
      .dpr-switches{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 12px}
      .dpr-switch{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
      .dpr-switch input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
      .dpr-advanced{padding-top:2px;border-top:.5px solid var(--dsw-alias-border-l2)}
      .dpr-summary{cursor:pointer;width:max-content;padding:10px 2px 0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
      .dpr-advanced-body{padding-top:12px}
      .dpr-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
      .dpr-button{height:36px;padding:0 15px;border:.5px solid var(--dsw-alias-border-l3);border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
      .dpr-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dpr-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .dpr-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dpr-button:disabled{cursor:default;opacity:.45}
      .dpr-message{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:18px}
      .dpr-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
      .dpr-success{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-module-platform)}
      .dpr-warning{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-module-platform)}
    `

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-privacy-router"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NAMESPACE
      tag.dataset.pluginCss = NAMESPACE
      tag.textContent = styles
      document.head.appendChild(tag)
    }

    function routeValue(provider, model) {
      if (!provider || !model) return ''
      return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
    }

    function readRoute(value) {
      const separator = value.indexOf('/')
      if (separator < 1 || separator === value.length - 1) return undefined
      try {
        return {
          provider: decodeURIComponent(value.slice(0, separator)),
          model: decodeURIComponent(value.slice(separator + 1)),
        }
      } catch {
        return undefined
      }
    }

    function editableDraft(value) {
      return {
        localRoute: routeValue(value.localProvider, value.localModel),
        cloudRoute: routeValue(value.cloudProvider, value.cloudModel),
        privacyPolicy: typeof value.privacyPolicy === 'string' ? value.privacyPolicy : '',
        sensitiveTerms: Array.isArray(value.sensitiveTerms) ? value.sensitiveTerms.join('\n') : '',
        blockEmails: value.blockEmails === true,
        blockPhones: value.blockPhones === true,
        blockLocalPaths: value.blockLocalPaths === true,
        maxPromptBytes: String(value.maxPromptBytes ?? ''),
        classifierMaxTokens: String(value.classifierMaxTokens ?? ''),
        cloudMaxTokens: String(value.cloudMaxTokens ?? ''),
      }
    }

    function trustedProvider(provider, value) {
      const exact = Array.isArray(value.trustedProviders) ? value.trustedProviders : []
      const prefixes = Array.isArray(value.trustedProviderPrefixes) ? value.trustedProviderPrefixes : []
      return exact.includes(provider) || prefixes.some(prefix => provider.startsWith(prefix))
    }

    function modelChoices(catalog, value, local) {
      const routable = new Set(Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [])
      const groups = Array.isArray(catalog.groups) ? catalog.groups : []
      const choices = []
      for (const group of groups) {
        if (!group || group.id === NAMESPACE || !routable.has(group.id)) continue
        if (trustedProvider(group.id, value) !== local) continue
        for (const model of Array.isArray(group.models) ? group.models : []) {
          if (!model || typeof model.id !== 'string' || model.id.length === 0) continue
          choices.push({
            value: routeValue(group.id, model.id),
            label: `${group.name || group.id} · ${model.name || model.id}`,
          })
        }
      }
      return choices
    }

    function utf8Length(value) {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
      return unescape(encodeURIComponent(value)).length
    }

    function parseTerms(value) {
      const seen = new Set()
      const terms = []
      for (const line of value.split(/\r?\n/)) {
        const term = line.trim()
        if (term.length > 0 && !seen.has(term)) {
          seen.add(term)
          terms.push(term)
        }
      }
      return terms
    }

    function validateDraft(draft, localChoices, cloudChoices) {
      if (!localChoices.some(choice => choice.value === draft.localRoute)) return '请选择受信任且当前可用的本地模型。'
      if (!cloudChoices.some(choice => choice.value === draft.cloudRoute)) return '请选择当前可用的云端模型。'
      if (draft.privacyPolicy.trim().length === 0) return '隐私规则不能为空。'
      if (utf8Length(draft.privacyPolicy) > 16384) return '隐私规则不能超过 16384 字节。'
      for (const [key, constraint] of Object.entries(LIMITS)) {
        const value = Number(draft[key])
        if (!Number.isInteger(value) || value < 1 || value > constraint.maximum) {
          return `${constraint.label} 必须是 1 到 ${constraint.maximum} 之间的整数。`
        }
      }
      return undefined
    }

    function patchFromDraft(draft) {
      const local = readRoute(draft.localRoute)
      const cloud = readRoute(draft.cloudRoute)
      return {
        localProvider: local.provider,
        localModel: local.model,
        cloudProvider: cloud.provider,
        cloudModel: cloud.model,
        privacyPolicy: draft.privacyPolicy,
        sensitiveTerms: parseTerms(draft.sensitiveTerms),
        blockEmails: draft.blockEmails,
        blockPhones: draft.blockPhones,
        blockLocalPaths: draft.blockLocalPaths,
        maxPromptBytes: Number(draft.maxPromptBytes),
        classifierMaxTokens: Number(draft.classifierMaxTokens),
        cloudMaxTokens: Number(draft.cloudMaxTokens),
      }
    }

    function resultError(response, fallback) {
      return response && response.ok === false && response.error
        ? response.error.message || response.error.code || fallback
        : fallback
    }

    function createOperations(ctx) {
      return {
        async load() {
          const [settingsResponse, catalogResponse] = await Promise.all([
            ctx.remote.settings.describe(),
            ctx.remote.session.modelCatalog(),
          ])
          if (!settingsResponse.ok) throw new Error(resultError(settingsResponse, '无法读取设置。'))
          if (!catalogResponse.ok) throw new Error(resultError(catalogResponse, '无法读取模型目录。'))
          const namespaces = settingsResponse.value && Array.isArray(settingsResponse.value.namespaces)
            ? settingsResponse.value.namespaces
            : []
          const view = namespaces.find(namespace => namespace.ns === NAMESPACE)
          if (!view) throw new Error('未找到智能路由设置。请确认插件已在服务端启用。')
          return {
            writable: settingsResponse.value.writable === true,
            view,
            catalog: catalogResponse.value,
          }
        },
        save(patch, revision) {
          return ctx.remote.settings.update(NAMESPACE, patch, revision)
        },
      }
    }

    function option(choice) {
      return h('option', { key: choice.value, value: choice.value }, choice.label)
    }

    function ModelSelect({ label, value, choices, disabled, onChange, emptyText }) {
      const options = choices.map(option)
      if (choices.length === 0 || !choices.some(choice => choice.value === value)) {
        options.unshift(h('option', { key: '', value: '', disabled: choices.length > 0 }, emptyText))
      }
      return h('label', { className: 'dpr-field' },
        label,
        h('select', {
          className: 'dpr-input',
          'aria-label': label,
          value,
          disabled: disabled || choices.length === 0,
          onChange,
        }, options),
      )
    }

    function TextField({ label, value, rows, className = '', disabled, onChange }) {
      return h('label', { className: 'dpr-field' },
        label,
        h('textarea', {
          className: `dpr-input dpr-textarea ${className}`,
          'aria-label': label,
          value,
          rows,
          disabled,
          onChange,
        }),
      )
    }

    function Toggle({ label, checked, disabled, onChange }) {
      return h('label', { className: 'dpr-switch' },
        h('input', { type: 'checkbox', 'aria-label': label, checked, disabled, onChange }),
        h('span', null, label),
      )
    }

    function LimitField({ name, draft, disabled, update }) {
      const constraint = LIMITS[name]
      return h('label', { className: 'dpr-field' },
        constraint.label,
        h('input', {
          className: 'dpr-input',
          type: 'number',
          min: 1,
          max: constraint.maximum,
          step: 1,
          inputMode: 'numeric',
          'aria-label': constraint.label,
          value: draft[name],
          disabled,
          onChange: event => update(name, event.target.value),
        }),
      )
    }

    function SettingsSection({ operations }) {
      const [state, setState] = React.useState({ status: 'idle', error: '', notice: '' })
      const [draft, setDraft] = React.useState(null)

      const load = async () => {
        setState(current => ({ ...current, status: 'loading', error: '', notice: '' }))
        try {
          const loaded = await operations.load()
          setDraft(editableDraft(loaded.view.value || {}))
          setState({ status: 'ready', error: '', notice: '', ...loaded })
        } catch (error) {
          setState(current => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            notice: '',
          }))
        }
      }

      React.useEffect(() => {
        let active = true
        operations.load().then(loaded => {
          if (!active) return
          setDraft(editableDraft(loaded.view.value || {}))
          setState({ status: 'ready', error: '', notice: '', ...loaded })
        }).catch(error => {
          if (!active) return
          setState({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            notice: '',
          })
        })
        return () => { active = false }
      }, [operations])

      if (state.status === 'error' && !state.view) {
        return h('section', { className: 'dpr-section', 'aria-label': '智能路由设置' },
          h('h2', { className: 'dpr-title' }, '智能路由'),
          h('p', { className: 'dpr-message dpr-error', role: 'alert' }, state.error),
          h('div', { className: 'dpr-actions' },
            h('button', { type: 'button', className: 'dpr-button', onClick: load }, '重试'),
          ),
        )
      }

      if (state.status === 'idle' || state.status === 'loading' || draft === null) {
        return h('section', { className: 'dpr-section', 'aria-label': '智能路由设置' },
          h('h2', { className: 'dpr-title' }, '智能路由'),
          h('p', { className: 'dpr-hint', role: 'status' }, '正在加载设置…'),
        )
      }

      const update = (key, value) => {
        setDraft(current => ({ ...current, [key]: value }))
        setState(current => ({ ...current, error: '', notice: '' }))
      }
      const localChoices = modelChoices(state.catalog, state.view.value || {}, true)
      const cloudChoices = modelChoices(state.catalog, state.view.value || {}, false)
      const disabled = state.status === 'saving' || !state.writable

      const save = async () => {
        const validation = validateDraft(draft, localChoices, cloudChoices)
        if (validation) {
          setState(current => ({ ...current, error: validation, notice: '' }))
          return
        }
        const patch = patchFromDraft(draft)
        for (const key of Object.keys(patch)) {
          if (!EDITABLE_FIELDS.includes(key)) Reflect.deleteProperty(patch, key)
        }
        setState(current => ({ ...current, status: 'saving', error: '', notice: '' }))
        try {
          const response = await operations.save(patch, state.view.revision)
          if (!response.ok) {
            const conflict = response.error && response.error.code === 'settings/conflict'
            setState(current => ({
              ...current,
              status: 'ready',
              error: conflict
                ? '设置已在其他位置更改。请重新加载后再保存，当前草稿仍会保留。'
                : `保存失败：${resultError(response, '服务端拒绝了这次更改。')}`,
            }))
            return
          }
          setDraft(editableDraft(response.value.value || patch))
          setState(current => ({
            ...current,
            status: 'ready',
            view: response.value,
            error: '',
            notice: '设置已保存，将从下一轮对话开始生效。',
          }))
        } catch (error) {
          setState(current => ({
            ...current,
            status: 'ready',
            error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
          }))
        }
      }

      return h('section', { className: 'dpr-section', 'aria-label': '智能路由设置' },
        h('div', null,
          h('h2', { className: 'dpr-title' }, '智能路由'),
          h('p', { className: 'dpr-intro' }, '只有在模型选择器中选择“智能路由”时，下面的规则才会启用。普通 Qwen 和其他模型保持原来的直连行为。'),
        ),
        !state.writable && h('p', { className: 'dpr-message dpr-warning', role: 'status' }, '当前部署的设置为只读。'),
        localChoices.length === 0 && h('p', { className: 'dpr-message dpr-warning', role: 'status' }, '尚未发现受信任的本地模型。请先在主机配置中设置可信提供方。'),
        state.error && h('p', { className: 'dpr-message dpr-error', role: 'alert' }, state.error),
        state.notice && h('p', { className: 'dpr-message dpr-success', role: 'status' }, state.notice),
        h('div', { className: 'dpr-card' },
          h('h3', { className: 'dpr-card-title' }, '路由目标'),
          h('p', { className: 'dpr-hint' }, '敏感、无法判断或依赖本地上下文的内容使用本地模型；仅将判定为公开的当前文本发送给云端模型。'),
          h('div', { className: 'dpr-grid' },
            h(ModelSelect, {
              label: '本地模型',
              value: draft.localRoute,
              choices: localChoices,
              disabled,
              emptyText: '未配置可信本地模型',
              onChange: event => update('localRoute', event.target.value),
            }),
            h(ModelSelect, {
              label: '云端模型',
              value: draft.cloudRoute,
              choices: cloudChoices,
              disabled,
              emptyText: '未选择云端模型',
              onChange: event => update('cloudRoute', event.target.value),
            }),
          ),
          h('details', { className: 'dpr-advanced' },
            h('summary', { className: 'dpr-summary' }, '推理等级如何匹配'),
            h('p', { className: 'dpr-hint' }, '在聊天模型菜单中统一选择：模型默认、关闭、低、中、高、最高。选择“模型默认”时，各目标保留自身默认设置；隐私分类始终关闭推理。'),
            h('p', { className: 'dpr-hint' }, '同名档位直接使用；缺档时优先选较低档，没有较低档则用最低可用档。“最高”使用目标支持的最高档。不同模型的同名档位不代表相同思考量。'),
            h('p', { className: 'dpr-hint' }, '不支持推理的模型照常回答，不发送推理参数。只能开启推理的模型无法使用“关闭”，会明确提示；无法识别的档位请选“模型默认”。'),
          ),
        ),
        h('div', { className: 'dpr-card' },
          h('h3', { className: 'dpr-card-title' }, '隐私判断'),
          h(TextField, {
            label: '隐私规则',
            value: draft.privacyPolicy,
            rows: 4,
            disabled,
            onChange: event => update('privacyPolicy', event.target.value),
          }),
          h(TextField, {
            label: '敏感词（每行一个）',
            value: draft.sensitiveTerms,
            rows: 5,
            className: 'dpr-terms',
            disabled,
            onChange: event => update('sensitiveTerms', event.target.value),
          }),
          h('div', { className: 'dpr-switches' },
            h(Toggle, { label: '拦截邮箱地址', checked: draft.blockEmails, disabled, onChange: event => update('blockEmails', event.target.checked) }),
            h(Toggle, { label: '拦截电话号码', checked: draft.blockPhones, disabled, onChange: event => update('blockPhones', event.target.checked) }),
            h(Toggle, { label: '拦截本地文件路径', checked: draft.blockLocalPaths, disabled, onChange: event => update('blockLocalPaths', event.target.checked) }),
          ),
          h('details', { className: 'dpr-advanced' },
            h('summary', { className: 'dpr-summary' }, '高级限制'),
            h('div', { className: 'dpr-grid dpr-advanced-body' },
              h(LimitField, { name: 'maxPromptBytes', draft, disabled, update }),
              h(LimitField, { name: 'classifierMaxTokens', draft, disabled, update }),
              h(LimitField, { name: 'cloudMaxTokens', draft, disabled, update }),
            ),
          ),
        ),
        h('div', { className: 'dpr-actions' },
          h('button', { type: 'button', className: 'dpr-button', disabled: state.status === 'saving', onClick: load }, '重新加载'),
          h('button', { type: 'button', className: 'dpr-button dpr-primary', disabled, onClick: save }, state.status === 'saving' ? '保存中…' : '保存'),
        ),
      )
    }

    const inject = ['slots', 'remote', 'remote.settings', 'remote.session']

    function apply(ctx) {
      const operations = createOperations(ctx)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NAMESPACE,
        order: 20,
        label: () => '智能路由',
        inject: () => ({ operations }),
      }, SettingsSection))
    }

    exports.SettingsSection = SettingsSection
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
