/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与 upgrade 迁移逻辑
 * - 表级增删改查、级联删除、整库导入导出
 * - 纯前端应用：不依赖任何后端服务或数据库
 */
import Dexie, { type Table } from 'dexie'
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import type { TombstoneRow } from '@/types/tombstone'
import type { BaselineSnapshot, MergeStaging, MetaState } from '@/types/merge'
import { tombstoneId, type MergeTable } from '@/types/tombstone'
import { fingerprintBaseline } from '@/utils/fingerprint'

/** IndexedDB 数据库名 */
export const DB_NAME = 'gbtunnelcrack'

/** 当前数据结构版本号：调整表结构必须递增并补 upgrade 迁移 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbtunnelcrack:db-version',
  lastBackupAt: 'gbtunnelcrack:last-backup-at',
  lastMergeAt: 'gbtunnelcrack:last-merge-at',
  uiPrefs: 'gbtunnelcrack:ui-prefs'
} as const

export interface UiPrefs {
  lastSectionId: string | null
  trendOnlyWarning: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastSectionId: null,
  trendOnlyWarning: false
}

/** 整库备份文件结构（v3 起携带基线与墓碑，旧版备份缺字段时按可选读取） */
export interface BackupPayload {
  app: 'gbtunnelcrack'
  dbVersion: number
  exportedAt: string
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
  advices: Advice[]
  /** 合并墓碑（旧版备份无此字段） */
  tombstones?: TombstoneRow[]
  /** 导出时所依据的共同基线内容指纹（旧版备份无此字段） */
  baselineId?: string
}

/** 带行修订号的持久化实体，便于逐行迁移 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision?: number
}

export const ROW_REVISION = 3

export type SectionRow = Section & Revisioned
export type RingRow = Ring & Revisioned
export type CrackRow = Crack & Revisioned
export type SurveyRow = Survey & Revisioned
export type AdviceRow = Advice & Revisioned

class TunnelCrackDatabase extends Dexie {
  sections!: Table<SectionRow, string>
  rings!: Table<RingRow, string>
  cracks!: Table<CrackRow, string>
  surveys!: Table<SurveyRow, string>
  advices!: Table<AdviceRow, string>
  /** 删除墓碑：让「删除」成为可离线合并的变化 */
  tombstones!: Table<TombstoneRow, string>
  /** 单行元数据：当前合并基线、已合并备份指纹 */
  meta!: Table<MetaState, string>
  /** 合并暂存现场（中断后可恢复） */
  mergeStaging!: Table<MergeStaging, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构
    this.version(1).stores({
      sections: 'id, line, structureType, startMileage',
      rings: 'id, sectionId, ringNo, mileage',
      cracks: 'id, ringId, code, position, direction, state',
      surveys: 'id, crackId, seq, date',
      advices: 'id, crackId, level, measure, state'
    })

    // v2：裂缝补充 sectionId 冗余列（按区间筛选/统计免联表）；复测补充 surveyor 索引；建议补充 note 字段
    this.version(2)
      .stores({
        sections: 'id, line, structureType, startMileage, updatedAt',
        rings: 'id, sectionId, ringNo, mileage, segmentType, updatedAt',
        cracks: 'id, ringId, sectionId, code, position, direction, state, updatedAt',
        surveys: 'id, crackId, seq, date, surveyor, updatedAt',
        advices: 'id, crackId, level, measure, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：为全部业务行补齐 revision
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('sections'),
          tx.table('rings'),
          tx.table('cracks'),
          tx.table('surveys'),
          tx.table('advices')
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }

        // 迁移 2：历史裂缝缺少 sectionId，用所属环片回填
        const ringRows = (await tx.table('rings').toArray()) as Array<{ id: string; sectionId: string }>
        const sectionOfRing = new Map(ringRows.map((ring) => [ring.id, ring.sectionId]))
        await tx
          .table('cracks')
          .toCollection()
          .modify((crack: Record<string, unknown>) => {
            if (typeof crack.sectionId !== 'string' || crack.sectionId.length === 0) {
              crack.sectionId = sectionOfRing.get(String(crack.ringId)) ?? ''
            }
            if (typeof crack.state !== 'string') crack.state = '观察'
          })

        // 迁移 3：复测缺失变化量时按前一次测次补算（仅补 0，避免误判速率）
        await tx
          .table('surveys')
          .toCollection()
          .modify((survey: Record<string, unknown>) => {
            if (typeof survey.deltaWidthMm !== 'number' || !Number.isFinite(survey.deltaWidthMm)) {
              survey.deltaWidthMm = 0
            }
          })
      })

    // v3：新增合并墓碑、元数据、合并暂存三张表，支持两班离线三向合并
    this.version(DB_VERSION).stores({
      sections: 'id, line, structureType, startMileage, updatedAt',
      rings: 'id, sectionId, ringNo, mileage, segmentType, updatedAt',
      cracks: 'id, ringId, sectionId, code, position, direction, state, updatedAt',
      surveys: 'id, crackId, seq, date, surveyor, updatedAt',
      advices: 'id, crackId, level, measure, state, updatedAt',
      tombstones: 'id, table, entityId, deletedAt',
      meta: 'id',
      mergeStaging: 'id, createdAt, committed'
    })
  }
}

