import { createHash } from 'node:crypto'
import {
  getTomlSections,
  isRuntimePreservedTomlSection,
  joinTomlBlocks
} from '../toml/config-toml-runtime-owned-sections'
import { stripCodexDaemonOverride } from '../shared-server/codex-daemon-socket-path-guard'
import { stripCodexSharedSqliteHome } from '../toml/config-toml-shared-sqlite-home'
import type { TopLevelSettingValue } from '../toml/config-toml-promoted-setting-values'
import { writeCodexSettingsBaseline, type CodexSettingsBaseline } from './config-settings-baseline'
import type { CodexSettingsPromotionPlan } from './config-settings-promotion'

/** The user's part of a managed config: everything but trust, Codex bookkeeping and Orca's own lines. */
export function digestCodexUserOwnedConfig(config: string): string {
  const stripped = stripCodexSharedSqliteHome(stripCodexDaemonOverride(config))
  const sections = getTomlSections(stripped)
  const preamble =
    sections.length === 0 ? stripped : stripped.split('\n').slice(0, sections[0]?.start).join('\n')
  const userOwned = joinTomlBlocks([
    preamble,
    ...sections.filter((section) => !isRuntimePreservedTomlSection(section)).map((s) => s.block)
  ])
  return createHash('sha256').update(userOwned).digest('hex')
}

/** Orca can't write a WSL guest's config back, so a user edit makes the managed copy the user's own. */
export function forkManagedConfig(
  runtimeHomePath: string,
  baseline: CodexSettingsBaseline | null
): CodexSettingsPromotionPlan {
  const forked: CodexSettingsBaseline = {
    settings: baseline?.settings ?? new Map(),
    conflicts: baseline?.conflicts ?? new Map(),
    // Kept so an older build reading this baseline still sees what was mirrored.
    registrations: baseline?.registrations ?? new Map(),
    mcpServers: baseline?.mcpServers ?? new Set(),
    mcpServerRoot: baseline?.mcpServerRoot ?? false,
    userConfigDigest: baseline?.userConfigDigest,
    inheritedTrustedProjects: baseline?.inheritedTrustedProjects,
    forked: true
  }
  writeCodexSettingsBaseline(runtimeHomePath, forked)
  return forkedPromotionPlan(forked)
}

export function forkedPromotionPlan(baseline: CodexSettingsBaseline): CodexSettingsPromotionPlan {
  return {
    conflicts: new Map(),
    runtimeValuesToPreserve: new Map(),
    mirroredMcpServers: new Set(),
    mirroredMcpServerRoot: false,
    forked: true,
    inheritedTrustedProjects: baseline.inheritedTrustedProjects ?? new Set()
  }
}

export function getComparableRaw(
  value: TopLevelSettingValue | undefined
): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}
