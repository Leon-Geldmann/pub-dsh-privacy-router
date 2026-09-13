import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConfinedFiles } from '../src/confined-files.js';
import { createWorkspace } from '../src/workspace.js';
import { hostRuntime } from './helpers/host-runtime.js';
const pythonPath = hostRuntime.pythonPath;
const exec = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'confined-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'parent/root');
  await fs.mkdir(root, { recursive: true });
  return { base, root };
}
for (const backend of process.platform === 'linux' ? ['python', 'linux'] : ['python']) {
  test(`${backend}: read, atomic replacement, nested creation, listing and removal`, async t => {
    const { root } = await fixture(t);
    const files = createConfinedFiles({ pythonPath, backend });
    await files.write(root, 'nested/file', Buffer.from('hello'), 0o640);
    assert.deepEqual(await files.read(root, 'nested/file'), { data: Buffer.from('hello'), mode: 0o640 });
    const old = await fs.open(path.join(root, 'nested/file'), 'r');
    try {
      await files.write(root, 'nested/file', 'replacement');
      assert.equal(await old.readFile('utf8'), 'hello');
    } finally { await old.close(); }
    assert.deepEqual(await files.entries(root), [{ name: 'nested', type: 'directory' }]);
    assert.deepEqual(await files.entries(root, 'nested'), [{ name: 'file', type: 'file' }]);
    await files.remove(root, 'nested/file');
    for (const op of [() => files.read(root, 'nested/file'), () => files.remove(root, 'nested/file'), () => files.entries(root, 'missing')]) {
      await assert.rejects(op(), { code: 'ENOENT' });
    }
  });
  test(`${backend}: bounds reads and writes at 2 MiB`, async t => {
    const { root } = await fixture(t); const files = createConfinedFiles({ pythonPath, backend });
    await files.write(root, 'limit', Buffer.alloc(MAX_FILE, 7));
    assert.equal((await files.read(root, 'limit')).data.length, MAX_FILE);
    await assert.rejects(files.write(root, 'huge', Buffer.alloc(MAX_FILE + 1)), /oversized/i);
    await fs.writeFile(path.join(root, 'huge'), Buffer.alloc(MAX_FILE + 1));
    await assert.rejects(files.read(root, 'huge'), /oversized/i);
  });
  test(`${backend}: rejects symlinks, hardlinks and FIFO without blocking`, { timeout: 10000 }, async t => {
    const { base, root } = await fixture(t); const files = createConfinedFiles({ pythonPath, backend });
    const outside = path.join(base, 'outside'); await fs.writeFile(outside, 'SECRET');
    await fs.symlink(outside, path.join(root, 'link'));
    await fs.link(outside, path.join(root, 'hard'));
    await exec('mkfifo', [path.join(root, 'fifo')]);
    for (const name of ['link', 'hard', 'fifo']) {
      await assert.rejects(files.read(root, name));
      await assert.rejects(files.write(root, name, 'changed'));
      await assert.rejects(files.remove(root, name));
    }
    assert.equal(await fs.readFile(outside, 'utf8'), 'SECRET');
    await fs.symlink(base, path.join(root, 'escape'));
    for (const op of [() => files.read(root, 'escape/outside'), () => files.write(root, 'escape/new', 'x'), () => files.remove(root, 'escape/outside'), () => files.entries(root, 'escape')]) await assert.rejects(op());
    await assert.rejects(fs.stat(path.join(base, 'new')), { code: 'ENOENT' });
  });
  test(`${backend}: pins every absolute root ancestor and rejects a swapped ancestor`, async t => {
    const { base, root } = await fixture(t); const files = createConfinedFiles({ pythonPath, backend });
    await files.write(root, 'file', 'original');
    await fs.mkdir(path.join(base, 'outside/root'), { recursive: true });
    await fs.writeFile(path.join(base, 'outside/root/file'), 'SECRET');
    await fs.rename(path.join(base, 'parent'), path.join(base, 'saved'));
    await fs.symlink(path.join(base, 'outside'), path.join(base, 'parent'));
    for (const op of [() => files.read(root, 'file'), () => files.write(root, 'file', 'changed'), () => files.remove(root, 'file'), () => files.entries(root)]) await assert.rejects(op());
    assert.equal(await fs.readFile(path.join(base, 'outside/root/file'), 'utf8'), 'SECRET');
  });
  test(`${backend}: rejects unsafe relative paths and noncanonical roots`, async t => {
    const { root } = await fixture(t); const files = createConfinedFiles({ pythonPath, backend });
    for (const value of ['../x', '/etc/passwd', 'a/../x', 'a//x', './x', 'a/', 'a\\x', 'a\0x', '', '*', 'a\nx']) {
      for (const op of [() => files.read(root, value), () => files.write(root, value, 'x'), () => files.remove(root, value)]) await assert.rejects(op(), /unsafe/i);
      if (value) await assert.rejects(files.entries(root, value), /unsafe/i);
    }
    for (const value of ['.', '/', `${root}/../root`, `${root}/`]) await assert.rejects(files.entries(value), /unsafe/i);
  });
}
test('Python workspace seam preserves public/private scope, commit conflicts and deletion refresh', async t => {
  const { base, root: projectRoot } = await fixture(t);
  await fs.writeFile(path.join(projectRoot, 'public'), 'before');
  await fs.writeFile(path.join(projectRoot, 'private'), 'SECRET');
  const workspace = await createWorkspace({ ...hostRuntime, projectRoot, publicPaths: ['public'] }, { stateRoot: path.join(base, 'state'), filesystemBackend: 'python' });
  t.after(() => workspace.dispose());
  assert.deepEqual(await workspace.list('public'), ['public']);
  await assert.rejects(workspace.read('public', 'private'), /denied/i);
  await workspace.write('public', 'public', 'after');
  await workspace.commit('public');
  await workspace.refreshPrivate();
  assert.equal(await workspace.read('private', 'public'), 'after');
  await workspace.write('private', 'private', 'new');
  await fs.writeFile(path.join(projectRoot, 'private'), 'external');
  await assert.rejects(workspace.commit('private'), /conflict/i);
  await fs.unlink(path.join(workspace.publicRoot, 'public'));
  await workspace.commit('public');
  await workspace.refreshPrivate();
  await assert.rejects(workspace.read('private', 'public'), { code: 'ENOENT' });
});
test('backend and interpreter selection fail closed', async t => {
  const { root } = await fixture(t);
  assert.throws(() => createConfinedFiles({ pythonPath, backend: 'unsafe' }), /backend/i);
  assert.throws(() => createConfinedFiles({ backend: 'python', pythonPath: 'python3' }), /absolute/i);
  await assert.rejects(createConfinedFiles({ backend: 'python', pythonPath: '/definitely-missing-python3' }).entries(root), /unavailable/i);
});

