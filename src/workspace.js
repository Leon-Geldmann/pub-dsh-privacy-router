import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runSandbox } from './sandbox.js';
import { createConfinedFiles } from './confined-files.js';

const MAX_FILES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const OMIT = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.cache', '__pycache__', 'dist', 'build', 'coverage', '.ssh', '.aws', '.azure', '.gnupg', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json']);
const hash = data => createHash('sha256').update(data).digest('hex');
function relativePath(value, prefix = false) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f*?\[\]{}]/.test(value) || path.posix.isAbsolute(value)) throw new Error('Unsafe relative path');
  const trimmed = prefix && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!trimmed || trimmed.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe relative path');
  return value;
}
function excluded(relative) {
  return relative.split('/').some(part => OMIT.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /\.(pem|key|p12|pfx|jks)$/i.test(part) || /^(id_rsa|id_ed25519|id_ecdsa)(\.|$)/i.test(part));
}
function matches(relative, prefixes) { return prefixes.some(p => p.endsWith('/') ? relative.startsWith(p) : relative === p); }
async function safeRoot(root, create = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || path.resolve(root) === '/' || path.resolve(root) === os.homedir()) throw new Error('Unsafe workspace root');
  let cursor = '/';
  for (const part of root.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (create) await fs.mkdir(cursor, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workspace directory');
  }
  return path.resolve(root);
}
async function scan(filesystem, root, allowed, { strict = true } = {}) {
  const files = new Map();
  let bytes = 0;
  let visited = 0;
  async function visit(relative = '') {
    for (const entry of await filesystem.entries(root, relative)) {
      if (++visited > MAX_FILES * 3) throw new Error('Workspace entry limit exceeded');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      relativePath(name);
      if (excluded(name)) continue;
      if (entry.type === 'directory') { await visit(name); continue; }
      if (!allowed(name)) continue;
      if (entry.type !== 'file') { if (strict) throw new Error('Unsafe snapshot file'); else continue; }
      const file = await filesystem.read(root, name);
      bytes += file.data.length;
      if (files.size >= MAX_FILES || bytes > MAX_BYTES) throw new Error('Workspace size limit exceeded');
      files.set(name, { ...file, hash: hash(file.data) });
    }
  }
  await visit();
  return files;
}

