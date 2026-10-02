/* eslint-disable no-console */
/**
 * 离线合并端到端冒烟测试（Node + fake-indexeddb）：
 * 1. 基线导出 → 2. 两侧分头改动 → 3. 三向合并 → 4. 自动接回/并列/删除墓碑
 * 5. 测次按日期重排序次并重算变化量 → 6. 同一备份重试不重复记账 → 7. 旧版备份可读
 */
import 'fake-indexeddb/auto'

// ---- localStorage 内存 shim（db.ts / mergeStore 依赖） ----
const memoryStore = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => void memoryStore.set(key, String(value)),
  removeItem: (key: string) => void memoryStore.delete(key),
  clear: () => memoryStore.clear()
}
;(globalThis as Record<string, unknown>).localStorage = localStorageShim

import {
  db,
  ROW_REVISION,
  exportSnapshot,
  deleteCrackCascade,
  deleteSurveySoft,
  type CrackRow,
  type SurveyRow,
  type RingRow,
  type SectionRow,
  type AdviceRow,
  type TombstoneRow,
  type BackupPayload
} from '../src/utils/db'
import { buildMergeEntries, normalizePayload } from '../src/utils/mergeUtil'
import { commitMergeEntries, loadAllRows, refreshDerived } from '../src/utils/mergeEngine'
import type { MergeSession, EntityRowsByTable, MergeEntry } from '../src/types/merge'
import { buildSurveyPoints } from '../src/utils/rate'
import { sha256Text } from '../src/utils/mergeHash'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function row<T extends { id: string }>(partial: Partial<T> & { id: string }): T {
  return { createdAt: 1, updatedAt: 1, revision: ROW_REVISION, ...partial } as T
}

async function seedBaseline(): Promise<void> {
  const sections: SectionRow[] = [
    row<SectionRow>({ id: 'sec-a', line: '1号线', startMileage: 1000, endMileage: 2000, structureType: '盾构', ringCount: 2 })
  ]
  const rings: RingRow[] = [
    row<RingRow>({ id: 'ring-a', sectionId: 'sec-a', ringNo: 1, mileage: 1100, segmentType: '钢筋混凝土', installDate: '2020-01-01' }),
    row<RingRow>({ id: 'ring-b', sectionId: 'sec-a', ringNo: 2, mileage: 1200, segmentType: '钢筋混凝土', installDate: '2020-01-02' })
  ]
  const cracks: CrackRow[] = [
    row<CrackRow>({
      id: 'crack-a', ringId: 'ring-a', sectionId: 'sec-a', code: 'SL-001', position: '拱顶',
      direction: '纵向', widthMm: 0.2, lengthMm: 100, state: '观察'
    }),
    row<CrackRow>({
      id: 'crack-b', ringId: 'ring-b', sectionId: 'sec-a', code: 'SL-002', position: '侧墙',
      direction: '环向', widthMm: 0.3, lengthMm: 200, state: '观察'
    })
  ]
  const surveys: SurveyRow[] = [
    row<SurveyRow>({ id: 'sv-a1', crackId: 'crack-a', seq: 1, date: '2024-01-01', widthMm: 0.2, lengthMm: 100, deltaWidthMm: 0, surveyor: '甲' }),
    row<SurveyRow>({ id: 'sv-b1', crackId: 'crack-b', seq: 1, date: '2024-01-01', widthMm: 0.3, lengthMm: 200, deltaWidthMm: 0, surveyor: '甲' })
  ]
  const advices: AdviceRow[] = [
    row<AdviceRow>({ id: 'ad-a', crackId: 'crack-a', level: '一般', measure: '观测', basis: '月均发展速率 0.000 mm/月，初始', state: '待下发' })
  ]
  await db.transaction('rw', db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones, async () => {
    await db.sections.bulkPut(sections)
    await db.rings.bulkPut(rings)
    await db.cracks.bulkPut(cracks)
    await db.surveys.bulkPut(surveys)
    await db.advices.bulkPut(advices)
  })
}

