/**
 * 回贴核对差异单导出（CSV / XLSX）。
 * 页面逐条看、导出、本机存的是同一份数据；冲突取舍策略与每条处理结果都写进单子。
 */
import type { Project, Reconciliation, ReconcileValue } from './types'
import {
  CONFLICT_POLICY_LABELS,
  RECONCILE_FIELDS,
  RECONCILE_FIELD_LABELS,
  RECONCILE_KIND_LABELS,
  RECONCILE_STATUS_LABELS
} from './reconcile'
import type { Sheet } from './xlsx'
import { toCsvText } from './csv'

function valueText(value: ReconcileValue): string {
  if (value === null || value === '') return ''
  if (value === 'male') return '男'
  if (value === 'female') return '女'
  return String(value)
}

/** 差异单元信息（单子头部写明冲突时以哪个为准） */
export function reconcileMetaRows(reconciliation: Reconciliation, project: Project): (string | number)[][] {
  return [
    ['项目名称', project.name],
    ['差异单编号', reconciliation.id],
    ['回表文件', reconciliation.fileName],
    ['文件指纹（同一份回贴重复比对只出这一份）', reconciliation.fingerprint],
    ['比对时间', new Date(reconciliation.createdAt).toLocaleString('zh-CN')],
    ['操作人', reconciliation.operator],
    ['冲突取舍策略', CONFLICT_POLICY_LABELS[reconciliation.conflictPolicy]],
    [
      '分类计数',
      `改了值 ${reconciliation.counts.changed} ｜ 表里有库里没有 ${reconciliation.counts.sheetOnly} ｜ 库里有表里没了 ${reconciliation.counts.dbOnly} ｜ 同一人两行 ${reconciliation.counts.duplicateSheet} ｜ 回表错误 ${reconciliation.counts.error} ｜ 冲突字段条目 ${reconciliation.counts.conflicts}`
    ],
    [
      '处理进度',
      `已采纳 ${reconciliation.counts.accepted} ｜ 不采纳 ${reconciliation.counts.rejected} ｜ 待处理 ${reconciliation.counts.pending}`
    ]
  ]
}

const MAIN_HEADER = [
  '序号',
  '分类',
  '状态',
  '姓名',
  '班级/车间',
  '回表行号',
  '改动字段数',
  '冲突字段',
  '冲突说明 / 情况',
  '采纳人',
  '采纳时间'
]

/** 逐条清单（每行一条差异；字段明细走另一张表） */
export function reconcileItemRows(reconciliation: Reconciliation): (string | number)[][] {
  const rows: (string | number)[][] = [MAIN_HEADER]
  reconciliation.items.forEach((item, index) => {
    const conflictFields = item.changes.filter((change) => change.conflict).map((change) => RECONCILE_FIELD_LABELS[change.field])
    rows.push([
      index + 1,
      RECONCILE_KIND_LABELS[item.kind],
      RECONCILE_STATUS_LABELS[item.status],
      item.name,
      item.orgUnit || '—',
      item.sheetLineNos.length ? item.sheetLineNos.join(' / ') : '—',
      item.changes.length,
      conflictFields.join('、'),
      item.note || item.parseError,
      item.decidedBy,
      item.decidedAt ? new Date(item.decidedAt).toLocaleString('zh-CN') : ''
    ])
  })
  return rows
}

const FIELD_HEADER = [
  '序号',
  '姓名',
  '班级/车间',
  '分类',
  '字段',
  '库里上次值（手工改动前基线）',
  '库里当前值',
  '学校回表值',
  '采纳后生效值',
  '是否冲突',
  '采纳时是否写入',
  '处理状态'
]

/** 字段级明细：哪几项被改过、改成多少、冲突时以哪个为准 */
export function reconcileFieldRows(reconciliation: Reconciliation): (string | number)[][] {
  const rows: (string | number)[][] = [FIELD_HEADER]
  let serial = 0
  for (const item of reconciliation.items) {
    if (item.kind === 'sheet_only') {
      serial += 1
      for (const field of RECONCILE_FIELDS) {
        const sheetValue = item.sheetValues[field]
        if (sheetValue === null || sheetValue === '') continue
        rows.push([
          serial,
          item.name,
          item.orgUnit || '—',
          RECONCILE_KIND_LABELS[item.kind],
          RECONCILE_FIELD_LABELS[field],
          '',
          '（库里无此人）',
          valueText(sheetValue),
          valueText(sheetValue),
          '',
          item.status === 'accepted' ? '是' : '待采纳',
          RECONCILE_STATUS_LABELS[item.status]
        ])
      }
      continue
    }
    if (item.kind === 'db_only') {
      serial += 1
      rows.push([
        serial,
        item.name,
        item.orgUnit || '—',
        RECONCILE_KIND_LABELS[item.kind],
        '（整人）',
        '',
        '库里有',
        '回表无此人',
        item.status === 'accepted' ? '排除出有效人数' : '待处理',
        '',
        item.status === 'accepted' ? '是' : '待采纳',
        RECONCILE_STATUS_LABELS[item.status]
      ])
      continue
    }
    if (item.kind === 'error') {
      serial += 1
      rows.push([
        serial,
        item.name,
        item.orgUnit || '—',
        RECONCILE_KIND_LABELS[item.kind],
        '—',
        '',
        '',
        '',
        '',
        '',
        '无法采纳',
        item.parseError
      ])
      continue
    }
    serial += 1
    if (item.changes.length === 0) {
      rows.push([
        serial,
        item.name,
        item.orgUnit || '—',
        RECONCILE_KIND_LABELS[item.kind],
        '（无改动）',
        '',
        '',
        '',
        '',
        '',
        '',
        RECONCILE_STATUS_LABELS[item.status]
      ])
    }
    for (const change of item.changes) {
      rows.push([
        serial,
        item.name,
        item.orgUnit || '—',
        RECONCILE_KIND_LABELS[item.kind],
        RECONCILE_FIELD_LABELS[change.field],
        valueText(change.baselineValue),
        valueText(change.dbValue),
        valueText(change.sheetValue),
        valueText(change.effectiveValue),
        change.conflict ? `冲突 · ${CONFLICT_POLICY_LABELS[reconciliation.conflictPolicy]}` : '',
        change.willApply ? '是' : '否（保留库里手工值）',
        RECONCILE_STATUS_LABELS[item.status]
      ])
    }
  }
  return rows
}

export function reconcileWorkbookSheets(reconciliation: Reconciliation, project: Project): Sheet[] {
  const meta = reconcileMetaRows(reconciliation, project)
  return [
    { name: '差异单', rows: [...meta, [], ...reconcileItemRows(reconciliation)] },
    { name: '字段级明细', rows: reconcileFieldRows(reconciliation) }
  ]
}

export function reconcileCsvText(reconciliation: Reconciliation, project: Project): string {
  return toCsvText([...reconcileMetaRows(reconciliation, project), [], ...reconcileItemRows(reconciliation)])
}

export function reconcileFieldsCsvText(reconciliation: Reconciliation): string {
  return toCsvText(reconcileFieldRows(reconciliation))
}

/** 导出文件名（与其它导出同一套时间戳风格由页面拼接） */
export function reconcileFileBase(project: Project, reconciliation: Reconciliation): string {
  const safeName = project.name.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = new Date(reconciliation.createdAt)
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}`
  return `${safeName}-回贴核对差异单-${stamp}`
}