export async function createWorkspace({ projectRoot, publicPaths = [], privatePaths = [], pythonPath = '', sandboxBackend = 'auto', dockerPath = '', dockerSocket = '', dockerImage = 'node:22-bookworm-slim' }, { stateRoot, signal, filesystemBackend = 'auto' } = {}) {
  const filesystem = createConfinedFiles({ backend: filesystemBackend, pythonPath });
  const readFile = filesystem.read; const writeFile = filesystem.write;
  const scanFiles = (root, allowed) => scan(filesystem, root, allowed);
  stateRoot ??= path.join(await fs.realpath(os.tmpdir()), 'dsh-private-workspaces');
  projectRoot = await safeRoot(projectRoot);
  for (const rules of [publicPaths, privatePaths]) {
    if (!Array.isArray(rules) || rules.length > 256) throw new Error('Invalid path policy');
    rules.forEach(p => relativePath(p, true));
  }
  publicPaths = [...publicPaths]; privatePaths = [...privatePaths];
  const isPublic = p => !excluded(p) && matches(p, publicPaths) && !matches(p, privatePaths);
  const isPrivate = p => !excluded(p) && !isPublic(p);
  const canRead = (scope, p) => scope === 'public' ? isPublic(p) : !excluded(p);
  const canWrite = (scope, p) => scope === 'public' ? isPublic(p) : isPrivate(p);
  const check = () => { if (signal?.aborted) throw new Error('Workspace aborted'); if (disposed) throw new Error('Workspace disposed'); };
  stateRoot = await safeRoot(stateRoot, true);
  if (stateRoot === projectRoot || stateRoot.startsWith(`${projectRoot}/`)) throw new Error('Workspace state must be outside project');
  const stateStat = await fs.stat(stateRoot);
  if (stateStat.uid !== process.getuid() || (stateStat.mode & 0o077)) throw new Error('Workspace state permissions must be private');
  const sessionRoot = await fs.mkdtemp(path.join(stateRoot, 'workspace-'));
  const publicRoot = path.join(sessionRoot, 'public');
  const privateRoot = path.join(sessionRoot, 'private');
  await fs.mkdir(publicRoot, { mode: 0o700 }); await fs.mkdir(privateRoot, { mode: 0o700 });
  let disposed = false;
  let active = false;
  let publicBaseline = new Map();
  let privateBaseline = new Map();
  let privatePublicBaseline = new Map();
  const roots = { public: publicRoot, private: privateRoot };
  function scopeRoot(scope) { check(); if (!Object.hasOwn(roots, scope)) throw new Error('Invalid scope'); return roots[scope]; }
  async function exclusive(fn) {
    check(); if (active) throw new Error('Workspace operation in progress'); active = true;
    try { return await fn(); } finally { active = false; }
  }
  try {
    check();
    const initial = await scanFiles(projectRoot, () => true);
    for (const [p, file] of initial) {
      check(); await writeFile(privateRoot, p, file.data, file.mode);
      if (isPublic(p)) { await writeFile(publicRoot, p, file.data, file.mode); publicBaseline.set(p, file); privatePublicBaseline.set(p, file); }
      else privateBaseline.set(p, file);
    }
  } catch (error) { await fs.rm(sessionRoot, { recursive: true, force: true }); throw error; }

  return {
    publicRoot, privateRoot,
    async read(scope, p) {
      return exclusive(async () => { const root = scopeRoot(scope); relativePath(p); if (!canRead(scope, p)) throw new Error('Path denied'); return (await readFile(root, p)).data.toString('utf8'); });
    },
    async list(scope) {
      return exclusive(async () => [...(await scanFiles(scopeRoot(scope), p => canRead(scope, p))).keys()].sort());
    },
    async write(scope, p, content) {
      return exclusive(async () => {
        const root = scopeRoot(scope); relativePath(p);
        if (!canWrite(scope, p)) throw new Error('Path denied');
        if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw new Error('Invalid or oversized content');
        await writeFile(root, p, content); return { path: p };
      });
    },
    async run(scope, command, options = {}) {
      return exclusive(async () => {
        const root = scopeRoot(scope);
        // Validate every mount ancestor before the sandbox resolves host paths.
        // A previous command may have replaced directories with symbolic links.
        const snapshot = await scanFiles(root, () => true);
        const readOnlyPaths = []; const writablePaths = [];
        if (scope === 'private') {
          for (const p of publicPaths) {
            const candidate = p.replace(/\/$/, '');
            if (excluded(candidate)) continue;
            // Directory grants include the directory itself as a mount boundary.
            if (privatePaths.some(rule => rule.endsWith('/') && (candidate === rule.slice(0, -1) || candidate.startsWith(rule)))) continue;
            try {
              const stat = await fs.lstat(path.join(root, candidate));
              if (!stat.isDirectory() && !stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe public mount');
              if (stat.isFile() && matches(candidate, privatePaths)) continue;
              if (stat.isDirectory() && privatePaths.some(rule => !rule.endsWith('/') && rule.startsWith(`${candidate}/`) && !excluded(rule))) {
                // A file bind requires an existing target and prevents atomic
                // replacement. Keep the containing directory writable, bind its
                // public files read-only, and let commit's public-context
                // preflight reject any new public sibling files as a whole.
                for (const name of snapshot.keys()) {
                  if (name.startsWith(`${candidate}/`) && isPublic(name)) readOnlyPaths.push(name);
                }
              } else readOnlyPaths.push(candidate);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          for (const p of privatePaths) {
            const candidate = p.replace(/\/$/, '');
            if (excluded(candidate) || !readOnlyPaths.some(r => candidate.startsWith(`${r}/`))) continue;
            try { await readFile(root, candidate); writablePaths.push(candidate); }
            catch (error) {
              if (p.endsWith('/')) {
                await safeRoot(path.join(root, candidate), true); writablePaths.push(candidate);
              } else if (error.code !== 'ENOENT') throw error;
            }
          }
        }
        return runSandbox(root, command, { signal: signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal, timeoutMs: options.timeoutMs, readOnlyPaths, writablePaths, sandboxBackend, dockerPath, dockerSocket, dockerImage });
      });
    },
    async commit(scope) {
      return exclusive(async () => {
        const root = scopeRoot(scope);
        if (scope === 'private') {
          const context = await scanFiles(root, isPublic);
          if (context.size !== privatePublicBaseline.size || [...context].some(([p, file]) => privatePublicBaseline.get(p)?.hash !== file.hash)) throw new Error('Private public-path mutation denied');
        }
        const current = await scanFiles(root, p => canWrite(scope, p));
        const baseline = scope === 'public' ? publicBaseline : privateBaseline;
        const changed = [...new Set([...baseline.keys(), ...current.keys()])].filter(p => baseline.get(p)?.hash !== current.get(p)?.hash).sort();
        for (const p of changed) {
          check();
          let original;
          try { original = await readFile(projectRoot, p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if ((original ? hash(original.data) : undefined) !== baseline.get(p)?.hash) throw new Error('Workspace commit conflict');
        }
        check();
        for (const p of changed) {
          check();
          const file = current.get(p);
          if (file) await writeFile(projectRoot, p, file.data, file.mode);
          else await filesystem.remove(projectRoot, p);
        }
        if (scope === 'public') publicBaseline = current; else privateBaseline = current;
        return { changed };
      });
    },
    async refreshPrivate() {
      return exclusive(async () => {
        const committed = await scanFiles(projectRoot, isPublic);
        const context = await scanFiles(privateRoot, isPublic);
        for (const p of context.keys()) {
          if (!committed.has(p)) await filesystem.remove(privateRoot, p);
        }
        for (const [p, file] of committed) { check(); await writeFile(privateRoot, p, file.data, file.mode); }
        privatePublicBaseline = committed;
      });
    },
    async dispose() { if (disposed) return; if (active) throw new Error('Workspace operation in progress'); disposed = true; await fs.rm(sessionRoot, { recursive: true, force: true }); },
  };
}
