import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export async function runTests(args, { platform = process.platform, home = os.homedir(), env = process.env, stdio = 'inherit' } = {}) {
  let root
  try {
    const childEnv = { ...env }
    // Colima shares the account home by default. Canonicalizing /var alone
    // would still leave actual snapshot bind mounts outside that share.
    if (platform === 'darwin') {
      root = await fs.mkdtemp(path.join(await fs.realpath(home), '.dsh-tests-'))
      childEnv.TMPDIR = root
    }
    return await new Promise(resolve => {
      const child = spawn(process.execPath, ['--test', ...args], { env: childEnv, stdio })
      child.on('error', error => { console.error(error.message) })
      // close follows exit/error after stdio settles; never remove mounted
      // workspaces while the child suite is still running.
      child.on('close', code => resolve(code ?? 1))
    })
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runTests(process.argv.slice(2))
