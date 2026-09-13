import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireDockerImage } from '../src/docker-image.js'

const exec = promisify(execFile)
const allowed = ['sandboxBackend', 'dockerPath', 'dockerSocket', 'dockerImage', 'pythonPath']
const knownPython = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f\\]/.test(value)

export async function resolvePython(pythonPath = '', candidates = knownPython) {
  assert(pythonPath === '' || absolute(pythonPath), 'Python test path must be absolute')
  for (const candidate of pythonPath ? [pythonPath] : candidates) {
    assert(absolute(candidate), 'Python test path must be absolute')
    try {
      const { stdout } = await exec(candidate, ['-I', '-S', '-c', "import os,sys; assert sys.version_info >= (3, 8); assert os.open in os.supports_dir_fd and os.listdir in os.supports_fd; assert all(hasattr(os,n) for n in ['O_NOFOLLOW','O_DIRECTORY','O_NONBLOCK']); print('DSH_PYTHON_READY')"], {
        cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 4096,
      })
      if (stdout.trim() === 'DSH_PYTHON_READY') return candidate
    } catch { /* An installed launcher is not necessarily a usable Python. */ }
  }
  throw new Error('Usable Python 3 unavailable; set pythonPath in the host runtime JSON (DSH_TEST_RUNTIME_CONFIG for npm test)')
}

// Only operator-owned runtime controls are accepted. This helper is used by
// acceptance tooling/tests; production configuration and dispatch stay unchanged.
export async function loadHostRuntime(filename) {
  const config = filename ? JSON.parse(await fs.readFile(filename, 'utf8')) : {}
  assert(config && typeof config === 'object' && !Array.isArray(config), 'Runtime config must be an object')
  assert(Object.keys(config).every(key => allowed.includes(key)), 'Runtime config contains unrelated settings')
  const backend = { linux: 'bwrap', darwin: 'docker' }[process.platform]
  assert(backend, 'Unsupported host for runtime checks')
  assert(config.sandboxBackend === undefined || ['auto', backend].includes(config.sandboxBackend), `Host runtime checks require ${backend}`)
  for (const key of ['dockerPath', 'dockerSocket', 'pythonPath']) {
    assert(config[key] === undefined || config[key] === '' || absolute(config[key]), `${key} must be an absolute local path`)
  }
  if (config.dockerImage !== undefined) requireDockerImage(config.dockerImage)
  return { ...config, sandboxBackend: backend, pythonPath: await resolvePython(config.pythonPath) }
}
