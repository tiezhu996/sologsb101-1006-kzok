/**
 * 离线三向合并引擎（纯函数，不触碰 IndexedDB）。
 * 输入三份快照（base/local/remote）与对侧墓碑，产出：
 * - 自动接回变化 autoChanges（仅一侧改动）
 * - 待核验冲突 conflicts（两边都改 / 删除-修改）
 * 裂缝、环片、测次两边都改默认并列保留；区间、建议的冲突与全部删除冲突须核验人定夺。
 */
import type { BackupPayload } from '@/utils/db'
import type {
  BaselineSnapshot,
  ConflictKind,
  FieldChange,
  MergeAutoChange,
  MergeConflict,
  MergeEntity,
  MergeMode,
  MergeStaging
} from '@/types/merge'
import {
  MERGE_TABLES,
  MERGE_TABLE_LABEL,
  PARALLEL_TABLES,
  tombstoneId,
  type MergeTable,
  type Tombstone
} from '@/types/tombstone'
import { ROW_REVISION } from '@/utils/db'
import { shortToken } from '@/utils/fingerprint'

type EntityMap = Map<string, MergeEntity>
type TableIndex = Record<MergeTable, EntityMap>
type IdIndex = Record<MergeTable, Set<string>>

const ENTITY_LABEL_FIELD: Record<MergeTable, string> = {
  sections: 'line',
  rings: 'ringNo',
  cracks: 'code',
  surveys: 'date',
  advices: 'measure'
}

/** 差异展示时忽略的内部字段 */
const IGNORE_DIFF_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'revision', 'mergeTag'])

/** 冲突/变化行的可读名称 */
export function entityLabel(table: MergeTable, row: MergeEntity | null): string {
  if (!row) return '（已删除）'
  const source = asRecord(row)
  const value = source[ENTITY_LABEL_FIELD[table]]
  switch (table) {
    case 'rings':
      return `第 ${value ?? '?'} 环`
    case 'surveys': {
      const code = String(source.crackId ?? '')
      return `复测 ${String(value ?? '')}（${code.slice(0, 10)}）`
    }
    default:
      return value === undefined || value === '' ? row.id : String(value)
  }
}

/** 字段中文名（合并暂存冲突展示用） */
export const FIELD_LABELS: Record<string, string> = {
  line: '线路',
  startMileage: '起里程',
  endMileage: '止里程',
  structureType: '结构型式',
  ringCount: '环数',
  sectionId: '所属区间',
  ringNo: '环号',
  mileage: '里程',
  segmentType: '管片类型',
  installDate: '安装日期',
  ringId: '所属环片',
  code: '编号',
  position: '部位',
  direction: '走向',
  widthMm: '宽度',
  lengthMm: '长度',
  state: '状态',
  crackId: '裂缝',
  seq: '测次',
  date: '日期',
  deltaWidthMm: '变化量',
  surveyor: '复测人',
  level: '等级',
  measure: '措施',
  basis: '判定依据',
  mergeTag: '并列标记'
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

function asEntity(row: unknown): MergeEntity {
  return row as MergeEntity
}

export function indexPayload(payload: BackupPayload | BaselineSnapshot | null): TableIndex {
  const empty = (): TableIndex => ({
    sections: new Map(),
    rings: new Map(),
    cracks: new Map(),
    surveys: new Map(),
    advices: new Map()
  })
  const index = empty()
  if (!payload) return index
  MERGE_TABLES.forEach((table) => {
    const rows = (payload as Record<MergeTable, unknown[]>)[table] ?? []
    rows.forEach((row) => {
      const entity = asEntity(row)
      index[table].set(entity.id, entity)
    })
  })
  return index
}

function tombstoneIndex(tombstones: Tombstone[]): IdIndex {
  const index = {
    sections: new Set<string>(),
    rings: new Set<string>(),
    cracks: new Set<string>(),
    surveys: new Set<string>(),
    advices: new Set<string>()
  }
  tombstones.forEach((tomb) => index[tomb.table].add(tomb.entityId))
  return index
}

function rowsEqual(a: MergeEntity | null, b: MergeEntity | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(stripMeta(a)) === JSON.stringify(stripMeta(b))
}

function asRecord(entity: MergeEntity | null): Record<string, unknown> {
  return (entity ?? {}) as unknown as Record<string, unknown>
}

function stripMeta(entity: MergeEntity): Record<string, unknown> {
  const source = entity as unknown as Record<string, unknown>
  return Object.keys(source)
    .filter((key) => !IGNORE_DIFF_FIELDS.has(key))
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = source[key]
      return acc
    }, {})
}

