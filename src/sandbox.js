import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { runDockerSandbox } from './sandbox-docker.js';

const OUTPUT_LIMIT = 256 * 1024;

// Only system runtimes and the snapshot are visible. Never inherit HOME, tokens,
// proxy settings, NODE_OPTIONS, or any other host environment variable.
export async function runSandbox(root, command, options = {}) {
  const { signal, timeoutMs = 60000, readOnlyPaths = [], writablePaths = [], sandboxPath = '/usr/bin/bwrap', sandboxBackend = 'auto' } = options;
  if (signal?.aborted) throw new Error('Command aborted');
  if (typeof command !== 'string' || !command.trim() || command.length > 32768) throw new Error('Invalid command');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid command timeout');
  if (!['auto', 'bwrap', 'docker'].includes(sandboxBackend)) throw new Error('Invalid sandbox backend');
  const backend = sandboxBackend === 'auto' ? ({ linux: 'bwrap', darwin: 'docker' })[process.platform] : sandboxBackend;
  if (backend === 'docker' && ['linux', 'darwin'].includes(process.platform)) return runDockerSandbox(root, command, options);
  if (backend !== 'bwrap' || process.platform !== 'linux') throw new Error('Sandbox unavailable on this platform');
  try { await fs.access(sandboxPath, fs.constants.X_OK); } catch { throw new Error('Sandbox unavailable'); }
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv'];
  for (const dir of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
    try { await fs.access(dir); args.push('--ro-bind', dir, dir); } catch { /* Optional system runtime directory. */ }
  }
  args.push('--dir', '/opt', '--dir', '/opt/node', '--dir', '/opt/node/bin', '--ro-bind', await fs.realpath(process.execPath), '/opt/node/bin/node',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home', '--dir', '/home/sandbox',
    '--bind', root, '/workspace');
  for (const relative of readOnlyPaths) args.push('--ro-bind', `${root}/${relative}`, `/workspace/${relative}`);
  for (const relative of writablePaths) args.push('--bind', `${root}/${relative}`, `/workspace/${relative}`);
  args.push('--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin', '--setenv', 'HOME', '/home/sandbox', '--setenv', 'LANG', 'C.UTF-8',
    '--chdir', '/workspace', '--', '/bin/sh', '-c', 'ulimit -f 131072; ulimit -n 256; exec /bin/sh -c "$1"', 'sandbox', command);
  return new Promise((resolve, reject) => {
    let child;
    let failure;
    let stdout = '';
    let stderr = '';
    let size = 0;
    let timer;
    const kill = reason => {
      failure ??= new Error(reason);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    };
    const abort = () => kill('Command aborted');
    try { child = spawn(sandboxPath, args, { detached: true, env: {}, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new Error('Sandbox unavailable')); return; }
    timer = setTimeout(() => kill('Command timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const capture = (chunk, stream) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { kill('Command output limit exceeded'); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.on('error', () => { failure ??= new Error('Sandbox unavailable'); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
