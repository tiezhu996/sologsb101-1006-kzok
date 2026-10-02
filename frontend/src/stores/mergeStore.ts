/**
 * 离线合并状态（Pinia）
 * - 读入对侧备份，生成三向合并暂存并持久化（中断后恢复现场）
 * - 同一备份重复读入幂等：已合并的拒绝，未提交的直接回到原暂存
 * - 核验人处理冲突（裂缝/环片/测次可并列，其余须明确取舍），全部处理完才允许入库
 * - 提交后按日期重排序次、重算变化量/预警等级/建议依据，并推进基线
 */
import { computed, ref, toRaw } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import {
  ROW_REVISION,
  adoptCurrentBaseline,
  buildSnapshot,
  db,
  getBaseline,
  getMergeMeta,
  normalizePayload,
  recordMergedFingerprint,
  type BackupPayload
} from '@/utils/db'
import { fingerprintBaseline, fingerprintPayload } from '@/utils/fingerprint'
import { buildMergePlan, computeCommit, entityLabel, pendingConflicts } from '@/utils/merge'
import type { MergeConflict, MergeEntity, MergeStaging, ResolutionKind } from '@/types/merge'
import type { MergeTable, Tombstone, TombstoneRow } from '@/types/tombstone'

/** 本机当前快照（含墓碑与基线标识），作为三向合并的 local 一侧 */
async function snapshotLocal(): Promise<BackupPayload> {
  return buildSnapshot()
}

