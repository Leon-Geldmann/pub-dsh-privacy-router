# Selectable Smart Router

The user's requested behavior is the authority: an independent model choice enables smart routing; choosing a local Qwen or any other ordinary model leaves that provider completely untouched. Routing rules are edited in the DSH Settings UI. The user explicitly chose privacy-first defaults: sensitive content stays local, public questions go to cloud.

## Architecture

Publish a DSH bundle from the user's fork. Register provider `privacy-router` with model `auto`, displayed as 智能路由. Use the existing public DSH LLM adapter and settings APIs, plus a browser `dsh.client` entry registering a `settings.section` slot. Do not patch DSH core. Keep virtual provider/model in request headers, so selection persists across turns and restarts. Route inside the virtual adapter. Never intercept or block calls selecting an ordinary provider.

Reuse upstream deterministic privacy rules and local classifier/context projection. Only current, approved, plain-text user input and a fixed system prompt reach cloud, with no local tools. Sensitive/unknown/classification-error/multimodal/context-dependent input stays local. Each turn snapshots its routing settings; tool continuations and retries reuse the decision. Auxiliary calls without an admitted main turn default to local. A cloud response attempting a tool call is refused. Invalid settings and recursive router targets are rejected before persistence. Existing cloud errors remain explicit (no silent transmission to a different provider).

## Settings contract

Settings namespace `privacy-router`. The UI edits `localProvider`, `localModel`, `cloudProvider`, `cloudModel`, `privacyPolicy` (editable natural-language privacy definition), `sensitiveTerms` (array, one term per UI line), `blockEmails`, `blockPhones`, `blockLocalPaths` (booleans), `maxPromptBytes`, `classifierMaxTokens`, `cloudMaxTokens`. Credentials/private key rules remain mandatory. Trusted local providers are configured by `trustedProviders`/`trustedProviderPrefixes` in host config; UI local choices must come from this trust boundary. Generic defaults leave local target unset and show a setup message. Local deployment supplies the three already verified local providers and selects Heretic as router's local target. Cloud deployment default uses current installed `deepseek-flash`.

Settings are durable through ctx.settings; saves validate, use expectedRevision for stale-edit protection, and take effect on the next turn. UI reads models from existing host catalog API; local model choices are constrained by trusted providers. Ordinary providers keep all existing settings, model limits and presets.

## UX

Model selection: a separate 智能路由 provider/model. Settings navigation: 智能路由. Page includes local and cloud model selectors; privacy checks; editable rules and sensitive terms; collapsed advanced limits; Save and reload/reset-draft actions with visible success/failure. Fit the existing DSH light/dark tokens and form density; use labels and keyboard-accessible controls. Explain that only selecting 智能路由 enables the rules.

## Verification

Tests must prove ordinary Qwen AND direct cloud requests bypass classification, routing, and restrictions; virtual route remains selected across turns/retries; switching from virtual to ordinary routes restores direct behavior; concurrent sessions do not share decisions. Cover settings validation and changes between turns, sanitized cloud context, sensitive/unknown local paths, abort and cloud tool rejection. Run actual installed DSH headless smoke requests, inspect live provider catalog and settings APIs, and verify model menu plus settings save/reload in browser. Do not send private user conversation or project files to test cloud calls. Preserve existing sessions and manually launched web service behavior.
