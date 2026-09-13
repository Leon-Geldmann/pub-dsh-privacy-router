import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { requireDockerImage } from './docker-image.js';

const OUTPUT_LIMIT = 256 * 1024;
const CONTROL_TIMEOUT = 15000;
const CLEANUP_TIMEOUT = 5000;
const INVALID_PATH = /[\x00-\x1f\x7f\\]/;

function absolute(value, kind) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || INVALID_PATH.test(value)) throw new Error(`Invalid ${kind}: expected an absolute local path`);
  return value;
}

async function dockerEndpoint(dockerPath, dockerSocket) {
  const home = os.userInfo().homedir;
  const binaries = dockerPath ? [absolute(dockerPath, 'Docker executable')] : ['/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/usr/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
  const sockets = dockerSocket ? [absolute(dockerSocket, 'Docker socket endpoint')] : [path.join(home, '.colima/default/docker.sock'), path.join(home, '.docker/run/docker.sock'), '/var/run/docker.sock', `/run/user/${process.getuid()}/docker.sock`];
  let executable; let socket;
  for (const candidate of binaries) {
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      await fs.access(resolved, fs.constants.X_OK);
      executable = resolved; break;
    } catch { /* Only the configured binary or known local installations. */ }
  }
  if (!executable) throw new Error('Docker sandbox unavailable: local executable missing');
  for (const candidate of sockets) {
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isSocket()) continue;
      socket = absolute(resolved, 'Docker socket endpoint'); break;
    } catch { /* Never fall back to Docker contexts or DOCKER_HOST. */ }
  }
  if (!socket) throw new Error('Docker sandbox unavailable: local Unix socket missing');
  return { executable, socket };
}

function csvField(value) {
  return /[",]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function snapshotMounts(root, readOnlyPaths, writablePaths) {
  absolute(root, 'snapshot path');
  if (root === '/' || await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) throw new Error('Unsafe snapshot path');
  if (!Array.isArray(readOnlyPaths) || !Array.isArray(writablePaths)) throw new Error('Invalid sandbox mount paths');
  const mount = (source, destination, readonly = false) => ['type=bind', csvField(`source=${source}`), csvField(`destination=${destination}`), ...(readonly ? ['readonly'] : []), 'bind-propagation=rprivate', 'bind-recursive=disabled'].join(',');
  const mounts = ['--mount', mount(root, '/workspace')];
  const seen = new Set();
  for (const [paths, readonly] of [[readOnlyPaths, true], [writablePaths, false]]) {
    for (const relative of paths) {
      if (typeof relative !== 'string' || !relative || INVALID_PATH.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative)) throw new Error('Invalid sandbox mount path');
      seen.add(relative);
      let source = root;
      for (const part of relative.split('/')) {
        source = path.join(source, part);
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Unsafe sandbox mount path');
      }
      if (await fs.realpath(source) !== source) throw new Error('Unsafe sandbox mount path');
      mounts.push('--mount', mount(source, `/workspace/${relative}`, readonly));
    }
  }
  return mounts;
}

// All calls are direct executable invocations with a new, credential-free CLI
// config and an explicit Unix endpoint. No host shell, Docker context or env.
function invoke(executable, prefix, env, args, { timeoutMs = CONTROL_TIMEOUT, onOutputLimit, onProcess, preserveRequest = false } = {}) {
  return new Promise(resolve => {
    let child; let failure; let size = 0; let stdout = ''; let stderr = '';
    const out = new StringDecoder('utf8'); const err = new StringDecoder('utf8');
    const kill = () => {
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    };
    try { child = spawn(executable, [...prefix, ...args], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: 1, failure: new Error('Docker sandbox unavailable'), stdout, stderr }); return; }
    onProcess?.(kill);
    const timer = setTimeout(() => { failure ??= new Error('Docker operation timeout'); kill(); }, timeoutMs);
    const capture = (chunk, stream) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        if (!failure) { failure = new Error('Command output limit exceeded'); onOutputLimit?.(); }
        if (!preserveRequest) kill();
        return;
      }
      if (stream === 'stdout') stdout += out.write(chunk); else stderr += err.write(chunk);
    };
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.on('error', () => { failure ??= new Error('Docker sandbox unavailable'); });
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      // A CLI helper process must not outlive the invocation either.
      kill();
      resolve({ code: code ?? 1, failure, interrupted: !!terminationSignal, stdout: stdout + out.end(), stderr: stderr + err.end() });
    });
  });
}