export const db = new TunnelCrackDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')

function stamp(offsetDays = 0): number {
  return SEED_STAMP + offsetDays * 86400000
}

const SEED_SECTIONS: SectionRow[] = [
  {
    id: 'sec-1',
    line: '1号线',
    startMileage: 12300,
    endMileage: 13150,
    structureType: '盾构',
    ringCount: 42,
    createdAt: stamp(-120),
    updatedAt: stamp(-6),
    revision: ROW_REVISION
  },
  {
    id: 'sec-2',
    line: '2号线',
    startMileage: 5000,
    endMileage: 5720,
    structureType: '明挖',
    ringCount: 36,
    createdAt: stamp(-96),
    updatedAt: stamp(-4),
    revision: ROW_REVISION
  }
]

const SEED_RINGS: RingRow[] = [
  { id: 'ring-1', sectionId: 'sec-1', ringNo: 118, mileage: 12300, segmentType: '钢筋混凝土', installDate: '2016-04-18', createdAt: stamp(-118), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'ring-2', sectionId: 'sec-1', ringNo: 132, mileage: 12468, segmentType: '钢筋混凝土', installDate: '2016-05-02', createdAt: stamp(-117), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'ring-3', sectionId: 'sec-1', ringNo: 145, mileage: 12625, segmentType: '铸铁', installDate: '2016-06-11', createdAt: stamp(-116), updatedAt: stamp(-5), revision: ROW_REVISION },
  { id: 'ring-4', sectionId: 'sec-2', ringNo: 27, mileage: 5080, segmentType: '钢筋混凝土', installDate: '2019-09-23', createdAt: stamp(-95), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'ring-5', sectionId: 'sec-2', ringNo: 41, mileage: 5220, segmentType: '钢管片', installDate: '2019-10-30', createdAt: stamp(-94), updatedAt: stamp(-4), revision: ROW_REVISION }
]

const SEED_CRACKS: CrackRow[] = [
  { id: 'crack-1', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-01', position: '拱顶', direction: '纵向', widthMm: 0.42, lengthMm: 620, state: '待整治', createdAt: stamp(-110), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'crack-2', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-02', position: '侧墙', direction: '环向', widthMm: 0.18, lengthMm: 410, state: '观察', createdAt: stamp(-110), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'crack-3', ringId: 'ring-2', sectionId: 'sec-1', code: 'SL-132-01', position: '道床', direction: '斜向', widthMm: 0.55, lengthMm: 880, state: '待整治', createdAt: stamp(-104), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'crack-4', ringId: 'ring-3', sectionId: 'sec-1', code: 'SL-145-01', position: '拱顶', direction: '环向', widthMm: 0.24, lengthMm: 350, state: '观察', createdAt: stamp(-99), updatedAt: stamp(-9), revision: ROW_REVISION },
  { id: 'crack-5', ringId: 'ring-4', sectionId: 'sec-2', code: 'NL-027-01', position: '侧墙', direction: '纵向', widthMm: 0.38, lengthMm: 540, state: '已整治', createdAt: stamp(-88), updatedAt: stamp(-20), revision: ROW_REVISION },
  { id: 'crack-6', ringId: 'ring-5', sectionId: 'sec-2', code: 'NL-041-01', position: '拱顶', direction: '斜向', widthMm: 0.12, lengthMm: 260, state: '观察', createdAt: stamp(-60), updatedAt: stamp(-6), revision: ROW_REVISION }
]

