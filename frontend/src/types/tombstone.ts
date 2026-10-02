/**
 * 合并墓碑：删除记录时落一行墓碑，使「删除」成为一种可离线合并的变化。
 * 对侧若未改过该记录，合并时自动接回删除；对侧若也改过，则作为冲突交核验人。
 */
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import type { Revisioned } from '@/utils/db'

/** 受合并管理的五类业务表 */
export type MergeTable = 'sections' | 'rings' | 'cracks' | 'surveys' | 'advices'

export const MERGE_TABLES: MergeTable[] = ['sections', 'rings', 'cracks', 'surveys', 'advices']

/** 各业务表对应的实体类型 */
export interface MergeEntityMap {
  sections: Section
  rings: Ring
  cracks: Crack
  surveys: Survey
  advices: Advice
}

/** 表中文名，用于冲突展示 */
export const MERGE_TABLE_LABEL: Record<MergeTable, string> = {
  sections: '区间',
  rings: '环片',
  cracks: '裂缝',
  surveys: '复测',
  advices: '整治建议'
}

/** 支持「并列保留」的表：裂缝、环片、测次两边都改时自动并列 */
export const PARALLEL_TABLES: MergeTable[] = ['rings', 'cracks', 'surveys']

export interface Tombstone {
  /** 主键固定为 ts_<table>_<entityId>，重复删除幂等 */
  id: string
  table: MergeTable
  entityId: string
  deletedAt: number
  /** 删除时的编号/名称快照，便于合并暂存中展示 */
  label: string
  createdAt: number
  updatedAt: number
}

export type TombstoneRow = Tombstone & Revisioned

/** 墓碑主键：同一行记录的删除只产生一条墓碑 */
export function tombstoneId(table: MergeTable, entityId: string): string {
  return `ts_${table}_${entityId}`
}
