import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function authorizationKey(config) {
  const { mode, projectRoot, publicPaths, privatePaths, publicBrief, localProvider, localModel, cloudProvider, cloudModel,
    sensitiveTerms, blockEmails, blockPhones, blockLocalPaths, integrationCommand } = config
  return digest({ mode, projectRoot, publicPaths, privatePaths, publicBrief, localProvider, localModel, cloudProvider, cloudModel,
    sensitiveTerms, blockEmails, blockPhones, blockLocalPaths, integrationCommand })
}

async function directory(path, privateDirectory = true) {
  const parent = dirname(path)
  // lstat of only the immediate parent still follows symlinks higher up.
  if (parent !== path) await directory(parent, false)
  await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateDirectory && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('协作记录目录必须仅当前用户可访问。')
  }
}

function checkedScope(scope) {
  if (scope !== 'public' && scope !== 'private') throw new Error('Invalid collaboration history scope')
  return scope
}

function serializeHistory(value) {
  let data = JSON.stringify(value)
  // Evict whole old turns, never message fragments. Mutate the caller's record
  // so subsequent writes cannot resurrect history already evicted from disk.
  while (Buffer.byteLength(data) > 33_554_432) {
    if (value.turns.length > 1) value.turns.shift()
    else {
      const keys = Object.keys(value.runs ?? {})
      const old = keys.slice(0, -1).find(key => value.runs[key]?.state === 'completed')
      if (old === undefined) throw new Error('协作记录超过存储限制；最新轮次或重试记录过大。')
      delete value.runs[old]
    }
    data = JSON.stringify(value)
  }
  return data
}

export async function openStore(config, sessionId) {
  const root = resolve(config.stateRoot)
  await directory(root)
  const key = digest([sessionId, authorizationKey(config)])
  async function read(scope) {
    const filename = join(root, `${key}.${checkedScope(scope)}.json`)
    let handle
    try {
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 33_554_432) throw new Error('Invalid collaboration history')
      const value = JSON.parse(await handle.readFile('utf8'))
      if (value.version !== 1 || !Array.isArray(value.turns)) throw new Error('Invalid collaboration history')
      return value
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, turns: [], runs: {} }
      throw error
    } finally { await handle?.close() }
  }
  async function write(scope, value) {
    const filename = join(root, `${key}.${checkedScope(scope)}.json`)
    const temporary = join(root, `${key}.${randomUUID()}.tmp`)
    const data = serializeHistory(value)
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, filename)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  return { root, read, write }
}

export async function withProjectLock(config, signal, fn) {
  const root = resolve(config.stateRoot)
  await directory(root)
  const lock = join(root, `${digest(resolve(config.projectRoot))}.lock`)
  const nonce = randomUUID()
  const ownerName = `${process.pid}.${nonce}.owner`
  const ownerPath = join(lock, ownerName)
  const removeEmptyLock = () => fs.rmdir(lock).catch(error => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  })
  const release = async () => {
    await fs.unlink(ownerPath).catch(error => { if (error.code !== 'ENOENT') throw error })
    await removeEmptyLock()
  }
  for (let tries = 0; ; tries++) {
    signal?.throwIfAborted()
    if (tries > 600) throw new Error('该项目仍有协作任务运行，请稍后重试。')
    let created = false
    try {
      await fs.mkdir(lock, { mode: 0o700 })
      created = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    try {
      const stat = await fs.lstat(lock)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe project lock')
      if (created) {
        let acquired = false
        try {
          await fs.writeFile(ownerPath, '', { flag: 'wx', mode: 0o600 })
          const owners = await fs.readdir(lock)
          acquired = owners.length === 1 && owners[0] === ownerName
        } finally {
          if (!acquired) await release()
        }
        if (acquired) break
      } else {
        const owners = await fs.readdir(lock)
        let removed = false
        for (const name of owners) {
          let pid = Number(/^(\d+)\.[0-9a-f-]{36}\.owner$/.exec(name)?.[1])
          if (name === 'owner.json') {
            let handle
            try {
              handle = await fs.open(join(lock, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
              const ownerStat = await handle.stat()
              if (!ownerStat.isFile() || ownerStat.nlink !== 1 || ownerStat.uid !== process.getuid() || (ownerStat.mode & 0o077) || ownerStat.size > 4096) throw new Error('Unsafe project lock owner')
              pid = JSON.parse(await handle.readFile('utf8'))?.pid
            } finally { await handle?.close() }
          }
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unknown project lock owner')
          try { process.kill(pid, 0) }
          catch (probe) {
            if (probe.code === 'ESRCH') {
              await fs.unlink(join(lock, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
              removed = true
            } else if (probe.code !== 'EPERM') throw probe
          }
        }
        if (removed || (owners.length === 0 && Date.now() - stat.mtimeMs > 30000)) {
          await removeEmptyLock()
          continue
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(100, undefined, { signal })
  }
  try { signal?.throwIfAborted(); return await fn() }
  finally { await release() }
}
