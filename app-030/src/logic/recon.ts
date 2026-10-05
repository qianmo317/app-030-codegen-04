/**
 * 回贴核对：学校把改过的量体表发回来后，与库中记录逐条比对。
 *
 * 核心规则：
 * - 按「姓名 + 班级」找人；重名同班的人按 性别 → 身高 → 胸围 → 腰围 就近配对，去重分开；
 * - 逐条比对 身高 / 体重 / 胸围 / 腰围 / 性别 / 班级 / 批次 七项，分出四类差异：
 *   改了值 / 表里有库里没有 / 库里有表里没了 / 同一人出现两行；
 * - 回贴改动与库中人工覆写冲突时，差异单上写明以哪个为准（默认以库里人工覆写为准）；
 * - 同一份回贴（文件指纹相同）重复比对只出一份差异单，此前的采纳 / 不采纳记录保留；
 * - 采纳写回后重新归并并复核人数与套数：常规 + 特殊 = 有效人数，对不上就整体拦住并指出肇事条目。
 *
 * 空单元格约定：回贴里的空格视为「未填写」，不产生差异、采纳时也不覆盖库中值。
 */
import { toRaw } from 'vue'
import type {
  Person,
  Project,
  Reconciliation,
  ReconCandidate,
  ReconDraftSnapshot,
  ReconFieldDiff,
  ReconFieldKey,
  ReconItem,
  ReconItemKind,
  SizeRule
} from './types'
import { analyzeDraft, type PersonDraft } from './analyze'
import { buildDraftFromRow, createPersonFromDraft, type ColumnMapping } from './importPlan'
import { cmToHalfUnits, formatCm } from './precision'
import { buildSummary, conservationText, runMerge } from './merge'

/* ------------------------------- 展示文本 ------------------------------- */

export function reconKindLabel(kind: ReconItemKind): string {
  if (kind === 'changed') return '改了值'
  if (kind === 'sheet_only') return '表里有·库里没有'
  if (kind === 'db_only') return '库里有·表里没了'
  return '同一人两行'
}

export function reconDecisionLabel(decision: ReconItem['decision']): string {
  if (decision === 'adopted') return '已采纳'
  if (decision === 'skipped') return '不采纳'
  return '待处理'
}

/** 冲突取值说明：差异单（页面与导出）上必须写清以哪个为准 */
export function reconPolicyText(item: ReconItem): string {
  if (!item.conflict) return ''
  return item.policy === 'keep_manual'
    ? '以库里人工覆写为准（量体值按回贴更新，号型保留人工覆写）'
    : '以回贴为准（清除人工覆写，按新量体值重新归并）'
}

function fmtValue(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return '（空）'
  return formatCm(value)
}

function fmtGender(gender: Person['gender'] | null): string {
  if (gender === 'male') return '男'
  if (gender === 'female') return '女'
  return '（空）'
}

/* ------------------------------- 字段比对 ------------------------------- */

const FIELD_LABELS: Record<ReconFieldKey, string> = {
  heightCm: '身高(cm)',
  weightKg: '体重(kg)',
  chestCm: '胸围(cm)',
  waistCm: '腰围(cm)',
  gender: '性别',
  orgUnit: '班级/车间',
  batch: '批次'
}

/**
 * 逐字段比对库中记录与回贴快照（0.5cm 用半厘米整数比较，体重按 0.1kg 整数比较）。
 * 回贴侧为空的字段跳过（视为未填写，不算差异）。
 */