const SEED_SURVEYS: SurveyRow[] = [
  // crack-1：0.42 → 0.71 → 1.02，末次月均 0.31 mm/月（严重）
  { id: 'sv-1-1', crackId: 'crack-1', seq: 1, date: '2024-04-08', widthMm: 0.42, lengthMm: 620, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-73), updatedAt: stamp(-73), revision: ROW_REVISION },
  { id: 'sv-1-2', crackId: 'crack-1', seq: 2, date: '2024-05-08', widthMm: 0.71, lengthMm: 690, deltaWidthMm: 0.29, surveyor: '周维', createdAt: stamp(-43), updatedAt: stamp(-43), revision: ROW_REVISION },
  { id: 'sv-1-3', crackId: 'crack-1', seq: 3, date: '2024-06-07', widthMm: 1.02, lengthMm: 745, deltaWidthMm: 0.31, surveyor: '李文博', createdAt: stamp(-13), updatedAt: stamp(-13), revision: ROW_REVISION },
  // crack-2：0.18 → 0.21 → 0.25，末次月均 0.04 mm/月（一般）
  { id: 'sv-2-1', crackId: 'crack-2', seq: 1, date: '2024-04-10', widthMm: 0.18, lengthMm: 410, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-71), updatedAt: stamp(-71), revision: ROW_REVISION },
  { id: 'sv-2-2', crackId: 'crack-2', seq: 2, date: '2024-05-10', widthMm: 0.21, lengthMm: 430, deltaWidthMm: 0.03, surveyor: '李文博', createdAt: stamp(-41), updatedAt: stamp(-41), revision: ROW_REVISION },
  { id: 'sv-2-3', crackId: 'crack-2', seq: 3, date: '2024-06-09', widthMm: 0.25, lengthMm: 452, deltaWidthMm: 0.04, surveyor: '李文博', createdAt: stamp(-11), updatedAt: stamp(-11), revision: ROW_REVISION },
  // crack-3：0.55 → 0.72 → 0.98，末次月均 0.26 mm/月（较重）
  { id: 'sv-3-1', crackId: 'crack-3', seq: 1, date: '2024-04-12', widthMm: 0.55, lengthMm: 880, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-69), updatedAt: stamp(-69), revision: ROW_REVISION },
  { id: 'sv-3-2', crackId: 'crack-3', seq: 2, date: '2024-05-12', widthMm: 0.72, lengthMm: 905, deltaWidthMm: 0.17, surveyor: '陈立', createdAt: stamp(-39), updatedAt: stamp(-39), revision: ROW_REVISION },
  { id: 'sv-3-3', crackId: 'crack-3', seq: 3, date: '2024-06-11', widthMm: 0.98, lengthMm: 962, deltaWidthMm: 0.26, surveyor: '陈立', createdAt: stamp(-9), updatedAt: stamp(-9), revision: ROW_REVISION },
  // crack-4：0.24 → 0.30，末次月均 0.06 mm/月（一般）
  { id: 'sv-4-1', crackId: 'crack-4', seq: 1, date: '2024-04-15', widthMm: 0.24, lengthMm: 350, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-66), updatedAt: stamp(-66), revision: ROW_REVISION },
  { id: 'sv-4-2', crackId: 'crack-4', seq: 2, date: '2024-05-15', widthMm: 0.3, lengthMm: 366, deltaWidthMm: 0.06, surveyor: '周维', createdAt: stamp(-36), updatedAt: stamp(-36), revision: ROW_REVISION },
  // crack-5（已整治）：0.38 → 0.46 后停止复测
  { id: 'sv-5-1', crackId: 'crack-5', seq: 1, date: '2024-02-20', widthMm: 0.38, lengthMm: 540, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-121), updatedAt: stamp(-121), revision: ROW_REVISION },
  { id: 'sv-5-2', crackId: 'crack-5', seq: 2, date: '2024-03-21', widthMm: 0.46, lengthMm: 548, deltaWidthMm: 0.08, surveyor: '陈立', createdAt: stamp(-91), updatedAt: stamp(-91), revision: ROW_REVISION },
  // crack-6：仅初测一次
  { id: 'sv-6-1', crackId: 'crack-6', seq: 1, date: '2024-05-06', widthMm: 0.12, lengthMm: 260, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-45), updatedAt: stamp(-45), revision: ROW_REVISION }
]

