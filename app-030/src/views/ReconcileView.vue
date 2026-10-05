<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  deleteReconciliation,
  ensureMerged,
  flushProject,
  getProject,
  getRule,
  saveReconciliation,
  store
} from '../logic/store'
import {
  CONFLICT_POLICY_LABELS,
  RECONCILE_FIELDS,
  RECONCILE_FIELD_LABELS,
  RECONCILE_KIND_LABELS,
  RECONCILE_STATUS_LABELS,
  buildReconciliation,
  commitAdoption,
  detectReconcileHeaderRow,
  findReconciliationByFingerprint,
  guessReconcileMapping,
  parseReconcileRow,
  previewAdopt,
  reconcileDisplayValue,
  rejectItems,
  resetItemDecision,
  selectDuplicateRow,
  selectMatchedPerson,
  type ParsedReconcileRow,
  type ReconcileColumnMapping
} from '../logic/reconcile'
import {
  reconcileCsvText,
  reconcileFieldRows,
  reconcileFileBase,
  reconcileWorkbookSheets
} from '../logic/reconcileExport'
import { downloadBlob, downloadText, fnv1a, parseDelimitedText, readFileAsText, toCsvText } from '../logic/csv'
import { buildXlsxBlob, isXlsxFile, readXlsxRows } from '../logic/xlsx'
import type { ReconcileConflictPolicy, ReconcileFieldKey, ReconcileItem, Reconciliation } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

/* ------------------------------- 第一步：读文件 ------------------------------- */

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileSize = ref(0)
const fingerprint = ref('')
const rawRows = ref<string[][]>([])
const headerIndex = ref(-1)
const mapping = ref<ReconcileColumnMapping | null>(null)
const conflictPolicy = ref<ReconcileConflictPolicy>('sheet_wins')
const fileError = ref('')
const notice = ref('')
const dragActive = ref(false)
const parseMs = ref(0)

const headerCells = computed(() =>
  headerIndex.value >= 0 ? rawRows.value[headerIndex.value] ?? [] : []
)
const rawPreview = computed(() =>
  headerIndex.value >= 0 ? rawRows.value.slice(headerIndex.value, headerIndex.value + 5) : []
)

const activeReconciliationId = ref<string>('')
const activeReconciliation = computed<Reconciliation | null>(() => {
  const current = project.value
  if (!current) return null
  if (activeReconciliationId.value) {
    return current.reconciliations.find((entry) => entry.id === activeReconciliationId.value) ?? null
  }
  return current.reconciliations[0] ?? null
})

const dataRowCount = computed(() =>
  headerIndex.value < 0 ? 0 : Math.max(0, rawRows.value.length - headerIndex.value - 1)
)

async function handleFile(file: File): Promise<void> {
  fileError.value = ''
  notice.value = ''
  fileName.value = file.name
  fileSize.value = file.size
  const started = performance.now()
  try {
    let rows: string[][]
    let contentKey = ''
    if (isXlsxFile(file)) {
      rows = await readXlsxRows(file)
      contentKey = rows.map((row) => row.join('')).join('')
    } else {
      const text = await readFileAsText(file)
      rows = parseDelimitedText(text)
      contentKey = text
    }
    if (rows.length === 0) {
      fileError.value = '文件里没有可识别的数据行'
      return
    }
    rawRows.value = rows
    fingerprint.value = `${file.name}|${file.size}|${fnv1a(contentKey)}`
    const detected = detectReconcileHeaderRow(rows)
    if (detected < 0) {
      fileError.value = '未能识别表头（前 8 行需包含「姓名」和「身高」列），请确认是导出的量体明细 / 学校回表'
      headerIndex.value = -1
      mapping.value = null
      return
    }
    headerIndex.value = detected
    mapping.value = guessReconcileMapping(rows[detected])
    parseMs.value = Math.round((performance.now() - started) * 100) / 100
  } catch (error) {
    fileError.value = error instanceof Error ? error.message : String(error)
  }
}

