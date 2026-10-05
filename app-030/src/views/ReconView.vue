<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, store } from '../logic/store'
import { buildSummary, conservationText } from '../logic/merge'
import {
  adoptItems,
  buildReconciliation,
  fieldDiffs,
  findReconciliation,
  reconCounts,
  reconDecisionLabel,
  reconExportRows,
  reconKindLabel,
  reconPolicyText,
  snapshotSummary,
  type AdoptCulprit
} from '../logic/recon'
import { EMPTY_MAPPING, IMPORT_FIELDS, detectHeaderRow, guessMapping, mappedCount, type ColumnMapping } from '../logic/importPlan'
import { downloadBlob, downloadText, fnv1a, parseDelimitedText, readFileAsText, toCsvText, todayStamp } from '../logic/csv'
import { buildXlsxBlob, isXlsxFile, readXlsxRows } from '../logic/xlsx'
import { formatCm } from '../logic/precision'
import type { Person, Reconciliation, ReconFieldDiff, ReconItem, ReconItemKind } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

/* ------------------------- 文件选择与解析 ------------------------- */

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fingerprint = ref('')
const rawRows = ref<string[][]>([])
const headerIndex = ref(-1)
const mapping = ref<ColumnMapping>({ ...EMPTY_MAPPING })
const fileError = ref('')
const dragActive = ref(false)

const headerCells = computed(() => (headerIndex.value >= 0 ? rawRows.value[headerIndex.value] ?? [] : []))
const dataRowCount = computed(() => (headerIndex.value < 0 ? 0 : Math.max(0, rawRows.value.length - headerIndex.value - 1)))
const requiredMissing = computed(() =>
  IMPORT_FIELDS.filter((field) => field.required && mapping.value[field.key] === null).map((field) => field.label)
)

function resetFile(): void {
  rawRows.value = []
  headerIndex.value = -1
  mapping.value = { ...EMPTY_MAPPING }
  fileName.value = ''
  fingerprint.value = ''
  fileError.value = ''
}

