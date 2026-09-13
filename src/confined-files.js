import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_FILE = 2 * 1024 * 1024;
const MAX_ENTRIES = 30000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const helper = fileURLToPath(new URL('./confined-files.py', import.meta.url));
function validate(root, relative, directory = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === '/' || path.resolve(root) !== root || root.includes('\0')) throw new Error('Unsafe filesystem root');
  if (directory && relative === '') return;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || /[\x00-\x1f*?\[\]{}]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe relative path');
}
function content(data, mode) {
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new Error('Invalid file content');
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > MAX_FILE) throw new Error('Oversized file');
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Unsafe file mode');
  return buffer;
}
function safeFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe file');
  if (stat.size > MAX_FILE) throw new Error('Oversized file');
}
// Start at / so O_NOFOLLOW protects the root's ancestors as well as its leaf.
async function directoryHandle(root, relative = '', create = false) {
  let handle = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rootParts = root.slice(1).split('/');
    const parts = [...rootParts, ...(relative ? relative.split('/') : [])];
    for (let i = 0; i < parts.length; i++) {
      const child = `/proc/self/fd/${handle.fd}/${parts[i]}`;
      if (create && i >= rootParts.length) await fs.mkdir(child, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const next = await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function parentHandle(root, relative, create = false) {
  const parts = relative.split('/'); const name = parts.pop();
  const handle = await directoryHandle(root, parts.join('/'), create);
  return { handle, filename: `/proc/self/fd/${handle.fd}/${name}` };
}
function linuxFiles() {
  return {
    async read(root, relative) {
      validate(root, relative); const parent = await parentHandle(root, relative); let file;
      try {
        file = await fs.open(parent.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat(); safeFile(stat);
        const buffer = Buffer.alloc(MAX_FILE + 1); let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        safeFile(await file.stat());
        if (length > MAX_FILE) throw new Error('Oversized file');
        return { data: Buffer.from(buffer.subarray(0, length)), mode: stat.mode & 0o777 };
      } finally { await file?.close(); await parent.handle.close(); }
    },
    async write(root, relative, data, mode = 0o600) {
      validate(root, relative); const buffer = content(data, mode);
      const parent = await parentHandle(root, relative, true);
      const temp = `${parent.filename}.privacy-${randomUUID()}`;
      const checkDestination = async () => { try { safeFile(await fs.lstat(parent.filename)); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
      try {
        await checkDestination();
        await fs.writeFile(temp, buffer, { flag: 'wx', mode });
        await checkDestination();
        await fs.rename(temp, parent.filename);
      } finally { await fs.unlink(temp).catch(() => {}); await parent.handle.close(); }
    },
    async remove(root, relative) {
      validate(root, relative); const parent = await parentHandle(root, relative);
      try { safeFile(await fs.lstat(parent.filename)); await fs.unlink(parent.filename); }
      finally { await parent.handle.close(); }
    },
    async entries(root, relative = '') {
      validate(root, relative, true); const handle = await directoryHandle(root, relative); let directory;
      try {
        directory = await fs.opendir(`/proc/self/fd/${handle.fd}`);
        const entries = []; let bytes = 0;
        for await (const entry of directory) {
          const item = { name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (entries.length >= MAX_ENTRIES || bytes > MAX_RESPONSE - 1024) throw new Error('Workspace entry limit exceeded');
          entries.push(item);
        }
        return entries;
      } finally { await directory?.close().catch(() => {}); await handle.close(); }
    },
  };
}
function pythonFiles(pythonPath) {
  if (typeof pythonPath !== 'string' || pythonPath && (!path.isAbsolute(pythonPath) || pythonPath.includes('\0'))) throw new Error('Python path must be absolute');
  let interpreter;
  async function resolveInterpreter() {
    if (pythonPath) return pythonPath;
    if (!interpreter) interpreter = (async () => {
      for (const candidate of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
        try { await fs.access(candidate, constants.X_OK); return candidate; } catch {}
      }
      throw new Error('Python 3 unavailable; configure an absolute pythonPath');
    })();
    return interpreter;
  }
  async function invoke(operation, root, relative, extra = {}) {
    validate(root, relative, operation === 'entries');
    const input = JSON.stringify({ operation, root, relative, ...extra });
    if (Buffer.byteLength(input) > 3 * 1024 * 1024) throw new Error('Filesystem request limit exceeded');
    const executable = await resolveInterpreter();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-I', '-S', helper], { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let size = 0; let error;
      const stop = reason => { error ??= reason; child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop(new Error('Confined filesystem helper timeout')), 15000);
      child.stdout.on('data', data => { size += data.length; if (size > MAX_RESPONSE) stop(new Error('Filesystem response limit exceeded')); else chunks.push(data); });
      let stderrBytes = 0;
      child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 16384) stop(new Error('Filesystem helper error output limit exceeded')); });
      child.on('error', cause => { error = new Error('Python 3 unavailable for confined filesystem', { cause }); });
      child.stdin.on('error', cause => { if (cause.code !== 'EPIPE') stop(cause); });
      child.on('close', code => {
        clearTimeout(timer);
        if (error) return reject(error);
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result.ok) throw Object.assign(new Error(result.error || 'Confined filesystem failed'), { code: result.code });
          if (code !== 0) throw new Error('Confined filesystem helper failed');
          resolve(result.result);
        } catch (cause) { reject(cause); }
      });
      child.stdin.end(input);
    });
  }
  return {
    async read(root, relative) { const result = await invoke('read', root, relative); return { data: Buffer.from(result.data, 'base64'), mode: result.mode }; },
    async write(root, relative, data, mode = 0o600) { const buffer = content(data, mode); await invoke('write', root, relative, { data: buffer.toString('base64'), mode }); },
    async remove(root, relative) { await invoke('remove', root, relative); },
    async entries(root, relative = '') { return invoke('entries', root, relative); },
  };
}
export function createConfinedFiles({ backend = 'auto', pythonPath = '' } = {}) {
  const selected = backend === 'auto' ? process.platform === 'linux' ? 'linux' : 'python' : backend;
  if (selected === 'python') return pythonFiles(pythonPath);
  if (selected === 'linux' && process.platform === 'linux') return linuxFiles();
  throw new Error('Unsupported confined filesystem backend');
}
