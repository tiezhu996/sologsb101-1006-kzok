/**
 * 离线合并执行引擎：把核验人处理过的合并条目真正写入 IndexedDB。
 * - auto：一侧改动自动接回（本机侧改动本就在库；对端改动直接写入）
 * - keep-both：裂缝/环片/测次双改并列，对端版本克隆为独立副本
 * - take-local/take-incoming：按核验人选择保留
 * 提交后统一按日期重排测次、重算变化量/裂缝读数/建议等级与自动依据。
 */
import {
  db,
  recalcSurveySeries,
  ROW_REVISION,
  type AdviceRow,
  type SurveyRow,
  type TombstoneRow
} from '@/utils/db'
import type { AnyEntityRow, EntityRowsByTable, MergeEntry, MergeSession } from '@/types/merge'
import type { EntityTable, Tombstone } from '@/types/tombstone'
import { buildSurveyPoints, basisText, levelFromRate } from '@/utils/rate'
import { crewSuffix, findTombstone, mergeId, signatureOf } from '@/utils/mergeUtil'
import type { MergeOriginMark } from '@/types/mergeMark'

const ALL_TABLES = [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones] as const
const TABLE_ORDER: EntityTable[] = ['sections', 'rings', 'cracks', 'surveys', 'advices']

function stamped<T extends object>(row: T): T {
  return { ...row, revision: ROW_REVISION }
}

/** 按表名写入任意实体行（联合类型无法共用单个 Dexie Table，这里按表显式收口） */
async function putEntity(table: EntityTable, row: AnyEntityRow): Promise<void> {
  switch (table) {
    case 'sections':
      await db.sections.put(row as Parameters<typeof db.sections.put>[0])
      return
    case 'rings':
      await db.rings.put(row as Parameters<typeof db.rings.put>[0])
      return
    case 'cracks':
      await db.cracks.put(row as Parameters<typeof db.cracks.put>[0])
      return
    case 'surveys':
      await db.surveys.put(row as Parameters<typeof db.surveys.put>[0])
      return
    case 'advices':
      await db.advices.put(row as Parameters<typeof db.advices.put>[0])
      return
  }
}

/** 按表名读取任意实体行 */
async function getEntity(table: EntityTable, id: string): Promise<AnyEntityRow | undefined> {
  switch (table) {
    case 'sections':
      return db.sections.get(id)
    case 'rings':
      return db.rings.get(id)
    case 'cracks':
      return db.cracks.get(id)
    case 'surveys':
      return db.surveys.get(id)
    case 'advices':
      return db.advices.get(id)
  }
}

/** 按表名删除任意实体行 */
async function deleteEntityById(table: EntityTable, id: string): Promise<void> {
  switch (table) {
    case 'sections':
      await db.sections.delete(id)
      return
    case 'rings':
      await db.rings.delete(id)
      return
    case 'cracks':
      await db.cracks.delete(id)
      return
    case 'surveys':
      await db.surveys.delete(id)
      return
    case 'advices':
      await db.advices.delete(id)
      return
  }
}

function entryEntityId(entry: MergeEntry): string {
  return (entry.baseRow ?? entry.localRow ?? entry.incomingRow)?.id as string
}

function findEntry(session: MergeSession, table: EntityTable, id: string): MergeEntry | undefined {
  return session.entries.find(
    (entry) => entry.table === table && (entry.baseRow?.id ?? entry.localRow?.id ?? entry.incomingRow?.id) === id
  )
}

/** 父级是否双改并列（决定子记录是随副本克隆还是单独自动接回） */
function parentKeptBoth(session: MergeSession, table: EntityTable, id: string): boolean {
  const entry = findEntry(session, table, id)
  return entry?.status === 'conflicted' && entry.resolution.type === 'keep-both'
}

/**
 * 对端独有的自动接回条目，是否已被某个并列副本覆盖：
 * - 裂缝并列时，对端版裂缝整棵子树（测次/建议）随副本克隆；
 * - 环片并列时，对端独有裂缝及其测次/建议随环片副本克隆。
 * 这类条目若再单独写入，会产生挂在已删除外键上的孤儿或重复，故跳过自动接回。
 */