export function fieldDiffs(person: Person, snap: ReconDraftSnapshot): ReconFieldDiff[] {
  const diffs: ReconFieldDiff[] = []
  const push = (field: ReconFieldKey, dbText: string, sheetText: string) => {
    diffs.push({ field, label: FIELD_LABELS[field], dbText, sheetText })
  }
  if (snap.heightCm !== null && cmToHalfUnits(person.heightCm) !== cmToHalfUnits(snap.heightCm)) {
    push('heightCm', fmtValue(person.heightCm), fmtValue(snap.heightCm))
  }
  if (snap.weightKg !== null) {
    const dbUnits = person.weightKg === null ? null : Math.round(person.weightKg * 10)
    if (dbUnits !== Math.round(snap.weightKg * 10)) push('weightKg', fmtValue(person.weightKg), fmtValue(snap.weightKg))
  }
  if (snap.chestCm !== null && cmToHalfUnits(person.chestCm) !== cmToHalfUnits(snap.chestCm)) {
    push('chestCm', fmtValue(person.chestCm), fmtValue(snap.chestCm))
  }
  if (snap.waistCm !== null && cmToHalfUnits(person.waistCm) !== cmToHalfUnits(snap.waistCm)) {
    push('waistCm', fmtValue(person.waistCm), fmtValue(snap.waistCm))
  }
  if (snap.gender !== null && person.gender !== snap.gender) {
    push('gender', fmtGender(person.gender), fmtGender(snap.gender))
  }
  if (snap.orgUnit.trim() !== '' && person.orgUnit.trim() !== snap.orgUnit.trim()) {
    push('orgUnit', person.orgUnit || '（空）', snap.orgUnit.trim())
  }
  if (snap.batch.trim() !== '' && person.batch.trim() !== snap.batch.trim()) {
    push('batch', person.batch || '（空）', snap.batch.trim())
  }
  return diffs
}

/* ------------------------------- 快照转换 ------------------------------- */

export function snapshotFromDraft(draft: PersonDraft): ReconDraftSnapshot {
  return {
    name: draft.name,
    gender: draft.gender,
    orgUnit: draft.orgUnit,
    batch: draft.batch,
    heightCm: draft.heightCm,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm,
    waistCm: draft.waistCm,
    specialFlag: draft.specialFlag,
    note: draft.note,
    sourceRow: draft.sourceRow
  }
}

export function draftFromSnapshot(snap: ReconDraftSnapshot): PersonDraft {
  return { ...snap, source: 'import' }
}

export function snapshotSummary(snap: ReconDraftSnapshot): string {
  return [
    `${fmtGender(snap.gender)}`,
    `身高${fmtValue(snap.heightCm)}`,
    `体重${fmtValue(snap.weightKg)}`,
    `胸围${fmtValue(snap.chestCm)}`,
    `腰围${fmtValue(snap.waistCm)}`,
    `批次${snap.batch || '（空）'}`
  ].join(' / ')
}

function chosenSnapshot(item: ReconItem): ReconDraftSnapshot | null {
  const chosen = item.candidates.find((candidate) => candidate.lineNo === item.chosenLineNo)
  return chosen?.draft ?? item.candidates[0]?.draft ?? null
}

/* ------------------------------- 比对 ------------------------------- */

type SheetEntry = { lineNo: number; draft: PersonDraft }

function matchKey(name: string, orgUnit: string): string {
  return `${name.trim()}|${orgUnit.trim()}`
}

/** 相似度评分（越小越像）：性别不一致优先拉开，再比身高 / 胸围 / 腰围差距（半厘米整数） */
function similarity(person: Person, draft: PersonDraft): [number, number, number, number] {
  const genderMiss = draft.gender !== null && person.gender !== draft.gender ? 1 : 0
  const gap = (dbValue: number, sheetValue: number | null): number =>
    sheetValue === null ? 9999 : Math.abs(cmToHalfUnits(dbValue) - cmToHalfUnits(sheetValue))
  return [genderMiss, gap(person.heightCm, draft.heightCm), gap(person.chestCm, draft.chestCm), gap(person.waistCm, draft.waistCm)]
}

function scoreLess(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index]
  }
  return false
}

/** 冲突判定：库中号型是人工覆写，且回贴改动了影响号型的量体值（身高 / 胸围 / 腰围 / 性别） */
function conflictFor(person: Person, diffs: ReconFieldDiff[]): { conflict: boolean; note: string } {
  const override = person.result?.manualOverride
  if (!override) return { conflict: false, note: '' }
  const touchesSize = diffs.some((diff) => ['heightCm', 'chestCm', 'waistCm', 'gender'].includes(diff.field))
  if (!touchesSize) return { conflict: false, note: '' }
  return {
    conflict: true,
    note: `库里号型为人工覆写「${override.sizeCode}」（${override.by}：${override.reason}），回贴又改动了量体值，两边对不上。默认以库里人工覆写为准：采纳只更新量体数值、号型保留覆写；改选「以回贴为准」则清除覆写、按新量体值重新归并。`
  }
}

