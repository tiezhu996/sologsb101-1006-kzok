<script setup lang="ts">
/**
 * /backup 整治建议与结构版本导出
 * 维护建议措施与状态流转；导出带基线的全量 JSON；
 * 导入对端备份时走三向离线合并（/merge），保留整库覆盖作为兜底；
 * 展示删除留痕（墓碑）、导出基线与并列保留归组。
 * 消费全部模型；复用 <EmptyPanel>、<FilterBar>、<StatBadge>。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Download, Edit, Plus, Refresh, RefreshRight, Right, Upload } from '@element-plus/icons-vue'
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
  deleteAdviceSoft,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type AdviceRow,
  type BackupPayload,
  type TombstoneRow
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
import { DUPLICATE_GROUPS_LS_KEY } from '@/types/baseline'
import { ENTITY_TABLES, type EntityTable } from '@/types/tombstone'
import { exportCrackCsv } from '@/utils/export'
import { formatMm } from '@/utils/rate'
import { sha256Text, shortHash } from '@/utils/mergeHash'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const crackStore = useCrackStore()
const surveyStore = useSurveyStore()
const sectionStore = useSectionStore()
const mergeStore = useMergeStore()
const adviceTable = useIdbTable<AdviceRow>((database) => database.advices, { sortByUpdatedAt: false })
const tombstoneTable = useIdbTable<TombstoneRow>((database) => database.tombstones, { sortByUpdatedAt: false })

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const stateFilter = ref<AdviceState[]>([])
const keyword = ref('')
const crewInput = ref(mergeStore.crewName)

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 班组名 ------------------------------ */

