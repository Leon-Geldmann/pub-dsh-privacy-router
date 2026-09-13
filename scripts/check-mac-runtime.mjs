import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkspace } from '../src/workspace.js'
import { loadHostRuntime } from './host-runtime.mjs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function publicProbe(hostCanary, port) {
  return `
    const fs = require('fs');
    const a = require('assert/strict');
    a.equal(fs.existsSync(${JSON.stringify(hostCanary)}), false);
    a.equal(fs.existsSync('private/secret.txt'), false);
    a.equal(process.env.DSH_RUNTIME_HOST_CANARY, undefined);
    a.equal(process.env.DOCKER_HOST, undefined);
    a.equal(fs.existsSync('/var/run/docker.sock'), false);
    // /proc/net/dev also lists interfaces without configured addresses.
    for (const row of fs.readFileSync('/proc/net/dev', 'utf8').split('\\n')) {
      if (row.includes(':')) a.equal(row.split(':')[0].trim(), 'lo', 'External network interface is present');
    }
    const interfaces = require('os').networkInterfaces();
    a.ok(Object.values(interfaces).flat().every(address => address.internal), 'External network interface is present');
    for (const filename of ['/proc/net/route', '/proc/net/ipv6_route']) {
      const rows = fs.readFileSync(filename, 'utf8').trim().split('\\n').filter(Boolean);
      for (const row of rows) {
        const fields = row.trim().split(/\\s+/);
        if (fields[0] === 'Iface') continue;
        const iface = filename.endsWith('ipv6_route') ? fields.at(-1) : fields[0];
        a.equal(iface, 'lo', 'External network route is present');
      }
    }
    fs.writeFileSync('public/result.js', 'public result');
    fetch('http://127.0.0.1:${port}', { signal: AbortSignal.timeout(1000) })
      .then(() => process.exit(9), () => console.log('public confinement passed'))
  `
}

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"

