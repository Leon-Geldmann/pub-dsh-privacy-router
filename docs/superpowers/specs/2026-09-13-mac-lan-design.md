# Mac DSH with LAN Qwen

The user authorizes implementation, local release verification, GitHub synchronization and a handoff prompt for Codex running on the Mac mini. Preserve the selectable privacy-router/auto model, routing and collaboration modes, direct models and five reasoning choices.

## Architecture

DSH runs natively on the Mac. Model requests to the explicitly trusted Ubuntu Qwen provider travel through an SSH local forward; the Ubuntu inference port stays loopback-only. The Mac project is not uploaded wholesale. Private prompt/file excerpts needed by the local worker reach Ubuntu, an explicitly trusted LAN machine; none of these reach the online provider. SSH host verification is required. No credentials are copied into the repository or handoff prompt.

Linux keeps its current bubblewrap execution. macOS uses a local Docker engine (Colima or Docker Desktop), a pre-pulled Node 22 Linux image and only the current public/private snapshot bind mounts. The engine endpoint must be a local Unix socket, never a remote daemon or implicit Docker context. Containers have no network, no host home/environment/credentials/Docker socket, a read-only root, private temporary storage and no Linux capabilities. Cleanup kills the named container, including descendants, on cancellation, timeout, normal completion or failure. No unsandboxed fallback or image pull during model execution.

The current filesystem operations use /proc/self/fd, which macOS does not expose. A small Python 3 helper uses POSIX dir_fd/O_NOFOLLOW to pin every ancestor for read, write, unlink and directory enumeration. It is used on Darwin and can be explicitly exercised on Linux for regression tests. It accepts bounded JSON over stdin, emits bounded JSON, preserves ENOENT codes and atomically replaces regular singly-linked files. No shell, inherited Python environment, arbitrary module import or path traversal. Linux's existing descriptor backend remains available.

Host-controlled settings: sandboxBackend auto|bwrap|docker (auto selects bwrap on Linux, docker on Darwin); dockerPath absolute or empty for discovery; dockerSocket absolute or empty for known local socket discovery; dockerImage local image reference default node:22-bookworm-slim; pythonPath absolute or empty for known interpreter discovery. Settings UI cannot modify these trust controls. Project paths are canonical absolute directories; system temp aliases on macOS are resolved before creating scratch roots, without accepting user-created symlink roots. Private overrides, public commit preflight and history boundaries remain unchanged.

## Validation and release

Test descriptor operations with real Python on Linux, synthetic symlink/hardlink/FIFO/traversal/conflict fixtures, Docker CLI boundaries/lifecycle with a controlled fake executable, and existing Linux runtime/sandbox tests. Supply an actual Docker smoke checker that must run on the target Mac before claiming macOS support verified. Preserve current Ubuntu installation settings and defaults when updating. Browser repair may reconnect a failed supported service but must never disable, bypass or fabricate policy decisions; record any unresolved service defect honestly.