function saveCrewName(): void {
  mergeStore.setCrewName(crewInput.value)
  ElMessage.success(mergeStore.crewName ? `当前班组：${mergeStore.crewName}` : '班组名已清空，导出将标记为「本机」')
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
    `确认撤销「${crackOf(advice.crackId)?.code ?? '该裂缝'}」的整治建议？撤销会留下删除留痕，可随备份合并。`,
    '撤销确认',
    { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await deleteAdviceSoft(advice.id)
  ElMessage.success('整治建议已撤销（删除已留痕）')
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

/* ------------------------ 导出（含基线） ------------------------ */

async function exportAll(): Promise<void> {
  const payload = await exportSnapshot(mergeStore.crewName || undefined)
  const hash = await sha256Text(JSON.stringify(payload))
  payload.hash = hash
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
  // 导出基线：下次合并对端复测备份时以此为共同祖先做三向比对
  await mergeStore.saveBaselineFromPayload(payload, hash)
  const iso = new Date().toISOString()
  stampBackupTime(iso)
  lastBackupAt.value = iso
  ElMessage.success(`已导出 ${filename}，并记住导出基线（指纹 ${shortHash(hash)}）`)
}

/* ------------------------ 导入（合并 / 覆盖） ------------------------ */

const fileInput = ref<HTMLInputElement | null>(null)
const importMode = ref<'merge' | 'overwrite'>('merge')

function triggerImport(mode: 'merge' | 'overwrite'): void {
  importMode.value = mode
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
    const hash = await sha256Text(text)
    if (importMode.value === 'overwrite') {
      const confirmed = await ElMessageBox.confirm(
        '覆盖导入会清空当前全部本地数据（含删除留痕与合并基线），确认继续？',
        '覆盖导入确认',
        { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
      ).catch(() => false)
      if (!confirmed) return
      await importSnapshot(payload)
      ElMessage.success(`存档已覆盖导入（v${payload.dbVersion ?? '未知'}，指纹 ${shortHash(hash)}）`)
      await refreshCounts()
    } else {
      if (mergeStore.hasMergedHash(hash)) {
        ElMessage.warning('这份备份已经合并入库，重试同一备份不会再多记一条。')
        return
      }
      const resume = mergeStore.session?.status === 'open' && mergeStore.session.backupHash === hash
      if (!resume && mergeStore.hasOpenSession) {
        const goOn = await ElMessageBox.confirm(
          '当前存在未完成的合并暂存，导入新备份会先保留该暂存。可在合并页先处理完毕；是否继续打开新备份？',
          '存在未完成合并',
          { type: 'warning', confirmButtonText: '打开新备份', cancelButtonText: '取消' }
        ).catch(() => false)
        if (!goOn) return
      }
      const prepared = await mergeStore.prepareMerge(payload, hash)
      if (prepared.missingBaseline) {
        ElMessageBox.alert(
          '本机没有找到导出基线（可能首次使用合并或清理过浏览器数据）。系统将按「双方新增」兜底比对：仅处理对端相对本机新增/删除的记录，对同一记录的两边改动无法识别为并列，建议先导出一次带基线的备份再分头复测。',
          '缺少导出基线',
          { type: 'warning', confirmButtonText: '知道了，继续合并' }
        ).catch(() => undefined)
      }
      router.push('/merge')
    }
  } catch (error) {
    ElMessage.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

async function clearData(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('清空后所有本地数据（含删除留痕、合并基线与暂存）将被删除且不可恢复，确认清空？', '清空确认', {
    type: 'warning',
    confirmButtonText: '确认清空',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await clearAllTables()
  mergeStore.clearBaseline()
  mergeStore.discardSession()
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

/* --------------------------- 删除留痕 / 并列 --------------------------- */

const TOMBSTONE_LABEL: Record<EntityTable, string> = {
  sections: '区间',
  rings: '环片',
  cracks: '裂缝',
  surveys: '测次',
  advices: '建议'
}

const recentTombstones = computed(() =>
  [...tombstoneTable.rows.value].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 8)
)

interface DuplicateGroupInfo {
  label: string
  table: string
  crew: string
  at: number
}

const duplicateGroups = computed<Record<string, DuplicateGroupInfo>>(() => {
  try {
    return JSON.parse(localStorage.getItem(DUPLICATE_GROUPS_LS_KEY) ?? '{}') as Record<string, DuplicateGroupInfo>
  } catch {
    return {}
  }
})

const duplicateRows = computed(() =>
  crackStore.cracks
    .filter((crack) => crack.mergeOrigin?.kind === 'duplicate')
    .map((crack) => ({
      id: crack.id,
      code: crack.code,
      crew: crack.mergeOrigin?.crew ?? '',
      origin: crack.mergeOrigin?.origin === 'local' ? '本机版' : '对端版',
      at: duplicateGroups.value[crack.id]?.at
    }))
)

const baselineMeta = computed(() =>
  mergeStore.baseline
    ? {
        exportedAt: new Date(mergeStore.baseline.exportedAt).toLocaleString('zh-CN'),
        hash: shortHash(mergeStore.baseline.hash),
        by: mergeStore.baseline.exportedBy || '本机'
      }
    : null
)

const mergedList = computed(() => mergeStore.mergedHashes.slice(-5).reverse())

void ENTITY_TABLES
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">整治建议与数据备份</h2>
        <p class="page-head__desc">
          导出带基线的全量 JSON 交另一班组离线复测；回传后走三向合并（一侧改动自动接回，双改并列/核验），不再只能整库覆盖。
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
      <StatBadge label="删除留痕" :value="tombstoneTable.rows.value.length" suffix="条" icon="Delete" tone="success" />
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
            <el-tag v-if="row.mergeOrigin?.origin === 'incoming'" size="small" type="info" style="margin-left: 4px">
              合并并入
            </el-tag>
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
              <el-icon><Delete /></el-icon> 撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">离线合并与备份</h3>

      <div class="crew-line">
        <span class="muted">本班组建名（导出与删除留痕会带上，对端合并时可辨认来源）：</span>
        <el-input v-model="crewInput" placeholder="如：维保一班 / 第三方监测组" style="width: 260px" maxlength="20" />
        <el-button size="small" @click="saveCrewName">记住班组名</el-button>
      </div>

      <el-descriptions :column="3" border size="small" style="margin-top: 12px">
        <el-descriptions-item label="导出基线">
          <template v-if="baselineMeta">
            {{ baselineMeta.by }} · {{ baselineMeta.exportedAt }} · 指纹 {{ baselineMeta.hash }}
          </template>
          <span v-else class="muted">尚未导出基线，导出全量 JSON 时自动记住</span>
        </el-descriptions-item>
        <el-descriptions-item label="最近备份时间">{{ lastBackupAt ?? '尚未备份' }}</el-descriptions-item>
        <el-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（localStorage 记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="区间 / 环片">
          {{ counts.sections ?? 0 }} / {{ counts.rings ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="裂缝 / 复测">
          {{ counts.cracks ?? 0 }} / {{ counts.surveys ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="建议 / 删除留痕">
          {{ counts.advices ?? 0 }} / {{ counts.tombstones ?? 0 }}
        </el-descriptions-item>
      </el-descriptions>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px">
        <el-button type="primary" :icon="Download" @click="exportAll">导出全量 JSON（记住基线）</el-button>
        <el-button type="success" plain :icon="Upload" @click="triggerImport('merge')">
          导入对端备份（离线合并）
        </el-button>
        <el-button :icon="Upload" @click="triggerImport('overwrite')">覆盖导入（整库替换，兜底）</el-button>
        <el-button :icon="RefreshRight" @click="reseed">重置为演示数据</el-button>
        <el-button type="danger" plain :icon="Delete" @click="clearData">清空本地数据</el-button>
        <el-button :icon="Refresh" @click="refreshCounts">刷新统计</el-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />

      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-top: 12px"
        title="合并口径：一侧改过自动接回；裂缝、环片、测次两边都改默认并列保留；区间/建议双改由核验人二选一。撤去的记录留下墓碑一起参与合并；同一备份重复导入不会多记一条；v1/v2 旧版备份也能读入。"
      />
    </div>

    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title">并列保留的裂缝（{{ duplicateRows.length }}）</h3>
        <span class="muted">双改并列后，对端版本以「（班组版）」后缀单独建档，核验后可人工合并取舍</span>
      </div>
      <el-empty v-if="duplicateRows.length === 0" description="暂无并列保留记录" :image-size="60" />
      <el-table v-else :data="duplicateRows" border stripe size="small">
        <el-table-column prop="code" label="裂缝编号" min-width="200" />
        <el-table-column label="来源" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.origin === '对端版' ? 'warning' : 'info'">{{ row.origin }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="crew" label="对端班组" width="160" />
      </el-table>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h3 class="panel-title">最近删除留痕（{{ tombstoneTable.rows.value.length }}）</h3>
        <span class="muted">撤去的记录不物理抹掉，随下一次备份导出并参与对端合并</span>
      </div>
      <el-empty v-if="recentTombstones.length === 0" description="暂无删除留痕" :image-size="60" />
      <el-table v-else :data="recentTombstones" border stripe size="small">
        <el-table-column label="类型" width="80">
          <template #default="{ row }">{{ TOMBSTONE_LABEL[row.table as EntityTable] }}</template>
        </el-table-column>
        <el-table-column prop="label" label="记录" min-width="180" show-overflow-tooltip />
        <el-table-column prop="deletedBy" label="操作人" width="120" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.deletedAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.origin === 'imported' ? 'warning' : 'info'">
              {{ row.origin === 'imported' ? '合并并入' : '本机删除' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel" v-if="mergedList.length > 0">
      <h3 class="panel-title">最近已合并备份</h3>
      <el-tag v-for="hash in mergedList" :key="hash" size="small" type="info" style="margin-right: 8px">
        {{ shortHash(hash) }}
      </el-tag>
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

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.crew-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