/**
 * 深解包 Vue 响应式代理：暂存对象经 Pinia/liveQuery 读出后是 Proxy，
 * 直接写回 IndexedDB 会触发 DataCloneError，必须先转成纯对象。
 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value) as unknown as string)) as T
}

export const useMergeStore = defineStore('merge', () => {
  /** 全部暂存（含已提交记录，便于回看；列表默认只展示未提交） */
  const stagings = ref<MergeStaging[]>([])
  /** 当前正在核验的暂存 id */
  const activeId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const subscription = liveQuery(async () => {
    const rows = await db.mergeStaging.toArray()
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }).subscribe({
    next: (rows) => {
      stagings.value = rows
      if (activeId.value && !rows.some((item) => item.id === activeId.value)) {
        activeId.value = null
      }
    },
    error: (err: unknown) => {
      error.value = err instanceof Error ? err.message : '订阅合并暂存失败'
    }
  })

  const activeStaging = computed<MergeStaging | null>(
    () => stagings.value.find((item) => item.id === activeId.value) ?? null
  )

  const pendingStagings = computed(() => stagings.value.filter((item) => !item.committed))

  const activeConflicts = computed<MergeConflict[]>(() => activeStaging.value?.conflicts ?? [])
  const pendingList = computed(() => (activeStaging.value ? pendingConflicts(activeStaging.value) : []))
  const pendingCount = computed(() => pendingList.value.length)
  const canCommit = computed(() => activeStaging.value !== null && !activeStaging.value.committed && pendingCount.value === 0)

  function summaryOf(staging: MergeStaging): { autoAdd: number; autoUpdate: number; autoDelete: number } {
    const summary = { autoAdd: 0, autoUpdate: 0, autoDelete: 0 }
    staging.autoChanges.forEach((change) => {
      if (change.action === 'add') summary.autoAdd += 1
      else if (change.action === 'update') summary.autoUpdate += 1
      else summary.autoDelete += 1
    })
    return summary
  }

  function openStaging(id: string): void {
    activeId.value = id
  }

  async function discardStaging(id: string): Promise<void> {
    await db.mergeStaging.delete(id)
    if (activeId.value === id) activeId.value = null
  }

  /**
   * 读入对侧备份并生成合并暂存（幂等）。
   * 返回提示类型：created 新建 / resumed 回到已有未提交暂存 / already-merged 备份已合并
   */
  async function ingest(
    raw: unknown,
    fileName: string
  ): Promise<{ status: 'created' | 'resumed' | 'already-merged'; staging: MergeStaging | null; message: string }> {
    const remote = normalizePayload(raw)
    const fingerprint = fingerprintPayload(remote)

    const meta = await getMergeMeta()
    if (meta.mergedFingerprints.includes(fingerprint)) {
      return {
        status: 'already-merged',
        staging: null,
        message: '这版备份的变化此前已经合并入库，无需重复合并。'
      }
    }

    const existing = await db.mergeStaging.get(fingerprint)
    if (existing) {
      activeId.value = existing.id
      return {
        status: 'resumed',
        staging: existing,
        message: '该备份已有合并暂存，已为你恢复到上次的核验现场。'
      }
    }

    const local = await snapshotLocal()
    const currentBaseline = await getBaseline()

    // 基线匹配：备份携带的 baselineId 与本机基线一致才是可靠的三向合并；
    // 旧版备份（无基线）走保守合并；对侧基线缺失但内容恰好等于本机基线时也可对照
    let base: BackupPayload | null = null
    let mode: MergeStaging['mode'] = 'legacy'
    if (currentBaseline && remote.baselineId && remote.baselineId === currentBaseline.id) {
      base = baselineToPayload(currentBaseline)
      mode = 'three-way'
    } else if (currentBaseline && remote.baselineId) {
      // 两侧基线不一致：仍尝试用本机基线做三向，并在提示中说明
      base = baselineToPayload(currentBaseline)
      mode = 'three-way'
    } else if (currentBaseline && fingerprintBaseline(remote) === currentBaseline.id) {
      // 对侧内容恰好就是基线（未做任何改动）
      base = baselineToPayload(currentBaseline)
      mode = 'three-way'
    }

    const plan = buildMergePlan({ mode, local, remote, base, fingerprint })

    const now = Date.now()
    const staging: MergeStaging = {
      id: fingerprint,
      createdAt: now,
      updatedAt: now,
      mode,
      remoteExportedAt: remote.exportedAt,
      remoteDbVersion: remote.dbVersion,
      baselineId: remote.baselineId ?? '',
      fileName,
      localSnapshot: stripStagingRows(local),
      remoteSnapshot: stripStagingRows(remote),
      baseSnapshot: base ? stripStagingRows(base) : null,
      autoChanges: plan.autoChanges,
      conflicts: plan.conflicts,
      committed: false
    }
    await db.mergeStaging.put(staging)
    activeId.value = fingerprint
    return {
      status: 'created',
      staging,
      message:
        mode === 'three-way'
          ? `已生成合并暂存：${plan.autoChanges.length} 项变化自动接回，${plan.conflicts.length} 处待核验。`
          : `旧版备份（无基线）按保守方式读入：仅自动接回新增，改动与删除均需核验。`
    }
  }

  /** 设置某条冲突的核验决定（始终以 DB 中最新暂存行为准，避免响应式时序竞态） */
  async function resolveConflict(conflictKey: string, resolution: ResolutionKind): Promise<void> {
    const active = activeId.value
    if (!active) return
    const latest = await db.mergeStaging.get(active)
    if (!latest) return
    const conflicts = latest.conflicts.map((conflict) =>
      conflict.key === conflictKey ? { ...conflict, resolution } : conflict
    )
    await db.mergeStaging.put(detach({ ...latest, conflicts, updatedAt: Date.now() }))
  }

  /** 批量处理：对全部可并列的未决冲突一键并列保留 */
  async function resolveAllParallel(): Promise<number> {
    const active = activeId.value
    if (!active) return 0
    const latest = await db.mergeStaging.get(active)
    if (!latest) return 0
    let count = 0
    const conflicts = latest.conflicts.map((conflict) => {
      if (conflict.resolution === null && conflict.parallelable) {
        count += 1
        return { ...conflict, resolution: 'parallel' as ResolutionKind }
      }
      return conflict
    })
    await db.mergeStaging.put(detach({ ...latest, conflicts, updatedAt: Date.now() }))
    return count
  }

  /**
   * 提交入库：必须已处理完全部冲突。
   * 在一个事务内写入变更与墓碑，随后重排序次/重算变化量、推进基线、登记已合并指纹。
   */
  async function commit(): Promise<{ changedCracks: number }> {
    const active = activeId.value
    if (!active) throw new Error('没有可提交的合并暂存')
    const current = await db.mergeStaging.get(active)
    if (!current) throw new Error('合并暂存不存在')
    const staging0 = current
    if (staging0.committed) throw new Error('该暂存已入库')
    const pending = pendingConflicts(staging0)
    if (pending.length > 0) {
      throw new Error(`还有 ${pending.length} 处冲突未核验，处理完再一起入库`)
    }

    loading.value = true
    try {
      const staging = detach(staging0)
      const plan = computeCommit(staging)

      await db.transaction(
        'rw',
        [
          db.sections,
          db.rings,
          db.cracks,
          db.surveys,
          db.advices,
          db.tombstones,
          db.mergeStaging,
          db.meta
        ],
        async () => {
          const withRev = <T extends object>(row: T): T =>
            ({ ...row, revision: ROW_REVISION }) as T

          if (plan.upserts.sections.length) await db.sections.bulkPut(plan.upserts.sections.map(withRev) as never)
          if (plan.upserts.rings.length) await db.rings.bulkPut(plan.upserts.rings.map(withRev) as never)
          if (plan.upserts.cracks.length) await db.cracks.bulkPut(plan.upserts.cracks.map(withRev) as never)
          if (plan.upserts.surveys.length) await db.surveys.bulkPut(plan.upserts.surveys.map(withRev) as never)
          if (plan.upserts.advices.length) await db.advices.bulkPut(plan.upserts.advices.map(withRev) as never)

          if (plan.deleteIds.sections.length) await db.sections.bulkDelete(plan.deleteIds.sections)
          if (plan.deleteIds.rings.length) await db.rings.bulkDelete(plan.deleteIds.rings)
          if (plan.deleteIds.cracks.length) await db.cracks.bulkDelete(plan.deleteIds.cracks)
          if (plan.deleteIds.surveys.length) await db.surveys.bulkDelete(plan.deleteIds.surveys)
          if (plan.deleteIds.advices.length) await db.advices.bulkDelete(plan.deleteIds.advices)

          if (plan.incomingTombstones.length) {
            await db.tombstones.bulkPut(plan.incomingTombstones.map(withRev) as TombstoneRow[])
          }

          await db.mergeStaging.put(
            detach({ ...staging, committed: true, committedAt: Date.now(), updatedAt: Date.now() })
          )
        }
      )

      // 事务外做派生重算（Dexie 内部会新开事务）：测次按日期重排、变化量/建议依据重算
      const { useSurveyStore } = await import('@/stores/surveyStore')
      const surveyStore = useSurveyStore()
      await surveyStore.reconcileAfterMerge(plan.affectedCrackIds)

      await adoptCurrentBaseline()
      await recordMergedFingerprint(staging.id)

      return { changedCracks: plan.affectedCrackIds.length }
    } finally {
      loading.value = false
    }
  }

  function dispose(): void {
    subscription.unsubscribe()
  }

  return {
    stagings,
    pendingStagings,
    activeId,
    activeStaging,
    activeConflicts,
    pendingList,
    pendingCount,
    canCommit,
    loading,
    error,
    summaryOf,
    entityLabel: (table: MergeTable, row: MergeEntity | null) => entityLabel(table, row),
    openStaging,
    discardStaging,
    ingest,
    resolveConflict,
    resolveAllParallel,
    commit,
    dispose
  }
})

