import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWorkspace } from '../src/workspace.js';
import { hostRuntime } from './helpers/host-runtime.js';
import { runSandbox } from '../src/sandbox.js';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'privacy-workspace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(path.join(projectRoot, 'public'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'private'));
  await fs.writeFile(path.join(projectRoot, 'public/api.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(projectRoot, 'private/secret.txt'), 'PRIVATE_CANARY');
  await fs.writeFile(path.join(projectRoot, 'public/.env'), 'CREDENTIAL_CANARY');
  await fs.mkdir(path.join(projectRoot, '.git'));
  await fs.writeFile(path.join(projectRoot, '.git/config'), 'GIT_CANARY');
  const workspace = await createWorkspace({ ...hostRuntime, projectRoot, publicPaths: ['public/'], privatePaths: ['private/'], ...extra }, { stateRoot: path.join(root, 'state') });
  t.after(() => workspace.dispose());
  return { root, projectRoot, workspace };
}

test('public exports only allowed regular files; private can read public context', async t => {
  const { workspace } = await fixture(t);
  assert.deepEqual(await workspace.list('public'), ['public/api.js']);
  assert.match(await workspace.read('private', 'private/secret.txt'), /PRIVATE_CANARY/);
  assert.match(await workspace.read('private', 'public/api.js'), /value = 1/);
  for (const name of ['private/secret.txt', 'public/.env', '.git/config', '../project/private/secret.txt', '/etc/passwd']) {
    await assert.rejects(workspace.read('public', name));
  }
});

test('commits write only each scope and refresh takes committed public data', async t => {
  const { workspace, projectRoot } = await fixture(t);
  await workspace.write('public', 'public/new.js', 'public contract');
  await workspace.commit('public');
  await workspace.refreshPrivate();
  assert.equal(await workspace.read('private', 'public/new.js'), 'public contract');
  await assert.rejects(workspace.write('private', 'public/new.js', 'PRIVATE_CANARY'));
  await workspace.write('private', 'private/impl.js', 'local implementation');
  await workspace.commit('private');
  assert.equal(await fs.readFile(path.join(projectRoot, 'private/impl.js'), 'utf8'), 'local implementation');
  await fs.writeFile(path.join(workspace.privateRoot, 'public/new.js'), 'PRIVATE_CANARY');
  await workspace.write('private', 'private/not-committed', 'private');
  await assert.rejects(workspace.commit('private'), /mutation/i);
  await assert.rejects(fs.stat(path.join(projectRoot, 'private/not-committed')), { code: 'ENOENT' });
  await workspace.refreshPrivate();
  assert.equal(await workspace.read('public', 'public/new.js'), 'public contract');
  assert.equal(await workspace.read('private', 'public/new.js'), 'public contract');
});

test('private prefixes override public prefixes and credentials remain excluded', async t => {
  const { workspace } = await fixture(t, { privatePaths: ['private/', 'public/api.js'] });
  assert.deepEqual(await workspace.list('public'), []);
  await workspace.write('private', 'public/api.js', 'PRIVATE_CANARY');
  await workspace.commit('private');
  await workspace.refreshPrivate();
  assert.deepEqual(await workspace.list('public'), []);
});

test('traversal, symlinks, hardlinks, and credential writes cannot escape', async t => {
  const { workspace, projectRoot } = await fixture(t);
  await fs.symlink(path.join(projectRoot, 'private/secret.txt'), path.join(workspace.publicRoot, 'public/link'));
  await fs.link(path.join(workspace.publicRoot, 'public/api.js'), path.join(workspace.publicRoot, 'public/hard'));
  for (const p of ['public/link', 'public/hard', 'public/../private/oops', 'public/.env', 'public/.ssh/key']) {
    await assert.rejects(workspace.write('public', p, 'bad'));
    await assert.rejects(workspace.read('public', p));
  }
  await assert.rejects(workspace.commit('public'));
  assert.equal(await fs.readFile(path.join(projectRoot, 'private/secret.txt'), 'utf8'), 'PRIVATE_CANARY');
});

test('conflicts preflight all changes and preserve external edits', async t => {
  const { workspace, projectRoot } = await fixture(t);
  await workspace.write('public', 'public/aaa.js', 'new');
  await workspace.write('public', 'public/api.js', 'ours');
  await fs.writeFile(path.join(projectRoot, 'public/api.js'), 'external edit');
  await assert.rejects(workspace.commit('public'), /conflict/i);
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/api.js'), 'utf8'), 'external edit');
  await assert.rejects(fs.stat(path.join(projectRoot, 'public/aaa.js')), { code: 'ENOENT' });
});

test('sandbox commands edit only snapshots, hide host data and environment, and have no network', async t => {
  const { workspace, root, projectRoot } = await fixture(t);
  const canary = path.join(root, 'host-canary');
  await fs.writeFile(canary, 'HOST_CANARY');
  process.env.WORKSPACE_SECRET_TEST = 'ENV_CANARY';
  t.after(() => { delete process.env.WORKSPACE_SECRET_TEST; });
  const server = http.createServer((req, res) => res.end('NETWORK_CANARY'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await workspace.run('public', `node -e 'const fs=require("fs"); fs.writeFileSync("public/from-command.js","created"); console.log(fs.existsSync(${JSON.stringify(canary)}), process.env.WORKSPACE_SECRET_TEST, fs.existsSync("private/secret.txt")); fetch("http://127.0.0.1:${server.address().port}").then(()=>process.exit(9),()=>console.log("offline"))'`, { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /false undefined false/);
  assert.match(result.stdout, /offline/);
  assert.equal(await workspace.read('public', 'public/from-command.js'), 'created');
  await assert.rejects(fs.stat(path.join(projectRoot, 'public/from-command.js')), { code: 'ENOENT' });
  await workspace.commit('public');
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/from-command.js'), 'utf8'), 'created');
});

test('private shell cannot publish via public paths, links, or refresh', async t => {
  const { workspace, projectRoot } = await fixture(t);
  await workspace.run('private', 'printf PRIVATE_CANARY > public/api.js; ln private/secret.txt public/leak; ln -s ../private/secret.txt public/link; printf local > private/output.txt', { timeoutMs: 5000 });
  await workspace.commit('private');
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/api.js'), 'utf8'), 'export const value = 1;\n');
  await workspace.refreshPrivate();
  assert.deepEqual(await workspace.list('public'), ['public/api.js']);
  assert.equal(await fs.readFile(path.join(projectRoot, 'private/output.txt'), 'utf8'), 'local');
});

test('timeout and abort kill the sandbox and prevent later writes', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(workspace.run('public', 'sleep 1; echo late > public/late', { timeoutMs: 60 }), /timeout/i);
  const abort = new AbortController();
  const running = workspace.run('public', 'sleep 1; echo late > public/late', { signal: abort.signal, timeoutMs: 5000 });
  setTimeout(() => abort.abort(), 60);
  await assert.rejects(running, /abort/i);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(workspace.read('public', 'public/late'));
});

test('reject unsafe roots and prefix policies', async t => {
  const { root, projectRoot } = await fixture(t);
  for (const bad of ['/', os.homedir(), '.', path.join(root, 'link')]) {
    if (bad.endsWith('/link')) await fs.symlink(projectRoot, bad);
    await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot: bad, publicPaths: ['public/'], privatePaths: [] }, { stateRoot: path.join(root, 'other-state') }));
  }
  for (const bad of ['../', '/tmp/', 'public/*', 'public/../private/', '']) {
    await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot, publicPaths: [bad], privatePaths: [] }, { stateRoot: path.join(root, 'other-state') }));
  }
});