function computeChanges(
  table: MergeTable,
  base: MergeEntity | null,
  local: MergeEntity | null,
  remote: MergeEntity | null
): FieldChange[] {
  const fields = new Set<string>()
  ;[base, local, remote].forEach((row) => {
    if (row) Object.keys(stripMeta(row)).forEach((field) => fields.add(field))
  })
  const changes: FieldChange[] = []
  fields.forEach((field) => {
    const b = base ? asRecord(base)[field] : undefined
    const l = local ? asRecord(local)[field] : undefined
    const r = remote ? asRecord(remote)[field] : undefined
    if (JSON.stringify(l) !== JSON.stringify(r) && (l !== undefined || r !== undefined)) {
      changes.push({ field, base: b, local: l, remote: r })
    }
  })
  void table
  return changes
}

export interface BuildPlanInput {
  mode: MergeMode
  local: BackupPayload
  remote: BackupPayload
  /** legacy 模式为 null */
  base: BackupPayload | null
  /** 对侧备份指纹，用于派生并列复制 id */
  fingerprint: string
}

export interface MergePlan {
  autoChanges: MergeAutoChange[]
  conflicts: MergeConflict[]
}

/**
 * 生成合并暂存计划（纯分类，不修改任何数据）。
 */
export function buildMergePlan(input: BuildPlanInput): MergePlan {
  const { mode, local, remote, base, fingerprint } = input
  const localIndex = indexPayload(local)
  const remoteIndex = indexPayload(remote)
  const baseIndex = indexPayload(base)
  const localTombs = tombstoneIndex(local.tombstones ?? [])
  const remoteTombs = tombstoneIndex(remote.tombstones ?? [])

  const autoChanges: MergeAutoChange[] = []
  const conflicts: MergeConflict[] = []

  const pushAuto = (
    table: MergeTable,
    action: MergeAutoChange['action'],
    incoming: MergeEntity | null
  ): void => {
    autoChanges.push({
      table,
      entityId: incoming ? incoming.id : '',
      action,
      incoming,
      label: incoming
        ? entityLabel(table, incoming)
        : MERGE_TABLE_LABEL[table]
    })
  }

  const pushConflict = (
    table: MergeTable,
    entityId: string,
    kind: ConflictKind,
    parallelable: boolean,
    localRow: MergeEntity | null,
    remoteRow: MergeEntity | null,
    baseRow: MergeEntity | null,
    deleteSide?: 'local' | 'remote'
  ): void => {
    conflicts.push({
      key: `${table}:${entityId}:${kind}`,
      table,
      entityId,
      kind,
      deleteSide,
      parallelable,
      local: localRow,
      remote: remoteRow,
      base: baseRow,
      changes: computeChanges(table, baseRow, localRow, remoteRow),
      resolution: null,
      cloneId: parallelable
        ? `${entityId}__dup_${shortToken(fingerprint)}`
        : undefined
    })
  }

  MERGE_TABLES.forEach((table) => {
    const ids = new Set<string>([
      ...localIndex[table].keys(),
      ...remoteIndex[table].keys(),
      ...baseIndex[table].keys()
    ])
    ids.forEach((id) => {
      const localRow = localIndex[table].get(id) ?? null
      const remoteRow = remoteIndex[table].get(id) ?? null
      const baseRow = baseIndex[table].get(id) ?? null
      // 删除以墓碑为准；墓碑在记录被删后仍保留，因此不会把「对侧新增」误判为「本机删除」
      const localDeleted = localTombs[table].has(id)
      const remoteDeleted = remoteTombs[table].has(id)

      if (mode === 'legacy') {
        classifyLegacy(table, id, localRow, remoteRow, localDeleted, remoteDeleted, pushAuto, pushConflict)
        return
      }
      classifyThreeWay(
        table,
        id,
        baseRow,
        localRow,
        remoteRow,
        localDeleted,
        remoteDeleted,
        pushAuto,
        pushConflict
      )
    })
  })

  // 固定排序，便于暂存展示稳定
  const tableOrder = (table: MergeTable): number => MERGE_TABLES.indexOf(table)
  autoChanges.sort(
    (a, b) => tableOrder(a.table) - tableOrder(b.table) || a.entityId.localeCompare(b.entityId)
  )
  conflicts.sort((a, b) => tableOrder(a.table) - tableOrder(b.table) || a.entityId.localeCompare(b.entityId))
  return { autoChanges, conflicts }
}

