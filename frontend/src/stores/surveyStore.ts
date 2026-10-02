/**
 * 复测测次状态（Pinia）
 * 维护测次顺序、变化量缓存与按裂缝汇总的发展速率。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, deleteSurveySoft, recalcSurveySeries, type SurveyRow } from '@/utils/db'
import type { Survey, SurveyDraft } from '@/types/survey'
import type { AdviceLevel } from '@/types/advice'
import { buildSurveyPoints, levelFromRate, round } from '@/utils/rate'

export interface CrackRateSummary {
  crackId: string
  /** 测次数量 */
  count: number
  /** 首测宽度（mm） */
  firstWidth: number
  /** 最新宽度（mm） */
  latestWidth: number
  /** 累计变化量（mm） */
  totalDelta: number
  /** 最新测次月均速率（mm/月） */
  rate: number
  level: AdviceLevel
  lastDate: string
}

export const useSurveyStore = defineStore('survey', () => {
  const surveyTable = useIdbTable<SurveyRow>((database) => database.surveys, { sortByUpdatedAt: false })

  /** 正在查看的裂缝 id（复测对比页与速率分级页共用） */
  const activeCrackId = ref<string | null>(null)

  const surveys = computed<SurveyRow[]>(() =>
    [...surveyTable.rows.value].sort((a, b) => {
      const crackDiff = a.crackId.localeCompare(b.crackId)
      if (crackDiff !== 0) return crackDiff
      return a.seq - b.seq
    })
  )

  function surveysOf(crackId: string): Survey[] {
    return surveys.value.filter((survey) => survey.crackId === crackId)
  }

  /** 按裂缝汇总的速率缓存 */
  const rates = computed<CrackRateSummary[]>(() => {
    const grouped = new Map<string, SurveyRow[]>()
    surveys.value.forEach((survey) => {
      const list = grouped.get(survey.crackId)
      if (list) list.push(survey)
      else grouped.set(survey.crackId, [survey])
    })
    const list: CrackRateSummary[] = []
    grouped.forEach((rows, crackId) => {
      const points = buildSurveyPoints(rows)
      const latest = points[points.length - 1]
      const first = points[0]
      const rate = latest ? latest.rate : 0
      list.push({
        crackId,
        count: points.length,
        firstWidth: first ? first.widthMm : 0,
        latestWidth: latest ? latest.widthMm : 0,
        totalDelta: round((latest ? latest.widthMm : 0) - (first ? first.widthMm : 0), 2),
        rate,
        level: levelFromRate(rate),
        lastDate: latest ? latest.date : ''
      })
    })
    return list.sort((a, b) => b.rate - a.rate)
  })

  const rateMap = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.rate
    })
    return map
  })

  const levelMap = computed<Record<string, AdviceLevel>>(() => {
    const map: Record<string, AdviceLevel> = {}
    rates.value.forEach((item) => {
      map[item.crackId] = item.level
    })
    return map
  })

  const warningCrackIds = computed(() => rates.value.filter((item) => item.level !== '一般').map((item) => item.crackId))

  const summaryOf = (crackId: string): CrackRateSummary | null =>
    rates.value.find((item) => item.crackId === crackId) ?? null

  function setActiveCrack(id: string | null): void {
    activeCrackId.value = id
  }

  /**
   * 追加一次复测读数：落库后统一按日期重排序次并重算变化量，
   * 避免离线补录的测次日期早于已有测次时序号错乱。
   */
  async function createSurvey(draft: SurveyDraft): Promise<SurveyRow> {
    const seq = (await db.surveys.where('crackId').equals(draft.crackId).count()) + 1
    const row = (await surveyTable.create(
      {
        crackId: draft.crackId,
        seq,
        date: draft.date,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        deltaWidthMm: 0,
        surveyor: draft.surveyor.trim() || '未署名'
      },
      'sv'
    )) as SurveyRow
    await recalcSurveySeries(draft.crackId)
    return row
  }

  /** 编辑测次后按日期重排序次并重算全部变化量 */
  async function updateSurvey(id: string, draft: SurveyDraft): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    await surveyTable.update(id, {
      date: draft.date,
      widthMm: round(draft.widthMm, 2),
      lengthMm: Math.round(draft.lengthMm),
      surveyor: draft.surveyor.trim() || '未署名'
    })
    await recalcSurveySeries(draft.crackId)
  }

  /** 撤去测次：留可合并的删除墓碑，剩余测次按日期重排并重算 */
  async function removeSurvey(id: string): Promise<void> {
    const row = surveyTable.rows.value.find((item) => item.id === id)
    if (!row) return
    await deleteSurveySoft(id)
  }

  /** 重排某条裂缝的测次序号，并按日期顺序重算变化量（保留旧调用名） */
  async function recalculate(crackId: string): Promise<void> {
    await recalcSurveySeries(crackId)
  }


  return {
    surveyTable,
    surveys,
    rates,
    rateMap,
    levelMap,
    warningCrackIds,
    activeCrackId,
    surveysOf,
    summaryOf,
    setActiveCrack,
    createSurvey,
    updateSurvey,
    removeSurvey,
    recalculate
  }
})