const SEED_ADVICES: AdviceRow[] = [
  { id: 'ad-1', crackId: 'crack-1', level: '严重', measure: '钢板带', basis: '月均发展速率 0.310 mm/月，超过严重阈值 0.25 mm/月', state: '已下发', createdAt: stamp(-10), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'ad-2', crackId: 'crack-3', level: '较重', measure: '嵌缝', basis: '月均发展速率 0.260 mm/月，超过预警阈值 0.10 mm/月', state: '待下发', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'ad-3', crackId: 'crack-5', level: '一般', measure: '观测', basis: '月均发展速率 0.080 mm/月，处于观察范围，整治后继续观测', state: '已完成', createdAt: stamp(-85), updatedAt: stamp(-30), revision: ROW_REVISION },
  { id: 'ad-4', crackId: 'crack-2', level: '一般', measure: '注浆', basis: '宽度缓慢增长，侧墙环向裂缝建议预防性注浆封堵', state: '待下发', createdAt: stamp(-7), updatedAt: stamp(-7), revision: ROW_REVISION }
]

/** 幂等播种：仅当主表为空时写入演示数据，并以当前数据为初始合并基线 */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.meta, db.tombstones],
    async () => {
      await db.sections.bulkPut(SEED_SECTIONS)
      await db.rings.bulkPut(SEED_RINGS)
      await db.cracks.bulkPut(SEED_CRACKS)
      await db.surveys.bulkPut(SEED_SURVEYS)
      await db.advices.bulkPut(SEED_ADVICES)
      await adoptCurrentBaseline()
    }
  )
}

/** 应用启动时调用：打开数据库并在首屏为空时播种 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.sections.count()) === 0) {
    await seedDatabase()
    return
  }
  // 老数据升级到 v3 时尚无基线：以当前库内容作为初始基线
  const meta = await getMergeMeta()
  if (!meta.baseline) {
    await adoptCurrentBaseline()
  }
}

/* ============================== 级联删除 ============================== */

/** 删除行时落墓碑（幂等），让删除成为可离线合并的变化 */
export async function putTombstone(table: MergeTable, entityId: string, label: string): Promise<void> {
  const now = Date.now()
  const row: TombstoneRow = {
    id: tombstoneId(table, entityId),
    table,
    entityId,
    deletedAt: now,
    label,
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.tombstones.put(row)
}

/** 从事务内集合里给行取可读名称 */
function labelFor(table: MergeTable, row: unknown): string {
  const record = (row ?? {}) as { [key: string]: unknown }
  if (!row) return table
  if (table === 'cracks') return String(record.code ?? record.id)
  if (table === 'rings') return `第 ${String(record.ringNo ?? '?')} 环`
  if (table === 'sections') return String(record.line ?? record.id)
  if (table === 'surveys') return `复测 ${String(record.date ?? record.id)}`
  return String(record.measure ?? record.id)
}

/** 删除区间：级联删除环片 → 裂缝 → 复测 → 建议（全部落墓碑） */
export async function deleteSectionCascade(sectionId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones],
    async () => {
      const section = await db.sections.get(sectionId)
      const rings = await db.rings.where('sectionId').equals(sectionId).toArray()
      const ringIds = rings.map((ring) => ring.id)
      await deleteCracksOfRings(ringIds)
      for (const ring of rings) await putTombstone('rings', ring.id, labelFor('rings', ring))
      if (ringIds.length > 0) await db.rings.bulkDelete(ringIds)
      await putTombstone('sections', sectionId, labelFor('sections', section))
      await db.sections.delete(sectionId)
    }
  )
}

/** 删除环片：级联删除裂缝及其下游 */
export async function deleteRingCascade(ringId: string): Promise<void> {
  await db.transaction('rw', db.rings, db.cracks, db.surveys, db.advices, db.tombstones, async () => {
    const ring = await db.rings.get(ringId)
    await deleteCracksOfRings([ringId])
    await putTombstone('rings', ringId, labelFor('rings', ring))
    await db.rings.delete(ringId)
  })
}

/** 删除裂缝：级联删除复测与建议 */
export async function deleteCrackCascade(crackId: string): Promise<void> {
  await db.transaction('rw', db.cracks, db.surveys, db.advices, db.tombstones, async () => {
    const crack = await db.cracks.get(crackId)
    const surveys = await db.surveys.where('crackId').equals(crackId).toArray()
    const advices = await db.advices.where('crackId').equals(crackId).toArray()
    for (const survey of surveys) await putTombstone('surveys', survey.id, labelFor('surveys', survey))
    for (const advice of advices) await putTombstone('advices', advice.id, labelFor('advices', advice))
    await db.surveys.where('crackId').equals(crackId).delete()
    await db.advices.where('crackId').equals(crackId).delete()
    await putTombstone('cracks', crackId, labelFor('cracks', crack))
    await db.cracks.delete(crackId)
  })
}

