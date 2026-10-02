/**
 * 稳定指纹：基线内容哈希与备份去重哈希。
 * - 基线指纹随内容决定，两侧从同一版台账导出必然一致，供三向合并对照。
 * - 备份指纹忽略 exportedAt，重复导出同一版数据指纹相同，保证重试幂等。
 * 纯函数，不依赖 IndexedDB，便于单测与在合并引擎中复用。
 */
import type { BackupPayload } from '@/utils/db'

/** 递归按 key 排序后序列化，保证字段顺序不影响指纹 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue(source[key])
        return acc
      }, {})
  }
  return value
}

/** FNV-1a 32 位哈希，输出 base36（短且跨机器稳定） */
export function fnvHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 任意行集合的内容指纹（剥离 updatedAt/revision 等易变元数据后再哈希） */
export function fingerprintRows(rows: readonly unknown[]): string {
  const normalized = rows.map((row) => stripVolatile(row))
  return fnvHash(stableStringify(normalized))
}

const VOLATILE_FIELDS = new Set(['revision', 'updatedAt'])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.keys(source)
      .filter((key) => !VOLATILE_FIELDS.has(key))
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stripVolatile(source[key])
        return acc
      }, {})
  }
  return value
}

/** 基线快照指纹：仅由五类业务行内容决定 */
export function fingerprintBaseline(parts: {
  sections: readonly unknown[]
  rings: readonly unknown[]
  cracks: readonly unknown[]
  surveys: readonly unknown[]
  advices: readonly unknown[]
}): string {
  return fnvHash(
    stableStringify({
      sections: parts.sections.map(stripVolatile),
      rings: parts.rings.map(stripVolatile),
      cracks: parts.cracks.map(stripVolatile),
      surveys: parts.surveys.map(stripVolatile),
      advices: parts.advices.map(stripVolatile)
    })
  )
}

/**
 * 对侧备份指纹：包含业务行、墓碑、基线标识与结构版本，
 * 刻意不含 exportedAt，同一版数据重复导出仍判定为同一备份。
 */
export function fingerprintPayload(payload: BackupPayload): string {
  return fnvHash(
    stableStringify({
      app: payload.app,
      dbVersion: payload.dbVersion,
      baselineId: payload.baselineId ?? '',
      sections: (payload.sections ?? []).map(stripVolatile),
      rings: (payload.rings ?? []).map(stripVolatile),
      cracks: (payload.cracks ?? []).map(stripVolatile),
      surveys: (payload.surveys ?? []).map(stripVolatile),
      advices: (payload.advices ?? []).map(stripVolatile),
      tombstones: (payload.tombstones ?? []).map(stripVolatile)
    })
  )
}

/** 由长指纹派生并列复制行 id 用的短令牌 */
export function shortToken(fingerprint: string): string {
  return fingerprint.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase() || 'merge'
}