type PushAuto = (table: MergeTable, action: MergeAutoChange['action'], incoming: MergeEntity | null) => void
type PushConflict = (
  table: MergeTable,
  entityId: string,
  kind: ConflictKind,
  parallelable: boolean,
  localRow: MergeEntity | null,
  remoteRow: MergeEntity | null,
  baseRow: MergeEntity | null,
  deleteSide?: 'local' | 'remote'
) => void

/* ------------------------------ 三向分类 ------------------------------ */

function classifyThreeWay(
  table: MergeTable,
  id: string,
  baseRow: MergeEntity | null,
  localRow: MergeEntity | null,
  remoteRow: MergeEntity | null,
  localDeleted: boolean,
  remoteDeleted: boolean,
  pushAuto: PushAuto,
  pushConflict: PushConflict
): void {
  const parallelable = PARALLEL_TABLES.includes(table)
  const localChanged = !rowsEqual(localRow, baseRow)
  const remoteChanged = !rowsEqual(remoteRow, baseRow)

  // 两侧都删：结论一致，自动删除（不算冲突）
  if (localDeleted && remoteDeleted) {
    pushAuto(table, 'delete', baseRow ?? localRow ?? remoteRow)
    return
  }
  // 本机删、对侧改
  if (localDeleted && remoteRow && !rowsEqual(remoteRow, baseRow)) {
    pushConflict(table, id, 'delete-edit', parallelable, null, remoteRow, baseRow, 'local')
    return
  }
  // 对侧删、本机改
  if (remoteDeleted && localRow && !rowsEqual(localRow, baseRow)) {
    pushConflict(table, id, 'delete-edit', parallelable, localRow, null, baseRow, 'remote')
    return
  }
  // 单侧删除（另一侧未动）→ 自动接回删除
  if (localDeleted && !remoteDeleted) {
    pushAuto(table, 'delete', remoteRow ?? baseRow)
    return
  }
  if (remoteDeleted && !localDeleted) {
    pushAuto(table, 'delete', localRow ?? baseRow)
    return
  }
  // 两侧都改
  if (localChanged && remoteChanged && !rowsEqual(localRow, remoteRow)) {
    pushConflict(table, id, 'both-edited', parallelable, localRow, remoteRow, baseRow)
    return
  }
  // 对侧改、本机未动 → 自动接回
  if (!localChanged && remoteChanged && remoteRow) {
    pushAuto(table, baseRow ? 'update' : 'add', remoteRow)
    return
  }
  // 本机改、对侧未动（或两侧改成相同结果）→ 保持本机，无需变化
  // 对侧新增但本机也有相同行（两侧独立新增同 id 且内容一致）→ 保持
}

/* --------------------------- 无基线保守分类 --------------------------- */

function classifyLegacy(
  table: MergeTable,
  id: string,
  localRow: MergeEntity | null,
  remoteRow: MergeEntity | null,
  localDeleted: boolean,
  remoteDeleted: boolean,
  pushAuto: PushAuto,
  pushConflict: PushConflict
): void {
  const parallelable = PARALLEL_TABLES.includes(table)
  if (localRow && remoteRow) {
    if (!rowsEqual(localRow, remoteRow)) {
      pushConflict(table, id, 'both-edited', parallelable, localRow, remoteRow, null)
    }
    return
  }
  if (localDeleted && remoteDeleted) {
    pushAuto(table, 'delete', localRow ?? remoteRow)
    return
  }
  if (localRow && remoteDeleted) {
    pushConflict(table, id, 'delete-edit', parallelable, localRow, null, null, 'remote')
    return
  }
  if (remoteRow && localDeleted) {
    pushConflict(table, id, 'delete-edit', parallelable, null, remoteRow, null, 'local')
    return
  }
  if (remoteRow && !localRow) {
    pushAuto(table, 'add', remoteRow)
    return
  }
  if (!remoteRow && localRow && !localDeleted) {
    // 本机独有：保持，不做处理
  }
  void id
}