test('Python helper keeps opened ancestors pinned during every operation', async t => {
  const { base } = await fixture(t);
  const helper = new URL('../src/confined-files.py', import.meta.url).pathname;
  const script = `
import os, runpy, sys
module = runpy.run_path(sys.argv[1])
base, operation, swap = sys.argv[2:]
root = base + '/parent/root'
os.makedirs(root + '/nested')
os.makedirs(base + '/outside/root/nested')
with open(base + '/outside/root/nested/outside-only', 'w') as stream: stream.write('SECRET')
for directory, text in [(root, 'original'), (base + '/outside/root', 'SECRET')]:
    with open(directory + '/nested/file', 'w') as stream: stream.write(text)
    with open(directory + '/marker-' + text, 'w') as stream: stream.write(text)
original_open = os.open
swapped = False
def opening(name, flags, *args, **kwargs):
    global swapped
    result = original_open(name, flags, *args, **kwargs)
    if name == swap and not swapped:
        swapped = True
        if swap == 'parent':
            os.rename(base + '/parent', base + '/saved')
            os.symlink(base + '/outside', base + '/parent')
        else:
            os.rename(root + '/nested', root + '/saved')
            os.symlink(base + '/outside/root/nested', root + '/nested')
    return result
os.open = opening
request = {'operation': operation, 'root': root, 'relative': 'nested' if operation == 'entries' else 'nested/file', 'data': 'Y2hhbmdlZA==', 'mode': 384}
result = module['operate'](request)
assert swapped
with open(base + '/outside/root/nested/file') as stream: assert stream.read() == 'SECRET'
pinned = base + '/saved/root/nested/file' if swap == 'parent' else root + '/saved/file'
if operation == 'read': assert result['data'] == 'b3JpZ2luYWw='
if operation == 'entries': assert result == [{'name': 'file', 'type': 'file'}]
if operation == 'write':
    with open(pinned) as stream: assert stream.read() == 'changed'
if operation == 'remove': assert not os.path.exists(pinned)
`;
  for (const swap of ['parent', 'nested']) for (const operation of ['read', 'write', 'remove', 'entries']) {
    const directory = path.join(base, `${swap}-${operation}`);
    await fs.mkdir(directory);
    await exec(pythonPath, ['-I', '-S', '-c', script, helper, directory, operation, swap]);
  }
});

