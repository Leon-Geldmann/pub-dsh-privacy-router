# Private Development Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Provide a cloud development lead and a local private worker without exporting private source or conversation.

**Architecture:** A virtual adapter owns two bounded LLM/tool loops and separate persisted histories. Public/private project snapshots, fixed export receipts and sandboxed commands enforce the boundary locally.

**Tech Stack:** Node.js 22+, ES modules, DSH 0.1.5 LLM/settings APIs, plain React client, Linux bubblewrap, node:test.

**Spec:** docs/superpowers/specs/2026-09-12-private-development-design.md

## Global Constraints

- One privacy-router/auto model; auto/off/low/medium/high only. Preserve direct models and existing routing mode.
- Private source, input, diagnostics and local-generated summaries never enter cloud envelopes.
- No external dependencies; no unsandboxed command fallback; no existing user project is auto-authorized.
- Current host targets and global model choice are preserved. Plugin configuration is backed up before install.
- Source paths in reports must be absolute. Source files under ChatGPT project sources/ are read-only.

### Task 1: Confined project snapshots and command execution

**Files:** Create src/workspace.js, src/sandbox.js, test/workspace.test.js.

**Interfaces:** `await createWorkspace({ projectRoot, publicPaths, privatePaths }, { stateRoot, signal })` returns `{ publicRoot, privateRoot, read(scope,path), list(scope), write(scope,path,content), run(scope,command,{signal,timeoutMs}), commit(scope), refreshPrivate(), dispose() }`. Scope is `public` or `private`. list/read operate only on authorized relative regular files and return safe data. run returns `{exitCode,stdout,stderr}`; callers must never export a private result. Public/private snapshots commit only their writable path class, against original hashes. `refreshPrivate()` overlays committed public files into the private snapshot before a private task. A private snapshot contains public files for context but commits cannot alter them. Public path prefixes use `dir/` or exact `file`, no glob syntax.

- [ ] Write node:test cases using temporary roots and private canaries: public list/read excludes private paths and .env/.git, public write and commit remain confined, private cannot publish through public prefixes, symlinks/hardlinks/traversal denied, conflicts preserve external modifications, private refresh reads latest public contract.
- [ ] Run `node --test test/workspace.test.js`; record expected missing implementation failure.
- [ ] Implement prefix policy and bounded snapshots. Directory roots must be absolute and not filesystem root or the user's home; reject symlinks. Public export rejects built-in credential files and private prefix overlap. Bound copied files/bytes and output; use safe temporary state permissions.
- [ ] Implement bubblewrap process execution with a mounted snapshot at /workspace, fresh network and PID namespaces, minimal PATH/HOME, standard runtime read-only mounts and the actual Node executable. Kill the process group on abort/timeout, bound stdout/stderr, and fail if bubblewrap unavailable. Never mount the host home or pass its environment.
- [ ] Verify actual commands can modify the intended snapshot and cannot access host canary paths or contact a local HTTP canary. Verify private commits and public conflicts. Commit only owned source/test files.

### Task 2: Collaboration settings UI

**Files:** Modify client.js and test/client.test.js only.

**Interfaces:** Existing privacy-router settings namespace adds `mode` (`routing`/`collaboration`), `projectRoot` (string, empty allowed for setup), `publicPaths` (string[]), `privatePaths` (string[]), `publicBrief` (string), `maxAgentSteps` (integer 1..64, default 16), `commandTimeoutSeconds` (integer 1..300, default 60), `integrationCommand` (string, default `node --test`). Root implements server validation. Existing settings fields remain intact.

- [ ] Add tests exercising settings round-trip, mode-specific controls and validation: `publicPaths:['public/']` displays as one line and saves as an array; saving unrelated fields preserves existing collaboration values; invalid absolute public paths and out-of-range limits fail before persistence.
- [ ] Run `node --test test/client.test.js` to observe failures.
- [ ] Add Chinese mode selector and collaboration fields to draft, validation and patch. Explain that public prefixes are explicit sharing grants, private prefixes override them, unknown content stays local, /公开 marks a current message for external use and the public project brief is sent to cloud. Keep five reasoning choices and current target selectors.
- [ ] Run client tests and commit only client files.

### Task 3: Bounded collaboration runtime and persistence

**Files:** Create src/collaboration.js, src/agent-loop.js, src/collaboration-store.js, test/collaboration.test.js; modify index.js, src/adapter.js, src/config.js and test/router.test.js as necessary.

**Interfaces:** `runCollaboration({ctx,options,decision,config,reasoningFor})` is an async generator of DSH LLM chunks. It consumes workspace Task 1, owns the cloud message envelope, and never emits provider-native tool calls to the outer DSH agent. `decision` carries the current direct-human candidate and admitted session; it captures configuration before any classification. `reasoningFor(provider,model,requested,signal,config)` uses existing validated five-tier mapper. Store snapshots are separate public/private records keyed by session and authorization digest.

- [ ] Extend config with Task 2 exact fields, strict validation and safe defaults. Add failing tests for unsupported mode, unsafe path rules, missing setup and five-tier preservation.
- [ ] Build real DSH runtime fixture adapters that return tool-call blocks to request public file edits, private delegation and integration. Include `PRIVATE_CANARY` in input, private code, local output and diagnostics. Assert every cloud call omits it while public calls carry the public brief and tools. Assert cloud/private file results are real on disk, ordinary Qwen never routes and state survives another plugin instance.
- [ ] Implement bounded tool-call collection with exact JSON validation, cancellation and terminal handling. Cloud tools operate only public snapshot and return only its data; private task tools never expose raw output to cloud. Private filesystem changes are committed locally and surfaced only to the human. Integration runs the settings-owned command in the private snapshot and exports only a fixed receipt independent of result; cloud cannot choose the integration command or receive an exit-status oracle.
- [ ] Persist histories atomically under a host-owned state directory, with policy/route invalidation and per-project locking. Keep cloud history append-only within the same authorization snapshot; replace private context with its own local record. Prevent outer DSH history/system/tools from entering cloud.
- [ ] Admit collaboration only for virtual main turns. Retain routing mode and local auxiliary behavior. Ensure stale requests, retries and cancellation do not repeat completed edits or weaken policy.
- [ ] Run full `npm test`, fix meaningful failures, and commit owned files.

### Task 4: Review, starter project, real verification and installation

**Files:** Update README.md, package.json and local installation evidence outside the repo. Create a fresh $HOME/Projects/dsh-collaboration starter workspace with public/ and private/ synthetic examples; use a fresh sibling if occupied.

- [ ] Independently review each component and whole-branch privacy boundaries. Reproduce and fix concrete findings; log decisions and re-review fixes.
- [ ] Run synthetic integration through actual configured Qwen and DeepSeek with isolated DSH settings. Assert public and private edits, fixed cloud receipts, mapped reasoning, persisted context and zero private canaries in captured cloud requests.
- [ ] Document settings, /公开, separate histories and Linux command isolation. Bump plugin to 0.3.0. Run `npm test` and `npm run pack:check` once after final changes.
- [ ] Publish complete reviewed tree to existing user fork; verify remote/local file equality. Back up installed profile, install the pinned commit, configure the synthetic starter workspace and collaboration mode, and restart the idle manual DSH terminal.
- [ ] Verify actual active plugin, five-choice model catalog, frontend settings save/reload and unchanged global model selection. Update installation record with limitations and evidence, then report the usable workspace to the user.
