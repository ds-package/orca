import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  getProjectTrustLevel,
  getRevocationTomlSectionHeaderKey,
  getTomlSections,
  isRuntimeProjectTomlSection,
  joinTomlBlocks
} from '../toml/config-toml-runtime-owned-sections'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../toml/config-toml-line-scan'
import { parseTomlKeyPath } from '../toml/config-toml-key-path'
import { normalizeCodexTrustProjectRevocationPath } from '../../trust/identity/codex-trust-identity'

type ProjectLines = { start: number; end: number }

/** Revocation keys of projects a config trusts, as tables or as top-level `projects` keys. */
export function readTrustedProjectKeys(config: string): Set<string> {
  const keys = new Set<string>()
  for (const section of getTomlSections(config)) {
    if (isRuntimeProjectTomlSection(section) && getProjectTrustLevel(section.block) === 'trusted') {
      keys.add(getRevocationTomlSectionHeaderKey(section))
    }
  }
  const lines = config.split('\n')
  for (const range of findTopLevelProjectLines(lines)) {
    for (const [key, , entry] of readProjectEntries(lines, range) ?? []) {
      if (entry.trust_level === 'trusted') {
        keys.add(key)
      }
    }
  }
  return keys
}

/**
 * One-way: a project the source trusted at the last mirror and no longer trusts loses its trust in
 * a managed copy the user owns. Nothing is added and nothing else is copied.
 */
export function dropRevokedInheritedTrust(
  runtimeConfig: string,
  systemConfig: string,
  inherited: ReadonlySet<string>
): string {
  if (inherited.size === 0 || systemConfig.trim() === '') {
    return runtimeConfig
  }
  const systemTrusted = readTrustedProjectKeys(systemConfig)
  const revoked = new Set([...inherited].filter((key) => !systemTrusted.has(key)))
  if (revoked.size === 0) {
    return runtimeConfig
  }
  const lines = runtimeConfig.split('\n')
  const appended: string[] = []
  // Bottom-up so earlier line indexes stay valid after each splice.
  for (const range of findTopLevelProjectLines(lines).toReversed()) {
    const entries = readProjectEntries(lines, range)
    if (!entries?.some(([key, , entry]) => revoked.has(key) && entry.trust_level === 'trusted')) {
      continue
    }
    const projects: Record<string, Record<string, unknown>> = {}
    for (const [key, path, entry] of entries) {
      const { trust_level: trustLevel, ...rest } = entry
      const withdrawn = revoked.has(key) && trustLevel === 'trusted'
      // Only an entry emptied by this revocation goes; other entries stay as written.
      if (!withdrawn || Object.keys(rest).length > 0) {
        projects[path] = withdrawn ? rest : entry
      }
    }
    lines.splice(range.start, range.end - range.start)
    if (Object.keys(projects).length > 0) {
      appended.push(stringifyToml({ projects }))
    }
  }
  const withoutInline = lines.join('\n')
  const tableLines = withoutInline.split('\n')
  for (const section of getTomlSections(withoutInline).toReversed()) {
    if (
      !isRuntimeProjectTomlSection(section) ||
      getProjectTrustLevel(section.block) !== 'trusted' ||
      !revoked.has(getRevocationTomlSectionHeaderKey(section))
    ) {
      continue
    }
    const [header = '', ...body] = section.block.split('\n')
    const keptBody = withoutTrustLevelAssignments(body)
    const empty = keptBody.every((line) => line.trim() === '' || line.trim().startsWith('#'))
    tableLines.splice(
      section.start,
      section.block.split('\n').length,
      ...(empty ? [] : [header, ...keptBody])
    )
  }
  const next = joinTrustEdits(tableLines.join('\n'), appended)
  return next === runtimeConfig ? runtimeConfig : next
}

/** Drops `trust_level` keys (bare or quoted) but never a line inside a multiline value. */
function withoutTrustLevelAssignments(body: readonly string[]): string[] {
  const kept: string[] = []
  let state = createTomlLineScanState()
  for (const line of body) {
    const structural = isTomlStructuralLine(state)
    state = updateTomlLineScanState(state, line)
    const parsed = structural ? parseTomlKeyPath(line) : null
    const isTrustLevel =
      parsed !== null &&
      line[parsed.end] === '=' &&
      parsed.segments.length === 1 &&
      parsed.segments[0] === 'trust_level'
    if (!isTrustLevel) {
      kept.push(line)
    }
  }
  return kept
}

function joinTrustEdits(config: string, appended: readonly string[]): string {
  return appended.length === 0 ? config : joinTomlBlocks([config, ...appended])
}

/** Top-level `projects…` assignments, quoted or dotted, skipping text inside multiline strings. */
function findTopLevelProjectLines(lines: readonly string[]): ProjectLines[] {
  const ranges: ProjectLines[] = []
  let state = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const structural = isTomlStructuralLine(state)
    state = updateTomlLineScanState(state, line)
    if (structural && line.trimStart().startsWith('[')) {
      break
    }
    const parsed = structural ? parseTomlKeyPath(line) : null
    if (!parsed || line[parsed.end] !== '=' || parsed.segments[0] !== 'projects') {
      continue
    }
    let end = index + 1
    while (end < lines.length && !isTomlStructuralLine(state)) {
      state = updateTomlLineScanState(state, lines[end] ?? '')
      end += 1
    }
    ranges.push({ start: index, end })
    index = end - 1
  }
  return ranges
}

function readProjectEntries(
  lines: readonly string[],
  range: ProjectLines
): [key: string, path: string, entry: Record<string, unknown>][] | null {
  let parsed: unknown
  try {
    parsed = parseToml(lines.slice(range.start, range.end).join('\n')).projects
  } catch {
    return null
  }
  if (!isPlainRecord(parsed)) {
    return null
  }
  const entries: [string, string, Record<string, unknown>][] = []
  for (const [path, value] of Object.entries(parsed)) {
    if (isPlainRecord(value)) {
      entries.push([`project:${normalizeCodexTrustProjectRevocationPath(path)}`, path, value])
    }
  }
  return entries
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}
