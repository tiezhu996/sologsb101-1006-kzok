<script setup lang="ts">
/**
 * /backup 整治建议与结构版本导出
 * 维护建议措施与状态流转，导出/覆盖导入全量 JSON，两班离线三向合并，重置演示数据。
 * 消费全部模型；复用 <EmptyPanel>、<LevelTag>、<FilterBar>、<StatBadge>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  Connection,
  Delete,
  Download,
  Edit,
  Plus,
  Refresh,
  RefreshRight,
  Right,
  Upload
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import LevelTag from '@/components/common/LevelTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCrackStore } from '@/stores/crackStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useMergeStore } from '@/stores/mergeStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  DB_VERSION,
  clearAllTables,
  countAll,
  db,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type AdviceRow,
  type BackupPayload
} from '@/utils/db'
import {
  ADVICE_LEVELS,
  ADVICE_MEASURES,
  ADVICE_STATES,
  ADVICE_STATE_FLOW,
  EMPTY_ADVICE_DRAFT,
  type AdviceDraft,
  type AdviceState
} from '@/types/advice'
import { exportCrackCsv } from '@/utils/export'
import { formatMm } from '@/utils/rate'
import { entityLabel, fieldLabel } from '@/utils/merge'
import type { MergeConflict, ResolutionKind } from '@/types/merge'
import { MERGE_TABLE_LABEL } from '@/types/tombstone'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const crackStore = useCrackStore()
const surveyStore = useSurveyStore()
const sectionStore = useSectionStore()
const mergeStore = useMergeStore()
const adviceTable = useIdbTable<AdviceRow>((database) => database.advices, { sortByUpdatedAt: false })

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const stateFilter = ref<AdviceState[]>([])
const keyword = ref('')

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: keyword.value,
  state: stateFilter.value
}))

const filterSelects = computed(() => [
  { key: 'state', label: '建议状态', options: ADVICE_STATES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  keyword.value = String(model.keyword ?? '')
  stateFilter.value = (Array.isArray(model.state) ? model.state : []) as AdviceState[]
}

/* ------------------------------ 建议行 ------------------------------ */

function crackOf(crackId: string) {
  return crackStore.cracks.find((crack) => crack.id === crackId) ?? null
}

const rows = computed(() =>
  adviceTable.rows.value
    .filter((advice) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(advice.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      const crack = crackOf(advice.crackId)
      return (
        (crack ? crack.code.toLowerCase().includes(text) : false) ||
        advice.measure.toLowerCase().includes(text) ||
        advice.basis.toLowerCase().includes(text)
      )
    })
    .sort((a, b) => ADVICE_LEVELS.indexOf(b.level) - ADVICE_LEVELS.indexOf(a.level))
)

const pendingCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '待下发').length)
const issuedCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已下发').length)
const doneCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已完成').length)

/* ------------------------------ 表单 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('新建整治建议')
const formRef = ref<FormInstance>()
const form = reactive<AdviceDraft>({ ...EMPTY_ADVICE_DRAFT })
let editingId: string | null = null

const rules: FormRules = {
  crackId: [{ required: true, message: '请选择裂缝', trigger: 'change' }],
  basis: [{ required: true, message: '请填写判定依据', trigger: 'blur' }]
}

const crackOptions = computed(() =>
  crackStore.cracks.map((crack) => {
    const ring = sectionStore.ringById.get(crack.ringId)
    const section = sectionStore.sectionById.get(crack.sectionId)
    return {
      label: `${crack.code} · ${section ? section.line : '未知'}${ring ? ` 第${ring.ringNo}环` : ''} · 当前 ${crack.widthMm.toFixed(2)} mm`,
      value: crack.id
    }
  })
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新建整治建议'
  const fallback = crackStore.cracks[0]
  Object.assign(form, {
    ...EMPTY_ADVICE_DRAFT,
    crackId: fallback ? fallback.id : '',
    basis: fallback ? `${fallback.code} 复测宽度持续增长，建议先观测后处置。` : ''
  })
  dialogVisible.value = true
}

function openEdit(advice: AdviceRow): void {
  editingId = advice.id
  dialogTitle.value = `编辑整治建议 · ${crackOf(advice.crackId)?.code ?? ''}`
  Object.assign(form, {
    crackId: advice.crackId,
    level: advice.level,
    measure: advice.measure,
    basis: advice.basis,
    state: advice.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  if (editingId) {
    await adviceTable.update(editingId, { ...form })
    ElMessage.success('整治建议已更新')
  } else {
    await adviceTable.create({ ...form }, 'ad')
    ElMessage.success('整治建议已创建')
  }
  dialogVisible.value = false
  await refreshCounts()
}

async function removeAdvice(advice: AdviceRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确认删除「${crackOf(advice.crackId)?.code ?? '该裂缝'}」的整治建议？`,
    '删除确认',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await adviceTable.remove(advice.id)
  ElMessage.success('整治建议已删除')
  await refreshCounts()
}

async function advance(advice: AdviceRow): Promise<void> {
  const next = ADVICE_STATE_FLOW[advice.state]
  if (!next) {
    ElMessage.info('该建议已完成闭环')
    return
  }
  await adviceTable.update(advice.id, { state: next })
  ElMessage.success(`建议状态已推进为「${next}」`)
  await refreshCounts()
}

/* ---------------------------- 备份与恢复 ---------------------------- */

