/** 逻辑删除标记：撤去的记录不物理抹掉，留下可随备份合并的删除变化 */
export type EntityTable = 'sections' | 'rings' | 'cracks' | 'surveys' | 'advices'

export const ENTITY_TABLES: EntityTable[] = ['sections', 'rings', 'cracks', 'surveys', 'advices']

export interface Tombstone {
  id: string
  /** 被删除记录所属的实体表 */
  table: EntityTable
  /** 被删除记录的主键（与其原表 id 相同） */
  entityId: string
  /** 冗余外键：环片/裂缝/复测/建议所属区间，便于级联清理 */
  sectionId?: string
  /** 冗余外键：裂缝/复测/建议所属环片 */
  ringId?: string
  /** 冗余外键：复测/建议所属裂缝 */
  crackId?: string
  /** 便于核验人辨认的名称，如裂缝编号 / 环号 / 测次日期 */
  label: string
  /** 删除前的内容指纹，供合并时与对侧改动对照 */
  signature: string
  deletedBy: string
  deletedAt: number
  /** 来源：本机操作或外部备份合并 */
  origin: 'local' | 'imported'
}

/** 各表外键级联顺序（父表 → 子表），删除与并墓时复用 */
export const CHILD_TABLES: Record<EntityTable, EntityTable[]> = {
  sections: ['rings', 'cracks', 'surveys', 'advices'],
  rings: ['cracks', 'surveys', 'advices'],
  cracks: ['surveys', 'advices'],
  surveys: [],
  advices: []
}