// Observe synthetic marker files directly on the host: invoking the Python
// scanner for each poll would consume the very startup budget being measured.
export async function checkStop(workspace, kind, { timeoutMs = 10000, startupMs = 30000, lateMs = kind === 'timeout' ? timeoutMs + 1500 : 1500 } = {}) {
  assert(['timeout', 'abort'].includes(kind))
  assert(lateMs > (kind === 'timeout' ? timeoutMs : 0), 'Late writes must extend past the stop deadline')
  const prefix = `private/stop-${kind}-${randomUUID()}`
  const childSource = `const fs=require('fs');const startedAt=Date.now();fs.writeFileSync('${prefix}-child-start.tmp',JSON.stringify({pid:process.pid,parentPid:process.ppid,startedAt,writeAt:startedAt+${lateMs}}));fs.renameSync('${prefix}-child-start.tmp','${prefix}-child-start');setTimeout(()=>fs.writeFileSync('${prefix}-child-late','bad'),${lateMs})`
  const parentSource = `const fs=require('fs');const startedAt=Date.now();fs.writeFileSync('${prefix}-parent-start.tmp',JSON.stringify({pid:process.pid,startedAt,writeAt:startedAt+${lateMs}}));fs.renameSync('${prefix}-parent-start.tmp','${prefix}-parent-start');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'inherit'});setTimeout(()=>fs.writeFileSync('${prefix}-parent-late','bad'),${lateMs})`
  const abort = new AbortController()
  let outcome
  const invokedAt = performance.now()
  const operation = workspace.run('private', `node -e ${shellQuote(parentSource)}`, {
    timeoutMs: kind === 'timeout' ? timeoutMs : startupMs + lateMs + 5000,
    signal: abort.signal,
  }).then(value => { outcome = { value } }, error => { outcome = { error } })
  let markers
  let observedAt
  try {
    const until = invokedAt + startupMs
    while (!markers) {
      if (outcome) {
        if (outcome.error && !/^Command (timeout|aborted)$/i.test(outcome.error.message)) throw outcome.error
        throw new Error(`${kind}: parent and child startup was not observed before the command stopped`)
      }
      try {
        const parent = JSON.parse(await fs.readFile(path.join(workspace.privateRoot, `${prefix}-parent-start`), 'utf8'))
        const child = JSON.parse(await fs.readFile(path.join(workspace.privateRoot, `${prefix}-child-start`), 'utf8'))
        assert(Number.isInteger(parent.pid) && parent.pid > 0 && Number.isInteger(child.pid) && child.pid > 0 && child.pid !== parent.pid && child.parentPid === parent.pid, 'Invalid parent/child startup evidence')
        assert([parent, child].every(marker => Number.isFinite(marker.startedAt) && marker.writeAt === marker.startedAt + lateMs), 'Invalid startup timing evidence')
        if (outcome) throw new Error(`${kind}: startup was not observed while the workload was running`)
        markers = [parent, child]
        observedAt = performance.now()
        if (kind === 'timeout') assert(observedAt < invokedAt + timeoutMs, 'Parent/child startup was not observed before the timeout deadline')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (!markers) {
        if (performance.now() >= until) throw new Error(`${kind}: timed out waiting for parent and child startup`)
        await delay(25)
      }
    }
    if (kind === 'abort') abort.abort()
    await operation
    assert(outcome.error, `${kind}: command unexpectedly completed`)
    assert.match(outcome.error.message, new RegExp(`^Command ${kind === 'abort' ? 'aborted' : 'timeout'}$`, 'i'), 'Stop failed or cleanup could not be confirmed')
    // Each timer begins inside its running process, so even slow engine startup
    // cannot move a delayed write before the runner's timeout deadline. Wait
    // from host observation too, avoiding host/VM wall-clock skew.
    await delay(Math.max(0, observedAt + lateMs + 500 - performance.now()))
    for (const role of ['parent', 'child']) {
      await assert.rejects(workspace.read('private', `${prefix}-${role}-late`), { code: 'ENOENT' })
    }
  } finally {
    abort.abort()
    await operation
    if (outcome?.error && /cleanup|could not be confirmed/i.test(outcome.error.message)) throw outcome.error
  }
}

export async function checkStops(workspace) {
  await checkStop(workspace, 'timeout')
  await checkStop(workspace, 'abort')
}

async function main() {
  const config = await loadHostRuntime(process.argv[2])

  // Colima shares the account home by default; macOS /private/var temp paths
  // may be outside that share. Only this fresh synthetic directory is mounted.
  const base = await fs.realpath(process.platform === 'darwin' ? os.homedir() : os.tmpdir())
  const root = await fs.mkdtemp(path.join(base, '.dsh-runtime-check-'))
  const projectRoot = path.join(root, 'project')
  let workspace
  let requests = 0
  const server = http.createServer((request, response) => { requests++; response.end('HOST_NETWORK_CANARY') })
  const priorCanary = process.env.DSH_RUNTIME_HOST_CANARY
  process.env.DSH_RUNTIME_HOST_CANARY = 'PRIVATE_ENV_CANARY'
  try {
    await fs.mkdir(path.join(projectRoot, 'public'), { recursive: true })
    await fs.mkdir(path.join(projectRoot, 'private'))
    await fs.writeFile(path.join(projectRoot, 'public/api.js'), 'public contract')
    await fs.writeFile(path.join(projectRoot, 'private/secret.txt'), 'PRIVATE_FILE_CANARY')
    await fs.writeFile(path.join(projectRoot, 'public/.env'), 'CREDENTIAL_CANARY')
    const hostCanary = path.join(root, 'host-secret')
    await fs.writeFile(hostCanary, 'HOST_FILE_CANARY')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    workspace = await createWorkspace({ ...config, projectRoot, publicPaths: ['public/'], privatePaths: ['private/'] }, {
      stateRoot: path.join(root, 'state'), filesystemBackend: 'python',
    })
    assert.deepEqual(await workspace.list('public'), ['public/api.js'])
    await assert.rejects(workspace.read('public', 'private/secret.txt'))
    await assert.rejects(workspace.read('public', 'public/.env'))
    // Use only synthetic text and a fresh loopback canary server.
    const probe = publicProbe(hostCanary, server.address().port)
    const publicResult = await workspace.run('public', `node -e ${shellQuote(probe)}`, { timeoutMs: 30000 })
    assert.equal(publicResult.exitCode, 0, publicResult.stderr)
    assert.equal(requests, 0, 'Sandbox reached the host network')
    await workspace.commit('public')
    await workspace.refreshPrivate()
    const localProbe = `const fs=require('fs');const a=require('assert/strict');a.equal(fs.readFileSync('private/secret.txt','utf8'),'PRIVATE_FILE_CANARY');a.throws(()=>fs.writeFileSync('public/api.js','PRIVATE_LEAK'));fs.writeFileSync('private/result.js','private result');console.log('private confinement passed')`
    const localResult = await workspace.run('private', `node -e ${shellQuote(localProbe)}`, { timeoutMs: 30000 })
    assert.equal(localResult.exitCode, 0, localResult.stderr)
    await workspace.commit('private')
    assert.equal(await fs.readFile(path.join(projectRoot, 'public/api.js'), 'utf8'), 'public contract')
    assert.equal(await fs.readFile(path.join(projectRoot, 'private/result.js'), 'utf8'), 'private result')
    await checkStops(workspace)
    console.log(JSON.stringify({ passed: true, platform: process.platform, filesystem: 'real Python dir_fd', commands: config.sandboxBackend, checks: ['public/private views', 'host files and environment hidden', 'no external network interfaces or routes', 'no host loopback access', 'public context read-only', 'scope commits', 'running parent/child timeout and cancellation'] }, null, 2))
  } finally {
    if (priorCanary === undefined) delete process.env.DSH_RUNTIME_HOST_CANARY
    else process.env.DSH_RUNTIME_HOST_CANARY = priorCanary
    await workspace?.dispose()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