function autoEntryCoveredByClone(session: MergeSession, entry: MergeEntry): boolean {
  if (entry.side !== 'incoming-only' || entry.status === 'deleted' || !entry.incomingRow) return false

  if (entry.table === 'cracks') {
    const ringId = (entry.incomingRow as { ringId?: string }).ringId ?? ''
    return parentKeptBoth(session, 'rings', ringId)
  }

  if (entry.table === 'surveys' || entry.table === 'advices') {
    const crackId = (entry.incomingRow as { crackId?: string }).crackId ?? ''
    if (parentKeptBoth(session, 'cracks', crackId)) return true
    const incomingCrack = session.incoming.cracks.find((crack) => crack.id === crackId)
    if (incomingCrack && parentKeptBoth(session, 'rings', incomingCrack.ringId)) return true
  }

  return false
}

/* ------------------------- 对端删除（墓碑接收） ------------------------- */

async function descendantIds(table: EntityTable, entityId: string): Promise<Array<{ table: EntityTable; id: string }>> {
  const out: Array<{ table: EntityTable; id: string }> = []
  if (table === 'sections') {
    const rings = await db.rings.where('sectionId').equals(entityId).toArray()
    for (const ring of rings) {
      out.push({ table: 'rings', id: ring.id })
      out.push(...(await descendantIds('rings', ring.id)))
    }
  } else if (table === 'rings') {
    const cracks = await db.cracks.where('ringId').equals(entityId).toArray()
    for (const crack of cracks) {
      out.push({ table: 'cracks', id: crack.id })
      out.push(...(await descendantIds('cracks', crack.id)))
    }
  } else if (table === 'cracks') {
    ;(await db.surveys.where('crackId').equals(entityId).toArray()).forEach((survey) =>
      out.push({ table: 'surveys', id: survey.id })
    )
    ;(await db.advices.where('crackId').equals(entityId).toArray()).forEach((advice) =>
      out.push({ table: 'advices', id: advice.id })
    )
  }
  return out
}

/** 落一条 imported 墓碑并移除活记录；记录不存在则跳过 */
async function writeDeleteTombstone(
  table: EntityTable,
  id: string,
  sourceTombstone: TombstoneRow | null,
  actor: string
): Promise<string | null> {
  const live = await getEntity(table, id)
  if (!live) return null
  const anyRow = live as { sectionId?: string; ringId?: string; crackId?: string }
  const tombstone: TombstoneRow = {
    id: `tm_${table}_${id}`,
    table,
    entityId: id,
    sectionId: anyRow.sectionId,
    ringId: anyRow.ringId,
    crackId: anyRow.crackId,
    label: sourceTombstone?.label ?? id,
    signature: signatureOf(live),
    deletedBy: actor,
    deletedAt: Date.now(),
    origin: 'imported' as Tombstone['origin'],
    revision: ROW_REVISION
  }
  await db.tombstones.put(tombstone)
  await deleteEntityById(table, id)
  return table === 'surveys' ? (live as SurveyRow).crackId : null
}

/** 把对端删除落到本机（并列保留/取本机的子项受保护，不被级联抹掉） */
async function applyIncomingDelete(
  session: MergeSession,
  entry: MergeEntry,
  protectedIds: ReadonlySet<string>,
  actor: string
): Promise<string[]> {
  const entityId = entryEntityId(entry)
  const sourceTombstone = findTombstone(session.incoming, entry.table, entityId)
  const affected: string[] = []

  const retainsLocal = (table: EntityTable, id: string): boolean => {
    const childEntry = session.entries.find(
      (item) => item.table === table && (item.baseRow?.id ?? item.localRow?.id ?? item.incomingRow?.id) === id
    )
    return (
      childEntry?.resolution.type === 'keep-both' || childEntry?.resolution.type === 'take-local'
    )
  }

  for (const child of await descendantIds(entry.table, entityId)) {
    if (protectedIds.has(child.id) || retainsLocal(child.table, child.id)) continue
    const crackId = await writeDeleteTombstone(child.table, child.id, sourceTombstone, actor)
    if (crackId) affected.push(crackId)
  }
  if (!protectedIds.has(entityId) && !retainsLocal(entry.table, entityId)) {
    const crackId = await writeDeleteTombstone(entry.table, entityId, sourceTombstone, actor)
    if (crackId) affected.push(crackId)
  }
  return Array.from(new Set(affected))
}