/** 删除单条复测（落墓碑，可离线合并） */
export async function deleteSurveyTombstoned(surveyId: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.tombstones, async () => {
    const survey = await db.surveys.get(surveyId)
    if (survey) await putTombstone('surveys', surveyId, labelFor('surveys', survey))
    await db.surveys.delete(surveyId)
  })
}

/** 删除单条建议（落墓碑，可离线合并） */
export async function deleteAdviceTombstoned(adviceId: string): Promise<void> {
  await db.transaction('rw', db.advices, db.tombstones, async () => {
    const advice = await db.advices.get(adviceId)
    if (advice) await putTombstone('advices', adviceId, labelFor('advices', advice))
    await db.advices.delete(adviceId)
  })
}

async function deleteCracksOfRings(ringIds: string[]): Promise<void> {
  if (ringIds.length === 0) return
  const cracks = await db.cracks.where('ringId').anyOf(ringIds).toArray()
  const crackIds = cracks.map((crack) => crack.id)
  if (crackIds.length > 0) {
    const surveys = await db.surveys.where('crackId').anyOf(crackIds).toArray()
    const advices = await db.advices.where('crackId').anyOf(crackIds).toArray()
    for (const survey of surveys) await putTombstone('surveys', survey.id, labelFor('surveys', survey))
    for (const advice of advices) await putTombstone('advices', advice.id, labelFor('advices', advice))
    await db.surveys.where('crackId').anyOf(crackIds).delete()
    await db.advices.where('crackId').anyOf(crackIds).delete()
    for (const crack of cracks) await putTombstone('cracks', crack.id, labelFor('cracks', crack))
    await db.cracks.bulkDelete(crackIds)
  }
}

/* ============================ 整库导入导出 ============================ */

const META_ID = 'merge-meta'

export const DEFAULT_META: MetaState = {
  id: META_ID,
  baseline: null,
  mergedFingerprints: [],
  lastMergeAt: null
}

/** 读取合并元数据（基线 / 已合并指纹 / 最近合并时间） */
export async function getMergeMeta(): Promise<MetaState> {
  const meta = await db.meta.get(META_ID)
  return meta ?? { ...DEFAULT_META }
}

/** 读取当前合并基线 */
export async function getBaseline(): Promise<BaselineSnapshot | null> {
  const meta = await getMergeMeta()
  return meta.baseline
}

/** 以当前五类业务行内容建立/刷新基线（成功合并或首次导出后调用） */
export async function adoptCurrentBaseline(): Promise<BaselineSnapshot> {
  const [sections, rings, cracks, surveys, advices] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray()
  ])
  const baseline: BaselineSnapshot = {
    id: fingerprintBaseline({ sections, rings, cracks, surveys, advices }),
    createdAt: Date.now(),
    dbVersion: DB_VERSION,
    sections,
    rings,
    cracks,
    surveys,
    advices
  }
  const meta = await getMergeMeta()
  await db.meta.put({ ...meta, id: META_ID, baseline })
  return baseline
}

/** 记录一次成功合并：登记对侧备份指纹（幂等去重）、最近合并时间 */
export async function recordMergedFingerprint(fingerprint: string): Promise<void> {
  const meta = await getMergeMeta()
  const fingerprints = meta.mergedFingerprints.includes(fingerprint)
    ? meta.mergedFingerprints
    : [fingerprint, ...meta.mergedFingerprints].slice(0, 50)
  await db.meta.put({ ...meta, id: META_ID, mergedFingerprints: fingerprints, lastMergeAt: Date.now() })
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [sections, rings, cracks, surveys, advices, tombstones] = await Promise.all([
    db.sections.count(),
    db.rings.count(),
    db.cracks.count(),
    db.surveys.count(),
    db.advices.count(),
    db.tombstones.count()
  ])
  return { sections, rings, cracks, surveys, advices, tombstones }
}

/** 组装整库快照（剥离内部 revision 字段，携带基线标识与墓碑） */
export async function buildSnapshot(): Promise<BackupPayload> {
  const [sections, rings, cracks, surveys, advices, tombstones, meta] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.tombstones.toArray(),
    getMergeMeta()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbtunnelcrack',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    sections: sections.map(strip),
    rings: rings.map(strip),
    cracks: cracks.map(strip),
    surveys: surveys.map(strip),
    advices: advices.map(strip),
    tombstones: tombstones.map(strip),
    baselineId: meta.baseline?.id ?? ''
  }
}

/** 导出整库快照（确保存在基线，保证两侧从同一版台账导出可三向合并） */
export async function exportSnapshot(): Promise<BackupPayload> {
  const meta = await getMergeMeta()
  if (!meta.baseline) await adoptCurrentBaseline()
  return buildSnapshot()
}