/** 用对端备份 + 本机行 + 基线构造一个内存合并会话 */
function makeSession(incomingPayload: BackupPayload, baselineRows: EntityRowsByTable, localRows: EntityRowsByTable, missingBaseline = false): MergeSession {
  const incoming = normalizePayload(incomingPayload)
  const entries = buildMergeEntries(baselineRows, localRows, incoming, missingBaseline)
  return {
    backupHash: 'hash-' + Math.random().toString(36).slice(2),
    backupExportedAt: incomingPayload.exportedAt,
    backupExportedBy: incomingPayload.exportedBy ?? '乙班',
    backupDbVersion: payloadDbVersion(incomingPayload),
    incomingCounts: {},
    missingBaseline,
    baseline: baselineRows,
    localSnapshot: localRows,
    incoming,
    entries,
    committedEntryIds: [],
    duplicateIds: {},
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

async function payloadOf(extra: Partial<BackupPayload> = {}): Promise<BackupPayload> {
  const snapshot = await exportSnapshot('乙班')
  return { ...snapshot, ...extra }
}

function payloadDbVersion(payload: BackupPayload): number {
  return typeof payload.dbVersion === 'number' ? payload.dbVersion : 0
}

async function resetDb(): Promise<void> {
  await db.transaction('rw', db.sections, db.rings, db.cracks, db.surveys, db.advices, db.tombstones, async () => {
    await Promise.all([
      db.sections.clear(), db.rings.clear(), db.cracks.clear(),
      db.surveys.clear(), db.advices.clear(), db.tombstones.clear()
    ])
  })
  memoryStore.clear()
}

async function main(): Promise<void> {
  console.log('\n[准备] 播种基线（1 区间 / 2 环片 / 2 裂缝 / 各 1 测次）')
  await resetDb()
  await seedBaseline()

  // ---- 导出基线（甲班导出后交给乙班的共同祖先） ----
  const baselinePayload = await payloadOf({ exportedBy: '甲班' })
  const baselineRows = normalizePayload(baselinePayload)
  check('基线包含 2 条裂缝', baselineRows.cracks.length === 2)
  check('基线墓碑为空', baselineRows.tombstones.length === 0)

  // ---- 乙班基于基线分头改动（构造 incoming 备份） ----
  // 乙班：改 crack-a 宽度；给 crack-a 追加一次更晚测次；新增 crack-c；删除 crack-b
  await db.cracks.put({ ...(await db.cracks.get('crack-a'))!, widthMm: 0.9, updatedAt: 9 })
  await db.surveys.put(
    row<SurveyRow>({ id: 'sv-a2', crackId: 'crack-a', seq: 2, date: '2024-03-01', widthMm: 0.9, lengthMm: 160, deltaWidthMm: 0.7, surveyor: '乙' })
  )
  await db.cracks.put(
    row<CrackRow>({
      id: 'crack-c', ringId: 'ring-a', sectionId: 'sec-a', code: 'SL-003', position: '道床',
      direction: '斜向', widthMm: 0.1, lengthMm: 50, state: '观察', createdAt: 5, updatedAt: 5
    })
  )
  await deleteCrackCascade('crack-b', '乙班')
  const incomingPayload = await payloadOf({ exportedBy: '乙班' })
  check('对端备份带删除墓碑', (incomingPayload.tombstones ?? []).some((t) => t.table === 'cracks' && t.entityId === 'crack-b'))

  // ---- 回到甲班本机状态（清库重播基线 + 甲班改动） ----
  await resetDb()
  await seedBaseline()
  // 甲班：改 crack-a 为不同宽度（双改）；给 crack-a 补一个更早日期的测次（测次双改场景：甲只加测次，乙也只加测次，属两边新增不同 id）
  await db.cracks.put({ ...(await db.cracks.get('crack-a'))!, widthMm: 0.5, updatedAt: 8 })
  await db.surveys.put(
    row<SurveyRow>({ id: 'sv-a2-jia', crackId: 'crack-a', seq: 2, date: '2024-02-01', widthMm: 0.5, lengthMm: 130, deltaWidthMm: 0.3, surveyor: '甲2' })
  )
  // 甲班也删一条测次（crack-b 的唯一测次）以验证测次删除墓碑合并
  await deleteSurveySoft('sv-b1', '甲班')
  const localRows = await loadAllRows()

  console.log('\n[三向比对]')
  const session = makeSession(incomingPayload, baselineRows, localRows)
  const byKey = new Map(session.entries.map((e) => [`${e.table}:${(e.baseRow ?? e.localRow ?? e.incomingRow)!.id}`, e]))

  const crackA = byKey.get('cracks:crack-a')
  check('crack-a 两边都改 → 冲突', crackA?.status === 'conflicted' && crackA.side === 'both')
  check('裂缝双改默认并列保留', crackA?.resolution.type === 'keep-both')

  const crackC = byKey.get('cracks:crack-c')
  check('乙班新增 crack-c → 仅对端新增自动接回', crackC?.status === 'added' && crackC.side === 'incoming-only' && crackC.resolution.type === 'auto')

  const crackB = byKey.get('cracks:crack-b')
  check('乙班删除 crack-b（甲未改）→ 自动删除', crackB?.status === 'deleted' && crackB.side === 'incoming-only')

  const svJia = byKey.get('surveys:sv-a2-jia')
  const svYi = byKey.get('surveys:sv-a2')
  check('甲班新测次 → local-only 自动', svJia?.side === 'local-only' && svJia.resolution.type === 'auto')
  check('乙班新测次 → incoming-only 自动', svYi?.side === 'incoming-only' && svYi.resolution.type === 'auto')

  const svB1 = byKey.get('surveys:sv-b1')
  check('两边都删除测次 sv-b1 → 变化一致不立项', svB1 === undefined)

  // 核验人对 crack-a 保持默认 keep-both，其余全部 auto
  console.log('\n[提交入库]')
  const result = await commitMergeEntries(session, session.entries, '核验人')
  check('提交条目数 > 0', result.committedIds.length > 0, `实际 ${result.committedIds.length}`)

  const cracksAfter = await db.cracks.toArray()
  const crackADuplicates = cracksAfter.filter((c) => c.code.startsWith('SL-001'))
  check('crack-a 并列保留为 2 条（本机原件 + 对端副本）', crackADuplicates.length === 2, `实际 ${crackADuplicates.length}`)
  const incomingDup = crackADuplicates.find((c) => c.mergeOrigin?.origin === 'incoming')
  check('对端副本带（乙班版）后缀', Boolean(incomingDup?.code.includes('乙班版')), incomingDup?.code)
  check('对端副本宽度取乙班 0.9', incomingDup?.widthMm === 0.9)
  const localDup = crackADuplicates.find((c) => c.mergeOrigin?.origin === 'local')
  check('本机原件宽度保持甲班 0.5', localDup?.widthMm === 0.5)

  const crackCAfter = await db.cracks.get('crack-c')
  check('crack-c 已自动接回', Boolean(crackCAfter))

  const crackBAfter = await db.cracks.get('crack-b')
  const tombB = await db.tombstones.get('tm_cracks_crack-b')
  check('crack-b 已撤去且有合并墓碑', !crackBAfter && tombB?.origin === 'imported')

  // 测次：crack-a 并列后两版各自保留自己的测次序列，各自按日期重排
  const surveysLocalA = (await db.surveys.where('crackId').equals(localDup!.id).toArray()).sort((a, b) => a.seq - b.seq)
  check('本机 crack-a 保留甲班 2 个测次（乙的随乙副本走）', surveysLocalA.length === 2, `实际 ${surveysLocalA.length}`)
  const points = buildSurveyPoints(surveysLocalA)
  check('测次按日期重排序次：1/2', points.map((p) => p.seq).join(',') === '1,2')
  check('测次日期升序：01-01 / 02-01', points.map((p) => p.date).join(',') === '2024-01-01,2024-02-01')
  check('变化量跟着重算：+0.3', points[1].deltaWidthMm === 0.3, `实际 ${points[1].deltaWidthMm}`)
  check('末次月均速率按 31 天重算 ≈ 0.290', Math.abs(points[1].rate - 0.29) < 0.01, `实际 ${points[1].rate}`)

  // 对端副本携带乙班测次序列（基线 1 + 乙 1），同步为乙的最新读数 0.9
  const surveysIncomingA = (await db.surveys.where('crackId').equals(incomingDup!.id).toArray()).sort((a, b) => a.seq - b.seq)
  check('对端副本携带乙班 2 个测次', surveysIncomingA.length === 2, `实际 ${surveysIncomingA.length}`)
  const incomingPoints = buildSurveyPoints(surveysIncomingA)
  check('副本测次按日期重排，末次为 03-01 / 0.9', incomingPoints[1].date === '2024-03-01' && incomingPoints[1].widthMm === 0.9)
  check('副本变化量重算为 +0.7', incomingPoints[1].deltaWidthMm === 0.7, `实际 ${incomingPoints[1].deltaWidthMm}`)
  check('本机裂缝读数保持甲班最新测次 0.5', localDup?.widthMm === 0.5, `实际 ${localDup?.widthMm}`)

  // 建议等级与依据跟着重算（甲版速率 0.29 → 较重）
  await refreshDerived([localDup!.id])
  const adviceLocal = await db.advices.where('crackId').equals(localDup!.id).first()
  check('建议等级重算为严重（速率 ≥ 0.25）', adviceLocal?.level === '严重', adviceLocal?.level)
  check('自动依据已按新速率重写', Boolean(adviceLocal?.basis.includes('0.290')), adviceLocal?.basis)

  // ---- 同一备份重试：已提交条目不会再多记一条 ----
  console.log('\n[幂等] 同一会话对象再次提交')
  const crackCountBefore = await db.cracks.count()
  const surveyCountBefore = await db.surveys.count()
  const retry = await commitMergeEntries(session, session.entries, '核验人')
  const crackCountAfter = await db.cracks.count()
  const surveyCountAfter = await db.surveys.count()
  check('重试提交 0 条', retry.committedIds.length === 0)
  check('裂缝数不增加', crackCountBefore === crackCountAfter)
  check('测次数不增加', surveyCountBefore === surveyCountAfter)

  // ---- 旧版（v1）备份可读入 ----
  console.log('\n[旧版兼容] v1 备份无 tombstones 字段')
  const legacyPayload: BackupPayload = {
    app: 'gbtunnelcrack',
    dbVersion: 1,
    exportedAt: '2023-01-01T00:00:00.000Z',
    sections: baselinePayload.sections,
    rings: baselinePayload.rings,
    cracks: baselinePayload.cracks,
    surveys: baselinePayload.surveys,
    advices: baselinePayload.advices
  }
  const normalizedLegacy = normalizePayload(legacyPayload)
  check('旧版备份墓碑按空读入', Array.isArray(normalizedLegacy.tombstones) && normalizedLegacy.tombstones.length === 0)
  check('旧版备份裂缝可读', normalizedLegacy.cracks.length === 2)
  const entriesLegacy = buildMergeEntries(baselineRows, baselineRows, normalizedLegacy)
  check('旧版与基线完全一致 → 无合并条目', entriesLegacy.length === 0)

  // ---- 中断恢复：部分提交后剩余挂起项仍在会话 ----
  console.log('\n[中断续作] 挂起项不入库但保留在会话')
  await resetDb()
  await seedBaseline()
  const baseline2 = normalizePayload(await payloadOf())
  // 两边对 advices 双改（不支持并列 → 默认 skip 挂起）
  await db.advices.put({ ...(await db.advices.get('ad-a'))!, basis: '甲班改的依据', updatedAt: 7 })
  const local2 = await loadAllRows()
  await resetDb()
  await seedBaseline()
  await db.advices.put({ ...(await db.advices.get('ad-a'))!, basis: '乙班改的依据', updatedAt: 8 })
  const incoming2 = await payloadOf()
  const session2 = makeSession(incoming2, baseline2, local2)
  const adviceConflict = session2.entries.find((e) => e.table === 'advices')
  check('建议双改产生冲突且默认挂起(skip)', adviceConflict?.status === 'conflicted' && adviceConflict.resolution.type === 'skip')
  const partial = await commitMergeEntries(session2, session2.entries, '核验人')
  check('挂起冲突不入库（committed=0）', partial.committedIds.length === 0)
  check('会话保留该挂起条目', session2.entries.includes(adviceConflict!))
  // 核验人随后决定取本机
  adviceConflict!.resolution = { type: 'take-local', decidedBy: '核验人', decidedAt: Date.now() }
  const partial2 = await commitMergeEntries(session2, session2.entries, '核验人')
  check('核验后续作可提交', partial2.committedIds.length === 1)

  // ---- 无基线兜底：同内容不立项、对端新增接回、同 id 不同内容双改、对端删除不自动生效 ----
  console.log('\n[无基线兜底]')
  const emptyBaseline: EntityRowsByTable = { sections: [], rings: [], cracks: [], surveys: [], advices: [], tombstones: [] }
  const nbLocal: EntityRowsByTable = {
    ...emptyBaseline,
    cracks: [
      row<CrackRow>({ id: 'k1', ringId: 'r', sectionId: 's', code: 'K-001', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 10, state: '观察' }),
      row<CrackRow>({ id: 'k2', ringId: 'r', sectionId: 's', code: 'K-002', position: '侧墙', direction: '环向', widthMm: 0.3, lengthMm: 20, state: '观察' })
    ]
  }
  const nbIncomingPayload: BackupPayload = {
    app: 'gbtunnelcrack',
    dbVersion: 3,
    exportedAt: '2024-05-01T00:00:00.000Z',
    sections: [],
    rings: [],
    // k1 与本机内容相同；k2 两边内容不同；k3 对端独有；对端未携带 k2 删除墓碑（无基线场景本就不识别删除）
    cracks: [
      row<CrackRow>({ id: 'k1', ringId: 'r', sectionId: 's', code: 'K-001', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 10, state: '观察' }),
      row<CrackRow>({ id: 'k2', ringId: 'r', sectionId: 's', code: 'K-002', position: '侧墙', direction: '环向', widthMm: 0.9, lengthMm: 20, state: '待整治' }),
      row<CrackRow>({ id: 'k3', ringId: 'r', sectionId: 's', code: 'K-003', position: '道床', direction: '斜向', widthMm: 0.1, lengthMm: 5, state: '观察' })
    ],
    surveys: [],
    advices: [],
    tombstones: []
  }
  const nbEntries = buildMergeEntries(emptyBaseline, nbLocal, normalizePayload(nbIncomingPayload), true)
  check('无基线：同内容 k1 不立项', !nbEntries.some((e) => e.table === 'cracks' && (e.baseRow ?? e.localRow ?? e.incomingRow)!.id === 'k1'))
  const nbK2 = nbEntries.find((e) => e.table === 'cracks' && (e.localRow ?? e.incomingRow)!.id === 'k2')
  check('无基线：k2 内容不同按双改并列', nbK2?.status === 'conflicted' && nbK2.resolution.type === 'keep-both')
  const nbK3 = nbEntries.find((e) => e.table === 'cracks' && (e.incomingRow)!.id === 'k3')
  check('无基线：对端独有 k3 自动接回', nbK3?.status === 'added' && nbK3.resolution.type === 'auto')

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