async function handleFile(file: File): Promise<void> {
  resetFile()
  fileName.value = file.name
  try {
    let rows: string[][]
    let contentKey = ''
    if (isXlsxFile(file)) {
      rows = await readXlsxRows(file)
      contentKey = rows.map((row) => row.join('\u0001')).join('\u0002')
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
    const detected = detectHeaderRow(rows)
    if (detected < 0) {
      fileError.value = '未能识别表头行（前 8 行未找到姓名/性别/身高/胸围/腰围等列名），请检查文件'
      return
    }
    headerIndex.value = detected
    mapping.value = guessMapping(rows[detected])
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

/* ------------------------- 比对与差异单 ------------------------- */

const currentReconId = ref('')
const message = ref('')
const errorText = ref('')
const culprits = ref<AdoptCulprit[]>([])
const selected = ref<string[]>([])
const filterKind = ref<'all' | ReconItemKind>('all')
const filterDecision = ref<'all' | 'pending' | 'adopted' | 'skipped'>('all')
const showAll = ref(false)
const RENDER_LIMIT = 200

const reconciliations = computed(() => [...(project.value?.reconciliations ?? [])].sort((a, b) => b.at - a.at))
const recon = computed<Reconciliation | null>(() => {
  const list = project.value?.reconciliations ?? []
  return list.find((item) => item.id === currentReconId.value) ?? null
})
const counts = computed(() => (recon.value ? reconCounts(recon.value) : null))

const filteredItems = computed(() => {
  const items = recon.value?.items ?? []
  const filtered = items.filter((item) => {
    if (filterKind.value !== 'all' && item.kind !== filterKind.value) return false
    if (filterDecision.value !== 'all' && item.decision !== filterDecision.value) return false
    return true
  })
  return showAll.value ? filtered : filtered.slice(0, RENDER_LIMIT)
})

const filteredAll = computed(() => {
  const items = recon.value?.items ?? []
  return items.filter((item) => {
    if (filterKind.value !== 'all' && item.kind !== filterKind.value) return false
    if (filterDecision.value !== 'all' && item.decision !== filterDecision.value) return false
    return true
  })
})

const hiddenCount = computed(() => Math.max(0, filteredAll.value.length - filteredItems.value.length))

const selectableIds = computed(() => filteredAll.value.filter((item) => item.decision !== 'adopted').map((item) => item.id))
const allSelected = computed(() => selectableIds.value.length > 0 && selectableIds.value.every((id) => selected.value.includes(id)))

watch(recon, () => {
  selected.value = []
  culprits.value = []
  showAll.value = false
})

function notify(text: string): void {
  message.value = text
  errorText.value = ''
  culprits.value = []
}

function notifyError(text: string, blocked: AdoptCulprit[] = []): void {
  errorText.value = text
  message.value = ''
  culprits.value = blocked
}

async function startCompare(): Promise<void> {
  const current = project.value
  if (!current) return
  message.value = ''
  errorText.value = ''
  culprits.value = []
  if (headerIndex.value < 0) {
    fileError.value = '请先选择学校发回的量体表'
    return
  }
  if (requiredMissing.value.length > 0) {
    fileError.value = `必填列未映射：${requiredMissing.value.join('、')}`
    return
  }
  // 同一份回贴重复比对只出一份差异单：先查指纹
  const existing = findReconciliation(current, fingerprint.value)
  if (existing) {
    currentReconId.value = existing.id
    notify(`同一份回贴此前已比对过（${new Date(existing.at).toLocaleString('zh-CN')}），已打开既有差异单，此前的采纳 / 不采纳记录都保留，未新建。`)
    return
  }
  const rows = rawRows.value
    .slice(headerIndex.value + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex.value + index + 2 }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
  ensureMerged(current)
  const built = buildReconciliation(current, rule.value, rows, mapping.value, fileName.value, fingerprint.value, store.operator)
  current.reconciliations.push(built)
  await flushProject(current)
  currentReconId.value = built.id
  const c = reconCounts(built)
  notify(
    `比对完成，已生成差异单：改了值 ${c.changed} 条、表里有库里没有 ${c.sheetOnly} 条、库里有表里没了 ${c.dbOnly} 条、同一人两行 ${c.duplicate} 条；完全一致 ${built.matchedCount} 行未列入。`
  )
}

function openRecon(id: string): void {
  currentReconId.value = id
  message.value = ''
  errorText.value = ''
  culprits.value = []
}

async function removeRecon(item: Reconciliation): Promise<void> {
  const current = project.value
  if (!current) return
  if (!window.confirm(`确认删除差异单「${item.fileName}」（${new Date(item.at).toLocaleString('zh-CN')}）？已采纳写回库中的数据不受影响。`)) return
  current.reconciliations = current.reconciliations.filter((entry) => entry.id !== item.id)
  if (currentReconId.value === item.id) currentReconId.value = ''
  await flushProject(current)
  notify('差异单已删除（仅删除核对记录，不改动库中量体数据）')
}

/* ------------------------- 采纳 / 不采纳 ------------------------- */

function toggleSelect(id: string, checked: boolean): void {
  if (checked) selected.value = [...selected.value, id]
  else selected.value = selected.value.filter((item) => item !== id)
}

function toggleSelectAll(checked: boolean): void {
  selected.value = checked ? [...selectableIds.value] : []
}

async function adoptIds(ids: string[]): Promise<void> {
  const current = project.value
  const sheet = recon.value
  if (!current || !sheet || ids.length === 0) return
  const result = adoptItems(current, rule.value, sheet, ids)
  if (!result.ok) {
    notifyError(result.message, result.culprits)
    return
  }
  await flushProject(current)
  const skippedText = result.skipped.length > 0 ? `；另有 ${result.skipped.length} 条无法写回被跳过（${result.skipped.map((s) => s.name).join('、')}）` : ''
  notify(`${result.message}${skippedText}`)
  selected.value = selected.value.filter((id) => !ids.includes(id))
}

async function adoptSelected(): Promise<void> {
  await adoptIds([...selected.value])
}

async function adoptOne(item: ReconItem): Promise<void> {
  await adoptIds([item.id])
}

async function markSkipped(ids: string[]): Promise<void> {
  const current = project.value
  const sheet = recon.value
  if (!current || !sheet) return
  let count = 0
  for (const item of sheet.items) {
    if (!ids.includes(item.id) || item.decision === 'adopted') continue
    item.decision = 'skipped'
    count += 1
  }
  await flushProject(current)
  notify(`已把 ${count} 条标为「不采纳」，留在差异单里下次再看。`)
  selected.value = selected.value.filter((id) => !ids.includes(id))
}

async function resetPending(item: ReconItem): Promise<void> {
  const current = project.value
  if (!current || item.decision !== 'skipped') return
  item.decision = 'pending'
  await flushProject(current)
}

/* ------------------------- 展示辅助 ------------------------- */

function personById(id: string | null): Person | undefined {
  if (!id) return undefined
  return project.value?.persons.find((person) => person.id === id)
}

function personSnapshotText(person: Person): string {
  return `${person.gender === 'male' ? '男' : '女'} / 身高${formatCm(person.heightCm) || '（空）'} / 体重${person.weightKg ? formatCm(person.weightKg) : '（空）'} / 胸围${formatCm(person.chestCm) || '（空）'} / 腰围${formatCm(person.waistCm) || '（空）'} / 批次${person.batch || '（空）'}`
}

/** 重复行条目：按当前选用行实时计算与库中的差异 */
function duplicateDiffs(item: ReconItem): ReconFieldDiff[] {
  const person = personById(item.personId)
  const snap = item.candidates.find((candidate) => candidate.lineNo === item.chosenLineNo)?.draft ?? item.candidates[0]?.draft
  if (!person || !snap) return []
  return fieldDiffs(person, snap)
}

function kindBadgeClass(kind: ReconItemKind): string {
  if (kind === 'changed') return 'badge-warn'
  if (kind === 'sheet_only') return 'badge-info'
  if (kind === 'db_only') return 'badge-danger'
  return 'badge-warn'
}

function decisionBadgeClass(item: ReconItem): string {
  if (item.decision === 'adopted') return 'badge-ok'
  if (item.decision === 'skipped') return 'badge-danger'
  return 'badge-info'
}

/* ------------------------- 导出 ------------------------- */

function exportName(ext: string): string {
  const safeName = (project.value?.name ?? '项目').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  return `${safeName}-回贴差异单-${todayStamp()}.${ext}`
}

function exportCsv(reconItem: Reconciliation): void {
  if (!project.value) return
  const rows = reconExportRows(project.value, reconItem)
  downloadText(toCsvText(rows), exportName('csv'))
  notify(`已导出差异单（CSV，${rows.length} 行）`)
}

function exportXlsx(reconItem: Reconciliation): void {
  if (!project.value) return
  const rows = reconExportRows(project.value, reconItem)
  downloadBlob(buildXlsxBlob([{ name: '回贴差异单', rows }]), exportName('xlsx'))
  notify(`已导出差异单（Excel，${rows.length} 行）`)
}
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 回贴核对</h1>
        <div class="sub">
          把学校改过的量体表发回来后在这里比对：按「姓名 + 班级」找人，逐项比出 身高 / 体重 / 胸围 / 腰围 / 性别 / 班级 / 批次 哪几项被改过
        </div>
      </div>
      <div class="spacer"></div>
      <span v-if="summary" class="badge" :class="summary.conserved ? 'badge-ok' : 'badge-danger'">
        当前库：{{ conservationText(summary) }}
      </span>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>第一步：选择学校发回的量体表（CSV / Excel）</h2>
        <div class="spacer"></div>
        <span v-if="fileName" class="badge badge-info">{{ fileName }}</span>
      </div>
      <div class="card-body">
        <div
          style="border: 1px dashed var(--line); border-radius: 10px; padding: 18px; text-align: center"
          :style="dragActive ? 'border-color: var(--brand); background: #f4f8fc' : ''"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          <p>把学校发回的量体表拖到这里，或</p>
          <input ref="fileInput" type="file" accept=".csv,.txt,.tsv,.xlsx" style="display: none" @change="onFileChange" />
          <button class="btn btn-primary" type="button" @click="fileInput?.click()">选择回贴文件</button>
          <p class="hint" style="margin-top: 8px">
            文件只在本机解析比对；同一份回贴重复比对只出一份差异单（按文件指纹判定），此前的处理记录保留
          </p>
        </div>

        <p v-if="fileError" class="notice notice-error" style="margin-top: 12px">{{ fileError }}</p>

        <div v-if="headerIndex >= 0" style="margin-top: 12px">
          <div class="stat-row">
            <div class="stat"><div class="stat-label">识别表头行</div><div class="stat-value">第 {{ headerIndex + 1 }} 行</div></div>
            <div class="stat"><div class="stat-label">回贴数据行</div><div class="stat-value">{{ dataRowCount }}</div></div>
            <div class="stat"><div class="stat-label">已映射列</div><div class="stat-value">{{ mappedCount(mapping) }}/{{ IMPORT_FIELDS.length }}</div></div>
            <div class="stat"><div class="stat-label">库中记录</div><div class="stat-value">{{ project.persons.length }}</div></div>
          </div>

          <h4 style="margin-top: 12px">列映射（确认后开始比对）</h4>
          <div class="form-grid">
            <label v-for="field in IMPORT_FIELDS" :key="field.key" class="field">
              <span class="field-label">{{ field.label }} <b v-if="field.required" class="req">*</b></span>
              <select v-model.number="mapping[field.key]" class="select" :class="{ error: field.required && mapping[field.key] === null }">
                <option :value="null">（忽略此列）</option>
                <option v-for="(cell, index) in headerCells" :key="index" :value="index">第 {{ index + 1 }} 列：{{ cell || '(空列名)' }}</option>
              </select>
            </label>
          </div>

          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-primary" type="button" :disabled="requiredMissing.length > 0" @click="startCompare">
              开始比对
            </button>
            <span v-if="requiredMissing.length" class="hint">必填列未映射：{{ requiredMissing.join('、') }}</span>
            <span class="hint">回贴里的空单元格视为「未填写」：不产生差异，采纳时也不会覆盖库中值</span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="message" class="notice notice-ok">{{ message }}</p>
    <div v-if="errorText" class="card card-accent-danger">
      <div class="card-head">
        <h2>采纳被拦下：人数与套数对不上</h2>
        <div class="spacer"></div>
        <span class="badge badge-danger">{{ culprits.length }} 条肇事</span>
      </div>
      <div class="card-body">
        <p class="notice notice-error">{{ errorText }}</p>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>姓名</th><th>回贴行号</th><th>造成的问题</th></tr>
            </thead>
            <tbody>
              <tr v-for="culprit in culprits" :key="culprit.itemId">
                <td>{{ culprit.name }}</td>
                <td class="num">{{ culprit.lineNos.join('、') || '—' }}</td>
                <td>{{ culprit.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-if="recon && counts" class="card">
      <div class="card-head">
        <h2>第二步：差异单（{{ recon.fileName }}）</h2>
        <div class="spacer"></div>
        <span class="badge badge-info">指纹 {{ recon.fingerprint }}</span>
        <span class="badge">{{ new Date(recon.at).toLocaleString('zh-CN') }} ｜ 核对人 {{ recon.operator }}</span>
      </div>
      <div class="card-body">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">改了值</div><div class="stat-value">{{ counts.changed }}</div></div>
          <div class="stat"><div class="stat-label">表里有·库里没有</div><div class="stat-value">{{ counts.sheetOnly }}</div></div>
          <div class="stat"><div class="stat-label">库里有·表里没了</div><div class="stat-value bad">{{ counts.dbOnly }}</div></div>
          <div class="stat"><div class="stat-label">同一人两行</div><div class="stat-value">{{ counts.duplicate }}</div></div>
          <div class="stat"><div class="stat-label">完全一致</div><div class="stat-value ok">{{ recon.matchedCount }}</div></div>
          <div class="stat"><div class="stat-label">待处理 / 已采纳 / 不采纳</div><div class="stat-value">{{ counts.pending }} / {{ counts.adopted }} / {{ counts.skipped }}</div></div>
        </div>

        <p v-if="recon.parseErrors.length > 0" class="notice notice-warn" style="margin-top: 12px">
          回贴中 {{ recon.parseErrors.length }} 行无法解析（{{ recon.parseErrors.map((e) => `第${e.lineNo}行`).join('、') }}），未参与比对，请在学校侧修正。
        </p>

        <div class="toolbar" style="margin-top: 12px">
          <button class="btn" type="button" @click="exportCsv(recon)">导出差异单 CSV</button>
          <button class="btn" type="button" @click="exportXlsx(recon)">导出差异单 Excel</button>
          <div class="spacer"></div>
          <span class="hint">差异单已保存在本机（随项目写入 IndexedDB），导出仅为留档 / 打印</span>
        </div>

        <div class="toolbar" style="margin-top: 10px">
          <label class="field" style="max-width: 180px">
            <span class="field-label">差异类别</span>
            <select v-model="filterKind" class="select">
              <option value="all">全部类别</option>
              <option value="changed">改了值</option>
              <option value="sheet_only">表里有·库里没有</option>
              <option value="db_only">库里有·表里没了</option>
              <option value="duplicate">同一人两行</option>
            </select>
          </label>
          <label class="field" style="max-width: 160px">
            <span class="field-label">处理状态</span>
            <select v-model="filterDecision" class="select">
              <option value="all">全部状态</option>
              <option value="pending">待处理</option>
              <option value="adopted">已采纳</option>
              <option value="skipped">不采纳</option>
            </select>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; align-self: flex-end">
            <input type="checkbox" :checked="allSelected" @change="toggleSelectAll(($event.target as HTMLInputElement).checked)" />
            全选可处理条目
          </label>
          <button class="btn btn-primary" type="button" :disabled="selected.length === 0" @click="adoptSelected">
            采纳所选（{{ selected.length }}）
          </button>
          <button class="btn" type="button" :disabled="selected.length === 0" @click="markSkipped([...selected])">
            不采纳所选
          </button>
          <span v-if="hiddenCount" class="hint">仅显示前 {{ RENDER_LIMIT }} 条</span>
          <button v-if="hiddenCount" class="btn btn-sm" type="button" @click="showAll = true">显示全部</button>
        </div>
        <p class="hint" style="margin-top: 6px">
          采纳会立即写回库中并重新归并复核：常规 + 特殊 = 有效人数，对不上会整体拦下并指出肇事条目；不采纳的条目留在单子里下次再看。
        </p>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th></th>
              <th>类别</th>
              <th>姓名 / 班级</th>
              <th class="num">回贴行号</th>
              <th>改了什么（库里值 → 回贴值）</th>
              <th>冲突与取值</th>
              <th>状态 / 操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.id" :class="item.decision === 'adopted' ? '' : item.kind === 'db_only' ? 'row-invalid' : ''">
              <td>
                <input
                  v-if="item.decision !== 'adopted'"
                  type="checkbox"
                  :checked="selected.includes(item.id)"
                  @change="toggleSelect(item.id, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td><span class="badge" :class="kindBadgeClass(item.kind)">{{ reconKindLabel(item.kind) }}</span></td>
              <td>
                <b>{{ item.name }}</b> ｜ {{ item.orgUnit || '（空）' }}
                <div v-if="item.note" class="hint">{{ item.note }}</div>
              </td>
              <td class="num">{{ item.sheetLineNos.join('、') || '—' }}</td>
              <td>
                <template v-if="item.kind === 'changed'">
                  <div v-for="diff in item.diffs" :key="diff.field">
                    {{ diff.label }}：<s>{{ diff.dbText }}</s> → <b>{{ diff.sheetText }}</b>
                  </div>
                </template>
                <template v-else-if="item.kind === 'sheet_only'">
                  <div>库里没有这个人，回贴值：{{ item.draft ? snapshotSummary(item.draft) : '—' }}</div>
                  <div class="hint">采纳 = 作为新记录入库</div>
                </template>
                <template v-else-if="item.kind === 'db_only'">
                  <div>回贴里没有了，库中现值：{{ personById(item.personId) ? personSnapshotText(personById(item.personId)!) : '（记录已不存在）' }}</div>
                  <div class="hint">采纳 = 移出有效人数（标无效留痕，不物理删除）</div>
                </template>
                <template v-else>
                  <label class="field" style="min-width: 260px">
                    <span class="field-label">以哪一行为准</span>
                    <select v-model.number="item.chosenLineNo" class="select" :disabled="item.decision === 'adopted'">
                      <option v-for="candidate in item.candidates" :key="candidate.lineNo" :value="candidate.lineNo">
                        {{ candidate.summary }}
                      </option>
                    </select>
                  </label>
                  <template v-if="item.personId">
                    <div v-for="diff in duplicateDiffs(item)" :key="diff.field" style="margin-top: 4px">
                      {{ diff.label }}：<s>{{ diff.dbText }}</s> → <b>{{ diff.sheetText }}</b>
                    </div>
                    <div class="hint" style="margin-top: 4px">采纳 = 把选用行写回库中此人</div>
                  </template>
                  <div v-else class="hint" style="margin-top: 4px">采纳 = 按选用行新增一条入库</div>
                </template>
              </td>
              <td style="max-width: 320px; white-space: normal">
                <template v-if="item.conflict">
                  <div class="hint" style="color: var(--warn)">{{ item.conflictNote }}</div>
                  <select v-model="item.policy" class="select" style="margin-top: 4px" :disabled="item.decision === 'adopted'">
                    <option value="keep_manual">以库里人工覆写为准</option>
                    <option value="sheet_wins">以回贴为准</option>
                  </select>
                  <div class="hint" style="margin-top: 2px">{{ reconPolicyText(item) }}</div>
                </template>
                <span v-else class="hint">—</span>
              </td>
              <td>
                <span class="badge" :class="decisionBadgeClass(item)">
                  {{ reconDecisionLabel(item.decision) }}<template v-if="item.adoptedAt">｜{{ new Date(item.adoptedAt).toLocaleString('zh-CN') }}</template>
                </span>
                <div class="toolbar" style="margin-top: 6px">
                  <template v-if="item.decision !== 'adopted'">
                    <button class="btn btn-sm btn-primary" type="button" @click="adoptOne(item)">采纳</button>
                    <button v-if="item.decision !== 'skipped'" class="btn btn-sm" type="button" @click="markSkipped([item.id])">不采纳</button>
                    <button v-else class="btn btn-sm" type="button" @click="resetPending(item)">恢复待处理</button>
                  </template>
                  <span v-else class="hint">已写回库中并留痕</span>
                </div>
              </td>
            </tr>
            <tr v-if="filteredItems.length === 0">
              <td colspan="7" class="empty">当前筛选条件下没有差异条目</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>历史差异单（{{ reconciliations.length }}）· 存在本机</h3>
        <div class="spacer"></div>
        <span class="hint">同一份回贴按指纹幂等，重复比对只会打开既有这一份</span>
      </div>
      <div v-if="reconciliations.length === 0" class="empty">还没有核对过回贴。先在上方选择学校发回的量体表。</div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>回贴文件</th>
              <th>比对时间</th>
              <th class="num">改了值</th>
              <th class="num">表里有库里没有</th>
              <th class="num">库里有表里没了</th>
              <th class="num">同一人两行</th>
              <th>处理进度</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in reconciliations" :key="entry.id" :class="entry.id === currentReconId ? 'row-highlight' : ''">
              <td>{{ entry.fileName }}<div class="hint"><code>{{ entry.fingerprint }}</code></div></td>
              <td>{{ new Date(entry.at).toLocaleString('zh-CN') }}</td>
              <td class="num">{{ reconCounts(entry).changed }}</td>
              <td class="num">{{ reconCounts(entry).sheetOnly }}</td>
              <td class="num">{{ reconCounts(entry).dbOnly }}</td>
              <td class="num">{{ reconCounts(entry).duplicate }}</td>
              <td class="num">{{ reconCounts(entry).adopted }}/{{ reconCounts(entry).total }} 已采纳</td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="openRecon(entry.id)">打开</button>
                  <button class="btn btn-sm" type="button" @click="exportCsv(entry)">CSV</button>
                  <button class="btn btn-sm btn-danger" type="button" @click="removeRecon(entry)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