/** 读取墓碑行（合并暂存与导出复用） */
export async function listTombstones(): Promise<TombstoneRow[]> {
  return db.tombstones.toArray()
}

/**
 * 归一化读入备份：兼容旧版（dbVersion 1/2，无墓碑/基线字段、行缺字段）。
 * 仅做结构补齐与清洗，不修改本地数据库。
 */
export function normalizePayload(input: unknown): BackupPayload {
  if (typeof input !== 'object' || input === null) throw new Error('备份内容不是有效的 JSON 对象')
  const raw = input as Partial<BackupPayload>
  if (raw.app !== 'gbtunnelcrack') throw new Error('存档文件格式不匹配（缺少 app: gbtunnelcrack 标识）')
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
  const withRev = <T extends object>(row: T): T => ({ revision: ROW_REVISION, ...(row as object) }) as T
  const payload: BackupPayload = {
    app: 'gbtunnelcrack',
    dbVersion: typeof raw.dbVersion === 'number' ? raw.dbVersion : 1,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date(0).toISOString(),
    sections: list<SectionRow>(raw.sections).map(withRev),
    rings: list<RingRow>(raw.rings).map(withRev),
    cracks: list<CrackRow>(raw.cracks).map(withRev),
    surveys: list<SurveyRow>(raw.surveys).map(normalizeSurvey),
    advices: list<AdviceRow>(raw.advices).map(withRev),
    tombstones: list<TombstoneRow>(raw.tombstones).map(withRev),
    baselineId: typeof raw.baselineId === 'string' ? raw.baselineId : ''
  }
  return payload
}

/** 旧版复测行可能缺变化量/复测人，补默认值 */
function normalizeSurvey(row: SurveyRow): SurveyRow {
  return {
    revision: ROW_REVISION,
    ...row,
    deltaWidthMm:
      typeof row.deltaWidthMm === 'number' && Number.isFinite(row.deltaWidthMm) ? row.deltaWidthMm : 0,
    surveyor: typeof row.surveyor === 'string' && row.surveyor.length > 0 ? row.surveyor : '未署名'
  }
}

/** 用快照覆盖整库（保留合并暂存现场与已合并指纹；携带基线时一并采纳） */
export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones, db.meta],
    async () => {
      await Promise.all([
        db.sections.clear(),
        db.rings.clear(),
        db.cracks.clear(),
        db.surveys.clear(),
        db.advices.clear(),
        db.tombstones.clear()
      ])
      const keep = <T>(row: T): T => ({ revision: ROW_REVISION, ...(row as object) }) as T
      await db.sections.bulkPut((payload.sections ?? []).map(keep))
      await db.rings.bulkPut((payload.rings ?? []).map(keep))
      await db.cracks.bulkPut((payload.cracks ?? []).map(keep))
      await db.surveys.bulkPut((payload.surveys ?? []).map(keep))
      await db.advices.bulkPut((payload.advices ?? []).map(keep))
      await db.tombstones.bulkPut((payload.tombstones ?? []).map(keep))

      // 覆盖导入携带基线时采纳；旧版备份无基线则以导入后的内容建立基线
      const meta = await getMergeMeta()
      if (payload.baselineId) {
        const baseline: BaselineSnapshot = {
          id: payload.baselineId,
          createdAt: Date.now(),
          dbVersion: payload.dbVersion,
          sections: payload.sections ?? [],
          rings: payload.rings ?? [],
          cracks: payload.cracks ?? [],
          surveys: payload.surveys ?? [],
          advices: payload.advices ?? []
        }
        await db.meta.put({ ...meta, baseline })
      } else if (!meta.baseline) {
        await adoptCurrentBaseline()
      }
    }
  )
}

/** 清空全部业务表（含墓碑、基线、合并暂存），用于重置/清空 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones, db.meta, db.mergeStaging],
    async () => {
      await Promise.all([
        db.sections.clear(),
        db.rings.clear(),
        db.cracks.clear(),
        db.surveys.clear(),
        db.advices.clear(),
        db.tombstones.clear(),
        db.mergeStaging.clear(),
        db.meta.clear()
      ])
    }
  )
}

/** 清空后重新播种（演示数据重置，并重建初始基线） */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastSectionId: typeof parsed.lastSectionId === 'string' ? parsed.lastSectionId : null,
      trendOnlyWarning: parsed.trendOnlyWarning === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录结构版本号，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