function onFileChange(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void handleFile(file)
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void handleFile(file)
}

function resetFile(): void {
  fileName.value = ''
  fileSize.value = 0
  fingerprint.value = ''
  rawRows.value = []
  headerIndex.value = -1
  mapping.value = null
  fileError.value = ''
  parseMs.value = 0
}

/* ------------------------------- 第二步：生成差异单 ------------------------------- */

const generating = ref(false)

async function generate(): Promise<void> {
  const current = project.value
  const currentMapping = mapping.value
  if (!current || !currentMapping) return
  fileError.value = ''
  notice.value = ''
  if (currentMapping.name === null) {
    fileError.value = '必须映射「姓名」列（按 姓名 + 班级 找人）'
    return
  }
  if (currentMapping.heightCm === null) {
    fileError.value = '必须映射「身高」列'
    return
  }

  const existing = findReconciliationByFingerprint(current, fingerprint.value)
  if (existing) {
    activeReconciliationId.value = existing.id
    notice.value = `同一份回贴（指纹 ${fingerprint.value}）此前已比对过，直接打开既有差异单——同一份回贴重复比对只出一份差异单。`
    resetFile()
    return
  }

  generating.value = true
  try {
    const started = performance.now()
    const defaultBatch = current.batches[0] ?? '未分批'
    const parsed: ParsedReconcileRow[] = []
    const dataRows = rawRows.value
      .slice(headerIndex.value + 1)
      .map((cells, index) => ({ cells, lineNo: headerIndex.value + index + 2 }))
      .filter((row) => row.cells.some((cell) => cell !== ''))
    for (const row of dataRows) {
      const parsedRow = parseReconcileRow(row.cells, currentMapping, defaultBatch, row.lineNo)
      if (parsedRow) parsed.push(parsedRow)
    }
    const reconciliation = buildReconciliation({
      project: current,
      rule: rule.value,
      parsedRows: parsed,
      fileName: fileName.value,
      fingerprint: fingerprint.value,
      conflictPolicy: conflictPolicy.value,
      operator: store.operator
    })
    parseMs.value = Math.round((performance.now() - started) * 100) / 100
    await saveReconciliation(current, reconciliation)
    activeReconciliationId.value = reconciliation.id
    notice.value = `差异单已生成并存到本机：改了值 ${reconciliation.counts.changed}、表里有库里没有 ${reconciliation.counts.sheetOnly}、库里有表里没了 ${reconciliation.counts.dbOnly}、同一人两行 ${reconciliation.counts.duplicateSheet}、错误行 ${reconciliation.counts.error}；冲突字段条目 ${reconciliation.counts.conflicts}。`
    resetFile()
  } finally {
    generating.value = false
  }
}

/* ------------------------------- 第三步：逐条处理 ------------------------------- */

const filterKind = ref<'all' | ReconcileItem['kind'] | 'conflict' | 'pending' | 'accepted' | 'rejected'>('all')
const checked = ref<Set<string>>(new Set())
const gateResult = ref<ReturnType<typeof previewAdopt> | null>(null)
const actionError = ref('')
const actionNotice = ref('')

const filteredItems = computed<ReconcileItem[]>(() => {
  const reconciliation = activeReconciliation.value
  if (!reconciliation) return []
  return reconciliation.items.filter((item) => {
    if (filterKind.value === 'all') return true
    if (filterKind.value === 'conflict') return item.changes.some((change) => change.conflict)
    if (filterKind.value === 'pending' || filterKind.value === 'accepted' || filterKind.value === 'rejected') {
      return item.status === filterKind.value
    }
    return item.kind === filterKind.value
  })
})

const pendingItems = computed(() => activeReconciliation.value?.items.filter((item) => item.status === 'pending') ?? [])
const checkedPending = computed(() => pendingItems.value.filter((item) => checked.value.has(item.id)))
const allChecked = computed(
  () => filteredItems.value.length > 0 && filteredItems.value.every((item) => checked.value.has(item.id))
)

