/**
 * 导出基线：两班组分头复测时的共同祖先快照。
 * 导出备份同时落一份基线到 localStorage（离线、无后端），
 * 合并对侧备份时做三向比对（本机 / 对端 / 基线）。
 */
import type { EntityRowsByTable } from '@/types/merge'

/** 基线元信息 + 全量行快照（与 BackupPayload 同构，额外带导出指纹） */
export interface MergeBaseline {
  app: 'gbtunnelcrack-baseline'
  /** 基线对应备份的 sha256 摘要 */
  hash: string
  exportedAt: string
  dbVersion: number
  /** 导出操作人/班组名 */
  exportedBy: string
  rows: EntityRowsByTable
}

export const BASELINE_APP = 'gbtunnelcrack-baseline'

/** localStorage 键：最近一次导出基线（只保留一版即可支持三向合并） */
export const BASELINE_LS_KEY = 'gbtunnelcrack:merge-baseline'
/** localStorage 键：合并暂存会话（合并中断后恢复现场） */
export const MERGE_SESSION_LS_KEY = 'gbtunnelcrack:merge-session'
/** localStorage 键：本机班组/操作人名，导出与删除留痕时带出 */
export const CREW_NAME_LS_KEY = 'gbtunnelcrack:crew-name'
/** localStorage 键：已合并备份摘要，重试同一备份不再多记 */
export const MERGED_HASHES_LS_KEY = 'gbtunnelcrack:merged-hashes'
/** localStorage 键：并列副本与原记录的归组关系 */
export const DUPLICATE_GROUPS_LS_KEY = 'gbtunnelcrack:duplicate-groups'