test('Python helper directly rejects unsafe protocol requests and bounded input', async t => {
  const { root } = await fixture(t);
  const helper = new URL('../src/confined-files.py', import.meta.url).pathname;
  async function request(input) {
    return new Promise((resolve, reject) => {
      const child = execFile(pythonPath, ['-I', '-S', helper], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    });
  }
  for (const relative of ['../outside', '/etc/passwd', 'a//file', 'a/../file', 'a\\file', 'a\0file']) {
    const result = await request({ operation: 'read', root, relative });
    assert.equal(result.ok, false); assert.match(result.error, /unsafe/i);
  }
  assert.match((await request(' '.repeat(3 * 1024 * 1024 + 1))).error, /request limit/i);
  const missing = await request({ operation: 'read', root, relative: 'missing' });
  assert.equal(missing.code, 'ENOENT');
  const huge = await request({ operation: 'write', root, relative: 'huge', data: Buffer.alloc(MAX_FILE + 1).toString('base64') });
  assert.match(huge.error, /oversized/i);
  await assert.rejects(fs.stat(path.join(root, 'huge')), { code: 'ENOENT' });
});

test('Python ignores inherited module startup configuration', async t => {
  const { base, root } = await fixture(t);
  const canary = path.join(base, 'executed');
  await fs.writeFile(path.join(base, 'sitecustomize.py'), `open(${JSON.stringify(canary)}, 'w').write('executed')`);
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = base;
  try {
    await createConfinedFiles({ pythonPath, backend: 'python' }).write(root, 'file', 'safe');
    await assert.rejects(fs.stat(canary), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous;
  }
});

test('workspace passes the host Python path to its selected backend', async t => {
  const { base, root: projectRoot } = await fixture(t);
  await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot, pythonPath: '/definitely-missing-python3' }, { stateRoot: path.join(base, 'state'), filesystemBackend: 'python' }), /unavailable/i);
});

test('small Linux reads do not retain a full per-file limit buffer', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await fixture(t);
  const files = createConfinedFiles({ pythonPath, backend: 'linux' });
  await files.write(root, 'small', 'small');
  const { data } = await files.read(root, 'small');
  assert.equal(data.toString(), 'small');
  assert.ok(data.buffer.byteLength <= 8192, 'snapshots with many small files must not retain 2 MiB per file');
});

test('workspace rejects noncanonical project roots', async t => {
  const { base, root } = await fixture(t);
  await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot: `${root}/../root` }, { stateRoot: path.join(base, 'state') }), /unsafe/i);
});

test('host tests resolve a working Python and fail explicitly for unusable installations', async t => {
  const { resolvePython, loadHostRuntime } = await import('../scripts/host-runtime.mjs');
  const { base, root } = await fixture(t);
  const launcher = path.join(base, 'unusable-python3');
  await fs.writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.equal(await resolvePython('', [launcher, pythonPath]), pythonPath);
  await assert.rejects(resolvePython(launcher), /usable Python.*unavailable/i);
  await assert.rejects(resolvePython('', [launcher]), /usable Python.*unavailable/i);
  await assert.rejects(resolvePython('python3'), /absolute/i);
  const configuredPython = path.join(base, 'selected-python3');
  await fs.symlink(pythonPath, configuredPython);
  const configFile = path.join(base, 'host-runtime.json');
  await fs.writeFile(configFile, JSON.stringify({ pythonPath: configuredPython, dockerImage: `sha256:${'a'.repeat(64)}` }));
  const selected = await loadHostRuntime(configFile);
  assert.equal(selected.pythonPath, configuredPython);
  assert.equal(selected.dockerImage, `sha256:${'a'.repeat(64)}`);
  await createConfinedFiles({ backend: 'python', pythonPath: selected.pythonPath }).write(root, 'selected', 'real Python');
  assert.equal(await fs.readFile(path.join(root, 'selected'), 'utf8'), 'real Python');
  for (const config of [{ projectRoot: root }, { platform: 'darwin' }, { dockerSocket: 'tcp://host:2375' }, { pythonPath: 'python3' }, { sandboxBackend: process.platform === 'linux' ? 'docker' : 'bwrap' }]) {
    await fs.writeFile(configFile, JSON.stringify(config));
    await assert.rejects(loadHostRuntime(configFile), /unrelated|absolute|require/i);
  }
});
