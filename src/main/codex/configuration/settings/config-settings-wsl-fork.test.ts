import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type * as WslPaths from '../../../../shared/file-access/wsl-paths'

const { homedirMock, forkTestState } = vi.hoisted(() => {
  const state: { wslPath: string | null; daemonGuard: boolean } = {
    wslPath: null,
    daemonGuard: false
  }
  return { homedirMock: vi.fn<() => string>(), forkTestState: state }
})

vi.mock('../shared-server/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexDaemonSocketPathExceedsLimit: () => forkTestState.daemonGuard
}))

vi.mock('../../../../shared/file-access/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof WslPaths>()
  return {
    ...actual,
    parseWslUncPath: (path: string) =>
      path === forkTestState.wslPath
        ? { distro: 'Ubuntu', linuxPath: '/home/u/.codex/config.toml' }
        : actual.parseWslUncPath(path)
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-fork-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-fork-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  forkTestState.wslPath = null
  forkTestState.daemonGuard = false
  if (homedir() !== tmpHome) {
    throw new Error('node:os homedir mock is not active; refusing to touch the real ~/.codex')
  }
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

const systemConfigPath = (): string => join(tmpHome, '.codex', 'config.toml')
const runtimeConfigPath = (): string =>
  join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const readRuntimeConfig = (): string => readFileSync(runtimeConfigPath(), 'utf-8')

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function simulateCodexSettingWrite(key: string, rawValue: string): void {
  mkdirSync(join(runtimeConfigPath(), '..'), { recursive: true })
  const existing = existsSync(runtimeConfigPath()) ? readRuntimeConfig() : ''
  const line = new RegExp(`^${key} = .*$`, 'm')
  const rendered = `${key} = ${rawValue}`
  writeFileSync(
    runtimeConfigPath(),
    line.test(existing) ? existing.replace(line, rendered) : `${rendered}\n${existing}`,
    'utf-8'
  )
}

describe('managed Codex config for a WSL guest config', () => {
  it('keeps refreshing an unedited managed copy from the guest config', () => {
    writeSystemConfig('model = "gpt-5"\n')
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig('model = "o5"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toBe('model = "o5"\n')
  })

  it('leaves an edited managed copy alone and never writes the guest config', () => {
    const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example"\n'
    writeSystemConfig(original)
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig('model = "o5"\napproval_policy = "never"\n')
    forkTestState.daemonGuard = true
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(
      'model = "o5"\napproval_policy = "never"\n'
    )
    expect(readRuntimeConfig()).toContain('model = "o4"')
    expect(readRuntimeConfig()).toContain('[mcp_servers.docs]')
    expect(readRuntimeConfig()).not.toContain('approval_policy')
    // Orca's own lines still follow the home.
    expect(readRuntimeConfig()).toMatch(/^daemon_auto_start = false # orca:/m)
  })

  it('keeps a managed change when the distro also changed that setting', () => {
    writeSystemConfig('model = "gpt-5"\n')
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    writeSystemConfig('model = "o5"\n')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "o4"')
  })

  it('keeps a managed edit of a value the distro wrote across several lines', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\nstatus_line = [\n  "model",\n]\n')
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      runtimeConfigPath(),
      readRuntimeConfig().replace(/status_line = \[[^\]]*\]/, 'status_line = ["cwd"]'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('status_line = ["cwd"]')
  })

  it('drops trust the distro withdrew from an edited copy, and never adds any', () => {
    writeSystemConfig(
      'model = "gpt-5"\n\n[projects."/home/u/a"]\ntrust_level = "trusted"\n\n[projects."/home/u/b"]\ntrust_level = "trusted"\n'
    )
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig(
      'model = "gpt-5"\n\n[projects."/home/u/a"]\ntrust_level = "untrusted"\n\n[projects."/home/u/c"]\ntrust_level = "trusted"\n'
    )
    syncSystemConfigIntoManagedCodexHome()

    const managed = parseToml(readRuntimeConfig())
    expect(managed.model).toBe('o4')
    expect(managed.projects).toBeUndefined()
  })

  it('drops withdrawn trust an edited copy inherited as an inline projects map', () => {
    writeSystemConfig(
      'model = "gpt-5"\nprojects = { "/home/u/a" = { trust_level = "trusted" }, "/home/u/b" = { trust_level = "trusted" } }\n'
    )
    forkTestState.wslPath = systemConfigPath()
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexSettingWrite('model', '"o4"')
    syncSystemConfigIntoManagedCodexHome()

    writeSystemConfig('model = "gpt-5"\n\n[projects."/home/u/b"]\ntrust_level = "trusted"\n')
    syncSystemConfigIntoManagedCodexHome()

    const managed = parseToml(readRuntimeConfig())
    expect(managed.model).toBe('o4')
    expect(managed.projects).toEqual({ '/home/u/b': { trust_level: 'trusted' } })
  })

  it.skipIf(process.platform === 'win32')(
    'never creates a config in a WSL guest through a linked ~/.codex folder',
    () => {
      const guestCodexDir = join(tmpHome, 'guest-codex')
      mkdirSync(guestCodexDir, { recursive: true })
      symlinkSync(guestCodexDir, join(tmpHome, '.codex'))
      forkTestState.wslPath = join(realpathSync(guestCodexDir), 'config.toml')
      simulateCodexSettingWrite('approval_policy', '"never"')
      syncSystemConfigIntoManagedCodexHome()

      simulateCodexSettingWrite('model', '"o4"')
      syncSystemConfigIntoManagedCodexHome()

      expect(existsSync(join(guestCodexDir, 'config.toml'))).toBe(false)
      expect(readRuntimeConfig()).toContain('model = "o4"')
    }
  )
})
