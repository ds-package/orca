import { readMcpServerTomlOwnership } from '../toml/config-toml-mcp-servers'
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { writeFileAtomicallyIfUnchanged } from '../../../filesystem/atomic-file-publication'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../homes/codex-home-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes,
  type CodexSettingsPromotionPlan
} from './config-settings-promotion'
import { readCodexSettingsBaseline } from './config-settings-baseline'
import { getCodexConfigSyncStatus, reportCodexConfigSyncOutcome } from './config-sync-stall'
import { preserveRuntimeConflictValues } from './codex-config-settings-preservation'
import {
  applyMeasuredRuntimeOwnedConfig,
  applyRuntimeOwnedConfig
} from './codex-config-runtime-owned-values'
import { codexDaemonSocketPathExceedsLimit } from '../shared-server/codex-daemon-socket-path-guard'
import {
  guardSystemConfigForRuntimeMerge,
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import { dropRevokedInheritedTrust, readTrustedProjectKeys } from './codex-config-forked-trust'

// Mirrored MCP environment tokens require owner-only writes.
const RUNTIME_CONFIG_WRITE = { mode: 0o600 } as const

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): boolean {
  const result = mirrorSystemConfigIntoManagedCodexHome(homes)
  if (!result.ran) {
    // Apply the daemon guard even on mirror stalls so long home paths can still launch Codex.
    ensureCodexDaemonSocketGuard(homes.runtimeHomePath)
  }
  return result.complete
}

/** A baseline failure prevents reuse without changing when the daemon guard is owed. */
function mirrorSystemConfigIntoManagedCodexHome(homes: CodexSettingsPromotionHomes): {
  ran: boolean
  complete: boolean
} {
  // Promote in-chat changes before mirroring ~/.codex or this pass would revert them.
  const promotionPlan = promoteCodexRuntimeSettingsToSystem(homes)
  if (!promotionPlan) {
    // Preserve runtime/baseline for retry; promotion failures must report stalls without clearing the latch.
    const stalledStatus = getCodexConfigSyncStatus(homes)
    if (stalledStatus.state === 'stalled') {
      reportCodexConfigSyncOutcome(homes.runtimeHomePath, stalledStatus)
    }
    return { ran: false, complete: false }
  }
  if (promotionPlan.forked) {
    return {
      ran: refreshForkedManagedConfig(homes, promotionPlan.inheritedTrustedProjects ?? new Set()),
      complete: true
    }
  }
  let mirrorResult: CodexConfigMirrorResult
  try {
    mirrorResult = syncSystemConfigIntoManagedCodexHomeUnsafe(homes, promotionPlan)
  } catch (error) {
    // Latch mirror failures too, so the user sees their cause without repeated generic logging.
    reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes), error)
    return { ran: false, complete: false }
  }
  if (mirrorResult.status === 'refused-indeterminate') {
    // Keep the baseline unchanged on indeterminate reads so unmirrored changes can retry.
    reportCodexConfigSyncOutcome(
      homes.runtimeHomePath,
      getCodexConfigSyncStatus(homes),
      mirrorResult.error
    )
    return { ran: false, complete: false }
  }
  if (mirrorResult.status === 'superseded') {
    // Keep the baseline: it must describe a config this pass published. The guard is still owed.
    return { ran: false, complete: false }
  }
  reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes))
  if (mirrorResult.status === 'skipped-missing-source') {
    // Bootstrap seeded homes only; advancing an existing baseline would strand unmirrored changes.
    if (!readCodexSettingsBaseline(homes.runtimeHomePath)) {
      return { ran: true, complete: snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath) }
    }
    return { ran: true, complete: true }
  }
  // Advance the baseline only after mirroring so unpromoted changes remain eligible for retry.
  const complete = snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath, {
    conflicts: new Map(
      [...promotionPlan.conflicts].filter(([key]) => mirrorResult.preservedConflictKeys.has(key))
    ),
    // Missing marketplace/plugin tables in later source configs now count as removals.
    mirroredRegistrations: true,
    mirroredMcpServers: mirrorResult.mirroredMcpServerNames,
    mirroredMcpServerRoot: mirrorResult.mirroredMcpServerRoot,
    publishedConfig: mirrorResult.publishedConfig,
    inheritedTrustedProjects: mirrorResult.inheritedTrustedProjects
  })
  return { ran: true, complete }
}

export function ensureCodexDaemonSocketGuard(runtimeHomePath: string): void {
  try {
    const observation = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
    if (observation.kind !== 'indeterminate') {
      writeCodexDaemonSocketGuard(
        runtimeHomePath,
        observation.kind === 'present' ? observation.value : null
      )
    }
  } catch (error) {
    console.warn('[codex-config] Failed to apply the Codex daemon socket guard:', error)
  }
}

/** The user owns a forked copy: only Orca's own lines and source project revocations change it. */
function refreshForkedManagedConfig(
  homes: CodexSettingsPromotionHomes,
  inheritedTrustedProjects: ReadonlySet<string>
): boolean {
  try {
    const runtime = observeAgentStateFile(join(homes.runtimeHomePath, 'config.toml'))
    const system = observeAgentStateFile(join(homes.systemHomePath, 'config.toml'))
    if (runtime.kind !== 'present' || system.kind === 'indeterminate') {
      return false
    }
    writeCodexDaemonSocketGuard(
      homes.runtimeHomePath,
      runtime.value,
      system.kind === 'present'
        ? dropRevokedInheritedTrust(runtime.value, system.value, inheritedTrustedProjects)
        : runtime.value
    )
    return true
  } catch (error) {
    console.warn('[codex-config] Failed to refresh a forked managed Codex config:', error)
    return false
  }
}

