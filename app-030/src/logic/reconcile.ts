/**
 * 回贴核对核心：学校改过的表发回来后，与库里记录逐条比对。
 * - 匹配键：姓名 + 班级（orgUnit），按人逐条分清（重名同班用性别 / 数值辅助区分）
 * - 比对字段：身高、体重、胸围、腰围、性别、班级、批次
 * - 四类差异：改了值(changed) / 表里有库里没有(sheet_only) / 库里有表里没了(db_only) / 同一人两行(duplicate_sheet)
 * - 冲突：回表值与库里手工改过的基线不一致时按策略取舍（学校回表为准 / 库里手工改为准）
 * - 幂等：同一文件指纹只出一份差异单
 * - 采纳先预演：重新归并 + 守恒复核，对不上则整批拦住并列出是哪几条造成的
 */
import type {
  Gender,
  Person,
  Project,
  ReconcileConflictPolicy,
  ReconcileFieldChange,
  ReconcileFieldKey,
  ReconcileItem,
  ReconcileItemStatus,
  ReconcileSheetRow,
  ReconcileValue,
  Reconciliation,
  ReconcileCandidate,
  SizeRule
} from './types'
import { analyzeDraft, makePersonId } from './analyze'
import { runMerge, buildSummary, type Summary } from './merge'
import { parseLengthCm, parseWeightKg } from './precision'
import { parseGenderValue } from './importPlan'

export const RECONCILE_FIELDS: ReconcileFieldKey[] = [
  'heightCm',
  'weightKg',
  'chestCm',
  'waistCm',
  'gender',
  'orgUnit',
  'batch'
]

export const RECONCILE_FIELD_LABELS: Record<ReconcileFieldKey, string> = {
  heightCm: '身高(cm)',
  weightKg: '体重(kg)',
  chestCm: '胸围(cm)',
  waistCm: '腰围(cm)',
  gender: '性别',
  orgUnit: '班级/车间',
  batch: '批次'
}

export const CONFLICT_POLICY_LABELS: Record<ReconcileConflictPolicy, string> = {
  sheet_wins: '学校回表为准（覆盖库里手工改动）',
  db_manual_wins: '库里手工改为准（冲突字段不覆盖）'
}

/** 回表表头识别模式（回贴明细表列名可能带括号 / 单位） */
export const RECONCILE_HEADER_PATTERNS: Record<'name' | ReconcileFieldKey, RegExp[]> = {
  name: [/姓名/, /名字/, /^name$/i, /学生/],
  heightCm: [/身高/, /^height/i, /^h$/i],
  weightKg: [/体重/, /^weight/i],
  chestCm: [/胸围/, /^chest/i, /^bust/i],
  waistCm: [/腰围/, /^waist/i],
  gender: [/性别/, /^sex$/i, /^gender$/i],
  orgUnit: [/班级/, /车间/, /部门/, /单位/, /^org/i, /班组/, /科室/],
  batch: [/批次/, /^batch$/i, /季节/]
}

export type ReconcileColumnMapping = Record<'name' | ReconcileFieldKey, number | null>

export const EMPTY_RECONCILE_MAPPING: ReconcileColumnMapping = {
  name: null,
  heightCm: null,
  weightKg: null,
  chestCm: null,
  waistCm: null,
  gender: null,
  orgUnit: null,
  batch: null
}

function normalizeHeader(text: string): string {
  return text.replace(/[\s（）()：:_\-/]/g, '').toLowerCase()
}

export function guessReconcileMapping(header: string[]): ReconcileColumnMapping {
  const mapping: ReconcileColumnMapping = { ...EMPTY_RECONCILE_MAPPING }
  const used = new Set<number>()
  for (const key of Object.keys(RECONCILE_HEADER_PATTERNS) as ('name' | ReconcileFieldKey)[]) {
    for (let index = 0; index < header.length; index += 1) {
      if (used.has(index)) continue
      const raw = header[index] ?? ''
      const normalized = normalizeHeader(raw)
      if (normalized === '') continue
      if (RECONCILE_HEADER_PATTERNS[key].some((pattern) => pattern.test(normalized) || pattern.test(raw))) {
        mapping[key] = index
        used.add(index)
        break
      }
    }
  }
  return mapping
}

export function reconcileMappedCount(mapping: ReconcileColumnMapping): number {
  return (Object.keys(mapping) as ('name' | ReconcileFieldKey)[]).filter((key) => mapping[key] !== null).length
}

