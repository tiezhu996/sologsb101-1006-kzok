<script setup lang="ts">
/**
 * /merge 离线合并评审（三向比对）
 * 一侧改过的记录自动接回；裂缝/环片/测次两边都改默认并列保留；
 * 其余双改由核验人二选一。核验处理完一起入库；挂起项留暂存，中断可续。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Clock, DocumentCopy } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMergeStore } from '@/stores/mergeStore'
import { formatMileage } from '@/types/section'
import type { AnyEntityRow, MergeEntry, MergeResolutionType } from '@/types/merge'
import type { EntityTable } from '@/types/tombstone'
import { shortHash } from '@/utils/mergeHash'

const router = useRouter()
const mergeStore = useMergeStore()
mergeStore.resumeSession()

type FilterKey = 'all' | 'auto' | 'pending' | 'resolved' | 'committed'
const activeFilter = ref<FilterKey>('all')

const TABLE_LABEL: Record<EntityTable, string> = {
  sections: '区间',
  rings: '环片',
  cracks: '裂缝',
  surveys: '测次',
  advices: '建议'
}

const KEEP_BOTH_TABLES: EntityTable[] = ['cracks', 'rings', 'surveys']

const SIDE_TEXT = {
  'local-only': '仅本机改过',
  'incoming-only': '仅对端改过',
  both: '两边都改过'
} as const

const STATUS_TEXT = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  unchanged: '无变化',
  conflicted: '双改冲突'
} as const

function isCommitted(entry: MergeEntry): boolean {
  return mergeStore.session?.committedEntryIds.includes(entry.id) ?? false
}

function isPending(entry: MergeEntry): boolean {
  return entry.status === 'conflicted' && (entry.resolution.type === 'skip' || entry.resolution.decidedAt === null)
}

const filteredEntries = computed<MergeEntry[]>(() => {
  const entries = mergeStore.session?.entries ?? []
  const sorted = [...entries].sort((a, b) => {
    const order: EntityTable[] = ['sections', 'rings', 'cracks', 'surveys', 'advices']
    const tableDiff = order.indexOf(a.table) - order.indexOf(b.table)
    if (tableDiff !== 0) return tableDiff
    return a.label.localeCompare(b.label, 'zh-Hans-CN')
  })
  switch (activeFilter.value) {
    case 'auto':
      return sorted.filter((entry) => entry.resolution.type === 'auto')
    case 'pending':
      return sorted.filter(isPending)
    case 'resolved':
      return sorted.filter(
        (entry) => entry.status === 'conflicted' && entry.resolution.type !== 'skip' && entry.resolution.decidedAt !== null
      )
    case 'committed':
      return sorted.filter(isCommitted)
    default:
      return sorted
  }
})

const actionableCount = computed(
  () =>
    (mergeStore.session?.entries.filter(
      (entry) => entry.resolution.type !== 'skip' && !isCommitted(entry)
    ).length) ?? 0
)

function onResolutionChange(entry: MergeEntry, value: MergeResolutionType): void {
  mergeStore.resolveEntry(entry.id, value)
}

async function commit(): Promise<void> {
  const pending = mergeStore.sessionStats.pending
  const confirmed = await ElMessageBox.confirm(
    pending > 0
      ? `将把 ${actionableCount.value} 条自动/已决记录一起入库；另有 ${pending} 条挂起冲突保留暂存，稍后可继续。确认入库？`
      : `将把 ${actionableCount.value} 条记录一起入库，确认继续？`,
    '合并入库确认',
    { type: 'warning', confirmButtonText: '一起入库', cancelButtonText: '再看看' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    const result = await mergeStore.commitResolved()
    if (result.remaining > 0) {
      ElMessage.success(`已入库 ${result.committed} 条，剩余 ${result.remaining} 条挂起项已留住暂存现场`)
    } else {
      ElMessage.success(`合并完成：共入库 ${result.committed} 条，并列保留 ${result.duplicateGroups} 组`)
    }
  } catch (error) {
    ElMessage.error(`入库失败：${error instanceof Error ? error.message : '未知错误'}（暂存现场已保留，可重试）`)
  }
}

async function discard(): Promise<void> {
  const confirmed = await ElMessageBox.confirm('放弃后本次比对暂存将被清除（两侧原始数据不受影响），确认放弃？', '放弃合并', {
    type: 'warning',
    confirmButtonText: '确认放弃',
    cancelButtonText: '继续核验'
  }).catch(() => false)
  if (!confirmed) return
  mergeStore.discardSession()
  ElMessage.info('合并暂存已清除')
}

function rowKey(row: MergeEntry): string {
  return row.id
}

/* ------------------------------ 字段对比 ------------------------------ */

