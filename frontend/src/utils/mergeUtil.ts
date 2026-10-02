/**
 * 合并通用工具：行指纹、显示名、备份规整、三向状态判定。
 * 不触碰 IndexedDB 与 localStorage，纯函数，便于核对与复用。
 */
import type { BackupPayload, SectionRow, RingRow, CrackRow, SurveyRow, AdviceRow, TombstoneRow } from '@/utils/db'
import type { AnyEntityRow, EntityRowsByTable, MergeEntry, MergeResolution, RowStatus, ChangeSide } from '@/types/merge'
import { ENTITY_TABLES, type EntityTable, type Tombstone } from '@/types/tombstone'
import { formatMileage } from '@/types/section'

export interface LabelContext {
  rings?: RingRow[]
  cracks?: CrackRow[]
}

/** 便于核验人辨认的记录名 */
export function entityLabel(table: EntityTable, row: AnyEntityRow | Tombstone, context?: LabelContext): string {
  switch (table) {
    case 'sections': {
      const section = row as SectionRow
      return `${section.line} ${formatMileage(section.startMileage)}～${formatMileage(section.endMileage)}`
    }
    case 'rings':
      return `第 ${(row as RingRow).ringNo} 环`
    case 'cracks':
      return (row as CrackRow).code
    case 'surveys': {
      const survey = row as SurveyRow
      const crack = context?.cracks?.find((item) => item.id === survey.crackId)
      return `${crack?.code ?? survey.crackId} · 第 ${survey.seq} 测次（${survey.date}）`
    }
    case 'advices': {
      const advice = row as AdviceRow
      const crack = context?.cracks?.find((item) => item.id === advice.crackId)
      return `${crack?.code ?? advice.crackId} · ${advice.measure}建议`
    }
  }
}

/** 参与比对的业务字段（主键与时间戳不参与内容指纹） */
const SIGNATURE_OMIT = new Set(['id', 'createdAt', 'updatedAt', 'revision'])

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }
  return value
}

/** 行内容指纹：剔除主键/时间戳后按键名排序序列化，比对不受键序影响 */
export function signatureOf(row: object): string {
  const source = row as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  Object.keys(source).forEach((key) => {
    if (!SIGNATURE_OMIT.has(key)) picked[key] = source[key]
  })
  return JSON.stringify(sortKeys(picked))
}

export function sameRow(a: object | null, b: object | null): boolean {
  if (!a || !b) return false
  return signatureOf(a) === signatureOf(b)
}