const fileInput = ref<HTMLInputElement | null>(null)
const mergeFileInput = ref<HTMLInputElement | null>(null)

async function exportAll(): Promise<void> {
  const payload = await exportSnapshot()
  const filename = `gbtunnelcrack-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  const iso = new Date().toISOString()
  stampBackupTime(iso)
  lastBackupAt.value = iso
  ElMessage.success(`已导出全量存档 ${filename}`)
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const payload = JSON.parse(text) as BackupPayload
    if (payload.app !== 'gbtunnelcrack') {
      ElMessage.error('存档文件格式不匹配（缺少 app: gbtunnelcrack 标识）')
      return
    }
    const confirmed = await ElMessageBox.confirm(
      '覆盖导入会用该存档整体替换当前全部本地数据（不会并入未提交的合并暂存）。如只想并入对侧复测，请改用「离线合并」。确认覆盖？',
      '覆盖导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    ).catch(() => false)
    if (!confirmed) return
    await importSnapshot(payload)
    ElMessage.success('存档已整库覆盖导入')
    await refreshCounts()
  } catch (error) {
    ElMessage.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

/* ---------------------------- 离线三向合并 ---------------------------- */

function triggerMergeFile(): void {
  mergeFileInput.value?.click()
}

async function onMergeFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const result = await mergeStore.ingest(JSON.parse(text), file.name)
    if (result.status === 'already-merged') {
      ElMessage.warning(result.message)
    } else if (result.status === 'resumed') {
      ElMessage.info(result.message)
    } else {
      ElMessage.success(result.message)
    }
  } catch (error) {
    ElMessage.error(`合并文件读入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

const activeMerge = computed(() => mergeStore.activeStaging)
const pendingMergeCount = computed(() => mergeStore.pendingCount)

function conflictTableLabel(conflict: MergeConflict): string {
  return MERGE_TABLE_LABEL[conflict.table]
}

function conflictName(conflict: MergeConflict): string {
  const row = conflict.remote ?? conflict.local ?? conflict.base
  return entityLabel(conflict.table, row)
}

function conflictKindText(conflict: MergeConflict): string {
  switch (conflict.kind) {
    case 'both-edited':
      return '两边都改过'
    case 'delete-edit':
      return conflict.deleteSide === 'local' ? '本机已删除 · 对侧改过' : '对侧已删除 · 本机改过'
    case 'both-deleted':
      return '两边都已删除'
    case 'legacy-add':
      return '双方新增撞号'
  }
}

function resolutionText(resolution: ResolutionKind | null): string {
  switch (resolution) {
    case 'parallel':
      return '并列保留'
    case 'local':
      return '保留本机'
    case 'remote':
      return '接回对侧'
    case 'delete':
      return '按删除处理'
    case 'drop':
      return '放弃对侧'
    default:
      return '待核验'
  }
}

function resolutionTagType(resolution: ResolutionKind | null): 'info' | 'warning' | 'success' | 'primary' | 'danger' {
  if (resolution === null) return 'danger'
  if (resolution === 'parallel') return 'success'
  if (resolution === 'delete') return 'warning'
  return 'primary'
}

/** 某条冲突可选的处理动作 */
function conflictOptions(conflict: MergeConflict): Array<{ value: ResolutionKind; label: string; disabled?: boolean }> {
  const options: Array<{ value: ResolutionKind; label: string; disabled?: boolean }> = []
  if (conflict.parallelable) options.push({ value: 'parallel', label: '并列保留（复制对侧为新记录）' })
  if (conflict.remote) options.push({ value: 'remote', label: '接回对侧版本' })
  if (conflict.local) options.push({ value: 'local', label: '保留本机版本' })
  if (conflict.kind === 'delete-edit') {
    options.push({ value: 'delete', label: '按删除处理' })
  }
  options.push({ value: 'drop', label: '放弃对侧该条' })
  return options
}

async function chooseResolution(conflict: MergeConflict, resolution: ResolutionKind): Promise<void> {
  await mergeStore.resolveConflict(conflict.key, resolution)
}

async function parallelAll(): Promise<void> {
  const count = await mergeStore.resolveAllParallel()
  if (count === 0) {
    ElMessage.info('没有可并列保留的未决冲突')
    return
  }
  ElMessage.success(`已将 ${count} 处裂缝/环片/测次冲突设为并列保留`)
}

async function commitMerge(): Promise<void> {
  if (!activeMerge.value) return
  if (pendingMergeCount.value > 0) {
    ElMessage.warning(`还有 ${pendingMergeCount.value} 处冲突未核验，处理完再一起入库`)
    return
  }
  const confirmed = await ElMessageBox.confirm(
    '核验已完成，确认把本次合并结果一次性入库？入库后测次将按日期重排，变化量、预警等级与建议依据会自动重算。',
    '合并入库确认',
    { type: 'warning', confirmButtonText: '确认入库', cancelButtonText: '再看看' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    const result = await mergeStore.commit()
    ElMessage.success(`合并已入库，重算了 ${result.changedCracks} 条裂缝的测次与分级`)
    await refreshCounts()
    await ElMessageBox.alert(
      '建议立即「导出全量 JSON」生成带新基线的台账，分发给另一班组作为下次复测的共同基线，避免下次合并出现多余冲突。',
      '合并完成',
      { confirmButtonText: '知道了' }
    ).catch(() => undefined)
  } catch (error) {
    ElMessage.error(`合并入库失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

async function discardMerge(): Promise<void> {
  if (!activeMerge.value) return
  const confirmed = await ElMessageBox.confirm('放弃该合并暂存？暂存内的核验结果将被清除，本机业务数据不受影响。', '放弃暂存', {
    type: 'warning',
    confirmButtonText: '放弃暂存',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await mergeStore.discardStaging(activeMerge.value.id)
  ElMessage.success('合并暂存已放弃')
}

function resumeMerge(id: string): void {
  mergeStore.openStaging(id)
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

function changeFieldLabel(field: string): string {
  return fieldLabel(field)
}

function autoActionText(action: 'add' | 'update' | 'delete'): string {
  return action === 'add' ? '新增接回' : action === 'update' ? '改动接回' : '删除接回'
}

function autoActionType(action: 'add' | 'update' | 'delete'): 'success' | 'primary' | 'warning' {
  return action === 'add' ? 'success' : action === 'update' ? 'primary' : 'warning'
}

const activeMergeSummary = computed(() =>
  activeMerge.value ? mergeStore.summaryOf(activeMerge.value) : { autoAdd: 0, autoUpdate: 0, autoDelete: 0 }
)

const otherStagings = computed(() =>
  mergeStore.pendingStagings.filter((item) => item.id !== mergeStore.activeId)
)

async function clearData(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('清空后所有本地数据将被删除且不可恢复，确认清空？', '清空确认', {
    type: 'warning',
    confirmButtonText: '确认清空',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await clearAllTables()
  ElMessage.success('本地数据已清空')
  await refreshCounts()
}

async function reseed(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('重置将清空现有数据并重新写入演示数据，确认继续？', '重置确认', {
    type: 'warning',
    confirmButtonText: '重置并播种',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await resetDatabase()
  stampedVersion.value = DB_VERSION
  ElMessage.success('已重置为演示数据')
  await refreshCounts()
}

async function exportCsv(): Promise<void> {
  const [sections, rings, cracks, surveys, advices] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray()
  ])
  const filename = exportCrackCsv(sections, rings, cracks, surveys, advices)
  ElMessage.success(`已导出 ${filename}`)
}

const adviceStateText = (state: AdviceState): string => state

function adviceRowKey(row: AdviceRow): string {
  return row.id
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">整治建议与数据备份</h2>
        <p class="page-head__desc">
          维护建议措施与状态流转（待下发 → 已下发 → 已完成），并导出/导入 IndexedDB 全量 JSON 存档。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Download" @click="exportCsv">导出裂缝台账 CSV</el-button>
        <el-button type="primary" :icon="Plus" :disabled="crackStore.cracks.length === 0" @click="openCreate">
          新建建议
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="建议总数" :value="adviceTable.rows.value.length" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待下发" :value="pendingCount" suffix="条" icon="Histogram" tone="warning" />
      <StatBadge label="已下发" :value="issuedCount" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="已完成" :value="doneCount" suffix="条" icon="CircleCheckFilled" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索裂缝编号 / 措施 / 依据"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">整治建议（{{ rows.length }}）</h3>
        <span class="muted">按等级从高到低排列，可逐条推进状态</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有整治建议"
        description="可在「速率分级」页按速率一键生成建议草稿，也可在此手工新建。"
        action-text="新建建议"
        compact
        :show-seed="crackStore.cracks.length === 0"
        @action="openCreate"
        @seed="reseed"
      />

      <el-table v-else :data="rows" border stripe :row-key="adviceRowKey">
        <el-table-column label="裂缝编号" width="140">
          <template #default="{ row }">
            <strong>{{ crackOf(row.crackId)?.code ?? '（裂缝已删除）' }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="月均速率" width="130">
          <template #default="{ row }">
            {{ (surveyStore.rateMap[row.crackId] ?? 0).toFixed(3) }} mm/月
          </template>
        </el-table-column>
        <el-table-column label="当前宽度" width="120">
          <template #default="{ row }">
            {{ formatMm(crackOf(row.crackId)?.widthMm ?? 0) }}
          </template>
        </el-table-column>
        <el-table-column label="建议等级" width="150">
          <template #default="{ row }">
            <LevelTag :level="row.level" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="建议措施" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.measure }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="basis" label="判定依据" min-width="240" show-overflow-tooltip />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已完成' ? 'success' : row.state === '已下发' ? 'primary' : 'warning'"
            >
              {{ adviceStateText(row.state) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEdit(row)">
              <el-icon><Edit /></el-icon> 编辑
            </el-button>
            <el-button size="small" text type="primary" :disabled="!ADVICE_STATE_FLOW[row.state as AdviceState]" @click="advance(row)">
              <el-icon><Right /></el-icon>
              {{ ADVICE_STATE_FLOW[row.state as AdviceState] ? `转${ADVICE_STATE_FLOW[row.state as AdviceState]}` : '已闭环' }}
            </el-button>
            <el-button size="small" text type="danger" @click="removeAdvice(row)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">两班离线合并</h3>
        <span class="muted">先从同一版台账各自导出基线，分头复测后在此并入对侧备份</span>
      </div>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="合并规则：仅一侧改过的记录自动接回；裂缝、环片、测次两边都改过默认并列保留；区间与建议的冲突、以及删除与修改相撞，需核验人逐条处理，全部处理完才能入库。"
        style="margin-bottom: 12px"
      />

      <div style="display: flex; flex-wrap: wrap; gap: 8px">
        <el-button type="primary" :icon="Connection" @click="triggerMergeFile">读入对侧备份并合并</el-button>
        <span v-if="mergeStore.pendingStagings.length > 0" class="muted" style="align-self: center">
          有 {{ mergeStore.pendingStagings.length }} 个未入库的合并暂存（中断后现场已保留）
        </span>
      </div>
      <input
        ref="mergeFileInput"
        type="file"
        accept="application/json,.json"
        style="display: none"
        @change="onMergeFileChange"
      />

      <!-- 其他未提交暂存（恢复现场） -->
      <div v-if="otherStagings.length > 0" style="margin-top: 12px">
        <h4 class="panel-subtitle">未入库的合并暂存</h4>
        <el-table :data="otherStagings" border stripe size="small">
          <el-table-column label="备份文件" min-width="220">
            <template #default="{ row }">
              <strong>{{ row.fileName }}</strong>
              <div class="muted">导出于 {{ row.remoteExportedAt.slice(0, 19).replace('T', ' ') }}</div>
            </template>
          </el-table-column>
          <el-table-column label="方式" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="row.mode === 'three-way' ? 'primary' : 'warning'">
                {{ row.mode === 'three-way' ? '三向合并' : '旧版保守合并' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="自动变化" width="160">
            <template #default="{ row }">
              增 {{ mergeStore.summaryOf(row).autoAdd }} · 改 {{ mergeStore.summaryOf(row).autoUpdate }} · 删
              {{ mergeStore.summaryOf(row).autoDelete }}
            </template>
          </el-table-column>
          <el-table-column label="待核验冲突" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.conflicts.filter((c: MergeConflict) => c.resolution === null).length > 0 ? 'danger' : 'success'">
                {{ row.conflicts.filter((c: MergeConflict) => c.resolution === null).length }} / {{ row.conflicts.length }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="resumeMerge(row.id)">恢复核验</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 当前合并暂存：核验现场 -->
      <template v-if="activeMerge">
        <el-divider />
        <div class="panel-head">
          <h3 class="panel-title" style="margin: 0">
            合并核验 · {{ activeMerge.fileName }}
            <el-tag
              size="small"
              :type="activeMerge.mode === 'three-way' ? 'primary' : 'warning'"
              style="margin-left: 8px"
            >
              {{ activeMerge.mode === 'three-way' ? '三向（已对上基线）' : '旧版备份（无基线，保守合并）' }}
            </el-tag>
          </h3>
          <div style="display: flex; gap: 8px">
            <el-button size="small" :icon="Connection" @click="parallelAll">可并列项一键并列</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="discardMerge">放弃暂存</el-button>
          </div>
        </div>

        <div class="stat-row">
          <StatBadge label="自动新增" :value="activeMergeSummary.autoAdd" suffix="条" icon="Plus" tone="success" />
          <StatBadge label="自动改动接回" :value="activeMergeSummary.autoUpdate" suffix="条" icon="Edit" tone="info" />
          <StatBadge label="自动删除接回" :value="activeMergeSummary.autoDelete" suffix="条" icon="Delete" tone="warning" />
          <StatBadge label="待核验冲突" :value="pendingMergeCount" suffix="处" icon="WarningFilled" tone="danger" />
        </div>

        <!-- 自动接回清单 -->
        <el-collapse style="margin-top: 8px">
          <el-collapse-item name="auto">
            <template #title>
              <span>自动接回变化（{{ activeMerge.autoChanges.length }}）</span>
            </template>
            <el-table :data="activeMerge.autoChanges" border stripe size="small">
              <el-table-column label="类型" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="autoActionType(row.action)">{{ autoActionText(row.action) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="表" width="100">
                <template #default="{ row }">{{ MERGE_TABLE_LABEL[row.table as keyof typeof MERGE_TABLE_LABEL] }}</template>
              </el-table-column>
              <el-table-column label="记录" min-width="200">
                <template #default="{ row }">{{ row.label }}</template>
              </el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>

        <!-- 冲突核验 -->
        <h4 class="panel-subtitle">冲突核验（{{ activeMerge.conflicts.length }}）</h4>
        <EmptyPanel
          v-if="activeMerge.conflicts.length === 0"
          title="没有冲突"
          description="两侧改动互不相交，全部变化都会自动接回，可直接入库。"
          compact
        />
        <el-table v-else :data="activeMerge.conflicts" border stripe size="small" row-key="key">
          <el-table-column label="对象" min-width="180">
            <template #default="{ row }">
              <strong>{{ conflictName(row) }}</strong>
              <div class="muted">{{ conflictTableLabel(row) }} · {{ conflictKindText(row) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="字段差异" min-width="260">
            <template #default="{ row }">
              <div v-if="row.changes.length === 0" class="muted">
                {{ row.kind === 'delete-edit' ? '删除与修改相撞' : '无字段级差异' }}
              </div>
              <div v-for="change in row.changes" :key="change.field" class="merge-diff">
                <span class="merge-diff__field">{{ changeFieldLabel(change.field) }}</span>
                <span class="merge-diff__local" :title="`本机：${formatValue(change.local)}`">本机 {{ formatValue(change.local) }}</span>
                <span class="merge-diff__arrow">→</span>
                <span class="merge-diff__remote" :title="`对侧：${formatValue(change.remote)}`">对侧 {{ formatValue(change.remote) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="核验处理" width="300">
            <template #default="{ row }">
              <el-radio-group
                :model-value="row.resolution"
                size="small"
                @update:model-value="(value: ResolutionKind) => chooseResolution(row, value)"
              >
                <el-radio-button
                  v-for="option in conflictOptions(row)"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </el-radio-button>
              </el-radio-group>
              <div style="margin-top: 4px">
                <el-tag size="small" :type="resolutionTagType(row.resolution)">{{ resolutionText(row.resolution) }}</el-tag>
                <span v-if="row.resolution === 'parallel'" class="muted" style="margin-left: 6px">
                  对侧将复制为新 id 并列，级联测次/建议一并复制
                </span>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div style="margin-top: 14px; display: flex; align-items: center; gap: 12px">
          <el-button type="primary" :disabled="!mergeStore.canCommit" :loading="mergeStore.loading" @click="commitMerge">
            核验完成，一起入库
          </el-button>
          <span v-if="pendingMergeCount > 0" class="muted">还有 {{ pendingMergeCount }} 处冲突未处理，暂不能入库</span>
          <span v-else class="muted">全部冲突已核验，可以入库</span>
        </div>
      </template>
    </div>

    <div class="panel">
      <h3 class="panel-title">结构版本与本地数据</h3>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="IndexedDB 库名">gbtunnelcrack</el-descriptions-item>
        <el-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（localStorage 记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="最近备份时间">{{ lastBackupAt ?? '尚未备份' }}</el-descriptions-item>
        <el-descriptions-item label="区间 / 环片">
          {{ counts.sections ?? 0 }} / {{ counts.rings ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="裂缝 / 复测">
          {{ counts.cracks ?? 0 }} / {{ counts.surveys ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="整治建议">{{ counts.advices ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="删除墓碑（待合并）">{{ counts.tombstones ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="合并暂存">{{ mergeStore.pendingStagings.length }}</el-descriptions-item>
      </el-descriptions>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px">
        <el-button type="primary" :icon="Download" @click="exportAll">导出全量 JSON（含基线）</el-button>
        <el-button :icon="Upload" @click="triggerImport">覆盖导入 JSON（整库替换）</el-button>
        <el-button :icon="Connection" @click="triggerMergeFile">离线合并对侧备份</el-button>
        <el-button :icon="RefreshRight" @click="reseed">重置为演示数据</el-button>
        <el-button type="danger" plain :icon="Delete" @click="clearData">清空本地数据</el-button>
        <el-button :icon="Refresh" @click="refreshCounts">刷新统计</el-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="关联裂缝" prop="crackId">
          <el-select v-model="form.crackId" filterable style="width: 100%">
            <el-option v-for="item in crackOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="建议等级" prop="level">
          <el-select v-model="form.level" style="width: 100%">
            <el-option v-for="item in ADVICE_LEVELS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="建议措施" prop="measure">
          <el-radio-group v-model="form.measure">
            <el-radio-button v-for="item in ADVICE_MEASURES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="判定依据" prop="basis">
          <el-input v-model="form.basis" type="textarea" :rows="3" placeholder="如：月均速率 0.310 mm/月 超过严重阈值" />
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ADVICE_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.panel-subtitle {
  margin: 14px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.merge-diff {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
}

.merge-diff__field {
  min-width: 64px;
  font-weight: 600;
  color: #16233a;
}

.merge-diff__local {
  color: #5b6b82;
}

.merge-diff__remote {
  color: #c0392b;
}

.merge-diff__arrow {
  color: #8c99ab;
}
</style>