/* --------------------------- 提交变更计算 --------------------------- */

export interface CommitPlan {
  /** 按表分组的最终写入行 */
  upserts: Record<MergeTable, MergeEntity[]>
  /** 按表分组的最终删除 id */
  deleteIds: Record<MergeTable, string[]>
  /** 需要新写的对侧墓碑（本机执行对侧删除） */
  incomingTombstones: Tombstone[]
  /** 受影响裂缝 id：需要重排序次、重算变化量与建议 */
  affectedCrackIds: string[]
}

/**
 * 根据核验人处理完的暂存，计算最终入库变更（仍为纯函数）。
 */
export function computeCommit(staging: MergeStaging): CommitPlan {
  const upserts: Record<MergeTable, MergeEntity[]> = {
    sections: [],
    rings: [],
    cracks: [],
    surveys: [],
    advices: []
  }
  const deleteIds: Record<MergeTable, string[]> = {
    sections: [],
    rings: [],
    cracks: [],
    surveys: [],
    advices: []
  }
  const incomingTombstones: Tombstone[] = []
  const affectedCrackIds = new Set<string>()

  const remoteIndex = indexPayload(staging.remoteSnapshot)
  const localIndex = indexPayload(staging.localSnapshot)
  const token = shortToken(staging.id)

  /** 并列根 → 复制新 id 的映射（根 + 级联子树） */
  const idRemap = new Map<string, string>()
  const remapKeyLocal = (table: MergeTable, id: string): string => `${table}:${id}`

  // 1) 依据冲突决定，扩展并列克隆树
  staging.conflicts.forEach((conflict) => {
    if (conflict.resolution !== 'parallel' || !conflict.parallelable || !conflict.cloneId) return
    const newId = conflict.cloneId
    idRemap.set(remapKeyLocal(conflict.table, conflict.entityId), newId)
    if (conflict.table === 'rings') expandRingClone(conflict.entityId, newId, remoteIndex, idRemap, token)
    if (conflict.table === 'cracks') expandCrackClone(conflict.entityId, newId, remoteIndex, idRemap, token)
  })

  const isRemapped = (table: MergeTable, id: string): boolean => idRemap.has(remapKeyLocal(table, id))

  // 2) 自动变化（跳过已并入并列克隆子树的行：它们会作为对侧克隆子树整体复制，
  //    避免把对侧克隆分支的子记录误挂回本机根）
  staging.autoChanges.forEach((change) => {
    if (isRemapped(change.table, change.entityId)) return
    // 测次/建议的父裂缝已被并列克隆时，跟随克隆子树，不走本机自动接回
    if (change.incoming && (change.table === 'surveys' || change.table === 'advices')) {
      const parentCrack = String(asRecord(change.incoming).crackId)
      if (isRemapped('cracks', parentCrack)) return
    }
    // 裂缝的父环片已被并列克隆时，裂缝跟随克隆环片
    if (change.incoming && change.table === 'cracks') {
      const parentRing = String(asRecord(change.incoming).ringId)
      if (isRemapped('rings', parentRing)) return
    }
    if (change.action === 'delete') {
      deleteIds[change.table].push(change.entityId)
      // 对侧删除：写入对侧墓碑使删除可继续向下游合并
      const remoteDeleted = (staging.remoteSnapshot.tombstones ?? []).find(
        (tomb) => tomb.table === change.table && tomb.entityId === change.entityId
      )
      if (remoteDeleted) {
        incomingTombstones.push(remoteDeleted)
      }
    } else if (change.incoming) {
      upserts[change.table].push(change.incoming)
    }
  })

  // 3) 冲突处理
  staging.conflicts.forEach((conflict) => {
    const { table, entityId, resolution } = conflict
    const remoteRow = remoteIndex[table].get(entityId) ?? null
    const cloneId = idRemap.get(remapKeyLocal(table, entityId))

    if (resolution === 'parallel' && conflict.parallelable) {
      // 本机根保持；对侧根以克隆 id 写入（子树在第 4 步统一展开）
      if (remoteRow && cloneId) {
        upserts[table].push(cloneEntity(table, remoteRow, cloneId, idRemap, token))
      }
      return
    }
    if (resolution === 'remote') {
      if (remoteRow) {
        upserts[table].push(remoteRow)
      } else if (conflict.kind === 'delete-edit' && conflict.deleteSide === 'local') {
        // 接回对侧（对侧删除）：执行删除本机
        deleteIds[table].push(entityId)
      }
      return
    }
    if (resolution === 'delete') {
      deleteIds[table].push(entityId)
      const remoteDeleted = (staging.remoteSnapshot.tombstones ?? []).find(
        (tomb) => tomb.table === table && tomb.entityId === entityId
      )
      if (remoteDeleted) incomingTombstones.push(remoteDeleted)
      return
    }
    // local / drop / 未决定（提交前应已拦截）：保持本机，不产生变更
  })

  // 4) 写入并列克隆的级联子树（环片→裂缝→测次/建议，裂缝→测次/建议）
  idRemap.forEach((newId, oldKey) => {
    const [table, oldId] = splitRemapKey(oldKey)
    // 根本身在第 3 步写入，跳过
    const isRoot = staging.conflicts.some(
      (conflict) =>
        conflict.resolution === 'parallel' &&
        conflict.parallelable &&
        conflict.table === table &&
        conflict.entityId === oldId
    )
    if (isRoot) return
    const source = remoteIndex[table].get(oldId)
    if (source) {
      upserts[table].push(cloneEntity(table, source, newId, idRemap, token))
    }
  })

  // 5) 级联删除：显式删除的父实体带上仍存在的下游 id（以对侧/本机关系并集为准）
  cascadeDeleteIds(deleteIds, localIndex, remoteIndex, incomingTombstones, staging)

  // 去重，保持稳定
  MERGE_TABLES.forEach((table) => {
    upserts[table] = dedupeById(upserts[table])
    deleteIds[table] = Array.from(new Set(deleteIds[table]))
  })

  // 6) 统一推导受影响裂缝：新增/改动测次或建议的裂缝、删除/新增的裂缝、删除环片下的裂缝
  upserts.surveys.forEach((survey) => affectedCrackIds.add(String(asRecord(survey).crackId)))
  upserts.advices.forEach((advice) => affectedCrackIds.add(String(asRecord(advice).crackId)))
  upserts.cracks.forEach((crack) => affectedCrackIds.add(crack.id))
  deleteIds.cracks.forEach((crackId) => affectedCrackIds.add(crackId))

  return {
    upserts,
    deleteIds,
    incomingTombstones: dedupeTombstones(incomingTombstones),
    affectedCrackIds: Array.from(affectedCrackIds).filter(Boolean)
  }
}

