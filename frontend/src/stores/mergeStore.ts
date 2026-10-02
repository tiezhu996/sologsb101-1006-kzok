/**
 * 离线合并状态（Pinia）
 * - 导出基线写入 localStorage，供三向比对取共同祖先
 * - 合并会话（含两侧快照与比对条目）暂存到 localStorage，中断后可恢复现场
 * - 同一备份 sha256 已合并则拒绝重复入库，重试不会多记一条
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  BASELINE_APP,
  BASELINE_LS_KEY,
  CREW_NAME_LS_KEY,
  DUPLICATE_GROUPS_LS_KEY,
  MERGED_HASHES_LS_KEY,
  MERGE_SESSION_LS_KEY,
  type MergeBaseline
} from '@/types/baseline'
import type { BackupPayload } from '@/utils/db'
import type { EntityRowsByTable, MergeEntry, MergeResolutionType, MergeSession, MergeStats } from '@/types/merge'
import { buildMergeEntries, emptyRows, normalizePayload } from '@/utils/mergeUtil'
import { commitMergeEntries, loadAllRows } from '@/utils/mergeEngine'
import { sha256Text } from '@/utils/mergeHash'

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    // 快照较大时 localStorage 可能超限：提示但不中断合并本身
    console.warn('合并暂存写入失败（可能是本地存储已满）', err)
  }
}

export interface PreparedMerge {
  session: MergeSession
  /** 是否缺少导出基线（按「双方新增」兜底合并） */
  missingBaseline: boolean
}