export async function runDockerSandbox(root, command, { signal, timeoutMs = 60000, readOnlyPaths = [], writablePaths = [], dockerPath = '', dockerSocket = '', dockerImage } = {}) {
  if (signal?.aborted) throw new Error('Command aborted');
  if (typeof command !== 'string' || !command.trim() || command.length > 32768 || command.includes('\0')) throw new Error('Invalid command');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid command timeout');
  const image = requireDockerImage(dockerImage);
  const mounts = await snapshotMounts(root, readOnlyPaths, writablePaths);
  const { executable, socket } = await dockerEndpoint(dockerPath, dockerSocket);
  const config = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-docker-config-'));
  const name = `dsh-sandbox-${randomUUID()}`;
  const prefix = ['--host', `unix://${socket}`, '--config', config];
  const env = { PATH: '/usr/bin:/bin', HOME: config, LANG: 'C.UTF-8' };
  let failure; let phase = 'setup'; let killAttached; let abortRemoval; let attemptedCreate = false; let creationUncertain = false;
  const call = (args, options) => invoke(executable, prefix, env, args, options);
  const remove = () => call(['rm', '--force', '--volumes', name], { timeoutMs: CLEANUP_TIMEOUT });
  const cancel = reason => {
    failure ??= new Error(reason);
    if (phase === 'start' && !abortRemoval) {
      // Kill the container through the daemon before killing the attached CLI.
      // Final cleanup is repeated after start settles to cover its race window.
      abortRemoval = remove().finally(() => killAttached?.());
    }
  };
  const abort = () => cancel('Command aborted');
  const timer = setTimeout(() => cancel('Command timeout'), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  let result;
  try {
    if (signal?.aborted) abort();
    if (failure) throw failure;
    phase = 'create'; attemptedCreate = true;
    const created = await call([
      'create', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
      '--memory=1g', '--memory-swap=1g', '--cpus=2', '--init', '--no-healthcheck',
      '--log-driver=none', '--ipc=private', '--cgroupns=private', '--restart=no',
      '--ulimit', 'fsize=134217728:134217728', '--ulimit', 'nofile=256:256', '--ulimit', 'core=0:0',
      '--shm-size=16m', '--user', `${process.getuid()}:${process.getgid()}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--workdir', '/workspace',
      ...mounts, '--entrypoint', '/usr/bin/env', image, '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp/home', 'LANG=C.UTF-8',
      '/bin/sh', '-c', 'mkdir -p "$HOME"; exec /bin/sh -c "$1"', 'sandbox', command,
    ], { preserveRequest: true });
    // Never kill create on user cancellation: the daemon may finish creating
    // after a premature rm. Await its bounded response, then remove by name.
    creationUncertain = created.interrupted;
    if (failure) throw failure;
    if (created.failure) throw created.failure;
    if (created.code !== 0) throw new Error(`Docker create failed: ${created.stderr.trim()}`);
    phase = 'start';
    const started = await call(['start', '--attach', name], {
      timeoutMs: timeoutMs + CONTROL_TIMEOUT,
      onProcess: kill => { killAttached = kill; },
      onOutputLimit: () => cancel('Command output limit exceeded'),
    });
    if (started.failure) failure ??= started.failure;
    result = { exitCode: started.code, stdout: started.stdout, stderr: started.stderr };
  } catch (error) { failure ??= error; }
  finally {
    phase = 'cleanup';
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (abortRemoval) await abortRemoval;
    if (attemptedCreate) {
      let removed = false;
      for (let attempt = 0; attempt < 3 && !removed; attempt++) {
        const cleanup = await remove();
        removed = !cleanup.failure && (cleanup.code === 0 || cleanup.stderr.includes(`No such container: ${name}`));
      }
      if (!removed) failure = new Error(`Docker cleanup failed for ${name}; container removal could not be confirmed${failure ? ` (${failure.message})` : ''}`);
      else if (creationUncertain) failure = new Error(`Docker cleanup for ${name} could not be confirmed: interrupted creation may still be pending in the daemon${failure ? ` (${failure.message})` : ''}`);
    }
    await fs.rm(config, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return result;
}