function splitRemapKey(key: string): [MergeTable, string] {
  const sep = key.indexOf(':')
  return [key.slice(0, sep) as MergeTable, key.slice(sep + 1)]
}

function expandRingClone(
  oldRingId: string,
  newRingId: string,
  remote: TableIndex,
  idRemap: Map<string, string>,
  token: string
): void {
  void newRingId
  remote.cracks.forEach((crack) => {
    if (String(asRecord(crack).ringId) !== oldRingId) return
    idRemap.set(remapKeyStr('cracks', crack.id), `${crack.id}__dup_${token}`)
    expandCrackClone(crack.id, '', remote, idRemap, token)
  })
}

function expandCrackClone(
  oldCrackId: string,
  _newCrackId: string,
  remote: TableIndex,
  idRemap: Map<string, string>,
  token: string
): void {
  remote.surveys.forEach((survey) => {
    if (String(asRecord(survey).crackId) !== oldCrackId) return
    idRemap.set(remapKeyStr('surveys', survey.id), `${survey.id}__dup_${token}`)
  })
  remote.advices.forEach((advice) => {
    if (String(asRecord(advice).crackId) !== oldCrackId) return
    idRemap.set(remapKeyStr('advices', advice.id), `${advice.id}__dup_${token}`)
  })
}

function remapKeyStr(table: MergeTable, id: string): string {
  return `${table}:${id}`
}

