import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { runSandbox } from '../src/sandbox.js';
import { resolveConfig } from '../src/config.js';

// Docker is not installed in CI. Exercise the real subprocess boundary against
// an executable fake that persists daemon state independently of its CLI PID.
async function fixture(t, mode = 'success', rootName = 'snapshot') {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-docker-test-'));
  const root = path.join(dir, rootName);
  await fs.mkdir(path.join(root, 'public/private'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/file'), 'public');
  const socket = path.join(dir, 'docker.sock');
  const server = net.createServer();
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => {
    try { process.kill(Number(await fs.readFile(path.join(dir, 'descendant'), 'utf8')), 'SIGKILL'); } catch {}
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const cli = path.join(dir, 'docker');
  await fs.writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const dir = ${JSON.stringify(dir)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const config = args[args.indexOf('--config') + 1];
fs.appendFileSync(dir + '/calls', JSON.stringify({ args, env: process.env, configFiles: fs.readdirSync(config) }) + '\\n');
const verb = args[4];
const marker = dir + '/container';
if (verb === 'create') {
  fs.writeFileSync(dir + '/creating', '1');
  const finish = () => {
    fs.writeFileSync(marker, args[args.indexOf('--name') + 1]);
    if (mode === 'create-crash') { process.kill(process.pid, 'SIGKILL'); return; }
    if (mode === 'create-fail') { console.error('create failed after allocation'); process.exit(125); }
    console.log('fake-container-id');
  };
  if (mode === 'create-output-race') {
    const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "late-created"), 250)'], { detached: true, stdio: 'ignore' });
    process.stdout.write('x'.repeat(300000));
    daemon.on('exit', () => process.exit(0));
  } else if (mode === 'create-race') setTimeout(finish, 250); else finish();
} else if (verb === 'start') {
  fs.writeFileSync(dir + '/starting', '1');
  if (mode === 'start-race') {
    setTimeout(() => { if (!fs.existsSync(marker)) process.exit(125); }, 200);
    setInterval(() => { if (!fs.existsSync(marker)) process.exit(137); }, 10);
  } else if (mode === 'hang' || mode === 'output') {
    if (mode === 'output') process.stdout.write('x'.repeat(300000));
    setInterval(() => { if (!fs.existsSync(marker)) process.exit(137); }, 10);
  } else if (mode === 'start-fail') {
    console.error('cannot start container'); process.exit(125);
  } else {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(dir + '/descendant', String(child.pid)); child.unref();
    console.log('command output'); console.error('command stderr');
    process.exitCode = mode === 'exit-seven' ? 7 : 0;
  }
} else if (verb === 'rm') {
  if (mode === 'cleanup-fail') { console.error('daemon unavailable'); process.exit(1); }
  try { process.kill(Number(fs.readFileSync(dir + '/descendant', 'utf8')), 'SIGKILL'); } catch {}
  fs.rmSync(marker, { force: true });
} else { console.error('unexpected verb: ' + verb); process.exit(99); }
`, { mode: 0o700 });
  const options = { sandboxBackend: 'docker', dockerPath: cli, dockerSocket: socket, timeoutMs: 3000 };
  return {
    dir, root, options,
    calls: async () => (await fs.readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse),
    absent: async () => assert.rejects(fs.stat(path.join(dir, 'container')), { code: 'ENOENT' }),
  };
}

async function waitFor(file) {
  for (let i = 0; i < 200; i++) {
    try { await fs.access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error(`Did not observe ${file}`);
}

test('Docker confines mounts, environment, endpoint and resources and removes completed descendants', async t => {
  const f = await fixture(t);
  const inherited = { DOCKER_HOST: 'tcp://untrusted:2375', DOCKER_CONTEXT: 'remote', DOCKER_CONFIG: '/host/credentials', SECRET_TEST: 'private', NODE_OPTIONS: '--invalid-option' };
  const saved = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const result = await runSandbox(f.root, 'echo hello', { ...f.options, readOnlyPaths: ['public'], writablePaths: ['public/private'] });
  assert.deepEqual(result, { exitCode: 0, stdout: 'command output\n', stderr: 'command stderr\n' });
  await f.absent();
  const calls = await f.calls();
  assert.deepEqual(calls.map(call => call.args[4]), ['create', 'start', 'rm']);
  for (const call of calls) {
    assert.equal(call.args[0], '--host');
    assert.equal(call.args[1], `unix://${f.options.dockerSocket}`);
    assert.equal(call.args[2], '--config');
    assert.deepEqual(call.configFiles, []);
    for (const key of Object.keys(inherited)) assert.equal(call.env[key], undefined, key);
    assert.equal(call.env.HOME, call.args[3]);
    await assert.rejects(fs.stat(call.args[3]), { code: 'ENOENT' });
  }
  const args = calls[0].args;
  const name = args[args.indexOf('--name') + 1];
  assert.match(name, /^dsh-sandbox-[a-f0-9-]{36}$/);
  for (const call of calls.slice(1)) assert.equal(call.args.at(-1), name);
  for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=2', '--init', '--no-healthcheck', '--log-driver=none']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
  assert.equal(args[args.indexOf('--tmpfs') + 1], '/tmp:rw,nosuid,nodev,size=128m,mode=1777');
  assert.ok(args.includes('fsize=134217728:134217728'));
  assert.ok(args.includes('nofile=256:256'));
  assert.ok(args.includes('core=0:0'));
  const mounts = args.flatMap((arg, i) => arg === '--mount' ? [args[i + 1]] : []);
  assert.equal(mounts.length, 3);
  assert.ok(mounts[0].includes(`source=${f.root},destination=/workspace`));
  assert.ok(mounts[1].includes(`source=${f.root}/public,destination=/workspace/public,readonly`));
  assert.ok(mounts[2].includes(`source=${f.root}/public/private,destination=/workspace/public/private`));
  assert.ok(mounts.every(mount => mount.includes('bind-recursive=disabled')));
  const image = args.indexOf('node:22-bookworm-slim');
  assert.ok(image > 0);
  assert.deepEqual(args.slice(image + 1), ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp/home', 'LANG=C.UTF-8', '/bin/sh', '-c', 'mkdir -p "$HOME"; exec /bin/sh -c "$1"', 'sandbox', 'echo hello']);
  assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/bin/env');
  const pid = Number(await fs.readFile(path.join(f.dir, 'descendant'), 'utf8'));
  // A reparented zombie has terminated even while the host init has not reaped it.
  try { assert.match(await fs.readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.+\) Z /); } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('Docker preserves the command exit status and cleans create/start failures', async t => {
  for (const mode of ['exit-seven', 'create-fail', 'start-fail']) {
    const f = await fixture(t, mode);
    if (mode === 'create-fail') await assert.rejects(runSandbox(f.root, 'command', f.options), /create failed/i);
    else assert.equal((await runSandbox(f.root, 'command', f.options)).exitCode, mode === 'exit-seven' ? 7 : 125);
    await f.absent();
    assert.equal((await f.calls()).at(-1).args[4], 'rm');
  }
});

test('Docker cancellation waits out create/start races and removes the named container', async t => {
  for (const mode of ['create-race', 'start-race', 'hang']) {
    const f = await fixture(t, mode);
    const controller = new AbortController();
    const run = runSandbox(f.root, 'command', { ...f.options, signal: controller.signal });
    const rejected = assert.rejects(run, /abort/i);
    await waitFor(path.join(f.dir, mode === 'create-race' ? 'creating' : 'starting'));
    controller.abort();
    await rejected;
    await f.absent();
    const calls = await f.calls();
    assert.equal(calls.at(-1).args[4], 'rm');
    if (mode === 'create-race') assert.equal(calls.some(call => call.args[4] === 'start'), false);
  }
});

test('Docker output and time limits terminate the container', async t => {
  for (const mode of ['hang', 'output']) {
    const f = await fixture(t, mode);
    await assert.rejects(runSandbox(f.root, 'command', { ...f.options, timeoutMs: mode === 'hang' ? 150 : 3000 }), mode === 'hang' ? /timeout/i : /output limit/i);
    await f.absent();
  }
});

test('excessive create output cannot leave a late-created daemon container', async t => {
  const f = await fixture(t, 'create-output-race');
  await assert.rejects(runSandbox(f.root, 'command', f.options), /output limit/i);
  await new Promise(resolve => setTimeout(resolve, 350));
  await f.absent();
  assert.equal((await f.calls()).some(call => call.args[4] === 'start'), false);
});

test('an interrupted create control process reports uncertain cleanup even after best-effort removal', async t => {
  const f = await fixture(t, 'create-crash');
  await assert.rejects(runSandbox(f.root, 'command', f.options), /cleanup.*could not be confirmed.*creation/i);
  await f.absent();
  assert.equal((await f.calls()).some(call => call.args[4] === 'start'), false);
});

test('Docker refuses remote endpoints, unsafe image references, invalid commands and paths before spawning', async t => {
  const f = await fixture(t);
  for (const dockerSocket of ['tcp://localhost:2375', 'ssh://localhost', 'unix:///tmp/socket', 'relative.sock', '/tmp/a\n']) await assert.rejects(runSandbox(f.root, 'command', { ...f.options, dockerSocket }), /socket|endpoint/i);
  for (const dockerPath of ['docker', './docker', '/missing/docker']) await assert.rejects(runSandbox(f.root, 'command', { ...f.options, dockerPath }), /Docker|absolute|unavailable/i);
  for (const dockerImage of ['--privileged', 'node:22 --network=host', 'https://host/image', 'node\n', '']) await assert.rejects(runSandbox(f.root, 'command', { ...f.options, dockerImage }), /image/i);
  for (const relative of ['../outside', '/etc', 'public/../other', 'public//private', 'public\n', 'public\\file']) await assert.rejects(runSandbox(f.root, 'command', { ...f.options, readOnlyPaths: [relative] }), /path/i);
  await fs.symlink('/etc', path.join(f.root, 'outside'));
  await assert.rejects(runSandbox(f.root, 'command', { ...f.options, readOnlyPaths: ['outside/passwd'] }), /path|symbolic|unsafe/i);
  await assert.rejects(runSandbox(f.root, '', f.options), /command/i);
  await assert.rejects(runSandbox(f.root, 'command', { ...f.options, timeoutMs: 0 }), /timeout/i);
  await assert.rejects(runSandbox(f.root, 'command', { ...f.options, sandboxBackend: 'unsafe' }), /backend/i);
  await assert.rejects(fs.stat(path.join(f.dir, 'calls')), { code: 'ENOENT' });
});

test('Docker CSV encoding keeps comma and quote paths inside a single mount field', async t => {
  const f = await fixture(t, 'success', 'snapshot,with"quotes');
  await runSandbox(f.root, 'command', f.options);
  const args = (await f.calls())[0].args;
  const mount = args[args.indexOf('--mount') + 1];
  assert.ok(mount.includes(`"source=${f.root.replaceAll('"', '""')}"`));
  await f.absent();
});

test('Docker cleanup errors are reported instead of claiming completed isolation', async t => {
  const f = await fixture(t, 'cleanup-fail');
  await assert.rejects(runSandbox(f.root, 'command', f.options), /cleanup.*dsh-sandbox-/i);
});

test('already-aborted Docker commands do not invoke the CLI', async t => {
  const f = await fixture(t);
  await assert.rejects(runSandbox(f.root, 'command', { ...f.options, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(fs.stat(path.join(f.dir, 'calls')), { code: 'ENOENT' });
});

test('resolved Docker image references reach the runtime CLI unchanged', async t => {
  const cases = [
    ['double underscore', 'team/my__runtime:22'],
    ['repeated hyphen', 'team/my--runtime:22'],
    ['256 characters', `${'a'.repeat(127)}/${'b'.repeat(124)}:tag`],
    ['registry port', 'registry.example.com:5000/team/runtime:22'],
    ['image identity', `sha256:${'a'.repeat(64)}`],
    ['repository digest', `node@sha256:${'b'.repeat(64)}`],
    ['tagged digest', `node:22@sha256:${'c'.repeat(64)}`],
  ];
  for (const [label, dockerImage] of cases) {
    await t.test(label, async t => {
      const f = await fixture(t);
      const resolved = resolveConfig({
        sandboxBackend: 'docker', dockerPath: f.options.dockerPath,
        dockerSocket: f.options.dockerSocket, dockerImage,
      });
      const result = await runSandbox(f.root, 'command', { ...resolved, timeoutMs: 3000 });
      assert.equal(result.exitCode, 0);
      const args = (await f.calls())[0].args;
      assert.equal(args[args.indexOf('--entrypoint') + 2], dockerImage);
      await f.absent();
    });
  }
});

test('configuration and runtime reject the same unsafe or unpinned Docker images', async t => {
  const f = await fixture(t);
  for (const dockerImage of [
    'node', 'node:22 --privileged', '--privileged', 'node:22\n',
    'https://registry.example.com/node:22', 'team/my___runtime:22',
    'team/my..runtime:22', 'team/-runtime:22', 'UPPER/runtime:22',
    `${'a'.repeat(127)}/${'b'.repeat(125)}:tag`, `node@sha256:${'a'.repeat(63)}`,
  ]) {
    assert.throws(() => resolveConfig({ dockerImage }), /dockerImage/);
    await assert.rejects(runSandbox(f.root, 'command', { ...f.options, dockerImage }), /image/i);
  }
  await assert.rejects(fs.stat(path.join(f.dir, 'calls')), { code: 'ENOENT' });
});