function toggleCheck(id: string): void {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

function toggleAllFiltered(): void {
  const next = new Set(checked.value)
  if (allChecked.value) {
    for (const item of filteredItems.value) next.delete(item.id)
  } else {
    for (const item of filteredItems.value) next.add(item.id)
  }
  checked.value = next
}

function checkAllPending(): void {
  checked.value = new Set(pendingItems.value.map((item) => item.id))
}

function clearChecks(): void {
  checked.value = new Set()
}

function kindBadgeClass(kind: ReconcileItem['kind']): string {
  if (kind === 'changed') return 'badge-info'
  if (kind === 'sheet_only') return 'badge-ok'
  if (kind === 'db_only') return 'badge-warn'
  if (kind === 'duplicate_sheet') return 'badge-warn'
  return 'badge-danger'
}

function statusBadgeClass(status: ReconcileItem['status']): string {
  if (status === 'accepted') return 'badge-ok'
  if (status === 'rejected') return 'badge-danger'
  return 'badge-warn'
}

function changeText(change: ReconcileItem['changes'][number]): string {
  return `${reconcileDisplayValue(change.dbValue)} → ${reconcileDisplayValue(change.sheetValue)}`
}

function selectRow(item: ReconcileItem, event: Event): void {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation || item.status !== 'pending') return
  const lineNo = Number((event.target as HTMLSelectElement).value)
  selectDuplicateRow(current, reconciliation, item, lineNo)
  void flushProject(current)
  gateResult.value = null
}

function selectPerson(item: ReconcileItem, event: Event): void {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation || item.status !== 'pending') return
  const personId = (event.target as HTMLSelectElement).value
  selectMatchedPerson(current, reconciliation, item, personId)
  void flushProject(current)
  gateResult.value = null
}

/* ------------------------------- 采纳预演 / 正式采纳 ------------------------------- */

async function runPreview(): Promise<boolean> {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return false
  const selected = new Set(checkedPending.value.map((item) => item.id))
  if (selected.size === 0) {
    actionError.value = '请先勾选要采纳的条目（每条可单独采纳；已处理的不会重复采纳）'
    return false
  }
  const gate = previewAdopt(current, rule.value, reconciliation, selected)
  gateResult.value = gate
  if (!gate.ok) {
    actionError.value = `采纳预演未通过守恒复核，已拦住，共 ${gate.blockingItems.length} 条造成对不上（见下方清单）；本次没有任何数据写回库里。`
    reconciliation.lastGateBlocked = true
    return false
  }
  actionError.value = ''
  return true
}

async function adoptChecked(): Promise<void> {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  if (!(await runPreview())) return
  const selected = new Set(checkedPending.value.map((item) => item.id))
  const result = commitAdoption(current, rule.value, reconciliation, selected, store.operator)
  if (!result.gate.ok) {
    actionError.value = '正式采纳时守恒复核未通过，已整批回滚，未写回任何数据。'
    return
  }
  await flushProject(current)
  actionNotice.value = `已采纳 ${result.adopted} 条并写回库里（标记为第 ${reconciliation.id} 次核对采纳）；采纳后复核：${result.gate.equation}，人数与套数对得上。`
  actionError.value = ''
  gateResult.value = null
  clearChecks()
}

async function rejectChecked(): Promise<void> {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  const selected = new Set(checkedPending.value.map((item) => item.id))
  if (selected.size === 0) {
    actionError.value = '请先勾选要不采纳的条目'
    return
  }
  const count = rejectItems(reconciliation, selected, store.operator)
  await flushProject(current)
  actionNotice.value = `已把 ${count} 条标记为「不采纳」，保留在差异单里，下次比对仍可再看。`
  actionError.value = ''
  clearChecks()
}

async function undoDecision(item: ReconcileItem): Promise<void> {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  resetItemDecision(reconciliation, item.id)
  await flushProject(current)
  actionNotice.value = '已退回「待处理」，可重新选择采纳或不采纳。'
}