/** 生成并列副本 / 克隆子记录用的主键 */
export function mergeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 班组名裁剪为副本后缀 */
export function crewSuffix(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '对端版'
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}版` : `${trimmed}版`
}

/* ------------------------------ 备份规整 ------------------------------ */

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** 旧版（v1/v2）备份兼容：缺列补默认、裂缝回填 sectionId */
export function normalizePayload(payload: BackupPayload): EntityRowsByTable {
  const sections = asArray<SectionRow>(payload.sections)
  const rings = asArray<RingRow>(payload.rings)
  const sectionByRing = new Map(rings.map((ring) => [ring.id, ring.sectionId]))
  const cracks = asArray<CrackRow>(payload.cracks).map((crack) => ({
    ...crack,
    sectionId: crack.sectionId || sectionByRing.get(crack.ringId) || ''
  }))
  const surveys = asArray<SurveyRow>(payload.surveys).map((survey) => ({
    ...survey,
    seq: typeof survey.seq === 'number' ? survey.seq : 0,
    deltaWidthMm: typeof survey.deltaWidthMm === 'number' ? survey.deltaWidthMm : 0
  }))
  const advices = asArray<AdviceRow>(payload.advices)
  const tombstones = asArray<TombstoneRow>(payload.tombstones ?? [])
  return { sections, rings, cracks, surveys, advices, tombstones }
}

export function emptyRows(): EntityRowsByTable {
  return { sections: [], rings: [], cracks: [], surveys: [], advices: [], tombstones: [] }
}

/* ------------------------------ 三向比对 ------------------------------ */

type SideState = 'same' | 'modified' | 'deleted' | 'absent'

interface SideSnapshot {
  rows: Map<string, AnyEntityRow>
  tombstones: Map<string, TombstoneRow>
}

function indexRows(rows: EntityRowsByTable): Record<EntityTable, SideSnapshot> {
  const result = {} as Record<EntityTable, SideSnapshot>
  ENTITY_TABLES.forEach((table) => {
    const list = rows[table] as AnyEntityRow[]
    result[table] = {
      rows: new Map(list.map((row) => [row.id, row])),
      tombstones: new Map(
        rows.tombstones.filter((tombstone) => tombstone.table === table).map((tombstone) => [tombstone.entityId, tombstone])
      )
    }
  })
  return result
}

function sideState(
  snapshot: SideSnapshot,
  entityId: string,
  baseRow: AnyEntityRow | null
): SideState {
  const row = snapshot.rows.get(entityId) ?? null
  const deleted = snapshot.tombstones.has(entityId)
  if (deleted) return 'deleted'
  if (!row) return baseRow ? 'absent' : 'same'
  if (!baseRow) return 'modified'
  return sameRow(baseRow, row) ? 'same' : 'modified'
}

function pendingResolution(keepBothSupported: boolean): MergeResolution {
  return {
    type: keepBothSupported ? 'keep-both' : 'skip',
    decidedBy: '',
    decidedAt: null
  }
}

/** 支持并列保留的实体：裂缝、环片、测次（需求明确列举） */
export const KEEP_BOTH_TABLES: EntityTable[] = ['cracks', 'rings', 'surveys']

/**
 * 三向比对：以基线为共同祖先，逐行判定本机/对端相对基线的变化。
 * 单改自动接回；双改裂缝/环片/测次记为冲突并默认并列；其余双改交核验人二选一。
 *
 * @param missingBaseline 无导出基线时的兜底：内容相同即无变化，对端新增自动接回，
 *                        两边同 id 内容不同仍按双改处理，对端删除无法佐证则忽略（不误删本机）。
 */
export function buildMergeEntries(
  baselineRows: EntityRowsByTable,
  localRows: EntityRowsByTable,
  incomingRows: EntityRowsByTable,
  missingBaseline = false
): MergeEntry[] {
  const base = indexRows(baselineRows)
  const local = indexRows(localRows)
  const incoming = indexRows(incomingRows)
  const entries: MergeEntry[] = []

  ENTITY_TABLES.forEach((table) => {
    const context = {
      rings: localRows.rings.concat(incomingRows.rings),
      cracks: localRows.cracks.concat(incomingRows.cracks)
    }
    const ids = new Set<string>([
      ...base[table].rows.keys(),
      ...local[table].rows.keys(),
      ...incoming[table].rows.keys()
    ])
    ids.forEach((id) => {
      const baseRow = base[table].rows.get(id) ?? null
      const localRow = local[table].rows.get(id) ?? null
      const incomingRow = incoming[table].rows.get(id) ?? null
      const localDeleted = local[table].tombstones.has(id)
      const incomingDeleted = incoming[table].tombstones.has(id)

      // 两边都没有活记录且两边都留了删除墓碑：变化一致，无需处理
      if (!baseRow && localDeleted && incomingDeleted) return

      const lState = sideState(local[table], id, baseRow)
      const iState = sideState(incoming[table], id, baseRow)
      if (lState === 'same' && iState === 'same') return

      let side: ChangeSide
      let status: RowStatus
      let resolution: MergeResolution
      const keepBoth = KEEP_BOTH_TABLES.includes(table)

      // 无基线兜底：两边都有同内容记录即视为无变化，删除因无祖先佐证一律不自动生效
      if (missingBaseline && !baseRow) {
        if (localRow && incomingRow) {
          if (sameRow(localRow, incomingRow)) return
          side = 'both'
          status = 'conflicted'
          resolution = pendingResolution(keepBoth)
        } else if (incomingRow && !localRow) {
          side = 'incoming-only'
          status = 'added'
          resolution = { type: 'auto', decidedBy: '', decidedAt: null }
        } else if (localRow && !incomingRow) {
          // 对端没有该记录：可能对端已删，也可能从未见过，无基线不自动删除本机记录
          return
        } else {
          return
        }
        entries.push({
          id: `me_${table}_${id}`,
          table,
          side,
          status,
          label: entityLabel(table, (localRow ?? incomingRow)!, context),
          baseRow,
          localRow,
          incomingRow,
          resolution
        })
        return
      }

      if (lState !== 'same' && iState !== 'same') {
        // 两边都撤去同一记录：变化一致，自动收敛，不报冲突
        if (lState === 'deleted' && iState === 'deleted') return
        side = 'both'
        status = 'conflicted'
        resolution = pendingResolution(keepBoth)
      } else if (lState !== 'same') {
        side = 'local-only'
        status = lState === 'deleted' ? 'deleted' : baseRow ? 'modified' : 'added'
        resolution = { type: 'auto', decidedBy: '', decidedAt: null }
      } else {
        side = 'incoming-only'
        status = iState === 'deleted' ? 'deleted' : baseRow ? 'modified' : 'added'
        resolution = { type: 'auto', decidedBy: '', decidedAt: null }
      }

      const displayRow = localRow ?? incomingRow ?? baseRow
      entries.push({
        id: `me_${table}_${id}`,
        table,
        side,
        status,
        label: displayRow ? entityLabel(table, displayRow, context) : id,
        baseRow,
        localRow,
        incomingRow,
        resolution
      })
    })
  })

  return entries
}

/** 查某条记录在指定侧的删除墓碑 */
export function findTombstone(rows: EntityRowsByTable, table: EntityTable, entityId: string): TombstoneRow | null {
  return rows.tombstones.find((item) => item.table === table && item.entityId === entityId) ?? null
}