test('missing sandbox and excessive output fail closed', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(runSandbox(workspace.publicRoot, 'echo unsafe > public/unsafe', { sandboxBackend: 'bwrap', sandboxPath: '/definitely-missing-bwrap' }), { message: process.platform === 'linux' ? /^Sandbox unavailable$/ : /unavailable on this platform/i });
  if (process.platform === 'darwin') await assert.rejects(runSandbox(workspace.publicRoot, 'echo unsafe > public/unsafe', { ...hostRuntime, sandboxBackend: 'docker', dockerPath: '/definitely-missing-docker' }), /unavailable/i);
  await assert.rejects(workspace.read('public', 'public/unsafe'), { code: 'ENOENT' });
  await assert.rejects(workspace.run('public', 'node -e "process.stdout.write(\'x\'.repeat(300000))"'), /output limit/i);
});

test('private subtree override is writable beneath read-only public directory', async t => {
  const { workspace, projectRoot } = await fixture(t, { privatePaths: ['private/', 'public/internal/'] });
  await workspace.write('private', 'public/internal/implementation.js', 'before');
  const result = await workspace.run('private', 'printf PRIVATE_CANARY > public/internal/implementation.js; printf bad > public/api.js', { timeoutMs: 5000 });
  assert.notEqual(result.exitCode, 0);
  await workspace.commit('private');
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/internal/implementation.js'), 'utf8'), 'PRIVATE_CANARY');
  assert.deepEqual(await workspace.list('public'), ['public/api.js']);
});

