# Selectable Smart Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in 智能路由 model and editable DSH settings without changing ordinary models.
**Architecture:** Register virtual LLM adapter, reuse privacy engine, store user options in DSH settings, expose a client settings section.
**Tech Stack:** JavaScript ESM, Node test runner, DSH Cordis/settings/LLM APIs, host-provided React browser runtime.
**Spec:** docs/superpowers/specs/2026-09-12-selectable-smart-router-design.md

## Global Constraints

- Only provider `privacy-router` model `auto` routes; all ordinary providers are unchanged.
- Privacy-first defaults; sensitive, unknown, failed classification and non-text remain local.
- Cloud gets only approved current plain-text input, fixed system prompt and no tools.
- No DSH core patches, no credentials or machine-specific data committed.
- Node ^22.19.0 or >=24; durable settings namespace `privacy-router`.
- Preserve current selected virtual model across turns; settings updates apply on next turn.

### Task 1: Opt-in adapter, validated settings and privacy engine

**Files:** index.js; src/config.js; src/privacy.js; src/adapter.js as needed; test/router.test.js; package.json; cordis.patch.yml.
**Interfaces:** Host exports apply(ctx, config), inject; provider `privacy-router` / model `auto`; settings contract from spec. Existing DSH references are installed under the DSH installation’s `node_modules/@deepseek-ai/` directory.

- [ ] Add failing behavioral tests with real routing engine and minimal fake external LLM boundary. Assert e.g. `assert.deepEqual(await fixture.request(directLocal), directLocal)` and zero classifier calls; virtual cloud dispatch receives `tools: []` and only candidate; virtual request result remains `{provider:'privacy-router',model:'auto'}`. Cover direct cloud, switch-away, multi-turn, retry, settings snapshots, concurrency, abort, rejected tools and invalid target configuration.
- [ ] Run `node --test` and record intended failures.
- [ ] Implement adapter registration and configuration. `ctx.llm.registerAdapter(['privacy-router'], adapter)`; `ctx.settings.register('privacy-router', schema, {base, validate})`; read current section at each new admitted turn. Keep main request selection virtual and route only in virtual adapter. Register read-only catalog metadata as needed for UI using existing APIs, never new unauthenticated endpoints.
- [ ] Extend package with peer dependencies on host LLM and schemastery (do not duplicate Cordis), exported `./client` pointing to `client.js`, and `dsh.client` inject metadata for settings/slots/remote APIs. Keep browser source as plain loadable host module, no build requirement. Version 0.2.0.
- [ ] Run tests and pack check, self-review, commit owned files, write task report.

### Task 2: Settings UI

**Files:** client.js; test/client.test.js; optional client helpers kept inside factory or separately bundled.
**Interfaces:** Read namespace via `ctx.remote.settings.describe()` and save via `ctx.remote.settings.update('privacy-router', patch, revision)` returning `{ok,value|error}`. Model catalog can use existing `ctx.remote.session.modelCatalog()` (confirm installed API method) or host metadata provided by Task 1; coordinate exact interface. Slot `settings.section`, id `privacy-router`, label 智能路由. Module loader id matches npm package `dsh-privacy-router`.

- [ ] Write failing tests evaluating the actual client factory with controlled React host, exercising draft validation/save, server refusal and stale revision, then implement the UI.
- [ ] Register with `window.__ModuleLoader__.load({id:'dsh-privacy-router', factory(require){...}})`, `exports.inject=['slots','remote','remote.settings',...]`, `ctx.slots.inject('settings.section',()=>ctx.slots.register({...}, SettingsSection))`.
- [ ] Provide labeled target-model selectors, editable policy/terms, rule toggles, advanced limits, save/reload feedback. Never accept arbitrary local target outside trusted providers. Keep unsaved draft on failed save. Use only host UI imports verified in installed bundles; CSS scoped to this plugin and DSH theme variables.
- [ ] Test, self-review, commit owned files and report. Root validates installed integration and attempts rendered UI verification; record any browser access limitation.

### Task 3: Integration and delivery

**Files:** README.md and local-only verification artifacts outside repository.
- [ ] Review both implementation tasks and resolve findings, then run complete suite and pack check.
- [ ] Package/install fork on existing web profile, replace old config with new defaults and enable only new opt-in plugin. Preserve the user’s existing selected/default model. Verify actual Qwen-direct, router-public, router-sensitive, settings save persistence, and switching behavior with isolated test sessions.
- [ ] Confirm runtime adapter active, UI model entry and settings form usable in browser, no new errors.
- [ ] Review final branch, publish checked source to user's fork, pin deployed package to delivered commit, write local install/rollback record and concise Chinese completion message.
