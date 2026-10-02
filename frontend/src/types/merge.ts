/**
 * 离线合并（三向比对）域类型
 * 一侧（本机）与另一班组建的备份，相对共同基线逐行比对；
 * 单改自动接回，双改（裂缝/环片/测次）并列保留，交核验人处理后入库。
 */
import type { EntityTable } from '@/types/tombstone'
import type { SectionRow, RingRow, CrackRow, SurveyRow, AdviceRow, TombstoneRow } from '@/utils/db'

export type AnyEntityRow = SectionRow | RingRow | CrackRow | SurveyRow | AdviceRow

export interface EntityRowsByTable {
  sections: SectionRow[]
  rings: RingRow[]
  cracks: CrackRow[]
  surveys: SurveyRow[]
  advices: AdviceRow[]
  tombstones: TombstoneRow[]
}

/** 单行相对基线的变化方向 */
export type ChangeSide = 'local-only' | 'incoming-only' | 'both'

export type RowStatus = 'added' | 'modified' | 'deleted' | 'unchanged' | 'conflicted'

/** 并列保留时给双改副本临时挂的来源标记 */
export type DuplicateOrigin = 'local' | 'incoming'

/** 一条待合并记录的比对结果（核验人在评审页看到的最小单元） */
export interface MergeEntry {
  id: string
  table: EntityTable
  /** 变化落在哪一侧 */
  side: ChangeSide
  /** 综合状态：both-modified 记为 conflicted */
  status: RowStatus
  /** 便于核验人辨认的名称 */
  label: string
  baseRow: AnyEntityRow | null
  localRow: AnyEntityRow | null
  incomingRow: AnyEntityRow | null
  /** 双改并列后，本机/对端副本的新主键（入库后回填） */
  duplicateLocalId?: string
  duplicateIncomingId?: string
  /** 核验决定 */
  resolution: MergeResolution
}

export type MergeResolutionType =
  | 'auto' // 单改自动接回，无需人决
  | 'keep-both' // 双改并列保留（默认）
  | 'take-local' // 仅保留本机版本
  | 'take-incoming' // 仅保留对端版本
  | 'skip' // 暂不处理（挂起后可继续入库其余项）

export interface MergeResolution {
  type: MergeResolutionType
  decidedBy: string
  decidedAt: number | null
  note?: string
}

/** 合并暂存（中断后可恢复；同一备份重试不会多记一条） */
export interface MergeSession {
  /** 备份文件 sha256 摘要，天然去重键 */
  backupHash: string
  /** 备份导出时间 */
  backupExportedAt: string
  /** 备份导出班组/操作人 */
  backupExportedBy: string
  /** 备份声明的结构版本（旧版备份也能读入） */
  backupDbVersion: number
  /** 备份内各表行数，评审页展示用 */
  incomingCounts: Record<string, number>
  /** 是否缺少导出基线（按「双方新增」兜底合并） */
  missingBaseline: boolean
  /** 共同基线快照 */
  baseline: EntityRowsByTable
  /** 评审开始时本机数据快照（仅做冲突展示，不入库） */
  localSnapshot: EntityRowsByTable
  /** 对端备份规整后的全量行（执行并列克隆时作为数据源） */
  incoming: EntityRowsByTable
  /** 全部比对条目（已 auto 处理的也保留，便于复核与去重） */
  entries: MergeEntry[]
  /** 已提交入库的条目 id（断点续作用） */
  committedEntryIds: string[]
  /** 已生成的并列副本映射：entryId -> { localId, incomingId } */
  duplicateIds: Record<string, { localId: string; incomingId: string }>
  status: 'open' | 'committed' | 'discarded'
  createdAt: number
  updatedAt: number
}

export interface MergeStats {
  total: number
  auto: number
  conflicts: number
  resolved: number
  pending: number
  committed: number
}