test('commands cannot mount an external directory through a replaced ancestor', async t => {
  const { workspace, root } = await fixture(t, { privatePaths: ['private/', 'public/internal/secrets/'] });
  await fs.mkdir(path.join(root, 'external/secrets'), { recursive: true });
  await fs.writeFile(path.join(root, 'external/secrets/host-key'), 'HOST_PRIVATE_CANARY');
  await fs.symlink(path.join(root, 'external'), path.join(workspace.privateRoot, 'public/internal'));
  await assert.rejects(workspace.run('private', 'cat public/internal/secrets/host-key'), /unsafe|symbolic|ENOTDIR|ELOOP/i);
});

test('snapshot refuses source links and oversized files', async t => {
  const { projectRoot, root } = await fixture(t);
  await fs.symlink('/etc/passwd', path.join(projectRoot, 'public/escape'));
  await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot, publicPaths: ['public/'] }, { stateRoot: path.join(root, 'state') }));
  await fs.unlink(path.join(projectRoot, 'public/escape'));
  await fs.writeFile(path.join(projectRoot, 'public/huge'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(createWorkspace({ ...hostRuntime, projectRoot, publicPaths: ['public/'] }, { stateRoot: path.join(root, 'state') }), /oversized/i);
});

test('public read-only file mounts reject a symlinked ancestor', async t => {
  const { workspace, root } = await fixture(t, { publicPaths: ['public/api.js'] });
  await fs.mkdir(path.join(root, 'external'));
  await fs.writeFile(path.join(root, 'external/api.js'), 'HOST_PRIVATE_CANARY');
  await fs.rm(path.join(workspace.privateRoot, 'public'), { recursive: true });
  await fs.symlink(path.join(root, 'external'), path.join(workspace.privateRoot, 'public'));
  await assert.rejects(workspace.run('private', 'cat public/api.js'), /unsafe|symbolic|ENOTDIR|ELOOP/i);
});

test('sandbox deletions commit and disposed workspaces deny further operations', async t => {
  const { workspace, projectRoot } = await fixture(t);
  const result = await workspace.run('public', 'rm public/api.js');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await workspace.commit('public'), { changed: ['public/api.js'] });
  await assert.rejects(fs.stat(path.join(projectRoot, 'public/api.js')), { code: 'ENOENT' });
  await workspace.refreshPrivate();
  await assert.rejects(workspace.read('private', 'public/api.js'));
  await workspace.dispose();
  await assert.rejects(fs.stat(workspace.publicRoot), { code: 'ENOENT' });
  await assert.rejects(workspace.write('public', 'public/late', 'late'), /disposed/i);
});