function writeCodexDaemonSocketGuard(
  runtimeHomePath: string,
  runtimeConfig: string | null,
  baseConfig = runtimeConfig ?? ''
): void {
  const guarded = applyRuntimeOwnedConfig(baseConfig, runtimeHomePath, runtimeConfig)
  if (guarded !== (runtimeConfig ?? '')) {
    writeFileAtomicallyIfUnchanged(
      join(runtimeHomePath, 'config.toml'),
      runtimeConfig,
      guarded,
      RUNTIME_CONFIG_WRITE
    )
  }
}

type CodexConfigMirrorResult =
  | { status: 'skipped-missing-source' }
  | { status: 'superseded' }
  | { status: 'refused-indeterminate'; error: unknown }
  | {
      status: 'mirrored'
      preservedConflictKeys: ReadonlySet<string>
      mirroredMcpServerNames: ReadonlySet<string>
      mirroredMcpServerRoot: boolean
      publishedConfig?: string
      inheritedTrustedProjects?: ReadonlySet<string>
    }

function syncSystemConfigIntoManagedCodexHomeUnsafe(
  homes: CodexSettingsPromotionHomes,
  promotionPlan: CodexSettingsPromotionPlan
): CodexConfigMirrorResult {
  const { runtimeHomePath, systemHomePath, systemConfigDir } = homes
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  // Distinguish unavailable paths from absent ones to avoid replacing an unreadable runtime as fresh.
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: systemConfigObservation.error }
  }
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: runtimeConfigObservation.error }
  }
  const runtimeConfigExists = runtimeConfigObservation.kind === 'present'
  const observedRuntimeConfig = runtimeConfigExists ? runtimeConfigObservation.value : null
  // A save since promotion read the file was never checked for user edits; the next pass will.
  if (
    promotionPlan.observedRuntimeConfig !== undefined &&
    promotionPlan.observedRuntimeConfig !== observedRuntimeConfig
  ) {
    return { status: 'superseded' }
  }
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  // Missing/blank cloud-synced configs may be unhydrated; preserve existing runtime settings.
  if (rawSystemConfig.trim() === '') {
    writeCodexDaemonSocketGuard(
      runtimeHomePath,
      runtimeConfigExists ? runtimeConfigObservation.value : null
    )
    return runtimeConfigExists
      ? { status: 'skipped-missing-source' }
      : {
          status: 'mirrored',
          preservedConflictKeys: new Set(),
          mirroredMcpServerNames: new Set(),
          mirroredMcpServerRoot: false
        }
  }

  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath, systemConfigDir)
  if (!runtimeConfigExists) {
    const freshRuntimeConfig = applyRuntimeOwnedConfig(
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir, runtimeHomePath),
      runtimeHomePath,
      null
    )
    const ownership = readMcpServerTomlOwnership(freshRuntimeConfig)
    if (
      !writeFileAtomicallyIfUnchanged(
        runtimeConfigPath,
        null,
        freshRuntimeConfig,
        RUNTIME_CONFIG_WRITE
      )
    ) {
      return { status: 'superseded' }
    }
    return {
      status: 'mirrored',
      preservedConflictKeys: new Set(),
      mirroredMcpServerNames: ownership.names,
      mirroredMcpServerRoot: ownership.ownsRoot,
      publishedConfig: freshRuntimeConfig,
      inheritedTrustedProjects: readTrustedProjectKeys(rawSystemConfig)
    }
  }

  const daemonGuarded = codexDaemonSocketPathExceedsLimit(runtimeHomePath)
  const systemConfig = guardSystemConfigForRuntimeMerge(
    prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir, runtimeHomePath),
    runtimeHomePath,
    daemonGuarded
  )
  const { names: mirroredMcpServerNames, ownsRoot: mirroredMcpServerRoot } =
    readMcpServerTomlOwnership(systemConfig)
  // Reuse the observed snapshot rather than mixing reads across path-state changes.
  const runtimeConfig = runtimeConfigObservation.value
  const preserved = preserveRuntimeConflictValues(
    mergeSystemCodexConfigIntoRuntime(
      runtimeConfig,
      systemConfig,
      sourceConfigDir,
      promotionPlan.mirroredMcpServers,
      promotionPlan.mirroredMcpServerRoot
    ),
    promotionPlan.runtimeValuesToPreserve
  )
  const nextRuntimeConfig = applyMeasuredRuntimeOwnedConfig(
    preserved.content,
    runtimeHomePath,
    runtimeConfig,
    daemonGuarded
  )
  // Why: hook passes on the trust worker write this file too; a save made since this read wins,
  // and the next pass merges again.
  if (
    nextRuntimeConfig !== runtimeConfig &&
    !writeFileAtomicallyIfUnchanged(
      runtimeConfigPath,
      runtimeConfig,
      nextRuntimeConfig,
      RUNTIME_CONFIG_WRITE
    )
  ) {
    return { status: 'superseded' }
  }
  return {
    status: 'mirrored',
    preservedConflictKeys: preserved.keys,
    mirroredMcpServerNames,
    mirroredMcpServerRoot,
    publishedConfig: nextRuntimeConfig,
    inheritedTrustedProjects: readTrustedProjectKeys(rawSystemConfig)
  }
}