function fieldPairs(table: EntityTable, row: AnyEntityRow | null): Array<[string, string]> {
  if (!row) return []
  switch (table) {
    case 'sections':
      return [
        ['线路', String((row as { line?: string }).line ?? '')],
        ['起里程', formatMileage((row as { startMileage?: number }).startMileage ?? 0)],
        ['止里程', formatMileage((row as { endMileage?: number }).endMileage ?? 0)],
        ['结构型式', String((row as { structureType?: string }).structureType ?? '')],
        ['环数', String((row as { ringCount?: number }).ringCount ?? 0)]
      ]
    case 'rings':
      return [
        ['环号', `第 ${(row as { ringNo?: number }).ringNo ?? 0} 环`],
        ['里程', formatMileage((row as { mileage?: number }).mileage ?? 0)],
        ['管片型式', String((row as { segmentType?: string }).segmentType ?? '')],
        ['安装日期', String((row as { installDate?: string }).installDate ?? '')]
      ]
    case 'cracks':
      return [
        ['编号', String((row as { code?: string }).code ?? '')],
        ['部位', String((row as { position?: string }).position ?? '')],
        ['走向', String((row as { direction?: string }).direction ?? '')],
        ['宽度', `${(row as { widthMm?: number }).widthMm ?? 0} mm`],
        ['长度', `${(row as { lengthMm?: number }).lengthMm ?? 0} mm`],
        ['状态', String((row as { state?: string }).state ?? '')]
      ]
    case 'surveys':
      return [
        ['测次', `第 ${(row as { seq?: number }).seq ?? 0} 测次`],
        ['日期', String((row as { date?: string }).date ?? '')],
        ['宽度', `${(row as { widthMm?: number }).widthMm ?? 0} mm`],
        ['长度', `${(row as { lengthMm?: number }).lengthMm ?? 0} mm`],
        ['复测人', String((row as { surveyor?: string }).surveyor ?? '')]
      ]
    case 'advices':
      return [
        ['等级', String((row as { level?: string }).level ?? '')],
        ['措施', String((row as { measure?: string }).measure ?? '')],
        ['状态', String((row as { state?: string }).state ?? '')],
        ['依据', String((row as { basis?: string }).basis ?? '')]
      ]
  }
}

type Triple = { label: string; base: string; local: string; incoming: string; differ: boolean }

function compareFields(entry: MergeEntry): Triple[] {
  const baseFields = new Map(fieldPairs(entry.table, entry.baseRow))
  const localFields = new Map(fieldPairs(entry.table, entry.localRow))
  const incomingFields = new Map(fieldPairs(entry.table, entry.incomingRow))
  const labels = Array.from(new Set([...baseFields.keys(), ...localFields.keys(), ...incomingFields.keys()]))
  return labels.map((label) => {
    const base = baseFields.get(label) ?? '—'
    const local = localFields.get(label) ?? (entry.localRow ? '—' : '（无记录）')
    const incoming = incomingFields.get(label) ?? (entry.incomingRow ? '—' : '（无记录）')
    return { label, base, local, incoming, differ: local !== incoming }
  })
}

