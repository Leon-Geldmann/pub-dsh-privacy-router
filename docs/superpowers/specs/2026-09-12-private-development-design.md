# Private development collaboration

User approved on 2026-09-12: an online lead develops architecture and shareable modules, a local Qwen worker implements private modules, and a local controller integrates and tests. Sensitive source and content must never be sent to cloud. User has no project yet and delegated choosing a safe starter workspace.

## Product behavior

- Keep one selectable privacy-router/auto model and exactly auto/off/low/medium/high efforts, with the existing Qwen/DeepSeek correspondence. Direct models remain untouched.
- Settings expose routing versus collaboration, absolute project root, public path prefixes, private path prefixes, an explicitly shareable project brief, agent step limit and command timeout. Defaults retain routing for existing installations; this host will be configured with a newly created starter workspace and collaboration mode.
- Create a standalone project under $HOME/Projects/dsh-collaboration (choose a fresh sibling if occupied), with public/ and private/ directories, synthetic starter code and integration tests. Only public/ is authorized for cloud; no existing user files are included.
- Ordinary chat text is private. The online agent gets the saved public brief and its own durable public conversation. A direct-human message beginning with /公开 explicitly releases only that current text; deterministic credential blocks still apply. Settings explain this boundary. Unmarked instructions are delivered to the local worker while online continues against the public brief. No automatic LLM-written summary declassifies private input.
- The online agent can read/write its public project view, run sandboxed public commands, and request a private implementation task. The local worker receives the complete current private instruction and local context, plus the online task and public interface. It can read the complete project view and write private files. It cannot publish its output through public files.
- Cloud receives only a fixed local-task receipt, not local output, paths, patches, diagnostics, success/failure, counts derived from private data, or summaries. Full local results remain visible to the human in the local DSH transcript. Integration executes the settings-owned integrationCommand and returns the same fixed receipt regardless of result; raw output remains local. Cloud cannot choose private integration commands or probe private data via exit-status feedback.
- User-authorized public input, online conversation, public files and private worker history are stored separately. Auxiliary model calls stay local; main DSH tools and history are never forwarded into either public loop.

## Enforcement and implementation

The virtual adapter hosts bounded tool loops with explicitly defined tool schemas. Reusing the unrestricted DSH child default would expose its inherited tool/context surface; these loops instead reuse DSH's LLM service while owning exact message and tool envelopes.

Two filesystem snapshots separate public and private execution. Filesystem reads/writes reject absolute paths, traversal, symlinks, special files and unsafe hard links. Private prefixes and built-in credential/VCS exclusions dominate public prefixes. Public views only contain explicitly public regular files. Local changes cannot modify or create files in public prefixes. Commits check base hashes before changing the actual project and fail on conflicts. Commands execute with bubblewrap, a fresh PID/network namespace, minimal environment, no host home or credentials, bounded output and timeout. No unsandboxed fallback.

Public persistence is keyed by session and a digest of project root, policy, public brief and target routes. Changing policy discards old cloud context. A session/project lock prevents overlapping commits; abort stops subprocesses and prevents late writes. Requests that lack an admitted main-turn boundary continue locally through the existing adapter.

## Acceptance

Automated tests must exercise actual filesystem confinement and bubblewrap, both agent loops through the real DSH LLM runtime, multi-turn persistence, settings changes/revocation, cancellation, ordinary model preservation, and private canaries in every cloud-bound system/message/tool argument. Real synthetic starter-project work must demonstrate cloud edits, private edits, integration checks, mapped reasoning, and restart-safe public context without any private canary in cloud traces. UI settings and the existing five-choice menu must work in installed DSH.