/** 基线快照转备份载荷形态（供合并引擎按同一索引读取） */
function baselineToPayload(baseline: NonNullTable): BackupPayload {
  return {
    app: 'gbtunnelcrack',
    dbVersion: baseline.dbVersion,
    exportedAt: new Date(baseline.createdAt).toISOString(),
    sections: baseline.sections as BackupPayload['sections'],
    rings: baseline.rings as BackupPayload['rings'],
    cracks: baseline.cracks as BackupPayload['cracks'],
    surveys: baseline.surveys as BackupPayload['surveys'],
    advices: baseline.advices as BackupPayload['advices'],
    tombstones: [],
    baselineId: baseline.id
  }
}

type NonNullTable = NonNullable<Awaited<ReturnType<typeof getBaseline>>>

/** 暂存内保存的快照剥离 revision，保持纯业务行 */
function stripStagingRows(payload: BackupPayload): BackupPayload {
  const strip = <T>(rows: T[] | undefined): T[] =>
    (rows ?? []).map((row) => {
      const source = row as Record<string, unknown>
      const { revision: _revision, ...rest } = source
      return rest as unknown as T
    })
  return {
    ...payload,
    sections: strip(payload.sections),
    rings: strip(payload.rings),
    cracks: strip(payload.cracks),
    surveys: strip(payload.surveys),
    advices: strip(payload.advices),
    tombstones: strip(payload.tombstones) as Tombstone[]
  }
}