function cloneEntity(
  table: MergeTable,
  source: MergeEntity,
  newId: string,
  idRemap: Map<string, string>,
  token: string
): MergeEntity {
  void token
  const record = asRecord(source)
  const cloned: Record<string, unknown> = { ...record, id: newId }
  if (table === 'cracks') {
    const newRingId = idRemap.get(remapKeyStr('rings', String(record.ringId)))
    if (newRingId) cloned.ringId = newRingId
    cloned.mergeTag = `对侧并列·${dateStamp()}`
  } else if (table === 'rings') {
    cloned.mergeTag = `对侧并列·${dateStamp()}`
  } else if (table === 'surveys') {
    const newCrackId = idRemap.get(remapKeyStr('cracks', String(record.crackId)))
    if (newCrackId) cloned.crackId = newCrackId
    cloned.seq = 0 // 入库后统一按日期重排
    cloned.mergeTag = `对侧并列·${dateStamp()}`
  } else if (table === 'advices') {
    const newCrackId = idRemap.get(remapKeyStr('cracks', String(record.crackId)))
    if (newCrackId) cloned.crackId = newCrackId
  }
  cloned.revision = ROW_REVISION
  return cloned as unknown as MergeEntity
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function dedupeById(rows: MergeEntity[]): MergeEntity[] {
  const map = new Map<string, MergeEntity>()
  rows.forEach((row) => map.set(row.id, row))
  return Array.from(map.values())
}

function dedupeTombstones(rows: Tombstone[]): Tombstone[] {
  const map = new Map<string, Tombstone>()
  rows.forEach((row) => map.set(row.id, row))
  return Array.from(map.values())
}

function cascadeDeleteIds(
  deleteIds: Record<MergeTable, string[]>,
  local: TableIndex,
  remote: TableIndex,
  incomingTombstones: Tombstone[],
  staging: MergeStaging
): void {
  const now = Date.now()
  const addTomb = (table: MergeTable, entityId: string, label: string): void => {
    incomingTombstones.push({
      id: tombstoneId(table, entityId),
      table,
      entityId,
      deletedAt: now,
      label,
      createdAt: now,
      updatedAt: now
    })
  }

  // 区间删除 → 环片 → 裂缝 → 测次/建议
  const sectionIds = new Set(deleteIds.sections)
  sectionIds.forEach((sectionId) => {
    const rings = new Set<string>()
    ;[...local.rings.values(), ...remote.rings.values()].forEach((ring) => {
      if (String(asRecord(ring).sectionId) === sectionId) rings.add(ring.id)
    })
    rings.forEach((ringId) => {
      if (!deleteIds.rings.includes(ringId)) deleteIds.rings.push(ringId)
    })
  })

  const ringIds = new Set(deleteIds.rings)
  ringIds.forEach((ringId) => {
    const cracks = new Set<string>()
    ;[...local.cracks.values(), ...remote.cracks.values()].forEach((crack) => {
      if (String(asRecord(crack).ringId) === ringId) cracks.add(crack.id)
    })
    cracks.forEach((crackId) => {
      if (!deleteIds.cracks.includes(crackId)) deleteIds.cracks.push(crackId)
    })
  })

  const crackIds = new Set(deleteIds.cracks)
  crackIds.forEach((crackId) => {
    ;[...local.surveys.values(), ...remote.surveys.values()].forEach((survey) => {
      if (String(asRecord(survey).crackId) === crackId && !deleteIds.surveys.includes(survey.id)) {
        deleteIds.surveys.push(survey.id)
      }
    })
    ;[...local.advices.values(), ...remote.advices.values()].forEach((advice) => {
      if (String(asRecord(advice).crackId) === crackId && !deleteIds.advices.includes(advice.id)) {
        deleteIds.advices.push(advice.id)
      }
    })
  })

  // 为每个最终删除生成墓碑（含级联），使删除可继续向其他副本合并
  const tombsInSnapshot = new Set((staging.remoteSnapshot.tombstones ?? []).map((t) => t.id))
  MERGE_TABLES.forEach((table) => {
    deleteIds[table].forEach((entityId) => {
      const tid = tombstoneId(table, entityId)
      if (!tombsInSnapshot.has(tid) && !incomingTombstones.some((t) => t.id === tid)) {
        const row = remote[table].get(entityId) ?? local[table].get(entityId) ?? null
        addTomb(table, entityId, row ? entityLabel(table, row) : MERGE_TABLE_LABEL[table])
      }
    })
  })
}

/** 是否还存在未处理冲突（未处理不允许入库） */
export function pendingConflicts(staging: MergeStaging): MergeConflict[] {
  return staging.conflicts.filter((conflict) => conflict.resolution === null)
}