/* ------------------------------- 导出 / 切换 / 删除 ------------------------------- */

function exportXlsx(): void {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  downloadBlob(
    buildXlsxBlob(reconcileWorkbookSheets(reconciliation, current)),
    `${reconcileFileBase(current, reconciliation)}.xlsx`
  )
  actionNotice.value = '差异单（Excel，含逐条清单与字段级明细两张表）已导出。'
}

function exportFieldsCsv(): void {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  downloadText(reconcileCsvText(reconciliation, current), `${reconcileFileBase(current, reconciliation)}.csv`)
  downloadText(toCsvText(reconcileFieldRows(reconciliation)), `${reconcileFileBase(current, reconciliation)}-字段明细.csv`)
  actionNotice.value = '逐条清单 + 字段级明细两份 CSV 已导出。'
}

function openReconciliation(id: string): void {
  activeReconciliationId.value = id
  gateResult.value = null
  actionError.value = ''
  actionNotice.value = ''
  clearChecks()
}

async function removeReconciliation(): Promise<void> {
  const current = project.value
  const reconciliation = activeReconciliation.value
  if (!current || !reconciliation) return
  if (!window.confirm(`确认删除差异单「${reconciliation.fileName}」？已采纳写回库里的数据不会受影响。`)) return
  await deleteReconciliation(current, reconciliation.id)
  activeReconciliationId.value = current.reconciliations[0]?.id ?? ''
  actionNotice.value = '差异单已删除（已采纳的库内数据保留）。'
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

const fieldKeys = RECONCILE_FIELDS
function fieldLabel(key: ReconcileFieldKey): string {
  return RECONCILE_FIELD_LABELS[key]
}

const reconciliationList = computed(() => project.value?.reconciliations ?? [])
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 回贴核对</h1>
        <div class="sub">
          学校改过的表发回来，按「姓名 + 班级」找人，逐条比身高 / 体重 / 胸围 / 腰围 / 性别 / 班级 / 批次；
          差异单存在本机，可逐条采纳
        </div>
      </div>
      <div class="spacer"></div>
      <RouterLink class="btn btn-sm" :to="`/export/${project.id}`">导出量体明细给学校</RouterLink>
    </div>

    <p v-if="notice" class="notice notice-info">{{ notice }}</p>
    <p v-if="actionNotice" class="notice notice-ok">{{ actionNotice }}</p>
    <p v-if="actionError" class="notice notice-error">{{ actionError }}</p>

    <!-- 第一步 + 第二步：上传与生成 -->
    <div class="card">
      <div class="card-head">
        <h2>第一步：选择学校发回来的表（CSV / Excel .xlsx）</h2>
        <div class="spacer"></div>
        <span v-if="fileName" class="badge badge-info">{{ fileName }}（{{ formatSize(fileSize) }}）</span>
      </div>
      <div class="card-body">
        <div
          style="border: 1px dashed var(--line); border-radius: 10px; padding: 18px; text-align: center"
          :style="dragActive ? 'border-color: var(--brand); background: #f4f8fc' : ''"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          <p>把学校回贴的表拖到这里，或</p>
          <input ref="fileInput" type="file" accept=".csv,.txt,.tsv,.xlsx" style="display: none" @change="onFileChange" />
          <button class="btn btn-primary" type="button" @click="fileInput?.click()">选择回表文件</button>
          <p class="hint" style="margin-top: 8px">文件只在本机解析，不上传；表头模糊识别（姓名 / 身高 / 胸围 / 班级…）</p>
        </div>
        <p v-if="fileError" class="notice notice-error" style="margin-top: 12px">{{ fileError }}</p>

        <div v-if="headerIndex >= 0 && mapping" style="margin-top: 12px">
          <div class="stat-row">
            <div class="stat"><div class="stat-label">识别表头行</div><div class="stat-value">第 {{ headerIndex + 1 }} 行</div></div>
            <div class="stat"><div class="stat-label">数据行数</div><div class="stat-value">{{ dataRowCount }}</div></div>
            <div class="stat"><div class="stat-label">解析耗时</div><div class="stat-value">{{ parseMs }} ms</div></div>
          </div>

          <h4 style="margin: 12px 0 6px">列映射（按姓名 + 班级找人）</h4>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">姓名 <b class="req">*</b></span>
              <select v-model.number="mapping.name" class="select" :class="{ error: mapping.name === null }">
                <option :value="null">（忽略）</option>
                <option v-for="(cell, index) in headerCells" :key="'n' + index" :value="index">
                  第 {{ index + 1 }} 列：{{ cell || '(空)' }}
                </option>
              </select>
            </label>
            <label v-for="key in fieldKeys" :key="key" class="field">
              <span class="field-label">{{ fieldLabel(key) }}</span>
              <select v-model.number="mapping[key]" class="select">
                <option :value="null">（忽略）</option>
                <option v-for="(cell, index) in headerCells" :key="key + index" :value="index">
                  第 {{ index + 1 }} 列：{{ cell || '(空)' }}
                </option>
              </select>
            </label>
          </div>

          <h4 style="margin: 12px 0 6px">回表值与库里手工改过的值冲突时，以哪个为准（会写进差异单）</h4>
          <div class="form-grid">
            <label class="field" style="max-width: 420px">
              <span class="field-label">冲突取舍策略</span>
              <select v-model="conflictPolicy" class="select">
                <option value="sheet_wins">{{ CONFLICT_POLICY_LABELS.sheet_wins }}</option>
                <option value="db_manual_wins">{{ CONFLICT_POLICY_LABELS.db_manual_wins }}</option>
              </select>
            </label>
          </div>
          <p class="hint" style="margin-top: 6px">
            冲突 = 学校改的与我们在库里手工改过的不一致（双方都改了同一字段）。选「库里手工改为准」时，冲突字段采纳时不会被回表覆盖，差异单字段明细会逐字段标明。
          </p>

          <div class="table-wrap" style="margin-top: 10px">
            <table class="data-table">
              <thead>
                <tr>
                  <th>原始行</th>
                  <th v-for="(cell, index) in headerCells" :key="index">{{ cell || `第${index + 1}列` }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in rawPreview" :key="rowIndex">
                  <td>{{ headerIndex + rowIndex + 1 }}</td>
                  <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-primary" type="button" :disabled="generating" @click="generate">
              {{ generating ? '比对中…' : '第二步：生成差异单（不写库）' }}
            </button>
            <button class="btn" type="button" @click="resetFile">重新选文件</button>
            <span class="hint">同一份回贴重复比对只出一份差异单（按文件内容指纹去重）</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 历史差异单 -->
    <div class="card" v-if="reconciliationList.length > 0">
      <div class="card-head">
        <h3>本机已存差异单（{{ reconciliationList.length }} 份）</h3>
        <div class="spacer"></div>
        <span class="hint">采纳的写回库里并标注核对批次；不采纳的留到下次</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>回表文件</th>
              <th>指纹</th>
              <th class="num">改值</th>
              <th class="num">表有库无</th>
              <th class="num">库有表无</th>
              <th class="num">同人两行</th>
              <th class="num">冲突</th>
              <th class="num">待处理</th>
              <th>策略</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in reconciliationList"
              :key="entry.id"
              :class="activeReconciliation?.id === entry.id ? 'row-highlight' : ''"
            >
              <td>{{ entry.fileName }}</td>
              <td><code>{{ entry.fingerprint.slice(0, 18) }}</code></td>
              <td class="num">{{ entry.counts.changed }}</td>
              <td class="num">{{ entry.counts.sheetOnly }}</td>
              <td class="num">{{ entry.counts.dbOnly }}</td>
              <td class="num">{{ entry.counts.duplicateSheet }}</td>
              <td class="num">{{ entry.counts.conflicts }}</td>
              <td class="num">
                <span :class="entry.counts.pending > 0 ? 'badge badge-warn' : 'badge badge-ok'">{{ entry.counts.pending }}</span>
              </td>
              <td>{{ entry.conflictPolicy === 'sheet_wins' ? '回表为准' : '手工改为准' }}</td>
              <td>{{ new Date(entry.createdAt).toLocaleString('zh-CN') }}</td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="openReconciliation(entry.id)">
                    {{ activeReconciliation?.id === entry.id ? '正在查看' : '打开' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 差异单详情 -->
    <template v-if="activeReconciliation">
      <div class="card card-accent-ok">
        <div class="card-head">
          <h2>差异单 · {{ activeReconciliation.fileName }}</h2>
          <div class="spacer"></div>
          <span class="badge badge-info">{{ activeReconciliation.id }}</span>
          <span class="badge" :class="activeReconciliation.counts.pending > 0 ? 'badge-warn' : 'badge-ok'">
            待处理 {{ activeReconciliation.counts.pending }}
          </span>
        </div>
        <div class="card-body tight">
          <div class="stat-row">
            <div class="stat"><div class="stat-label">改了值</div><div class="stat-value">{{ activeReconciliation.counts.changed }}</div></div>
            <div class="stat"><div class="stat-label">表里有·库里没有</div><div class="stat-value ok">{{ activeReconciliation.counts.sheetOnly }}</div></div>
            <div class="stat"><div class="stat-label">库里有·表里没了</div><div class="stat-value">{{ activeReconciliation.counts.dbOnly }}</div></div>
            <div class="stat"><div class="stat-label">同一人两行</div><div class="stat-value">{{ activeReconciliation.counts.duplicateSheet }}</div></div>
            <div class="stat"><div class="stat-label">回表错误</div><div class="stat-value bad">{{ activeReconciliation.counts.error }}</div></div>
            <div class="stat"><div class="stat-label">冲突字段条目</div><div class="stat-value bad">{{ activeReconciliation.counts.conflicts }}</div></div>
            <div class="stat"><div class="stat-label">已采纳 / 不采纳</div><div class="stat-value">{{ activeReconciliation.counts.accepted }} / {{ activeReconciliation.counts.rejected }}</div></div>
          </div>
          <p class="notice notice-info" style="margin-top: 10px">
            冲突取舍策略：<b>{{ CONFLICT_POLICY_LABELS[activeReconciliation.conflictPolicy] }}</b>；比对时间
            {{ new Date(activeReconciliation.createdAt).toLocaleString('zh-CN') }}；操作人 {{ activeReconciliation.operator }}。
            采纳后会重新归并并复核人数与套数，对不上整批拦住，不写回任何数据。
          </p>
          <div class="toolbar" style="margin-top: 10px">
            <button class="btn btn-primary btn-sm" type="button" :disabled="checkedPending.length === 0" @click="adoptChecked">
              采纳勾选的 {{ checkedPending.length }} 条（先过守恒复核）
            </button>
            <button class="btn btn-sm" type="button" :disabled="checkedPending.length === 0" @click="rejectChecked">
              不采纳勾选的
            </button>
            <button class="btn btn-sm" type="button" @click="checkAllPending">全选待处理</button>
            <button class="btn btn-sm" type="button" @click="clearChecks">清空勾选</button>
            <div class="spacer"></div>
            <button class="btn btn-sm" type="button" @click="exportXlsx">导出 Excel</button>
            <button class="btn btn-sm" type="button" @click="exportFieldsCsv">导出 CSV（清单+字段明细）</button>
            <button class="btn btn-sm btn-danger" type="button" @click="removeReconciliation">删除这份差异单</button>
          </div>
        </div>
      </div>

      <!-- 守恒拦截明细 -->
      <div v-if="gateResult && !gateResult.ok" class="card card-accent-danger">
        <div class="card-head">
          <h3>采纳已被拦住：以下 {{ gateResult.blockingItems.length }} 条会造成人数 / 套数对不上</h3>
        </div>
        <div class="card-body tight">
          <p class="notice notice-error">
            预演结果：{{ gateResult.equation }}；守恒不成立或数据被校验拦截。请先取消这些条目的勾选，或到归并页处理对应人员后再采纳。
          </p>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>姓名</th><th>班级/车间</th><th>分类</th><th>拦截原因</th></tr>
              </thead>
              <tbody>
                <tr v-for="blocked in gateResult.blockingItems" :key="blocked.itemId" class="row-invalid">
                  <td>{{ blocked.name }}</td>
                  <td>{{ blocked.orgUnit || '—' }}</td>
                  <td><span class="badge" :class="kindBadgeClass(blocked.kind)">{{ RECONCILE_KIND_LABELS[blocked.kind] }}</span></td>
                  <td>{{ blocked.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div v-else-if="gateResult && gateResult.ok" class="card card-accent-ok">
        <div class="card-body tight">
          <p class="notice notice-ok" style="margin: 0">
            预演通过：有效人数 {{ gateResult.before.valid }} → {{ gateResult.after.valid }}，总套数 {{ gateResult.before.qty }} →
            {{ gateResult.after.qty }}；{{ gateResult.equation }}。确认采纳后写回。
          </p>
        </div>
      </div>

      <!-- 逐条清单 -->
      <div class="card">
        <div class="card-head">
          <h3>逐条核对（{{ filteredItems.length }}）</h3>
          <div class="spacer"></div>
          <div class="toolbar">
            <select v-model="filterKind" class="select btn-sm" style="width: auto">
              <option value="all">全部分类</option>
              <option value="changed">仅改了值</option>
              <option value="sheet_only">仅表里有·库里没有</option>
              <option value="db_only">仅库里有·表里没了</option>
              <option value="duplicate_sheet">仅同一人两行</option>
              <option value="error">仅错误行</option>
              <option value="conflict">仅冲突</option>
              <option value="pending">仅待处理</option>
              <option value="accepted">仅已采纳</option>
              <option value="rejected">仅不采纳</option>
            </select>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th><input type="checkbox" :checked="allChecked" @change="toggleAllFiltered" /></th>
                <th>分类</th>
                <th>状态</th>
                <th>姓名</th>
                <th>班级/车间</th>
                <th class="num">回表行</th>
                <th>字段改动（库里 → 回表）</th>
                <th>情况 / 操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in filteredItems" :key="item.id" :class="item.kind === 'error' ? 'row-invalid' : ''">
                <td>
                  <input
                    v-if="item.status === 'pending' && item.kind !== 'error'"
                    type="checkbox"
                    :checked="checked.has(item.id)"
                    @change="toggleCheck(item.id)"
                  />
                </td>
                <td><span class="badge" :class="kindBadgeClass(item.kind)">{{ RECONCILE_KIND_LABELS[item.kind] }}</span></td>
                <td><span class="badge" :class="statusBadgeClass(item.status)">{{ RECONCILE_STATUS_LABELS[item.status] }}</span></td>
                <td><b>{{ item.name }}</b></td>
                <td>{{ item.orgUnit || '—' }}</td>
                <td class="num">{{ item.sheetLineNos.length ? item.sheetLineNos.join(' / ') : '—' }}</td>
                <td>
                  <!-- 改值 / 同人两行：字段级展示 -->
                  <template v-if="item.changes.length">
                    <div v-for="change in item.changes" :key="change.field" class="change-line">
                      <span class="badge">{{ fieldLabel(change.field) }}</span>
                      <span :class="change.conflict ? 'conflict-text' : ''">{{ changeText(change) }}</span>
                      <span v-if="change.conflict" class="badge badge-danger" style="margin-left: 4px">
                        冲突{{ change.willApply ? '·回表为准' : '·保留手工值' }}
                      </span>
                      <span v-else-if="item.kind === 'duplicate_sheet'" class="hint"></span>
                    </div>
                  </template>
                  <span v-else-if="item.kind === 'changed'" class="hint">七个字段一致，无改动</span>

                  <!-- 表有库无：展示回表值 -->
                  <template v-else-if="item.kind === 'sheet_only'">
                    <div class="pill-list">
                      <span v-for="key in fieldKeys" :key="key" class="badge">
                        {{ fieldLabel(key) }}：{{ reconcileDisplayValue(item.sheetValues[key]) }}
                      </span>
                    </div>
                  </template>

                  <!-- 库有表无 -->
                  <span v-else-if="item.kind === 'db_only'" class="hint">
                    采纳后排除出有效人数（身高 {{ reconcileDisplayValue(item.dbValues.heightCm) }}，
                    号型可在归并页查看；误删可恢复）
                  </span>

                  <span v-else-if="item.kind === 'error'" class="notice notice-error" style="padding: 2px 8px">
                    {{ item.parseError }}
                  </span>
                </td>
                <td>
                  <div style="max-width: 320px">
                    <p class="hint" style="margin-bottom: 4px">{{ item.note }}</p>
                    <!-- 同人两行：选择回表行 + 显示库里候选人 -->
                    <template v-if="item.kind === 'duplicate_sheet'">
                      <label class="field" style="margin-bottom: 4px">
                        <span class="field-label">以回表第几行为准</span>
                        <select
                          class="select btn-sm"
                          :value="item.selectedLineNo ?? undefined"
                          :disabled="item.status !== 'pending'"
                          @change="selectRow(item, $event)"
                        >
                          <option v-for="option in item.duplicateRows" :key="option.lineNo" :value="option.lineNo">
                            第 {{ option.lineNo }} 行（身高 {{ reconcileDisplayValue(option.values.heightCm) }} /
                            胸围 {{ reconcileDisplayValue(option.values.chestCm) }}）
                          </option>
                        </select>
                      </label>
                      <label v-if="item.candidates.length > 1" class="field" style="margin-bottom: 4px">
                        <span class="field-label">对到库里哪位（重名同班请分清）</span>
                        <select
                          class="select btn-sm"
                          :value="item.personId ?? ''"
                          :disabled="item.status !== 'pending'"
                          @change="selectPerson(item, $event)"
                        >
                          <option v-for="candidate in item.candidates" :key="candidate.personId" :value="candidate.personId">
                            {{ candidate.gender === 'male' ? '男' : '女' }} ｜
                            身高 {{ candidate.heightCm || '—' }} ｜ 胸围 {{ candidate.chestCm || '—' }} ｜
                            腰围 {{ candidate.waistCm || '—' }} ｜ {{ candidate.status === 'active' ? '有效' : candidate.status }}
                          </option>
                        </select>
                      </label>
                      <p v-else-if="item.candidates.length === 1" class="hint" style="margin-bottom: 4px">
                        已对到库里此人（身高 {{ item.candidates[0].heightCm }}cm）
                      </p>
                    </template>
                    <div v-if="item.status !== 'pending'" class="toolbar">
                      <span class="hint">
                        {{ item.decidedBy }} · {{ item.decidedAt ? new Date(item.decidedAt).toLocaleString('zh-CN') : '' }}
                      </span>
                      <button class="btn btn-sm" type="button" @click="undoDecision(item)">退回待处理</button>
                    </div>
                  </div>
                </td>
              </tr>
              <tr v-if="filteredItems.length === 0">
                <td colspan="8" class="empty">当前筛选下没有条目</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <div v-else-if="reconciliationList.length === 0" class="card">
      <div class="empty">
        还没有差异单。先用「导出量体明细」把表发给学校，学校改完发回来后，在本页选择回表文件生成差异单。
      </div>
    </div>
  </section>
</template>

<style scoped>
.change-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 1px 0;
}
.conflict-text {
  color: var(--danger);
  font-weight: 650;
}
</style>