function reconMarkNote(person: Person): string {
  const mark = person.reconMark
  if (!mark) return ''
  const actionText = mark.action === 'added' ? '新增入库' : mark.action === 'removed' ? '移出有效人数' : '修改过量体值'
  return `该记录此前由核对「${mark.fileName}」${actionText}（${new Date(mark.at).toLocaleString('zh-CN')}）`
}

export function findReconciliation(project: Project, fingerprint: string): Reconciliation | undefined {
  return (project.reconciliations ?? []).find((recon) => recon.fingerprint === fingerprint)
}

export function makeReconId(): string {
  return `recon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 比对回贴与库中记录，生成差异单（纯函数，不写库；由调用方登记到 project.reconciliations）。
 * 同一份回贴重复比对前，调用方应先用 findReconciliation 查指纹，保证只出一份差异单。
 */
export function buildReconciliation(
  project: Project,
  rule: SizeRule,
  dataRows: { cells: string[]; lineNo: number }[],
  mapping: ColumnMapping,
  fileName: string,
  fingerprint: string,
  operator: string
): Reconciliation {
  const defaultBatch = project.batches[0] ?? '未分批'
  const sheetEntries: SheetEntry[] = []
  const parseErrors: { lineNo: number; reason: string }[] = []

  for (const row of dataRows) {
    const parsed = buildDraftFromRow(row.cells, mapping, rule, defaultBatch, row.lineNo)
    if (!parsed.draft) {
      parseErrors.push({ lineNo: row.lineNo, reason: parsed.error })
      continue
    }
    sheetEntries.push({ lineNo: row.lineNo, draft: parsed.draft })
  }

  // 库中记录按「姓名 + 班级」分组（含无效 / 重复行：学校可能把当初无效的行改对了发回来）
  const dbByKey = new Map<string, Person[]>()
  for (const person of project.persons) {
    const key = matchKey(person.name, person.orgUnit)
    if (!dbByKey.has(key)) dbByKey.set(key, [])
    dbByKey.get(key)!.push(person)
  }
  for (const group of dbByKey.values()) {
    group.sort((a, b) => (a.sourceRow ?? Number.MAX_SAFE_INTEGER) - (b.sourceRow ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  }

  const sheetByKey = new Map<string, SheetEntry[]>()
  for (const entry of sheetEntries) {
    const key = matchKey(entry.draft.name, entry.draft.orgUnit)
    if (!sheetByKey.has(key)) sheetByKey.set(key, [])
    sheetByKey.get(key)!.push(entry)
  }
  for (const group of sheetByKey.values()) group.sort((a, b) => a.lineNo - b.lineNo)

  const items: ReconItem[] = []
  let matchedCount = 0
  let seq = 0
  const nextId = (kind: ReconItemKind): string => {
    seq += 1
    return `ri_${kind}_${seq}`
  }

  const allKeys = [...new Set([...dbByKey.keys(), ...sheetByKey.keys()])].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  /** 组内配对（贪心就近）：回贴行按行号顺序各取库中最相似的一条；多余的人 / 行落进差异单 */
  const pairGroup = (persons: Person[], entries: SheetEntry[], multiNote: string): void => {
    const pool = [...persons]
    const pairs: { person: Person; entry: SheetEntry }[] = []
    for (const entry of entries) {
      if (pool.length === 0) break
      let bestIndex = 0
      for (let index = 1; index < pool.length; index += 1) {
        if (scoreLess(similarity(pool[index], entry.draft), similarity(pool[bestIndex], entry.draft))) bestIndex = index
      }
      pairs.push({ person: pool.splice(bestIndex, 1)[0], entry })
    }

    for (const pair of pairs) {
      const snap = snapshotFromDraft(pair.entry.draft)
      const diffs = fieldDiffs(pair.person, snap)
      if (diffs.length === 0) {
        matchedCount += 1
        continue
      }
      const { conflict, note } = conflictFor(pair.person, diffs)
      items.push({
        id: nextId('changed'),
        kind: 'changed',
        name: pair.person.name,
        orgUnit: pair.person.orgUnit,
        personId: pair.person.id,
        sheetLineNos: [pair.entry.lineNo],
        diffs,
        draft: snap,
        candidates: [],
        chosenLineNo: null,
        conflict,
        conflictNote: note,
        policy: 'keep_manual',
        note: [multiNote, reconMarkNote(pair.person)].filter((part) => part !== '').join('；'),
        decision: 'pending',
        adoptedAt: null
      })
    }

    // 表里有而库里没有
    for (const entry of entries.slice(pairs.length)) {
      items.push({
        id: nextId('sheet_only'),
        kind: 'sheet_only',
        name: entry.draft.name.trim(),
        orgUnit: entry.draft.orgUnit.trim(),
        personId: null,
        sheetLineNos: [entry.lineNo],
        diffs: [],
        draft: snapshotFromDraft(entry.draft),
        candidates: [],
        chosenLineNo: null,
        conflict: false,
        conflictNote: '',
        policy: 'keep_manual',
        note: '',
        decision: 'pending',
        adoptedAt: null
      })
    }

    // 库里有而表里没了
    for (const person of pool) {
      items.push({
        id: nextId('db_only'),
        kind: 'db_only',
        name: person.name,
        orgUnit: person.orgUnit,
        personId: person.id,
        sheetLineNos: [],
        diffs: [],
        draft: null,
        candidates: [],
        chosenLineNo: null,
        conflict: false,
        conflictNote: '',
        policy: 'keep_manual',
        note: [multiNote, reconMarkNote(person)].filter((part) => part !== '').join('；'),
        decision: 'pending',
        adoptedAt: null
      })
    }
  }

  for (const key of allKeys) {
    const dbGroup = dbByKey.get(key) ?? []
    const sheetGroup = sheetByKey.get(key) ?? []
    const multiNote = dbGroup.length > 1 ? `重名同班 ${dbGroup.length} 人，已按性别 / 身高就近配对去重分开` : ''

    // 同一人在表里出现多行且多于库中人数 → 重复行差异
    if (sheetGroup.length >= 2 && sheetGroup.length > dbGroup.length) {
      if (dbGroup.length <= 1) {
        // 库里 0 或 1 人：整组并成一条「同一人两行」，由人工选以哪一行为准
        const person = dbGroup[0] ?? null
        const candidates: ReconCandidate[] = sheetGroup.map((entry) => ({
          lineNo: entry.lineNo,
          draft: snapshotFromDraft(entry.draft),
          summary: `第 ${entry.lineNo} 行：${snapshotSummary(snapshotFromDraft(entry.draft))}`
        }))
        let bestIndex = 0
        if (person) {
          for (let index = 1; index < sheetGroup.length; index += 1) {
            if (scoreLess(similarity(person, sheetGroup[index].draft), similarity(person, sheetGroup[bestIndex].draft))) {
              bestIndex = index
            }
          }
        }
        const chosen = candidates[bestIndex]
        const diffs = person ? fieldDiffs(person, chosen.draft) : []
        const { conflict, note } = person ? conflictFor(person, diffs) : { conflict: false, note: '' }
        const lineNos = sheetGroup.map((entry) => entry.lineNo)
        items.push({
          id: nextId('duplicate'),
          kind: 'duplicate',
          name: sheetGroup[0].draft.name.trim(),
          orgUnit: person?.orgUnit ?? sheetGroup[0].draft.orgUnit.trim(),
          personId: person?.id ?? null,
          sheetLineNos: lineNos,
          diffs,
          draft: null,
          candidates,
          chosenLineNo: chosen.lineNo,
          conflict,
          conflictNote: note,
          policy: 'keep_manual',
          note: [
            `回贴中同一「姓名 + 班级」出现 ${sheetGroup.length} 行（第 ${lineNos.join('、')} 行），默认取与库中最接近的第 ${chosen.lineNo} 行，可切换以哪一行为准`,
            multiNote,
            person ? reconMarkNote(person) : ''
          ].filter((part) => part !== '').join('；'),
          decision: 'pending',
          adoptedAt: null
        })
        continue
      }
      // 库里 ≥2 人：先正常配对，多出来的回贴行单列为重复行
      const surplus = sheetGroup.slice(dbGroup.length)
      const surplusCandidates: ReconCandidate[] = surplus.map((entry) => ({
        lineNo: entry.lineNo,
        draft: snapshotFromDraft(entry.draft),
        summary: `第 ${entry.lineNo} 行：${snapshotSummary(snapshotFromDraft(entry.draft))}`
      }))
      items.push({
        id: nextId('duplicate'),
        kind: 'duplicate',
        name: surplus[0].draft.name.trim(),
        orgUnit: surplus[0].draft.orgUnit.trim(),
        personId: null,
        sheetLineNos: surplus.map((entry) => entry.lineNo),
        diffs: [],
        draft: null,
        candidates: surplusCandidates,
        chosenLineNo: surplusCandidates[0].lineNo,
        conflict: false,
        conflictNote: '',
        policy: 'keep_manual',
        note: `库中 ${dbGroup.length} 个同名同班记录已全部配对，回贴还多出 ${surplus.length} 行（第 ${surplus.map((entry) => entry.lineNo).join('、')} 行），疑似同一人登记了两遍`,
        decision: 'pending',
        adoptedAt: null
      })
      // 配对用前 dbGroup.length 行继续走正常流程
      pairGroup(dbGroup, sheetGroup.slice(0, dbGroup.length), multiNote)
      continue
    }

    pairGroup(dbGroup, sheetGroup, multiNote)
  }

  // 第二遍：学校可能改了班级 —— 表里有库里没有 与 库里有表里没了 按姓名唯一配对，视为同一人改了班级 / 批次
  const sheetOnly = items.filter((item) => item.kind === 'sheet_only')
  const dbOnly = items.filter((item) => item.kind === 'db_only')
  const sheetByName = new Map<string, ReconItem[]>()
  const dbByName = new Map<string, ReconItem[]>()
  for (const item of sheetOnly) {
    if (!sheetByName.has(item.name)) sheetByName.set(item.name, [])
    sheetByName.get(item.name)!.push(item)
  }
  for (const item of dbOnly) {
    if (!dbByName.has(item.name)) dbByName.set(item.name, [])
    dbByName.get(item.name)!.push(item)
  }
  const removed = new Set<string>()
  for (const [name, sheetItems] of [...sheetByName.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
    const dbItems = dbByName.get(name) ?? []
    if (sheetItems.length !== 1 || dbItems.length !== 1) continue
    const sheetItem = sheetItems[0]
    const dbItem = dbItems[0]
    const person = project.persons.find((entry) => entry.id === dbItem.personId)
    if (!person || !sheetItem.draft) continue
    const diffs = fieldDiffs(person, sheetItem.draft)
    const { conflict, note } = conflictFor(person, diffs)
    removed.add(sheetItem.id)
    removed.add(dbItem.id)
    items.push({
      id: nextId('changed'),
      kind: 'changed',
      name: person.name,
      orgUnit: person.orgUnit,
      personId: person.id,
      sheetLineNos: [...sheetItem.sheetLineNos],
      diffs,
      draft: sheetItem.draft,
      candidates: [],
      chosenLineNo: null,
      conflict,
      conflictNote: note,
      policy: 'keep_manual',
      note: [
        `回贴班级「${sheetItem.draft.orgUnit}」与库中「${person.orgUnit}」不一致，已按姓名唯一匹配为同一人（视为改了班级 / 批次）`,
        reconMarkNote(person)
      ].filter((part) => part !== '').join('；'),
      decision: 'pending',
      adoptedAt: null
    })
  }
  const finalItems = items.filter((item) => !removed.has(item.id))

  // 差异单排序：改了值 → 表里有库里没有 → 库里有表里没了 → 同一人两行；同类按回贴行号 / 班级姓名
  const kindRank: Record<ReconItemKind, number> = { changed: 0, sheet_only: 1, db_only: 2, duplicate: 3 }
  finalItems.sort((a, b) => {
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind]
    const lineA = a.sheetLineNos[0] ?? Number.MAX_SAFE_INTEGER
    const lineB = b.sheetLineNos[0] ?? Number.MAX_SAFE_INTEGER
    if (lineA !== lineB) return lineA - lineB
    return `${a.orgUnit}|${a.name}`.localeCompare(`${b.orgUnit}|${b.name}`, 'zh-Hans-CN')
  })

  return {
    id: makeReconId(),
    fingerprint,
    fileName,
    at: Date.now(),
    operator,
    sheetRows: sheetEntries.length,
    dbCount: project.persons.length,
    matchedCount,
    parseErrors,
    items: finalItems
  }
}

/* ------------------------------- 统计 ------------------------------- */

export type ReconCounts = {
  changed: number
  sheetOnly: number
  dbOnly: number
  duplicate: number
  pending: number
  adopted: number
  skipped: number
  total: number
}

export function reconCounts(recon: Reconciliation): ReconCounts {
  const counts: ReconCounts = { changed: 0, sheetOnly: 0, dbOnly: 0, duplicate: 0, pending: 0, adopted: 0, skipped: 0, total: recon.items.length }
  for (const item of recon.items) {
    if (item.kind === 'changed') counts.changed += 1
    else if (item.kind === 'sheet_only') counts.sheetOnly += 1
    else if (item.kind === 'db_only') counts.dbOnly += 1
    else counts.duplicate += 1
    if (item.decision === 'adopted') counts.adopted += 1
    else if (item.decision === 'skipped') counts.skipped += 1
    else counts.pending += 1
  }
  return counts
}

/* ------------------------------- 采纳写回 ------------------------------- */

/** 把回贴快照写回库中记录：只写回贴里填了的字段（空单元格不覆盖） */
function writeSnapshotToPerson(person: Person, snap: ReconDraftSnapshot): void {
  if (snap.heightCm !== null) person.heightCm = snap.heightCm
  if (snap.weightKg !== null) person.weightKg = snap.weightKg
  if (snap.chestCm !== null) person.chestCm = snap.chestCm
  if (snap.waistCm !== null) person.waistCm = snap.waistCm
  if (snap.gender) person.gender = snap.gender
  if (snap.orgUnit.trim() !== '') person.orgUnit = snap.orgUnit.trim()
  if (snap.batch.trim() !== '') person.batch = snap.batch.trim()
}

/** 采纳后按规则重新校验该行（「重复行（已排除）」状态是人工确认的，保持不动） */
function reanalyzePerson(person: Person, rule: SizeRule): void {
  if (person.status === 'duplicate') return
  const outcome = analyzeDraft(
    {
      name: person.name,
      gender: person.gender,
      orgUnit: person.orgUnit,
      batch: person.batch,
      heightCm: person.heightCm > 0 ? person.heightCm : null,
      weightKg: person.weightKg,
      chestCm: person.chestCm > 0 ? person.chestCm : null,
      waistCm: person.waistCm > 0 ? person.waistCm : null,
      specialFlag: person.specialFlag,
      note: person.note,
      sourceRow: person.sourceRow,
      source: person.source
    },
    rule
  )
  person.status = outcome.status
  person.statusReason = outcome.statusReason
  person.anomaly = outcome.anomaly
  person.needsConfirm = outcome.needsConfirm
}

/** 应用单条差异，返回受影响的库中记录 id；无法应用（如记录已不存在）返回 null */
function applyReconItem(project: Project, rule: SizeRule, recon: Reconciliation, item: ReconItem, now: number): string | null {
  const mark = (action: 'updated' | 'added' | 'removed') => ({
    reconId: recon.id,
    fileName: recon.fileName,
    at: now,
    action
  })

  if (item.kind === 'db_only') {
    // 库里有而表里没了：采纳 = 移出有效人数（标无效、留痕，不物理删除）
    const person = project.persons.find((entry) => entry.id === item.personId)
    if (!person) return null
    person.status = 'invalid'
    person.statusReason = `回贴核对采纳：学校回贴中已无此人（${recon.fileName}）`
    person.result = null
    person.reconMark = mark('removed')
    return person.id
  }

  if (item.kind === 'sheet_only') {
    // 表里有而库里没有：采纳 = 新增入库
    if (!item.draft) return null
    const person = createPersonFromDraft(draftFromSnapshot(item.draft), rule, null)
    person.reconMark = mark('added')
    project.persons.push(person)
    return person.id
  }

  // changed / duplicate：把选用行的值写回库中记录；duplicate 且库里无人时按选用行新增
  const snap = item.kind === 'duplicate' ? chosenSnapshot(item) : item.draft
  if (!snap) return null
  if (item.personId) {
    const person = project.persons.find((entry) => entry.id === item.personId)
    if (!person) return null
    writeSnapshotToPerson(person, snap)
    reanalyzePerson(person, rule)
    if (item.conflict && item.policy === 'sheet_wins') {
      // 以回贴为准：清除人工覆写，重新归并时按新量体值计算
      person.result = null
    }
    person.reconMark = mark('updated')
    return person.id
  }
  const person = createPersonFromDraft(draftFromSnapshot(snap), rule, null)
  person.reconMark = mark('added')
  project.persons.push(person)
  return person.id
}

export type AdoptCulprit = { itemId: string; name: string; lineNos: number[]; reason: string }

export type AdoptResult = {
  ok: boolean
  applied: number
  /** 无法应用而被跳过的条目（如库中记录已不存在） */
  skipped: { itemId: string; name: string; reason: string }[]
  /** 守恒复核没过关时被拦下的肇事条目 */
  culprits: AdoptCulprit[]
  beforeText: string
  afterText: string
  message: string
}

/**
 * 采纳所选条目：先写回，再重新归并并复核人数与套数（常规 + 特殊 = 有效人数）。
 * 任何一条导致守恒对不上（新增未归并行）→ 整体回滚、一条都不采纳，并指出是哪几条造成的。
 */
export function adoptItems(project: Project, rule: SizeRule, recon: Reconciliation, itemIds: string[]): AdoptResult {
  const empty = { applied: 0, skipped: [], culprits: [], beforeText: '', afterText: '' }
  const targets = recon.items.filter((item) => itemIds.includes(item.id) && item.decision !== 'adopted')
  if (targets.length === 0) {
    return { ok: false, ...empty, message: '没有可采纳的条目（已采纳的条目不会重复写回）' }
  }

  runMerge(project, rule)
  const beforeSummary = buildSummary(project, rule)
  const beforeText = conservationText(beforeSummary)
  const beforeUnmerged = new Set(beforeSummary.unmerged.map((diff) => diff.personId))
  // 快照用于守恒不过关时整体回滚
  const snapshot = structuredClone(toRaw(project).persons) as Person[]

  const now = Date.now()
  const touchedByItem = new Map<string, string>()
  const skipped: { itemId: string; name: string; reason: string }[] = []
  let applied = 0
  for (const item of targets) {
    const personId = applyReconItem(project, rule, recon, item, now)
    if (!personId) {
      skipped.push({ itemId: item.id, name: item.name, reason: '库中记录已不存在或条目缺少回贴数据，未写回' })
      continue
    }
    touchedByItem.set(item.id, personId)
    applied += 1
  }

  // 重新归并 + 复核人数与套数
  runMerge(project, rule)
  const afterSummary = buildSummary(project, rule)
  const afterText = conservationText(afterSummary)
  const newUnmerged = afterSummary.unmerged.filter((diff) => !beforeUnmerged.has(diff.personId))
  const broken = newUnmerged.length > 0 || afterSummary.totals.accountedQty !== afterSummary.totals.validRows

  if (broken) {
    project.persons.splice(0, project.persons.length, ...snapshot)
    runMerge(project, rule)
    const culpritPersons = new Set(newUnmerged.map((diff) => diff.personId))
    const culprits: AdoptCulprit[] = []
    for (const item of targets) {
      const personId = touchedByItem.get(item.id)
      if (!personId || !culpritPersons.has(personId)) continue
      const diff = newUnmerged.find((entry) => entry.personId === personId)
      culprits.push({
        itemId: item.id,
        name: item.name,
        lineNos: item.sheetLineNos,
        reason: diff?.reason ?? '采纳后该记录无法归并'
      })
    }
    if (culprits.length === 0) {
      for (const item of targets) {
        culprits.push({ itemId: item.id, name: item.name, lineNos: item.sheetLineNos, reason: '采纳后总人数与总套数对不上' })
      }
    }
    return {
      ok: false,
      applied: 0,
      skipped,
      culprits,
      beforeText,
      afterText,
      message: `采纳已拦下：写回后人数与套数对不上（${afterText}），已整体回滚，一条都没有写回。请修正下列条目后重试。`
    }
  }

  for (const item of targets) {
    if (!touchedByItem.has(item.id)) continue
    item.decision = 'adopted'
    item.adoptedAt = now
  }
  return {
    ok: true,
    applied,
    skipped,
    culprits: [],
    beforeText,
    afterText,
    message: `已采纳 ${applied} 条并写回库中（复核：${afterText}，人数与套数一致）`
  }
}

/* ------------------------------- 差异单导出 ------------------------------- */

export const RECON_EXPORT_HEADER = [
  '类别',
  '姓名',
  '班级/车间（库）',
  '回贴行号',
  '改动字段',
  '库里值',
  '回贴值',
  '冲突与取值',
  '配对说明',
  '处理状态',
  '采纳时间'
]

/** 差异单导出行（页面预览、CSV、XLSX 共用，保证逐行一致） */
export function reconExportRows(project: Project, recon: Reconciliation): (string | number)[][] {
  const counts = reconCounts(recon)
  const rows: (string | number)[][] = [
    ['项目', project.name],
    ['回贴文件', recon.fileName],
    ['文件指纹', recon.fingerprint],
    ['比对时间', new Date(recon.at).toLocaleString('zh-CN')],
    ['核对人', recon.operator],
    [
      '差异统计',
      `改了值 ${counts.changed} / 表里有库里没有 ${counts.sheetOnly} / 库里有表里没了 ${counts.dbOnly} / 同一人两行 ${counts.duplicate} / 完全一致 ${recon.matchedCount}（回贴 ${recon.sheetRows} 行 ↔ 库中 ${recon.dbCount} 条）`
    ],
    ['处理进度', `已采纳 ${counts.adopted} / 不采纳 ${counts.skipped} / 待处理 ${counts.pending}`],
    ['冲突取值说明', '「以库里人工覆写为准」= 量体值按回贴更新、号型保留人工覆写；「以回贴为准」= 清除人工覆写、按新量体值重新归并'],
    []
  ]
  rows.push([...RECON_EXPORT_HEADER])
  const decisionText = (item: ReconItem): string =>
    item.decision === 'adopted' ? `已采纳（${reconPolicyText(item) || '按差异单取值'}）` : reconDecisionLabel(item.decision)
  const adoptedText = (item: ReconItem): string => (item.adoptedAt ? new Date(item.adoptedAt).toLocaleString('zh-CN') : '')

  for (const item of recon.items) {
    const base = [
      reconKindLabel(item.kind),
      item.name,
      item.orgUnit || '（空）',
      item.sheetLineNos.length > 0 ? item.sheetLineNos.join('、') : '—'
    ]
    const tail = [item.note, decisionText(item), adoptedText(item)]
    if (item.kind === 'changed') {
      for (const diff of item.diffs) {
        rows.push([...base, diff.label, diff.dbText, diff.sheetText, item.conflict ? `${item.conflictNote} ⇒ ${reconPolicyText(item)}` : '', ...tail])
      }
    } else if (item.kind === 'duplicate') {
      const chosen = item.candidates.find((candidate) => candidate.lineNo === item.chosenLineNo)
      rows.push([
        ...base,
        `候选 ${item.candidates.length} 行，取第 ${item.chosenLineNo ?? '—'} 行`,
        item.personId ? '库中有此人' : '库中无此人',
        item.candidates.map((candidate) => candidate.summary).join('；'),
        item.conflict ? `${item.conflictNote} ⇒ ${reconPolicyText(item)}` : '',
        `${item.note}${chosen ? `（当前取：${chosen.summary}）` : ''}`,
        decisionText(item),
        adoptedText(item)
      ])
    } else if (item.kind === 'sheet_only') {
      rows.push([...base, '—', '库中无此人', item.draft ? snapshotSummary(item.draft) : '', '', ...tail])
    } else {
      rows.push([...base, '—', '回贴中已无此人', '', '', ...tail])
    }
  }
  if (recon.parseErrors.length > 0) {
    rows.push([])
    rows.push(['无法解析的回贴行', recon.parseErrors.length])
    for (const error of recon.parseErrors) rows.push([`第 ${error.lineNo} 行`, error.reason])
  }
  return rows
}