test('project-level abort prevents pending edits from committing', async t => {
  const { projectRoot, root } = await fixture(t);
  const controller = new AbortController();
  const workspace = await createWorkspace({ ...hostRuntime, projectRoot, publicPaths: ['public/'] }, { stateRoot: path.join(root, 'state'), signal: controller.signal });
  t.after(() => workspace.dispose());
  await workspace.write('public', 'public/api.js', 'uncommitted');
  controller.abort();
  await assert.rejects(workspace.commit('public'), /aborted/i);
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/api.js'), 'utf8'), 'export const value = 1;\n');
});

test('background descendants cannot outlive the command namespace', async t => {
  const { workspace } = await fixture(t);
  const result = await workspace.run('public', '(sleep 0.2; echo escaped > public/escaped) >/dev/null 2>&1 & true', { timeoutMs: 2000 });
  assert.equal(result.exitCode, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(workspace.read('public', 'public/escaped'));
});

test('an equal private directory override stays shell-writable', async t => {
  const { workspace, projectRoot } = await fixture(t, { publicPaths: ['public/'], privatePaths: ['public/'] });
  const result = await workspace.run('private', 'printf PRIVATE_CANARY > public/api.js; printf local > public/new.js', { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  await workspace.commit('private');
  await workspace.refreshPrivate();
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/api.js'), 'utf8'), 'PRIVATE_CANARY');
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/new.js'), 'utf8'), 'local');
  assert.deepEqual(await workspace.list('public'), []);
});

test('a missing exact private override can be created and atomically replaced by shell', async t => {
  const { workspace, projectRoot } = await fixture(t, { publicPaths: ['public/'], privatePaths: ['public/new.js'] });
  const result = await workspace.run('private', 'test ! -e public/new.js && printf PRIVATE_CANARY > public/new.js', { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  await workspace.commit('private');
  const replacement = await workspace.run('private', 'printf replacement > /tmp/replacement; mv /tmp/replacement public/new.js', { timeoutMs: 5000 });
  assert.equal(replacement.exitCode, 0, replacement.stderr);
  await workspace.commit('private');
  await workspace.refreshPrivate();
  assert.equal(await fs.readFile(path.join(projectRoot, 'public/new.js'), 'utf8'), 'replacement');
  assert.deepEqual(await workspace.list('public'), ['public/api.js']);
  await assert.rejects(workspace.read('public', 'public/new.js'));
});

test('exact private shell overrides never publish sibling public changes or partially commit', async t => {
  const { workspace, projectRoot } = await fixture(t, { publicPaths: ['public/'], privatePaths: ['public/new.js'] });
  const result = await workspace.run('private', 'printf PRIVATE_CANARY > public/new.js; printf PRIVATE_CANARY > public/leak.js', { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, result.stderr);
  await assert.rejects(workspace.commit('private'), /mutation/i);
  await assert.rejects(fs.stat(path.join(projectRoot, 'public/new.js')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(projectRoot, 'public/leak.js')), { code: 'ENOENT' });
  await workspace.refreshPrivate();
  assert.deepEqual(await workspace.list('public'), ['public/api.js']);
  await assert.rejects(workspace.read('private', 'public/leak.js'));
});

// Acceptance checks must reject setup-only stops and an ordinary Docker bridge.
// These controlled runtime results cannot prove a workload or isolation started.
test('runtime checker rejects timeout/abort results without workload startup', async t => {
  const { checkStops } = await import('../scripts/check-mac-runtime.mjs');
  const { root } = await fixture(t);
  const workspace = {
    privateRoot: root,
    async run() {
      throw new Error('Command timeout');
    },
    async read() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  await assert.rejects(checkStops(workspace), /startup|started/i);
});

test('runtime network probe rejects external interfaces and routes without Internet access', async () => {
  const { publicProbe } = await import('../scripts/check-mac-runtime.mjs');
  const { runInNewContext } = await import('node:vm');
  const loopback = { lo: [{ address: '127.0.0.1', internal: true }] };
  for (const network of [
    { interfaces: loopback, devices: 'Inter-| Receive | Transmit\n eth0: 0 0 0 0\n', ipv4: '', ipv6: '' },
    { interfaces: { ...loopback, eth0: [{ address: '172.17.0.2', internal: false }] }, ipv4: '', ipv6: '' },
    { interfaces: loopback, ipv4: 'Iface Destination Gateway Flags\neth0 00000000 010011AC 0003\n', ipv6: '' },
    { interfaces: loopback, ipv4: '', ipv6: '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 00000003 eth0\n' },
  ]) {
    const modules = {
      fs: { existsSync: () => false, writeFileSync() {}, readFileSync: filename => filename.endsWith('/dev') ? (network.devices ?? 'lo: 0 0 0 0\n') : filename.endsWith('ipv6_route') ? network.ipv6 : network.ipv4 },
      os: { networkInterfaces: () => network.interfaces },
      'assert/strict': assert,
    };
    await assert.rejects(async () => runInNewContext(publicProbe('/synthetic/host-secret', 1234), {
      require: name => modules[name.replace(/^node:/, '')], process: { env: {}, exit() { throw new Error('Unexpected network access'); } },
      fetch: async () => { throw new Error('Loopback is isolated'); }, AbortSignal, console: { log() {} },
    }), /network|interface|route/i);
  }
});

test('runtime stop checks require both processes and reject setup or uncertain cleanup errors', async t => {
  const { checkStop } = await import('../scripts/check-mac-runtime.mjs');
  const { root } = await fixture(t);
  for (const kind of ['timeout', 'abort']) {
    // A never-started create-only command can report the right stop reason.
    const workspace = {
      privateRoot: root,
      async run(_scope, _command, { signal }) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('Command aborted');
      },
    };
    await assert.rejects(checkStop(workspace, kind, { startupMs: 50 }), /startup/i);
    for (const message of ['Sandbox unavailable', 'Docker create failed', 'Command timeout; cleanup could not be confirmed']) {
      await assert.rejects(checkStop({ ...workspace, async run() { throw new Error(message); } }, kind), error => error.message === message);
    }
  }
});

test('actual sandbox stop probes observe running parent and child before verifying late writes', async t => {
  const { checkStops } = await import('../scripts/check-mac-runtime.mjs');
  const { workspace } = await fixture(t);
  await checkStops(workspace);
});

test('Mac test temp roots are canonical home children and survive until the suite settles', async t => {
  const { runTests } = await import('../scripts/test.mjs');
  const { root } = await fixture(t);
  const home = path.join(root, 'home');
  const alias = path.join(root, 'home-alias');
  await fs.mkdir(home);
  await fs.symlink(home, alias);
  const seen = [];
  for (const fail of [false, true]) {
    const proof = path.join(root, `proof-${fail}.json`);
    const suite = path.join(root, `child-${fail}.mjs`);
    await fs.writeFile(suite, `import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
const root=os.tmpdir(); assert.equal(path.dirname(root),${JSON.stringify(home)}); assert.equal(await fs.realpath(root),root);
await new Promise(resolve=>setTimeout(resolve,100)); await fs.stat(root); await fs.writeFile(${JSON.stringify(proof)},JSON.stringify(root)); process.exitCode=${fail ? 7 : 0};`);
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    assert.equal(await runTests([suite], { platform: 'darwin', home: alias, env: childEnv, stdio: 'ignore' }), fail ? 1 : 0);
    const tempRoot = JSON.parse(await fs.readFile(proof, 'utf8'));
    seen.push(tempRoot);
    await assert.rejects(fs.stat(tempRoot), { code: 'ENOENT' });
  }
  assert.notEqual(seen[0], seen[1]);
});