export const useMergeStore = defineStore('merge', () => {
  const crewName = ref<string>(localStorage.getItem(CREW_NAME_LS_KEY) ?? '')
  const baseline = ref<MergeBaseline | null>(readJson<MergeBaseline>(BASELINE_LS_KEY))
  const session = ref<MergeSession | null>(readJson<MergeSession>(MERGE_SESSION_LS_KEY))

  const mergedHashes = ref<string[]>(readJson<string[]>(MERGED_HASHES_LS_KEY) ?? [])

  const hasOpenSession = computed(() => session.value?.status === 'open')

  const sessionStats = computed<MergeStats>(() => {
    const entries = session.value?.entries ?? []
    const auto = entries.filter((entry) => entry.resolution.type === 'auto').length
    const conflicts = entries.filter((entry) => entry.status === 'conflicted').length
    const resolved = entries.filter(
      (entry) =>
        entry.status === 'conflicted' &&
        entry.resolution.type !== 'skip' &&
        entry.resolution.decidedAt !== null
    ).length
    const pending = conflicts - resolved
    const committed = session.value?.committedEntryIds.length ?? 0
    return { total: entries.length, auto, conflicts, resolved, pending, committed }
  })

  function setCrewName(name: string): void {
    crewName.value = name.trim()
    localStorage.setItem(CREW_NAME_LS_KEY, crewName.value)
  }

  /* ------------------------------ 基线 ------------------------------ */

  /** 导出备份后调用：把该快照存为共同祖先基线 */
  async function saveBaselineFromPayload(payload: BackupPayload, hash?: string): Promise<void> {
    const finalHash = hash ?? (await sha256Text(JSON.stringify(payload)))
    const record: MergeBaseline = {
      app: BASELINE_APP,
      hash: finalHash,
      exportedAt: payload.exportedAt,
      dbVersion: payload.dbVersion,
      exportedBy: payload.exportedBy ?? crewName.value,
      rows: normalizePayload(payload)
    }
    baseline.value = record
    writeJson(BASELINE_LS_KEY, record)
  }

  function clearBaseline(): void {
    baseline.value = null
    localStorage.removeItem(BASELINE_LS_KEY)
  }

  /* ---------------------------- 备份去重 ---------------------------- */

  function hasMergedHash(hash: string): boolean {
    return mergedHashes.value.includes(hash)
  }

  /* ---------------------------- 会话准备 ---------------------------- */

  /**
   * 读入对端备份并生成三向比对会话。
   * 已合并过的同一备份直接拒绝；存在同 hash 的未完成会话则交回调用方恢复。
   */
  async function prepareMerge(payload: BackupPayload, hash: string): Promise<PreparedMerge> {
    const open = session.value
    if (open?.status === 'open' && open.backupHash === hash) {
      return { session: open, missingBaseline: false }
    }
    if (mergedHashes.value.includes(hash)) {
      throw new Error('这份备份已经合并入库，重复导入不会再多记一条。')
    }

    const incoming = normalizePayload(payload)
    const localSnapshot = await loadAllRows()
    // 基线优先用本机导出基线；无基线时（旧流程/清过浏览器）按空祖先兜底
    const baselineRows: EntityRowsByTable = baseline.value?.rows ?? emptyRows()
    const missingBaseline = baseline.value === null
    const entries = buildMergeEntries(baselineRows, localSnapshot, incoming, missingBaseline)

    const record: MergeSession = {
      backupHash: hash,
      backupExportedAt: payload.exportedAt,
      backupExportedBy: payload.exportedBy ?? '',
      backupDbVersion: payload.dbVersion ?? 0,
      incomingCounts: {
        sections: incoming.sections.length,
        rings: incoming.rings.length,
        cracks: incoming.cracks.length,
        surveys: incoming.surveys.length,
        advices: incoming.advices.length,
        tombstones: incoming.tombstones.length
      },
      missingBaseline,
      baseline: baselineRows,
      localSnapshot,
      incoming,
      entries,
      committedEntryIds: [],
      duplicateIds: {},
      status: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    session.value = record
    persistSession()
    return { session: record, missingBaseline }
  }

  /** 刷新进入页面时恢复上次中断的暂存会话 */
  function resumeSession(): MergeSession | null {
    const current = readJson<MergeSession>(MERGE_SESSION_LS_KEY)
    if (current && current.status === 'open') session.value = current
    return session.value
  }

  function persistSession(): void {
    if (session.value) writeJson(MERGE_SESSION_LS_KEY, session.value)
  }

  function entryById(entryId: string): MergeEntry | null {
    return session.value?.entries.find((entry) => entry.id === entryId) ?? null
  }

  /** 核验人对一条冲突作出处理 */
  function resolveEntry(entryId: string, type: MergeResolutionType, note?: string): void {
    const current = session.value
    if (!current) return
    const entry = current.entries.find((item) => item.id === entryId)
    if (!entry || entry.status !== 'conflicted') return
    entry.resolution = {
      type,
      decidedBy: crewName.value || '核验人',
      decidedAt: Date.now(),
      note
    }
    current.updatedAt = Date.now()
    persistSession()
  }

  /** 把冲突恢复为未处理（keep-both 支持表的默认决定） */
  function resetEntry(entryId: string): void {
    const current = session.value
    if (!current) return
    const entry = current.entries.find((item) => item.id === entryId)
    if (!entry || entry.status !== 'conflicted') return
    entry.resolution = {
      type: ['cracks', 'rings', 'surveys'].includes(entry.table) ? 'keep-both' : 'skip',
      decidedBy: '',
      decidedAt: null
    }
    current.updatedAt = Date.now()
    persistSession()
  }

  /* ------------------------------ 提交 ------------------------------ */

  /**
   * 把自动条目与核验已决条目一起入库；仍挂起（skip）的条目留在暂存会话，
   * 下次继续。全部条目入库后关闭会话并记录备份 hash（重试去重）。
   */
  async function commitResolved(): Promise<{ committed: number; remaining: number; duplicateGroups: number }> {
    const current = session.value
    if (!current) return { committed: 0, remaining: 0, duplicateGroups: 0 }
    const before = current.committedEntryIds.length
    const result = await commitMergeEntries(current, current.entries, crewName.value || '核验人')
    current.committedEntryIds = Array.from(new Set([...current.committedEntryIds, ...result.committedIds]))
    current.duplicateIds = result.duplicates
    current.updatedAt = Date.now()

    const remaining = current.entries.filter((entry) => !current.committedEntryIds.includes(entry.id)).length
    let duplicateGroups = 0
    if (remaining === 0) {
      current.status = 'committed'
      if (!mergedHashes.value.includes(current.backupHash)) {
        mergedHashes.value = [...mergedHashes.value, current.backupHash]
        writeJson(MERGED_HASHES_LS_KEY, mergedHashes.value)
      }
      duplicateGroups = await persistDuplicateGroups(current)
      localStorage.removeItem(MERGE_SESSION_LS_KEY)
      session.value = null
    } else {
      persistSession()
    }
    return { committed: current.committedEntryIds.length - before, remaining, duplicateGroups }
  }

  /** 并列副本归组信息写入 localStorage，备份页「并列保留」面板展示 */
  async function persistDuplicateGroups(closed: MergeSession): Promise<number> {
    const groups = readJson<Record<string, { label: string; table: string; crew: string; at: number }>>(
      DUPLICATE_GROUPS_LS_KEY
    ) ?? {}
    Object.entries(closed.duplicateIds).forEach(([entryId, ids]) => {
      const entry = closed.entries.find((item) => item.id === entryId)
      if (!entry) return
      const groupId = `dup_${entry.table}_${(entry.baseRow ?? entry.localRow ?? entry.incomingRow)?.id ?? ''}`
      groups[groupId] = {
        label: entry.label,
        table: entry.table,
        crew: closed.backupExportedBy,
        at: Date.now()
      }
      groups[ids.localId] = groups[groupId]
      groups[ids.incomingId] = groups[groupId]
    })
    writeJson(DUPLICATE_GROUPS_LS_KEY, groups)
    return Object.keys(closed.duplicateIds).length
  }

  function discardSession(): void {
    session.value = null
    localStorage.removeItem(MERGE_SESSION_LS_KEY)
  }

  return {
    crewName,
    baseline,
    session,
    mergedHashes,
    hasOpenSession,
    sessionStats,
    setCrewName,
    saveBaselineFromPayload,
    clearBaseline,
    hasMergedHash,
    prepareMerge,
    resumeSession,
    entryById,
    resolveEntry,
    resetEntry,
    commitResolved,
    discardSession
  }
})