function deletedText(entry: MergeEntry): string {
  if (entry.side === 'incoming-only' && entry.status === 'deleted') return '对端已撤去'
  if (entry.side === 'local-only' && entry.status === 'deleted') return '本机已撤去'
  if (entry.status === 'conflicted' && !entry.localRow) return '本机已撤去 / 对端有改动'
  if (entry.status === 'conflicted' && !entry.incomingRow) return '对端已撤去 / 本机有改动'
  return ''
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">离线合并 · 三向比对核验</h2>
        <p class="page-head__desc">
          以导出基线为共同祖先：一侧改动自动接回，裂缝/环片/测次两边都改默认并列保留，核验处理完再一起入库。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="DocumentCopy" @click="router.push('/backup')">返回备份页</el-button>
      </div>
    </div>

    <EmptyPanel
      v-if="!mergeStore.session"
      title="没有进行中的合并"
      description="先在「建议与备份」页导出带基线的全量 JSON 交给另一班组；拿到对端复测后的备份后，在此页发起合并导入。"
      action-text="去备份页导入对端备份"
      @action="router.push('/backup')"
    />

    <template v-else>
      <el-alert
        v-if="mergeStore.session.missingBaseline"
        type="warning"
        :closable="false"
        show-icon
        title="本机没有导出基线：已按「双方新增」兜底比对——对端新增自动接回、同 id 内容不同仍列双改；对端删除因无共同祖先佐证不会自动生效。建议先导出一次带基线的备份再分头复测。"
        style="margin-bottom: 12px"
      />
      <el-alert
        v-if="mergeStore.session.backupDbVersion < 3"
        type="info"
        :closable="false"
        show-icon
        title="该备份由旧版（v1/v2）导出，已按兼容结构读入；旧版不含删除墓碑，撤去记录按无变化处理。"
        style="margin-bottom: 12px"
      />

      <div class="stat-row">
        <StatBadge label="比对条目" :value="mergeStore.sessionStats.total" suffix="条" icon="Files" tone="primary" />
        <StatBadge label="自动接回" :value="mergeStore.sessionStats.auto" suffix="条" icon="CircleCheckFilled" tone="success" />
        <StatBadge label="待核验" :value="mergeStore.sessionStats.pending" suffix="条" icon="WarningFilled" tone="danger" />
        <StatBadge label="已入库" :value="mergeStore.sessionStats.committed" suffix="条" icon="CircleCheck" tone="info" />
      </div>

      <div class="panel" style="margin-top: 16px">
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="对端备份导出时间">
            {{ new Date(mergeStore.session.backupExportedAt).toLocaleString('zh-CN') }}
          </el-descriptions-item>
          <el-descriptions-item label="备份结构版本">v{{ mergeStore.session.backupDbVersion }}</el-descriptions-item>
          <el-descriptions-item label="备份指纹">{{ shortHash(mergeStore.session.backupHash) }}</el-descriptions-item>
          <el-descriptions-item label="对端数据量">
            区间 {{ mergeStore.session.incomingCounts.sections ?? 0 }} · 环片
            {{ mergeStore.session.incomingCounts.rings ?? 0 }} · 裂缝
            {{ mergeStore.session.incomingCounts.cracks ?? 0 }} · 测次
            {{ mergeStore.session.incomingCounts.surveys ?? 0 }} · 建议
            {{ mergeStore.session.incomingCounts.advices ?? 0 }}
          </el-descriptions-item>
          <el-descriptions-item label="删除留痕">
            {{ mergeStore.session.incomingCounts.tombstones ?? 0 }} 条
          </el-descriptions-item>
          <el-descriptions-item label="暂存状态">
            <el-tag size="small" type="warning"><el-icon><Clock /></el-icon> 中断后可恢复，重试不重复记账</el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0">
          <el-button
            v-for="item in [
              { key: 'all', label: `全部 ${mergeStore.sessionStats.total}` },
              { key: 'pending', label: `待核验 ${mergeStore.sessionStats.pending}` },
              { key: 'auto', label: `自动接回 ${mergeStore.sessionStats.auto}` },
              {
                key: 'resolved',
                label: `已处理 ${mergeStore.sessionStats.resolved}`
              },
              { key: 'committed', label: `已入库 ${mergeStore.sessionStats.committed}` }
            ]"
            :key="item.key"
            :type="activeFilter === item.key ? 'primary' : 'default'"
            size="small"
            @click="activeFilter = item.key as FilterKey"
          >
            {{ item.label }}
          </el-button>
          <span style="flex: 1" />
          <el-button type="danger" plain size="small" @click="discard">放弃暂存</el-button>
          <el-button type="primary" size="small" :disabled="actionableCount === 0" @click="commit">
            把已处理的一起入库（{{ actionableCount }}）
          </el-button>
        </div>

        <el-table :data="filteredEntries" border stripe :row-key="rowKey" size="small">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="diff-grid">
                <div class="diff-col">
                  <h5>导出基线</h5>
                  <p v-for="field in compareFields(row)" :key="field.label" class="diff-line">
                    <span class="diff-label">{{ field.label }}</span>
                    <span>{{ field.base }}</span>
                  </p>
                </div>
                <div class="diff-col">
                  <h5>本机当前</h5>
                  <p v-for="field in compareFields(row)" :key="field.label" class="diff-line">
                    <span class="diff-label">{{ field.label }}</span>
                    <span :class="{ 'diff-hot': field.differ && row.side === 'both' }">{{ field.local }}</span>
                  </p>
                </div>
                <div class="diff-col">
                  <h5>对端备份</h5>
                  <p v-for="field in compareFields(row)" :key="field.label" class="diff-line">
                    <span class="diff-label">{{ field.label }}</span>
                    <span :class="{ 'diff-hot': field.differ && row.side === 'both' }">{{ field.incoming }}</span>
                  </p>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="72">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ TABLE_LABEL[(row as MergeEntry).table] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="label" label="记录" min-width="200" show-overflow-tooltip />
          <el-table-column label="变化" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="(row as MergeEntry).side === 'both' ? 'danger' : 'info'">
                {{ SIDE_TEXT[(row as MergeEntry).side] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="(row as MergeEntry).status === 'conflicted' ? 'danger' : (row as MergeEntry).status === 'deleted' ? 'warning' : 'success'"
              >
                {{ STATUS_TEXT[(row as MergeEntry).status] }}
              </el-tag>
              <div v-if="deletedText(row as MergeEntry)" class="muted" style="font-size: 12px">
                {{ deletedText(row as MergeEntry) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="核验决定" min-width="250">
            <template #default="{ row }">
              <template v-if="isCommitted(row as MergeEntry)">
                <el-tag size="small" type="success"><el-icon><CircleCheck /></el-icon> 已入库</el-tag>
              </template>
              <template v-else-if="(row as MergeEntry).resolution.type === 'auto'">
                <el-tag size="small" type="success">自动接回</el-tag>
                <span class="muted" style="margin-left: 8px; font-size: 12px">入库时直接生效</span>
              </template>
              <template v-else>
                <el-radio-group
                  :model-value="(row as MergeEntry).resolution.type"
                  size="small"
                  @update:model-value="(value: string | number | boolean) => onResolutionChange(row as MergeEntry, value as MergeResolutionType)"
                >
                  <el-radio-button
                    v-if="KEEP_BOTH_TABLES.includes((row as MergeEntry).table)"
                    value="keep-both"
                  >
                    并列保留
                  </el-radio-button>
                  <el-radio-button value="take-local">取本机</el-radio-button>
                  <el-radio-button value="take-incoming">取对端</el-radio-button>
                </el-radio-group>
                <el-button
                  v-if="!KEEP_BOTH_TABLES.includes((row as MergeEntry).table)"
                  link
                  type="warning"
                  size="small"
                  @click="mergeStore.resetEntry((row as MergeEntry).id)"
                >
                  挂起
                </el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 8px 16px;
}

.diff-col h5 {
  margin: 0 0 6px;
  font-size: 13px;
}

.diff-line {
  display: flex;
  gap: 8px;
  margin: 2px 0;
  font-size: 12px;
  line-height: 1.6;
}

.diff-label {
  flex: 0 0 64px;
  color: var(--el-text-color-secondary);
}

.diff-hot {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
