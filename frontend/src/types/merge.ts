/**
 * 离线合并的暂存与冲突模型。
 * 三向合并：base（共同基线）/ local（本机当前）/ remote（对侧备份）。
 */
import type { BackupPayload } from '@/utils/db'
import type { MergeTable, MergeEntityMap } from '@/types/tombstone'

/** 合并基线模式：三方（携带共同基线）/ 无基线（旧版备份，保守合并） */
export type MergeMode = 'three-way' | 'legacy'

/**
 * 冲突种类：
 * - both-edited  两边都改了同一条（裂缝/环片/测次可并列，其余须核验人定夺）
 * - delete-edit  一边删除、另一边修改
 * - both-deleted 两边都删（信息性，自动随删除）
 * - legacy-add   无基线下双方都新增了相同 id
 */
export type ConflictKind = 'both-edited' | 'delete-edit' | 'both-deleted' | 'legacy-add'

/** 删除发生在哪一侧（相对本机） */
export type DeleteSide = 'local' | 'remote'

/**
 * 核验人的处理决定：
 * - parallel 并列保留（仅裂缝/环片/测次）：保留两侧，对侧记录复制为新 id
 * - local    保留本机版本，丢弃对侧该条变化
 * - remote   接回对侧版本（删除冲突时表示接回对侧、撤销本机删除）
 * - delete   执行删除（delete-edit 中「按删除处理」）
 * - drop     放弃对侧该条（legacy-add / 不采纳）
 */
export type ResolutionKind = 'parallel' | 'local' | 'remote' | 'delete' | 'drop'

/** 一条业务记录在合并暂存中的归一形态（已剥离 revision） */
export type MergeEntity = MergeEntityMap[MergeTable]

export interface FieldChange {
  field: string
  base: unknown
  local: unknown
  remote: unknown
}

export interface MergeConflict {
  /** 冲突在一次暂存内的稳定键：表 + 主键 + 种类（重试同一备份保持不变） */
  key: string
  table: MergeTable
  entityId: string
  kind: ConflictKind
  deleteSide?: DeleteSide
  /** 并列保留是否可行（裂缝/环片/测次的 both-edited） */
  parallelable: boolean
  /** 两侧记录快照（删除侧可能缺失） */
  local: MergeEntity | null
  remote: MergeEntity | null
  base: MergeEntity | null
  /** 字段级差异（用于核验人查看） */
  changes: FieldChange[]
  /** 核验人决定；null 表示尚未处理（未处理冲突不允许入库） */
  resolution: ResolutionKind | null
  /** 并列保留时对侧复制行将使用的新 id（确定性，保证重试幂等） */
  cloneId?: string
}

/** 自动接回的变化（无需核验人介入） */
export interface MergeAutoChange {
  table: MergeTable
  entityId: string
  /** add 新增 / update 一侧改另一侧未动 / delete 一侧删另一侧未动 */
  action: 'add' | 'update' | 'delete'
  /** 接回来源记录（delete 时为 null） */
  incoming: MergeEntity | null
  label: string
}

export interface MergeSummary {
  autoAdd: number
  autoUpdate: number
  autoDelete: number
  conflictCount: number
  pendingCount: number
}

/**
 * 合并暂存现场：导入备份后生成，核验人处理冲突，随后一次性入库。
 * 整条持久化到 mergeStaging 表，中断/刷新后可原样恢复。
 */
export interface MergeStaging {
  /** 暂存主键 = 对侧备份指纹（同一备份重复导入幂等） */
  id: string
  createdAt: number
  updatedAt: number
  mode: MergeMode
  /** 对侧备份导出时间与结构版本 */
  remoteExportedAt: string
  remoteDbVersion: number
  /** 基线 id（legacy 模式为空串） */
  baselineId: string
  fileName: string
  /** 生成暂存时本机快照，保证现场不因本机后续改动而失真 */
  localSnapshot: BackupPayload
  remoteSnapshot: BackupPayload
  baseSnapshot: BackupPayload | null
  autoChanges: MergeAutoChange[]
  conflicts: MergeConflict[]
  /** 是否已入库提交 */
  committed: boolean
  committedAt?: number
}

/** 基线快照：一次成功合并或显式导出后记录，供下一次三向合并对照 */
export interface BaselineSnapshot {
  /** 内容指纹，作为基线标识；两侧从同一版台账导出时一致 */
  id: string
  createdAt: number
  dbVersion: number
  sections: MergeEntity[]
  rings: MergeEntity[]
  cracks: MergeEntity[]
  surveys: MergeEntity[]
  advices: MergeEntity[]
}

/** meta 表中保存当前基线/合并日志的记录 */
export interface MetaState {
  id: 'merge-meta'
  baseline: BaselineSnapshot | null
  /** 已成功合并的对侧备份指纹，防止重复入账 */
  mergedFingerprints: string[]
  lastMergeAt: number | null
}
