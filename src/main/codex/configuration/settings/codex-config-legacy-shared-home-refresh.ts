import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import {
  recoverInterruptedGuardedFileOperation,
  writeFileAtomicallyIfUnchanged
} from '../../../filesystem/atomic-file-publication'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import type { CodexSettingsPromotionHomes } from './config-settings-promotion'
import { observeCodexSettingsBaseline } from './config-settings-baseline'
import { applyMeasuredRuntimeOwnedConfig } from './codex-config-runtime-owned-values'
import { codexDaemonSocketPathExceedsLimit } from '../shared-server/codex-daemon-socket-path-guard'
import {
  guardSystemConfigForRuntimeMerge,
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import { dropRevokedInheritedTrust } from './codex-config-forked-trust'

// Mirrored MCP environment tokens require owner-only writes.
const RUNTIME_CONFIG_WRITE = { mode: 0o600 } as const

/** One-way refresh for retained PTYs; promoting stale settings from this retired home could overwrite live config. */
export function syncSystemConfigIntoLegacySharedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  const systemConfigPath = join(homes.systemHomePath, 'config.toml')
  const runtimeConfigPath = join(homes.runtimeHomePath, 'config.toml')
  recoverInterruptedGuardedFileOperation(runtimeConfigPath)
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    throw systemConfigObservation.error
  }
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    throw runtimeConfigObservation.error
  }
  const runtimeConfigBeforeMirror =
    runtimeConfigObservation.kind === 'present' ? runtimeConfigObservation.value : null
  const daemonGuarded = codexDaemonSocketPathExceedsLimit(homes.runtimeHomePath)
  // A missing cloud-synced source does not prove the user cleared config.
  let mirroredRuntimeConfig = runtimeConfigBeforeMirror ?? ''
  const legacyOwnership =
    rawSystemConfig.trim() !== '' && runtimeConfigBeforeMirror !== null
      ? readLegacySharedHomeOwnership(homes.runtimeHomePath)
      : null
  if (legacyOwnership?.forked && runtimeConfigBeforeMirror !== null) {
    mirroredRuntimeConfig = dropRevokedInheritedTrust(
      runtimeConfigBeforeMirror,
      rawSystemConfig,
      legacyOwnership.inheritedTrustedProjects
    )
  } else if (rawSystemConfig.trim() !== '') {
    const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(homes.systemHomePath)
    mirroredRuntimeConfig =
      runtimeConfigBeforeMirror !== null && legacyOwnership
        ? mergeSystemCodexConfigIntoRuntime(
            runtimeConfigBeforeMirror,
            guardSystemConfigForRuntimeMerge(
              prepareSystemConfigForRuntimeMirror(
                rawSystemConfig,
                sourceConfigDir,
                homes.runtimeHomePath
              ),
              homes.runtimeHomePath,
              daemonGuarded
            ),
            sourceConfigDir,
            legacyOwnership.mcpServers,
            legacyOwnership.mcpServerRoot
          )
        : prepareSystemConfigForFreshRuntimeMirror(
            rawSystemConfig,
            sourceConfigDir,
            homes.runtimeHomePath
          )
  }
  const nextRuntimeConfig = applyMeasuredRuntimeOwnedConfig(
    mirroredRuntimeConfig,
    homes.runtimeHomePath,
    runtimeConfigBeforeMirror,
    daemonGuarded
  )
  if ((runtimeConfigBeforeMirror ?? '') === nextRuntimeConfig) {
    return
  }
  // Compare before replacement so concurrent trust writes from retained Codex processes win.
  writeFileAtomicallyIfUnchanged(
    runtimeConfigPath,
    runtimeConfigBeforeMirror,
    nextRuntimeConfig,
    RUNTIME_CONFIG_WRITE
  )
}

// The last baseline identifies system-owned MCP servers; never advance it during this one-way refresh.
function readLegacySharedHomeOwnership(runtimeHomePath: string): {
  mcpServers: ReadonlySet<string>
  mcpServerRoot: boolean
  forked: boolean
  inheritedTrustedProjects: ReadonlySet<string>
} {
  const observation = observeCodexSettingsBaseline(runtimeHomePath)
  if (observation.kind === 'indeterminate') {
    throw new Error('Codex settings baseline could not be read')
  }
  return observation.kind === 'present'
    ? {
        mcpServers: observation.baseline.mcpServers,
        mcpServerRoot: observation.baseline.mcpServerRoot,
        forked: observation.baseline.forked === true,
        inheritedTrustedProjects: observation.baseline.inheritedTrustedProjects ?? new Set()
      }
    : {
        mcpServers: new Set(),
        mcpServerRoot: true,
        forked: false,
        inheritedTrustedProjects: new Set()
      }
}