/* --------------------------- 并列副本克隆 --------------------------- */

/** 从对端快照克隆裂缝整棵子树（裂缝双改并列 / 本机删对端改时复活） */
async function cloneCrackFromSession(
  session: MergeSession,
  sourceCrackId: string,
  groupId: string,
  crew: string,
  ringIdOverride?: string
): Promise<string> {
  const source = session.incoming.cracks.find((crack) => crack.id === sourceCrackId)
  if (!source) return sourceCrackId
  const newCrackId = mergeId('crack')
  const mark: MergeOriginMark = { kind: 'duplicate', groupId, origin: 'incoming', crew }
  await db.cracks.put(
    stamped({
      ...source,
      id: newCrackId,
      ringId: ringIdOverride ?? source.ringId,
      code: `${source.code}（${crewSuffix(crew)}）`,
      mergeOrigin: mark,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  )
  for (const survey of session.incoming.surveys.filter((item) => item.crackId === sourceCrackId)) {
    await db.surveys.put(
      stamped({
        ...survey,
        id: mergeId('sv'),
        crackId: newCrackId,
        mergeOrigin: mark
      })
    )
  }
  for (const advice of session.incoming.advices.filter((item) => item.crackId === sourceCrackId)) {
    // 基线里已存在的建议属于两边共有，不随并列裂缝重复；只复制对端相对基线新增的建议
    if (session.baseline.advices.some((item) => item.id === advice.id)) continue
    await db.advices.put(
      stamped({
        ...advice,
        id: mergeId('ad'),
        crackId: newCrackId,
        mergeOrigin: mark
      })
    )
  }
  return newCrackId
}

/** 从对端快照克隆环片及其下对端新增裂缝整棵子树（环片双改并列），返回新环片与新裂缝 id */
async function cloneRingFromSession(
  session: MergeSession,
  sourceRingId: string,
  groupId: string,
  crew: string
): Promise<{ ringId: string; crackIds: string[] }> {
  const source = session.incoming.rings.find((ring) => ring.id === sourceRingId)
  if (!source) return { ringId: sourceRingId, crackIds: [] }
  const newRingId = mergeId('ring')
  const mark: MergeOriginMark = { kind: 'duplicate', groupId, origin: 'incoming', crew }
  await db.rings.put(
    stamped({
      ...source,
      id: newRingId,
      mergeOrigin: mark,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  )
  const crackIds: string[] = []
  for (const crack of session.incoming.cracks.filter((item) => item.ringId === sourceRingId)) {
    // 基线共有的裂缝两边原件都在（挂在本机环片下），环片并列时只克隆对端新增的裂缝
    if (session.baseline.cracks.some((item) => item.id === crack.id)) continue
    const clonedCrackId = await cloneCrackFromSession(session, crack.id, `${groupId}_${crack.id}`, crew, newRingId)
    crackIds.push(clonedCrackId)
  }
  return { ringId: newRingId, crackIds }
}

/* ----------------------------- 单条提交 ----------------------------- */

interface ApplyResult {
  affectedCrackIds: string[]
  duplicate?: { localId: string; incomingId: string }
}

async function applyEntry(
  session: MergeSession,
  entry: MergeEntry,
  actor: string,
  protectedIds: ReadonlySet<string>
): Promise<ApplyResult> {
  const resolution = entry.resolution
  const entityId = entryEntityId(entry)
  const affectedCrackIds: string[] = []
  let duplicate: { localId: string; incomingId: string } | undefined

  /* 自动接回 */
  if (resolution.type === 'auto') {
    if (entry.side === 'incoming-only') {
      if (entry.status === 'deleted') {
        return { affectedCrackIds: await applyIncomingDelete(session, entry, protectedIds, actor) }
      }
      // 子记录已随并列副本克隆（裂缝/环片并列），不再单独写入原件侧
      if (autoEntryCoveredByClone(session, entry)) {
        return { affectedCrackIds }
      }
      if (entry.incomingRow) {
        await putEntity(entry.table, stamped(entry.incomingRow))
        if (entry.table === 'surveys') affectedCrackIds.push((entry.incomingRow as SurveyRow).crackId)
      }
    }
    // local-only 改动本就在本机库（含本机删除墓碑），无需动作
    return { affectedCrackIds }
  }

  const groupId = `dup_${entry.table}_${entityId}`
  const crew = session.backupExportedBy

  /* 测次双改 */
  if (entry.table === 'surveys') {
    const localId = entry.localRow?.id ?? ''
    if (resolution.type === 'keep-both') {
      let incomingId = localId
      if (entry.incomingRow) {
        const incomingSurvey = entry.incomingRow as SurveyRow
        incomingId = mergeId('sv')
        await db.surveys.put(
          stamped({
            ...incomingSurvey,
            id: incomingId,
            mergeOrigin: { kind: 'duplicate', groupId, origin: 'incoming', crew } satisfies MergeOriginMark
          })
        )
        affectedCrackIds.push(incomingSurvey.crackId)
      }
      if (localId) {
        await db.surveys.update(localId, {
          mergeOrigin: { kind: 'duplicate', groupId, origin: 'local' } as never
        })
        affectedCrackIds.push((entry.localRow as SurveyRow).crackId)
      }
      duplicate = { localId, incomingId }
    } else if (resolution.type === 'take-incoming' && entry.incomingRow) {
      const incomingSurvey = entry.incomingRow as SurveyRow
      await db.surveys.put(stamped(incomingSurvey))
      await db.tombstones.where('entityId').equals(entityId).delete()
      affectedCrackIds.push(incomingSurvey.crackId)
    }
    return { affectedCrackIds, duplicate }
  }

  /* 裂缝双改 */
  if (entry.table === 'cracks') {
    const localId = entry.localRow?.id ?? ''
    if (resolution.type === 'keep-both') {
      let incomingId = localId
      if (entry.incomingRow && entry.localRow) {
        incomingId = await cloneCrackFromSession(session, entry.incomingRow.id, groupId, crew)
        await db.cracks.update(localId, {
          mergeOrigin: { kind: 'duplicate', groupId, origin: 'local' } as never
        })
        affectedCrackIds.push(localId, incomingId)
      } else if (entry.incomingRow && !entry.localRow) {
        // 本机已删、对端改：对端版本以新 id 并列复活，本机删除墓碑保留
        incomingId = await cloneCrackFromSession(session, entry.incomingRow.id, groupId, crew)
        affectedCrackIds.push(incomingId)
      } else if (entry.localRow) {
        affectedCrackIds.push(localId)
      }
      duplicate = { localId, incomingId }
    } else if (resolution.type === 'take-incoming' && entry.incomingRow) {
      await db.cracks.put(stamped(entry.incomingRow as Parameters<typeof db.cracks.put>[0]))
      await db.tombstones.where('entityId').equals(entityId).delete()
      affectedCrackIds.push(entityId)
    }
    return { affectedCrackIds, duplicate }
  }

  /* 环片双改 */
  if (entry.table === 'rings') {
    const localId = entry.localRow?.id ?? ''
    if (resolution.type === 'keep-both') {
      let incomingId = localId
      if (entry.incomingRow && entry.localRow) {
        const cloned = await cloneRingFromSession(session, entry.incomingRow.id, groupId, crew)
        incomingId = cloned.ringId
        affectedCrackIds.push(...cloned.crackIds)
        await db.rings.update(localId, {
          mergeOrigin: { kind: 'duplicate', groupId, origin: 'local' } as never
        })
      } else if (entry.incomingRow && !entry.localRow) {
        const cloned = await cloneRingFromSession(session, entry.incomingRow.id, groupId, crew)
        incomingId = cloned.ringId
        affectedCrackIds.push(...cloned.crackIds)
      }
      duplicate = { localId, incomingId }
    } else if (resolution.type === 'take-incoming' && entry.incomingRow) {
      await db.rings.put(stamped(entry.incomingRow as Parameters<typeof db.rings.put>[0]))
      await db.tombstones.where('entityId').equals(entityId).delete()
    }
    return { affectedCrackIds, duplicate }
  }

  /* 区间 / 建议：无双改并列，核验人二选一（take-local 无动作） */
  if (resolution.type === 'take-incoming' && entry.incomingRow) {
    await putEntity(entry.table, stamped(entry.incomingRow))
    await db.tombstones.where('entityId').equals(entityId).delete()
  }
  return { affectedCrackIds, duplicate }
}

/* ------------------------------ 批量提交 ------------------------------ */

export interface CommitResult {
  committedIds: string[]
  duplicates: Record<string, { localId: string; incomingId: string }>
  affectedCrackIds: string[]
}

/**
 * 提交一批已决条目（skip 不提交）。同一会话内已提交条目自动跳过，
 * 因此中断重试 / 再次选择同一备份不会多记一条。
 */
export async function commitMergeEntries(
  session: MergeSession,
  entries: MergeEntry[],
  actor: string
): Promise<CommitResult> {
  const pending = entries.filter(
    (entry) => entry.resolution.type !== 'skip' && !session.committedEntryIds.includes(entry.id)
  )
  const duplicates: Record<string, { localId: string; incomingId: string }> = { ...session.duplicateIds }
  const affectedCrackIds: string[] = []
  const protectedIds = new Set<string>()

  // 并列保留的本机子项受保护：父级对端删除级联时跳过
  for (const entry of pending) {
    if (entry.resolution.type === 'keep-both' && entry.localRow) protectedIds.add(entry.localRow.id)
  }

  await db.transaction('rw', [...ALL_TABLES], async () => {
    for (const table of TABLE_ORDER) {
      for (const entry of pending.filter((item) => item.table === table)) {
        const result = await applyEntry(session, entry, actor, protectedIds)
        affectedCrackIds.push(...result.affectedCrackIds)
        if (result.duplicate) duplicates[entry.id] = result.duplicate
      }
    }

    // 对端删除墓碑留痕（本机已有同实体墓碑时不覆盖）
    for (const tombstone of session.incoming.tombstones) {
      const id = `tm_${tombstone.table}_${tombstone.entityId}`
      const existing = await db.tombstones.get(id)
      const localEntry = session.entries.find(
        (entry) =>
          entry.table === tombstone.table &&
          entryEntityId(entry) === tombstone.entityId &&
          (entry.resolution.type === 'keep-both' || entry.resolution.type === 'take-local')
      )
      if (!existing && !localEntry) {
        await db.tombstones.put(stamped({ ...tombstone, id, origin: 'imported' as Tombstone['origin'] }))
      }
    }
  })

  const crackIds = Array.from(new Set(affectedCrackIds))
  await refreshDerived(crackIds)

  // 回写会话：即使调用方未持久化（如中断后直接重试同一对象），也不会重复记账
  const committedIds = pending.map((entry) => entry.id)
  session.committedEntryIds = Array.from(new Set([...session.committedEntryIds, ...committedIds]))
  session.duplicateIds = duplicates
  session.updatedAt = Date.now()

  return { committedIds, duplicates, affectedCrackIds: crackIds }
}

/** 重算受影响裂缝：测次按日期重排 → 变化量/裂缝读数 → 建议等级与自动依据 */
export async function refreshDerived(crackIds: string[]): Promise<void> {
  for (const crackId of Array.from(new Set(crackIds))) {
    await recalcSurveySeries(crackId)
    const advice = await db.advices.where('crackId').equals(crackId).first()
    if (!advice) continue
    const surveys = await db.surveys.where('crackId').equals(crackId).toArray()
    const points = buildSurveyPoints(surveys)
    if (points.length === 0) continue
    const rate = points[points.length - 1].rate
    const level = levelFromRate(rate)
    const patch: Partial<AdviceRow> = { level, updatedAt: Date.now() }
    // 仅重算自动生成的依据（以「月均发展速率」开头），人工填写的依据保留
    if (advice.basis.startsWith('月均发展速率')) patch.basis = basisText(rate, level)
    await db.advices.update(advice.id, patch as never)
  }
}

/** 读入当前库全量行（供合并准备与会话恢复） */
export async function loadAllRows(): Promise<EntityRowsByTable> {
  const [sections, rings, cracks, surveys, advices, tombstones] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.tombstones.toArray()
  ])
  return { sections, rings, cracks, surveys, advices, tombstones }
}