/** 表头行识别：前 8 行内命中字段最多的一行（至少命中姓名 + 身高） */
export function detectReconcileHeaderRow(rows: string[][]): number {
  let bestIndex = -1
  let bestScore = 0
  const limit = Math.min(rows.length, 8)
  for (let index = 0; index < limit; index += 1) {
    const mapping = guessReconcileMapping(rows[index])
    const score = reconcileMappedCount(mapping)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  if (bestIndex < 0) return -1
  const mapping = guessReconcileMapping(rows[bestIndex])
  return mapping.name !== null && mapping.heightCm !== null ? bestIndex : -1
}

export type ParsedReconcileRow = {
  lineNo: number
  row: ReconcileSheetRow | null
  error: string
  raw: string[]
}

function cellAt(cells: string[], index: number | null): string {
  if (index === null) return ''
  return (cells[index] ?? '').trim()
}

/** 解析回表一行为结构化行；缺姓名跳过（空行），关键字段错误返回 error 行（进差异单 error 类） */
export function parseReconcileRow(
  cells: string[],
  mapping: ReconcileColumnMapping,
  defaultBatch: string,
  lineNo: number
): ParsedReconcileRow | null {
  const name = cellAt(cells, mapping.name)
  if (name === '') return null

  const genderRaw = cellAt(cells, mapping.gender)
  const gender = parseGenderValue(genderRaw)
  if (!gender) {
    return { lineNo, row: null, error: `性别「${genderRaw || '空'}」无法识别（应为 男/女/M/F）`, raw: cells }
  }
  const heightRaw = cellAt(cells, mapping.heightCm)
  const heightCm = parseLengthCm(heightRaw)
  if (heightRaw !== '' && heightCm === null) {
    return { lineNo, row: null, error: `身高「${heightRaw}」不是有效数字`, raw: cells }
  }
  const chestRaw = cellAt(cells, mapping.chestCm)
  const chestCm = parseLengthCm(chestRaw)
  if (chestRaw !== '' && chestCm === null) {
    return { lineNo, row: null, error: `胸围「${chestRaw}」不是有效数字`, raw: cells }
  }
  const waistRaw = cellAt(cells, mapping.waistCm)
  const waistCm = parseLengthCm(waistRaw)
  if (waistRaw !== '' && waistCm === null) {
    return { lineNo, row: null, error: `腰围「${waistRaw}」不是有效数字`, raw: cells }
  }
  const weightRaw = cellAt(cells, mapping.weightKg)
  const weightKg = parseWeightKg(weightRaw)
  if (weightRaw !== '' && weightKg === null) {
    return { lineNo, row: null, error: `体重「${weightRaw}」不是有效数字`, raw: cells }
  }

  return {
    lineNo,
    error: '',
    raw: cells,
    row: {
      lineNo,
      name,
      gender,
      orgUnit: cellAt(cells, mapping.orgUnit),
      batch: cellAt(cells, mapping.batch) || defaultBatch,
      heightCm,
      weightKg,
      chestCm,
      waistCm
    }
  }
}

/* -------------------------------- 匹配与比对 -------------------------------- */

export function personMatchKey(name: string, orgUnit: string): string {
  return `${name.trim()}|${orgUnit.trim()}`
}

function fieldValueOf(person: Person, field: ReconcileFieldKey): ReconcileValue {
  if (field === 'gender') return person.gender
  if (field === 'orgUnit') return person.orgUnit
  if (field === 'batch') return person.batch
  if (field === 'weightKg') return person.weightKg
  const value = person[field]
  return value > 0 ? value : null
}

function sheetValueOf(row: ReconcileSheetRow, field: ReconcileFieldKey): ReconcileValue {
  if (field === 'gender') return row.gender
  if (field === 'orgUnit') return row.orgUnit
  if (field === 'batch') return row.batch
  return row[field]
}

function valuesEqual(a: ReconcileValue, b: ReconcileValue): boolean {
  if (a === null || a === '') return b === null || b === ''
  if (b === null || b === '') return false
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  return String(a) === String(b)
}

function displayValue(value: ReconcileValue): string {
  if (value === null || value === '') return '—'
  if (value === 'male') return '男'
  if (value === 'female') return '女'
  return String(value)
}

export function reconcileDisplayValue(value: ReconcileValue): string {
  return displayValue(value)
}

function makeItemId(): string {
  return `rcitem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function candidateOf(person: Person): ReconcileCandidate {
  return {
    personId: person.id,
    gender: person.gender,
    batch: person.batch,
    heightCm: person.heightCm,
    weightKg: person.weightKg,
    chestCm: person.chestCm,
    waistCm: person.waistCm,
    status: person.status
  }
}

function dbValuesOf(person: Person): Record<ReconcileFieldKey, ReconcileValue> {
  const result = {} as Record<ReconcileFieldKey, ReconcileValue>
  for (const field of RECONCILE_FIELDS) result[field] = fieldValueOf(person, field)
  return result
}

function sheetValuesOf(row: ReconcileSheetRow): Record<ReconcileFieldKey, ReconcileValue> {
  const result = {} as Record<ReconcileFieldKey, ReconcileValue>
  for (const field of RECONCILE_FIELDS) result[field] = sheetValueOf(row, field)
  return result
}

/**
 * 计算一个字段的改动与冲突。
 * 冲突定义：库里值在本次核对前被手工改过（baseline ≠ db），且回表值与这两个值都不同
 * （学校没看到我们的手工修正，双方都改了 → 必须在差异单上写明以哪个为准）。
 */
function buildFieldChange(
  field: ReconcileFieldKey,
  dbValue: ReconcileValue,
  sheetValue: ReconcileValue,
  baselineValue: ReconcileValue,
  policy: ReconcileConflictPolicy
): ReconcileFieldChange {
  const changed = !valuesEqual(dbValue, sheetValue)
  const conflict = changed && !valuesEqual(baselineValue, dbValue) && !valuesEqual(baselineValue, sheetValue)
  const willApply = changed && !(conflict && policy === 'db_manual_wins')
  return {
    field,
    dbValue,
    sheetValue,
    baselineValue,
    conflict,
    effectiveValue: willApply ? sheetValue : dbValue,
    willApply
  }
}

/** 两个候选人的字段差异条数（用于重名同班时辅助匹配） */
function differenceCount(person: Person, row: ReconcileSheetRow): number {
  let count = 0
  for (const field of RECONCILE_FIELDS) {
    if (!valuesEqual(fieldValueOf(person, field), sheetValueOf(row, field))) count += 1
  }
  return count
}

/** 取库里同键的多个人与回表多行的配对（贪心：差异最小的先配） */
function pairCandidates(persons: Person[], rows: ReconcileSheetRow[]): Map<number, Person> {
  const pairs = new Map<number, Person>()
  const usedPersonIds = new Set<string>()
  const options: { lineNo: number; person: Person; diff: number }[] = []
  for (const row of rows) {
    for (const person of persons) {
      options.push({ lineNo: row.lineNo, person, diff: differenceCount(person, row) })
    }
  }
  options.sort((a, b) => a.diff - b.diff)
  for (const option of options) {
    if (pairs.has(option.lineNo) || usedPersonIds.has(option.person.id)) continue
    pairs.set(option.lineNo, option.person)
    usedPersonIds.add(option.person.id)
  }
  return pairs
}

export type BuildReconcileInput = {
  project: Project
  rule: SizeRule
  parsedRows: ParsedReconcileRow[]
  fileName: string
  fingerprint: string
  conflictPolicy: ReconcileConflictPolicy
  operator: string
  now?: number
}

/**
 * 构建差异单（不写库）。比对基线取项目里「上一次核对」的采纳结果：
 * 没有历史核对时，基线等于当前库里值（回表与当前不同即学校改的，不判冲突）。
 */
export function buildReconciliation(input: BuildReconcileInput): Reconciliation {
  const { project, conflictPolicy } = input
  const now = input.now ?? Date.now()

  // 「库里手工改过」的基线：
  // 1) 优先取最近一次导出明细时的快照（明细发出后库里又改过 → 快照值≠当前值）
  // 2) 其次取上一份核对已采纳的生效值（上次学校确认后库里又手工改过）
  // 都没有时基线 = 当前值（回表与当前不同即学校改的，不判冲突）
  const snapshot = project.detailSnapshot ?? null
  const previous = project.reconciliations[0] ?? null
  const acceptedByPerson = new Map<string, ReconcileItem>()
  if (previous) {
    for (const item of previous.items) {
      if (item.status === 'accepted' && item.personId) acceptedByPerson.set(item.personId, item)
    }
  }
  const baselineFor = (person: Person, field: ReconcileFieldKey): ReconcileValue => {
    const currentValue = fieldValueOf(person, field)
    const key = personMatchKey(person.name, person.orgUnit)
    const snapValue = snapshot?.values[key]?.[field]
    if (snapValue !== undefined && !valuesEqual(snapValue, currentValue)) return snapValue
    const accepted = acceptedByPerson.get(person.id)
    if (accepted) {
      const change = accepted.changes.find((entry) => entry.field === field)
      if (change && !valuesEqual(change.effectiveValue, currentValue)) return change.effectiveValue
    }
    return currentValue
  }

  // 库里按「姓名 + 班级」分组（只在库里当前键下分组；重名同班自然落到同一组）
  const dbGroups = new Map<string, Person[]>()
  // 库里按「姓名」分组（回表改了班级时的回退匹配；重名者再用性别 / 数值分清）
  const dbByName = new Map<string, Person[]>()
  for (const person of project.persons) {
    const key = personMatchKey(person.name, person.orgUnit)
    const group = dbGroups.get(key)
    if (group) group.push(person)
    else dbGroups.set(key, [person])
    const byName = dbByName.get(person.name.trim())
    if (byName) byName.push(person)
    else dbByName.set(person.name.trim(), [person])
  }

  // 回表按同键分组
  const sheetGroups = new Map<string, ReconcileSheetRow[]>()
  const sheetOrder: string[] = []
  const items: ReconcileItem[] = []
  /** 本次回表已对到的库里人 id（重名同班时未对到的人要出 db_only） */
  const referencedPersonIds = new Set<string>()
  /** 回表按姓名分组的占用情况（跨班级回退匹配时避免两个回表行抢同一个库里人） */
  const claimedByName = new Map<string, Set<string>>()

  for (const parsed of input.parsedRows) {
    if (!parsed.row) {
      items.push({
        id: makeItemId(),
        kind: 'error',
        status: 'pending',
        matchKey: `error|${parsed.lineNo}`,
        name: parsed.raw[0] ?? '',
        orgUnit: '',
        sheetLineNos: [parsed.lineNo],
        selectedLineNo: null,
        extraLineNos: [],
        personId: null,
        candidates: [],
        duplicateRows: [],
        changes: [],
        dbValues: emptyValues(),
        sheetValues: emptyValues(),
        parseError: parsed.error,
        note: '回表此行无法解析，未参与比对，请修正原表后重新比对',
        decidedAt: null,
        decidedBy: ''
      })
      continue
    }
    const row = parsed.row
    const key = personMatchKey(row.name, row.orgUnit)
    const group = sheetGroups.get(key)
    if (group) group.push(row)
    else {
      sheetGroups.set(key, [row])
      sheetOrder.push(key)
    }
  }

  /** 把一个库里人标记为已被某个姓名占用（跨班级回退也占位） */
  function claim(name: string, personId: string): void {
    const set = claimedByName.get(name) ?? new Set<string>()
    set.add(personId)
    claimedByName.set(name, set)
  }
  function isClaimed(name: string, personId: string): boolean {
    return claimedByName.get(name)?.has(personId) ?? false
  }

  for (const key of sheetOrder) {
    const sheetRows = sheetGroups.get(key) ?? []
    let dbPersons = dbGroups.get(key) ?? []
    const firstName = sheetRows[0]?.name ?? ''
    const firstOrg = sheetRows[0]?.orgUnit ?? ''

    // 同「姓名+班级」没找到库里人时，按姓名回退（学校可能把班级也改了）
    let classChangedFallback = false
    if (dbPersons.length === 0) {
      const sameName = (dbByName.get(firstName.trim()) ?? []).filter(
        (person) => !isClaimed(firstName.trim(), person.id)
      )
      if (sameName.length === 1) {
        dbPersons = sameName
        classChangedFallback = true
      } else if (sameName.length > 1) {
        // 多个同名：取性别一致且数值最接近的
        const sameGender = sameName.filter((person) => person.gender === sheetRows[0]?.gender)
        const pool = sameGender.length > 0 ? sameGender : sameName
        const pairs = pairCandidates(pool, sheetRows)
        const matched = pairs.get(sheetRows[0].lineNo) ?? pool[0]
        dbPersons = [matched]
        classChangedFallback = true
      }
    }

    if (dbPersons.length === 0) {
      // 确实表里有、库里没有
      for (const row of sheetRows) items.push(buildSheetOnlyItem(personMatchKey(row.name, row.orgUnit), row))
      continue
    }

    if (sheetRows.length > 1) {
      // 同一人出现两行：重名同班去重，列出回表每一行与库里候选人，默认选与某人最接近的第一行
      const pairs = pairCandidates(dbPersons, sheetRows)
      const selected = sheetRows[0]
      const matchedPerson = pairs.get(selected.lineNo) ?? dbPersons[0] ?? null
      items.push(
        buildDuplicateOrChangedItem({
          key,
          name: firstName,
          orgUnit: classChangedFallback && matchedPerson ? matchedPerson.orgUnit : firstOrg,
          sheetRows,
          selected,
          dbPersons,
          matchedPerson,
          conflictPolicy,
          baselineFor
        })
      )
      if (matchedPerson) {
        referencedPersonIds.add(matchedPerson.id)
        claim(firstName.trim(), matchedPerson.id)
      }
      continue
    }

    const row = sheetRows[0]
    if (dbPersons.length === 1) {
      const person = dbPersons[0]
      const item = buildChangedItem(key, row, person, conflictPolicy, baselineFor)
      // 七个字段完全一致的人不进差异单（差异单只列有差异的），但仍占用匹配，不算「库有表无」
      referencedPersonIds.add(person.id)
      claim(person.name.trim(), person.id)
      if (item.changes.length === 0 && !classChangedFallback) continue
      if (classChangedFallback) {
        item.note = `回表班级「${row.orgUnit}」与库里班级「${person.orgUnit}」不同，已按姓名匹配（疑似学校改了班级）；请确认是否同一人`
      }
      items.push(item)
      continue
    }

    // 回表 1 行、库里同键多人（重名同班）：辅助配对到差异最小的人，并列出全部候选人供分清
    const pairs = pairCandidates(dbPersons, [row])
    const matchedPerson = pairs.get(row.lineNo) ?? dbPersons[0]
    items.push(
      buildDuplicateOrChangedItem({
        key,
        name: row.name,
        orgUnit: row.orgUnit,
        sheetRows: [row],
        selected: row,
        dbPersons,
        matchedPerson,
        conflictPolicy,
        baselineFor
      })
    )
    referencedPersonIds.add(matchedPerson.id)
    claim(matchedPerson.name.trim(), matchedPerson.id)
  }

  // 库里有、表里没了（含重名同班但本次回表未对到的人）
  for (const [key, persons] of dbGroups) {
    for (const person of persons) {
      if (referencedPersonIds.has(person.id)) continue
      items.push(buildDbOnlyItem(key, person, persons.length > 1))
    }
  }

  // 排序：四类顺序 changed → duplicate_sheet → sheet_only → db_only → error；同类按行号 / 姓名
  const order: Record<ReconcileItem['kind'], number> = {
    changed: 0,
    duplicate_sheet: 1,
    sheet_only: 2,
    db_only: 3,
    error: 4
  }
  items.sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind]
    const lineA = a.sheetLineNos[0] ?? Number.MAX_SAFE_INTEGER
    const lineB = b.sheetLineNos[0] ?? Number.MAX_SAFE_INTEGER
    if (lineA !== lineB) return lineA - lineB
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  const reconciliation: Reconciliation = {
    id: makeReconciliationId(),
    projectId: project.id,
    fileName: input.fileName,
    fingerprint: input.fingerprint,
    conflictPolicy,
    operator: input.operator,
    createdAt: now,
    items,
    counts: countItems(items),
    lastAppliedAt: null,
    lastGateBlocked: false
  }
  return reconciliation
}

function emptyValues(): Record<ReconcileFieldKey, ReconcileValue> {
  const result = {} as Record<ReconcileFieldKey, ReconcileValue>
  for (const field of RECONCILE_FIELDS) result[field] = null
  return result
}

type BuildItemArg = {
  key: string
  name: string
  orgUnit: string
  sheetRows: ReconcileSheetRow[]
  selected: ReconcileSheetRow
  dbPersons: Person[]
  matchedPerson: Person | null
  conflictPolicy: ReconcileConflictPolicy
  baselineFor: (person: Person, field: ReconcileFieldKey) => ReconcileValue
}

/** 同一人出现两行（或库里重名同班需分清）：逐行列出，默认对选中行与选中的人做字段比对 */
function buildDuplicateOrChangedItem(arg: BuildItemArg): ReconcileItem {
  const { key, name, orgUnit, sheetRows, selected, dbPersons, matchedPerson, conflictPolicy, baselineFor } = arg
  const dbValues = matchedPerson ? dbValuesOf(matchedPerson) : emptyValues()
  const sheetValues = sheetValuesOf(selected)
  const changes = matchedPerson
    ? RECONCILE_FIELDS.map((field) =>
        buildFieldChange(
          field,
          dbValues[field],
          sheetValues[field],
          baselineFor(matchedPerson, field),
          conflictPolicy
        )
      ).filter((change) => !valuesEqual(change.dbValue, change.sheetValue))
    : []
  const ambiguous = sheetRows.length > 1 || dbPersons.length > 1
  return {
    id: makeItemId(),
    kind: sheetRows.length > 1 ? 'duplicate_sheet' : 'changed',
    status: 'pending',
    matchKey: key,
    name,
    orgUnit,
    sheetLineNos: sheetRows.map((row) => row.lineNo),
    selectedLineNo: selected.lineNo,
    extraLineNos: sheetRows.map((row) => row.lineNo).filter((lineNo) => lineNo !== selected.lineNo),
    personId: matchedPerson?.id ?? null,
    candidates: dbPersons.map(candidateOf),
    duplicateRows: sheetRows.map((row) => ({ lineNo: row.lineNo, values: sheetValuesOf(row) })),
    changes,
    dbValues,
    sheetValues,
    parseError: '',
    note: ambiguous
      ? `同键 ${sheetRows.length} 行 × 库里 ${dbPersons.length} 人：请逐行分清，默认对第 ${selected.lineNo} 行与「${
          matchedPerson ? `${matchedPerson.name}（身高 ${matchedPerson.heightCm}）` : '未匹配'
        }」比对`
      : '',
    decidedAt: null,
    decidedBy: ''
  }
}

/** 表里有、库里没有 */
function buildSheetOnlyItem(key: string, row: ReconcileSheetRow): ReconcileItem {
  return {
    id: makeItemId(),
    kind: 'sheet_only',
    status: 'pending',
    matchKey: key,
    name: row.name,
    orgUnit: row.orgUnit,
    sheetLineNos: [row.lineNo],
    selectedLineNo: row.lineNo,
    extraLineNos: [],
    personId: null,
    candidates: [],
    duplicateRows: [],
    changes: [],
    dbValues: emptyValues(),
    sheetValues: sheetValuesOf(row),
    parseError: '',
    note: '回表有此人、库里没有；采纳将作为新人写入（来源标注为本次核对）',
    decidedAt: null,
    decidedBy: ''
  }
}

/** 库里有、表里没了（siblingMany = 同键还有其它人被对到，本条是重名同班中未对上的那位） */
function buildDbOnlyItem(key: string, person: Person, siblingMany: boolean): ReconcileItem {
  return {
    id: makeItemId(),
    kind: 'db_only',
    status: 'pending',
    matchKey: key,
    name: person.name,
    orgUnit: person.orgUnit,
    sheetLineNos: [],
    selectedLineNo: null,
    extraLineNos: [],
    personId: person.id,
    candidates: siblingMany ? [candidateOf(person)] : [],
    duplicateRows: [],
    changes: [],
    dbValues: dbValuesOf(person),
    sheetValues: emptyValues(),
    parseError: '',
    note: siblingMany
      ? `重名同班的另一位（身高 ${person.heightCm}cm）未对上回表任何行；请人工分清是否为不同人，采纳将排除出有效人数`
      : person.status === 'active'
        ? '库里有此人、回表没有；采纳将标记为「回表删除」并排除出有效人数（可在归并页恢复）'
        : `库里此人为「${person.status}」状态，本就不计入有效人数`,
    decidedAt: null,
    decidedBy: ''
  }
}

/** 回表 1 行 × 库里 1 人：逐字段比对 */
function buildChangedItem(
  key: string,
  row: ReconcileSheetRow,
  person: Person,
  conflictPolicy: ReconcileConflictPolicy,
  baselineFor: (person: Person, field: ReconcileFieldKey) => ReconcileValue
): ReconcileItem {
  const dbValues = dbValuesOf(person)
  const sheetValues = sheetValuesOf(row)
  const changes = RECONCILE_FIELDS.map((field) =>
    buildFieldChange(field, dbValues[field], sheetValues[field], baselineFor(person, field), conflictPolicy)
  ).filter((change) => !valuesEqual(change.dbValue, change.sheetValue))
  return {
    id: makeItemId(),
    kind: 'changed',
    status: 'pending',
    matchKey: key,
    name: person.name,
    orgUnit: person.orgUnit,
    sheetLineNos: [row.lineNo],
    selectedLineNo: row.lineNo,
    extraLineNos: [],
    personId: person.id,
    candidates: [],
    duplicateRows: [],
    changes,
    dbValues,
    sheetValues,
    parseError: '',
    note:
      changes.length === 0
        ? '七个字段全部一致，无改动'
        : changes.some((change) => change.conflict)
          ? `有 ${changes.filter((change) => change.conflict).length} 个字段与库里手工改动冲突，按「${CONFLICT_POLICY_LABELS[conflictPolicy]}」处理`
          : `学校回表改了 ${changes.length} 个字段`,
    decidedAt: null,
    decidedBy: ''
  }
}

export function countItems(items: ReconcileItem[]): Reconciliation['counts'] {
  const counts = {
    total: items.length,
    changed: 0,
    sheetOnly: 0,
    dbOnly: 0,
    duplicateSheet: 0,
    error: 0,
    conflicts: 0,
    pending: 0,
    accepted: 0,
    rejected: 0
  }
  for (const item of items) {
    if (item.kind === 'changed') counts.changed += 1
    else if (item.kind === 'sheet_only') counts.sheetOnly += 1
    else if (item.kind === 'db_only') counts.dbOnly += 1
    else if (item.kind === 'duplicate_sheet') counts.duplicateSheet += 1
    else counts.error += 1
    if (item.changes.some((change) => change.conflict)) counts.conflicts += 1
    if (item.status === 'accepted') counts.accepted += 1
    else if (item.status === 'rejected') counts.rejected += 1
    else counts.pending += 1
  }
  return counts
}

export function makeReconciliationId(): string {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 同一份回贴（指纹相同）只出一份差异单 */
export function findReconciliationByFingerprint(project: Project, fingerprint: string): Reconciliation | undefined {
  return project.reconciliations.find((reconciliation) => reconciliation.fingerprint === fingerprint)
}

/* -------------------------------- 采纳与守恒复核 -------------------------------- */

/** 深拷贝（项目是响应式代理，预演必须在普通副本上做，不能污染当前库） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function applyScalarToPerson(person: Person, field: ReconcileFieldKey, value: ReconcileValue): void {
  if (field === 'gender') person.gender = (value as Gender) ?? person.gender
  else if (field === 'orgUnit') person.orgUnit = String(value ?? '')
  else if (field === 'batch') person.batch = String(value ?? '')
  else if (field === 'weightKg') person.weightKg = typeof value === 'number' ? value : null
  else if (field === 'heightCm') person.heightCm = typeof value === 'number' ? value : person.heightCm
  else if (field === 'chestCm') person.chestCm = typeof value === 'number' ? value : person.chestCm
  else if (field === 'waistCm') person.waistCm = typeof value === 'number' ? value : person.waistCm
}

function revalidatePerson(person: Person, rule: SizeRule): void {
  const outcome = analyzeDraft(
    {
      name: person.name,
      gender: person.gender,
      orgUnit: person.orgUnit,
      batch: person.batch,
      heightCm: person.heightCm || null,
      weightKg: person.weightKg,
      chestCm: person.chestCm || null,
      waistCm: person.waistCm || null,
      specialFlag: person.specialFlag,
      note: person.note,
      sourceRow: person.sourceRow,
      source: 'reconcile'
    },
    rule
  )
  if (outcome.status === 'invalid') {
    person.status = 'invalid'
    person.statusReason = outcome.statusReason
  }
  person.anomaly = outcome.anomaly
  person.needsConfirm = outcome.needsConfirm
  person.result = null
}

/** 复制一个新人（sheet_only 采纳） */
function createPersonFromItem(item: ReconcileItem, rule: SizeRule, reconcileId: string, sourceRow: number): Person {
  const values = item.sheetValues
  const person: Person = {
    id: makePersonId(),
    name: item.name.trim(),
    gender: (values.gender as Gender) ?? 'male',
    orgUnit: String(values.orgUnit ?? ''),
    batch: String(values.batch ?? ''),
    heightCm: typeof values.heightCm === 'number' ? values.heightCm : 0,
    weightKg: typeof values.weightKg === 'number' ? values.weightKg : null,
    chestCm: typeof values.chestCm === 'number' ? values.chestCm : 0,
    waistCm: typeof values.waistCm === 'number' ? values.waistCm : 0,
    specialFlag: null,
    note: `回贴核对新增（差异单 ${reconcileId}）`,
    status: 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow,
    source: 'reconcile',
    result: null,
    adoptedInReconcileId: null,
    createdAt: Date.now()
  }
  revalidatePerson(person, rule)
  return person
}

export type GateBlockingItem = {
  itemId: string
  name: string
  orgUnit: string
  kind: ReconcileItem['kind']
  reason: string
}

export type AdoptionGateResult = {
  ok: boolean
  before: { valid: number; qty: number }
  after: { valid: number; qty: number }
  /** 守恒等式文本 */
  equation: string
  summary: Summary
  blockingItems: GateBlockingItem[]
  /** 预演后的临时项目（ok 时用于正式提交） */
  previewProject: Project
}

/**
 * 采纳预演：在项目副本上应用选中的条目 → 重新归并 → 复核人数与套数。
 * 守恒不成立（有人归不进号型）或采纳的条目本身造成异常时，拦住并列出条目。
 */
export function previewAdopt(
  project: Project,
  rule: SizeRule,
  reconciliation: Reconciliation,
  selectedItemIds: Set<string>
): AdoptionGateResult {
  const preview = deepClone(project)
  const previewReconciliation = preview.reconciliations.find((entry) => entry.id === reconciliation.id)
  if (!previewReconciliation) throw new Error('差异单不在该项目中')
  const targetItems = previewReconciliation.items.filter((item) => selectedItemIds.has(item.id))
  const idMap = new Map<string, Person>()

  const beforeSummary = buildSummary(preview, rule)
  const before = { valid: beforeSummary.totals.validRows, qty: beforeSummary.totals.accountedQty }

  const blockingItems: GateBlockingItem[] = []
  const personIndex = new Map<string, Person>()
  for (const person of preview.persons) personIndex.set(person.id, person)

  for (const item of targetItems) {
    if (item.kind === 'error') {
      blockingItems.push({
        itemId: item.id,
        name: item.name,
        orgUnit: item.orgUnit,
        kind: item.kind,
        reason: item.parseError || '回表行无法解析'
      })
      continue
    }

    if (item.kind === 'sheet_only') {
      const created = createPersonFromItem(item, rule, previewReconciliation.id, item.sheetLineNos[0] ?? preview.persons.length + 1)
      created.adoptedInReconcileId = previewReconciliation.id
      preview.persons.push(created)
      personIndex.set(created.id, created)
      idMap.set(item.id, created)
      if (created.status === 'invalid') {
        blockingItems.push({
          itemId: item.id,
          name: created.name,
          orgUnit: created.orgUnit,
          kind: item.kind,
          reason: `新增后被校验拦截为无效行：${created.statusReason}`
        })
      }
      continue
    }

    if (item.kind === 'db_only') {
      const person = item.personId ? personIndex.get(item.personId) : undefined
      if (!person) {
        blockingItems.push({
          itemId: item.id,
          name: item.name,
          orgUnit: item.orgUnit,
          kind: item.kind,
          reason: '库里记录已不存在（可能已被其它操作删除）'
        })
        continue
      }
      if (person.status === 'active') {
        person.status = 'removed'
        person.statusReason = `回贴核对采纳：回表无此人（第 ${previewReconciliation.id} 次核对）`
        person.result = null
      }
      continue
    }

    // changed / duplicate_sheet：把选中行的值按字段写回（冲突字段遵循策略，重算 changes.willApply）
    let person = item.personId ? personIndex.get(item.personId) : undefined
    if (!person && item.kind === 'duplicate_sheet') {
      person = preview.persons.find((entry) => entry.name === item.name && entry.orgUnit === item.orgUnit)
    }
    if (!person) {
      blockingItems.push({
        itemId: item.id,
        name: item.name,
        orgUnit: item.orgUnit,
        kind: item.kind,
        reason: '匹配到的库里记录已不存在'
      })
      continue
    }

    // duplicate_sheet：用当前选中行的值重算字段改动（用户可能切换了选中行）
    const effectiveChanges =
      item.kind === 'duplicate_sheet'
        ? RECONCILE_FIELDS.map((field) =>
            buildFieldChange(
              field,
              item.dbValues[field],
              item.sheetValues[field],
              item.changes.find((change) => change.field === field)?.baselineValue ?? item.dbValues[field],
              previewReconciliation.conflictPolicy
            )
          ).filter((change) => !valuesEqual(change.dbValue, change.sheetValue))
        : item.changes
    item.changes = effectiveChanges

    for (const change of effectiveChanges) {
      if (change.willApply) applyScalarToPerson(person, change.field, change.sheetValue)
    }
    revalidatePerson(person, rule)
    person.adoptedInReconcileId = previewReconciliation.id
    if (person.status === 'invalid') {
      blockingItems.push({
        itemId: item.id,
        name: person.name,
        orgUnit: person.orgUnit,
        kind: item.kind,
        reason: `采纳回表值后被校验拦截为无效行：${person.statusReason}`
      })
    }
  }

  runMerge(preview, rule)
  const afterSummary = buildSummary(preview, rule)
  const after = { valid: afterSummary.totals.validRows, qty: afterSummary.totals.accountedQty }

  // 守恒复核：有效人数必须全部归并（Σ常规 + Σ特殊 = 有效人数）
  if (!afterSummary.conserved) {
    const unmergedById = new Set(afterSummary.unmerged.map((entry) => entry.personId))
    for (const item of targetItems) {
      const person = item.personId ? personIndex.get(item.personId) : idMap.get(item.id)
      if (person && unmergedById.has(person.id)) {
        const reason = afterSummary.unmerged.find((entry) => entry.personId === person.id)?.reason ?? '采纳后无法归并号型'
        blockingItems.push({
          itemId: item.id,
          name: person.name,
          orgUnit: person.orgUnit,
          kind: item.kind,
          reason
        })
      }
    }
  }

  const ok = blockingItems.length === 0 && afterSummary.conserved
  return {
    ok,
    before,
    after,
    equation: `常规 ${afterSummary.totals.regularQty} + 特殊 ${afterSummary.totals.specialQty} = 有效 ${afterSummary.totals.validRows} / 总录入 ${afterSummary.totals.totalRows}`,
    summary: afterSummary,
    blockingItems,
    previewProject: preview
  }
}

export type CommitResult = {
  adopted: number
  gate: AdoptionGateResult
}

/**
 * 正式采纳：预演通过后，用预演后的人员列表替换项目人员，
 * 并把条目标记为 accepted（标明哪一次核对、操作人、时间）。不采纳的保持 pending。
 */
export function commitAdoption(
  project: Project,
  rule: SizeRule,
  reconciliation: Reconciliation,
  selectedItemIds: Set<string>,
  operator: string,
  now = Date.now()
): CommitResult {
  const gate = previewAdopt(project, rule, reconciliation, selectedItemIds)
  if (!gate.ok) return { adopted: 0, gate }

  // 把预演后的人员与差异单状态回写到真实项目
  project.persons = gate.previewProject.persons
  const live = project.reconciliations.find((entry) => entry.id === reconciliation.id)
  if (live) {
    for (const item of live.items) {
      if (selectedItemIds.has(item.id) && item.status === 'pending') {
        item.status = 'accepted'
        item.decidedAt = now
        item.decidedBy = operator
      }
    }
    // 同步预演中重算过的 duplicate_sheet changes（选中行可能切换）
    const preview = gate.previewProject.reconciliations.find((entry) => entry.id === reconciliation.id)
    if (preview) {
      for (const previewItem of preview.items) {
        const target = live.items.find((item) => item.id === previewItem.id)
        if (target && previewItem.kind === 'duplicate_sheet') target.changes = previewItem.changes
      }
    }
    live.counts = countItems(live.items)
    live.lastAppliedAt = now
    live.lastGateBlocked = false
  }
  // 采纳写回后，把明细快照刷新到当前值：下次比对时已采纳的值不会再被当成手工改动
  project.detailSnapshot = buildCurrentSnapshot(project, reconciliation.fileName, operator, now)
  runMerge(project, rule)
  return { adopted: selectedItemIds.size, gate }
}

/** 按项目当前人员重建明细快照（采纳后调用，使基线与库里一致） */
function buildCurrentSnapshot(project: Project, fileName: string, operator: string, at: number) {
  const values: NonNullable<Project['detailSnapshot']>['values'] = {}
  for (const person of project.persons) {
    const key = personMatchKey(person.name, person.orgUnit)
    const entry = {} as Record<ReconcileFieldKey, ReconcileValue>
    for (const field of RECONCILE_FIELDS) entry[field] = fieldValueOf(person, field)
    values[key] = entry
  }
  return { at, fileName, operator, values }
}

/** 单条 / 批量「不采纳」：留着下次再看（状态保持 pending 或显式 rejected） */
export function rejectItems(reconciliation: Reconciliation, itemIds: Set<string>, operator: string, now = Date.now()): number {
  let count = 0
  for (const item of reconciliation.items) {
    if (itemIds.has(item.id) && item.status === 'pending') {
      item.status = 'rejected'
      item.decidedAt = now
      item.decidedBy = operator
      count += 1
    }
  }
  reconciliation.counts = countItems(reconciliation.items)
  return count
}

/** 把已决定（采纳 / 不采纳）的条目退回待处理 */
export function resetItemDecision(reconciliation: Reconciliation, itemId: string): void {
  const item = reconciliation.items.find((entry) => entry.id === itemId)
  if (!item) return
  item.status = 'pending'
  item.decidedAt = null
  item.decidedBy = ''
  reconciliation.counts = countItems(reconciliation.items)
}

/** duplicate_sheet 切换选中的回表行：重算 sheetValues、changes 与匹配人 */
export function selectDuplicateRow(
  project: Project,
  reconciliation: Reconciliation,
  item: ReconcileItem,
  lineNo: number
): void {
  if (item.kind !== 'duplicate_sheet') return
  const option = item.duplicateRows.find((entry) => entry.lineNo === lineNo)
  if (!option) return
  item.selectedLineNo = lineNo
  item.extraLineNos = item.sheetLineNos.filter((entry) => entry !== lineNo)
  item.sheetValues = option.values

  const dbPersons = project.persons.filter(
    (person) => personMatchKey(person.name, person.orgUnit) === item.matchKey
  )
  if (dbPersons.length > 0) {
    // 选中行与差异最小的库里人配对
    let best = dbPersons[0]
    let bestDiff = Number.MAX_SAFE_INTEGER
    for (const person of dbPersons) {
      let diff = 0
      for (const field of RECONCILE_FIELDS) {
        if (!valuesEqual(fieldValueOf(person, field), option.values[field])) diff += 1
      }
      if (diff < bestDiff) {
        bestDiff = diff
        best = person
      }
    }
    item.personId = best.id
    item.dbValues = dbValuesOf(best)
    recomputeChanges(reconciliation, item, best)
  }
}

/** 重名同班：手动把这一条对到库里某个具体的人（去重分开） */
export function selectMatchedPerson(project: Project, reconciliation: Reconciliation, item: ReconcileItem, personId: string): void {
  if (item.kind !== 'duplicate_sheet' && item.kind !== 'changed') return
  const newPerson = project.persons.find((entry) => entry.id === personId)
  if (!newPerson || item.personId === personId) return
  const oldPersonId = item.personId
  item.personId = newPerson.id
  item.dbValues = dbValuesOf(newPerson)
  recomputeChanges(reconciliation, item, newPerson)

  // 原来对到的人改为「库有表无」；若新目标原本占着一条 db_only，则把那条让给旧人
  const dbOnlyForNew = reconciliation.items.find(
    (entry) => entry.kind === 'db_only' && entry.personId === personId
  )
  if (dbOnlyForNew && oldPersonId) {
    const oldPerson = project.persons.find((entry) => entry.id === oldPersonId)
    if (oldPerson) {
      dbOnlyForNew.personId = oldPerson.id
      dbOnlyForNew.name = oldPerson.name
      dbOnlyForNew.orgUnit = oldPerson.orgUnit
      dbOnlyForNew.matchKey = personMatchKey(oldPerson.name, oldPerson.orgUnit)
      dbOnlyForNew.dbValues = dbValuesOf(oldPerson)
      dbOnlyForNew.note = '重名同班改配后，库里此人未对上回表任何行；请确认是否为不同人，采纳将排除出有效人数'
    }
  } else if (oldPersonId) {
    const oldPerson = project.persons.find((entry) => entry.id === oldPersonId)
    if (oldPerson) {
      reconciliation.items.push(buildDbOnlyItem(personMatchKey(oldPerson.name, oldPerson.orgUnit), oldPerson, true))
      reconciliation.counts = countItems(reconciliation.items)
    }
  }
}

function recomputeChanges(reconciliation: Reconciliation, item: ReconcileItem, person: Person | null): void {
  item.changes = RECONCILE_FIELDS.map((field) =>
    buildFieldChange(
      field,
      item.dbValues[field],
      item.sheetValues[field],
      // 切换匹配人后，基线取切换前该字段原值（即新匹配人的库里值），不沿用上一人基线
      person ? fieldValueOf(person, field) : item.dbValues[field],
      reconciliation.conflictPolicy
    )
  ).filter((change) => !valuesEqual(change.dbValue, change.sheetValue))
  reconciliation.counts = countItems(reconciliation.items)
}

/** 供页面展示的状态 / 类型中文 */
export const RECONCILE_KIND_LABELS: Record<ReconcileItem['kind'], string> = {
  changed: '改了值',
  sheet_only: '表里有·库里没有',
  db_only: '库里有·表里没了',
  duplicate_sheet: '同一人两行',
  error: '回表错误行'
}

export const RECONCILE_STATUS_LABELS: Record<ReconcileItemStatus, string> = {
  pending: '待处理',
  accepted: '已采纳',
  rejected: '不采纳'
}
