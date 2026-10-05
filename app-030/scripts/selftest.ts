/* 端到端逻辑自测（临时，不进构建）：构造项目 → 模拟学校回表 → 比对 → 采纳 → 守恒复核 */
import assert from 'node:assert'
import { BUILTIN_RULES } from '../src/logic/sizeRules'
import type { Person, Project, Reconciliation } from '../src/logic/types'
import { analyzeDraft, makePersonId, type PersonDraft } from '../src/logic/analyze'
import {
  buildReconciliation,
  commitAdoption,
  findReconciliationByFingerprint,
  previewAdopt,
  rejectItems,
  selectDuplicateRow,
  selectMatchedPerson,
  parseReconcileRow,
  guessReconcileMapping,
  detectReconcileHeaderRow,
  EMPTY_RECONCILE_MAPPING,
  type ParsedReconcileRow,
  type ReconcileColumnMapping
} from '../src/logic/reconcile'
import { buildSummary, runMerge } from '../src/logic/merge'
import { buildDetailSnapshot } from '../src/logic/exporter'

const rule = BUILTIN_RULES[0]
let passed = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
  passed += 1
  console.log(`  ✓ ${name}`)
}

function makePerson(partial: Partial<PersonDraft> & { name: string }): Person {
  const draft: PersonDraft = {
    name: partial.name,
    gender: partial.gender ?? 'male',
    orgUnit: partial.orgUnit ?? '高一1班',
    batch: partial.batch ?? '春装',
    heightCm: partial.heightCm ?? 170,
    weightKg: partial.weightKg ?? 60,
    chestCm: partial.chestCm ?? 88,
    waistCm: partial.waistCm ?? 74,
    specialFlag: partial.specialFlag ?? null,
    note: '',
    sourceRow: null,
    source: 'manual'
  }
  const outcome = analyzeDraft(draft, rule)
  return {
    id: makePersonId(),
    name: draft.name,
    gender: draft.gender,
    orgUnit: draft.orgUnit,
    batch: draft.batch,
    heightCm: draft.heightCm ?? 0,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm ?? 0,
    waistCm: draft.waistCm ?? 0,
    specialFlag: null,
    note: '',
    status: outcome.status,
    statusReason: outcome.statusReason,
    anomaly: outcome.anomaly,
    needsConfirm: outcome.needsConfirm,
    possibleDuplicateOf: null,
    sourceRow: null,
    source: 'manual',
    result: null,
    adoptedInReconcileId: null,
    createdAt: Date.now()
  }
}

function makeProject(persons: Person[]): Project {
  const now = Date.now()
  const project: Project = {
    id: 'prj_test',
    name: '测试中学',
    kind: 'school',
    ruleVersion: rule.version,
    batches: ['春装'],
    persons,
    imports: [],
    reconciliations: [],
    detailSnapshot: null,
    createdAt: now,
    updatedAt: now
  }
  runMerge(project, rule)
  return project
}

/** 用字符串二维行模拟回表解析（带表头） */
function parseSheet(project: Project, rows: string[][], policy: 'sheet_wins' | 'db_manual_wins' = 'sheet_wins'): Reconciliation {
  const headerRow = detectReconcileHeaderRow(rows)
  assert.ok(headerRow >= 0, '应识别到表头')
  const mapping = guessReconcileMapping(rows[headerRow])
  const parsed: ParsedReconcileRow[] = []
  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const cells = rows[index]
    if (!cells.some((cell) => cell !== '')) continue
    const r = parseReconcileRow(cells, mapping, project.batches[0] ?? '未分批', index + 1)
    if (r) parsed.push(r)
  }
  return buildReconciliation({
    project,
    rule,
    parsedRows: parsed,
    fileName: '回表.xlsx',
    fingerprint: `fp_${Math.random()}`,
    conflictPolicy: policy,
    operator: '测试员',
    now: Date.now()
  })
}

const HEADER = ['姓名', '性别', '班级', '批次', '身高(cm)', '体重(kg)', '胸围(cm)', '腰围(cm)']

console.log('场景 1：四类差异齐全（改值 / 表有库无 / 库有表无 / 同人两行）')
{
  const zhang = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const wang = makePerson({ name: '王五', heightCm: 165, chestCm: 84, waistCm: 70 })
  const zhao = makePerson({ name: '赵六', heightCm: 175, chestCm: 92, waistCm: 80 })
  const project = makeProject([zhang, wang, zhao])

  const rows = [
    HEADER,
    // 张三：身高 170→172.5，胸围 88→90（改了值）
    ['张三', '男', '高一1班', '春装', '172.5', '60', '90', '74'],
    // 李四：库里没有（表有库无）
    ['李四', '女', '高一1班', '春装', '160', '50', '82', '66'],
    // 王五：出现两行（同人两行），第二行身高不同
    ['王五', '男', '高一1班', '春装', '165', '55', '84', '70'],
    ['王五', '男', '高一1班', '春装', '167.5', '55', '84', '70']
    // 赵六不出现（库有表无）
  ]
  const rec = parseSheet(project, rows)
  const kinds = Object.fromEntries(['changed', 'sheet_only', 'db_only', 'duplicate_sheet'].map((k) => [k, rec.items.filter((i) => i.kind === k).length]))
  eq('四类计数', kinds, { changed: 1, sheet_only: 1, db_only: 1, duplicate_sheet: 1 })

  const changed = rec.items.find((i) => i.name === '张三' && i.kind === 'changed')!
  const fields = changed.changes.map((c) => c.field).sort()
  eq('张三改了身高+胸围', fields, ['chestCm', 'heightCm'])
  const heightChange = changed.changes.find((c) => c.field === 'heightCm')!
  eq('身高 170→172.5', [heightChange.dbValue, heightChange.sheetValue], [170, 172.5])
  ok('无手工改动基线时不判冲突', !changed.changes.some((c) => c.conflict))

  const dup = rec.items.find((i) => i.kind === 'duplicate_sheet')!
  eq('同人两行列了两个行号', dup.sheetLineNos.length, 2)
  eq('默认选第一行', dup.selectedLineNo, 4)
  eq('第二行行号', dup.sheetLineNos[1], 5)

  const sheetOnly = rec.items.find((i) => i.kind === 'sheet_only')!
  eq('李四是表有库无', sheetOnly.name, '李四')

  const dbOnly = rec.items.find((i) => i.kind === 'db_only')!
  eq('赵六是库有表无', dbOnly.name, '赵六')
}

console.log('场景 2：冲突检测 —— 明细发出后库里手工改过，回表又改成第三个值')
{
  const zhang = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const project = makeProject([zhang])
  // 模拟导出明细时身高 170
  project.detailSnapshot = buildDetailSnapshot({ project, rule }, '明细.csv')
  project.detailSnapshot.operator = '测试员'
  // 导出后库里手工改成 171
  zhang.heightCm = 171
  runMerge(project, rule)

  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '173', '60', '88', '74']]

  const recWins = parseSheet(project, rows, 'sheet_wins')
  const changed = recWins.items.find((i) => i.name === '张三')!
  const hc = changed.changes.find((c) => c.field === 'heightCm')!
  eq('回表为准策略判冲突', hc.conflict, true)
  eq('基线=明细时的170', hc.baselineValue, 170)
  eq('当前库值171', hc.dbValue, 171)
  eq('回表值173', hc.sheetValue, 173)
  eq('回表为准时生效173', hc.effectiveValue, 173)
  eq('回表为准 willApply', hc.willApply, true)

  const recManual = parseSheet(project, rows, 'db_manual_wins')
  const hcManual = recManual.items.find((i) => i.name === '张三')!.changes.find((c) => c.field === 'heightCm')!
  eq('手工为准时生效保留171', hcManual.effectiveValue, 171)
  eq('手工为准 willApply=false', hcManual.willApply, false)
  ok('冲突条目计数', recManual.counts.conflicts === 1)
}

console.log('场景 3：同一回贴指纹幂等（页面层 findReconciliationByFingerprint）')
{
  const zhang = makePerson({ name: '张三' })
  const project = makeProject([zhang])
  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '172', '60', '88', '74']]
  const headerRow = detectReconcileHeaderRow(rows)
  const mapping = guessReconcileMapping(rows[headerRow])
  const parsed = [parseReconcileRow(rows[1], mapping, '春装', 2)!]
  const rec = buildReconciliation({
    project, rule, parsedRows: parsed, fileName: 'a.xlsx', fingerprint: 'SAMEFP',
    conflictPolicy: 'sheet_wins', operator: 'x'
  })
  project.reconciliations.unshift(rec)
  const rec2 = buildReconciliation({
    project, rule, parsedRows: parsed, fileName: 'a.xlsx', fingerprint: 'SAMEFP',
    conflictPolicy: 'sheet_wins', operator: 'x'
  })
  ok('同指纹能找到既有差异单', Boolean(findReconciliationByFingerprint(project, 'SAMEFP')))
  ok('两份单子条目数一致（同内容同结果）', rec2.items.length === rec.items.length)
}

console.log('场景 4：采纳写回 + 守恒复核通过 + 标注核对批次')
{
  const zhang = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const zhao = makePerson({ name: '赵六', heightCm: 175, chestCm: 92, waistCm: 80 })
  const project = makeProject([zhang, zhao])
  const before = buildSummary(project, rule)
  eq('采纳前有效2人', before.totals.validRows, 2)
  eq('采纳前守恒', before.conserved, true)

  const rows = [
    HEADER,
    ['张三', '男', '高一1班', '春装', '172.5', '60', '90', '76'],
    ['李四', '女', '高一1班', '春装', '160', '50', '82', '66']
  ]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)

  const pendingIds = new Set(rec.items.filter((i) => i.status === 'pending').map((i) => i.id))
  const gate = previewAdopt(project, rule, rec, pendingIds)
  eq('预演通过', gate.ok, true)
  // 张三改值（仍在）、李四新增（+1）、赵六库有表无被移除（-1）→ 有效仍为 2
  eq('有效人数 2→2（李四+1 赵六-1）', gate.after.valid, 2)

  const result = commitAdoption(project, rule, rec, pendingIds, '测试员')
  eq('正式采纳成功', result.gate.ok, true)
  const zhangAfter = project.persons.find((p) => p.name === '张三')!
  eq('张三身高写回172.5', zhangAfter.heightCm, 172.5)
  eq('张三腰围写回76', zhangAfter.waistCm, 76)
  eq('张三标注核对批次', zhangAfter.adoptedInReconcileId, rec.id)
  const li = project.persons.find((p) => p.name === '李四')!
  ok('李四为新人且来源 reconcile', li.source === 'reconcile')
  eq('李四标注核对批次', li.adoptedInReconcileId, rec.id)
  // 赵六未在回表，但我们没有勾选 db_only（全部 pending 都勾选了！）
  const zhaoAfter = project.persons.find((p) => p.name === '赵六')!
  eq('赵六被标记 removed（因为勾选了全部 pending）', zhaoAfter.status, 'removed')
  const after = buildSummary(project, rule)
  eq('采纳后守恒仍成立（新增1，移除1：有效2）', after.conserved, true)
  eq('采纳后有效人数', after.totals.validRows, 2)
  eq('采纳后总套数', after.totals.accountedQty, 2)
  // 全部条目标记
  eq('accepted 数', rec.counts.accepted, rec.items.length)
}

console.log('场景 5：采纳导致归不进号型（胸腰差异常）→ 整批拦住并指出条目')
{
  const zhang = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const project = makeProject([zhang])
  // 回表把腰围改成 96 → 胸腰差为负，无法归并
  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '170', '60', '88', '96']]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const ids = new Set(rec.items.map((i) => i.id))
  const gate = previewAdopt(project, rule, rec, ids)
  eq('预演被拦', gate.ok, false)
  ok('指出张三这条', gate.blockingItems.some((b) => b.name === '张三'))
  const result = commitAdoption(project, rule, rec, ids, 'x')
  eq('正式采纳也被拦', result.gate.ok, false)
  eq('库未被污染身高未变', project.persons[0].waistCm, 74)
}

console.log('场景 6：不采纳保留 pending，下次可再看')
{
  const zhang = makePerson({ name: '张三', heightCm: 170 })
  const project = makeProject([zhang])
  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '172', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const ids = new Set(rec.items.map((i) => i.id))
  rejectItems(rec, ids, '测试员')
  eq('标记 rejected', rec.items[0].status, 'rejected')
  ok('库值未变', project.persons[0].heightCm === 170)
}

console.log('场景 7：重名同班的两个不同人能分开')
{
  const a = makePerson({ name: '张伟', heightCm: 160, chestCm: 82, waistCm: 68 })
  const b = makePerson({ name: '张伟', heightCm: 180, chestCm: 96, waistCm: 84 })
  const project = makeProject([a, b])
  // 回表只回了一个张伟（身高180那位）
  const rows = [HEADER, ['张伟', '男', '高一1班', '春装', '180', '60', '96', '84']]
  const rec = parseSheet(project, rows)
  const matched = rec.items.find((i) => i.kind === 'changed')
  const dbOnly = rec.items.find((i) => i.kind === 'db_only')
  ok('自动配对到180那位', Boolean(matched) && project.persons.find((p) => p.id === matched!.personId)?.heightCm === 180)
  ok('160那位列为库有表无', Boolean(dbOnly) && project.persons.find((p) => p.id === dbOnly!.personId)?.heightCm === 160)
  ok('候选人列出两个', (matched?.candidates.length ?? 0) === 2)
}

console.log('场景 8：回表错误行（性别无法识别）进 error 类且不可采纳')
{
  const zhang = makePerson({ name: '张三' })
  const project = makeProject([zhang])
  const rows = [HEADER, ['张三', 'X', '高一1班', '春装', '170', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const err = rec.items.find((i) => i.kind === 'error')
  ok('有错误行', Boolean(err))
  const ids = new Set(rec.items.filter((i) => i.kind !== 'error').map((i) => i.id))
  // 张三实际没变化（值一致），不应有 changed；error 行勾选不进来
  const gate = previewAdopt(project, rule, rec, ids)
  eq('无有效勾选时预演通过（空集也能跑）', gate.ok, true)
}

console.log('场景 9：同人两行切换选中行会重算比对')
{
  const wang = makePerson({ name: '王五', heightCm: 165, chestCm: 84, waistCm: 70 })
  const project = makeProject([wang])
  const rows = [
    HEADER,
    ['王五', '男', '高一1班', '春装', '165', '55', '84', '70'],
    ['王五', '男', '高一1班', '春装', '168', '55', '84', '70']
  ]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const dup = rec.items.find((i) => i.kind === 'duplicate_sheet')!
  eq('默认第一行（行2）无身高改动', dup.changes.filter((c) => c.field === 'heightCm').length, 0)
  selectDuplicateRow(project, rec, dup, 3)
  eq('切到第二行（行3）检测出身高改动', dup.changes.find((c) => c.field === 'heightCm')?.sheetValue, 168)
}

console.log(`\n全部通过，共 ${passed} 个断言`)

console.log('场景 10：空勾选预演应视为无可采纳项（页面层另有提示，预演本身返回 ok）')
{
  const zhang = makePerson({ name: '张三', heightCm: 170 })
  const project = makeProject([zhang])
  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '172', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const gate = previewAdopt(project, rule, rec, new Set())
  eq('空集预演 ok（不改动）', gate.ok, true)
  eq('空集 after=before 有效人数', gate.after.valid, gate.before.valid)
}

console.log('场景 11：性别 / 批次 文本字段参与比对与写回（改班级会换匹配键，属库有表无+表有库无）')
{
  const zhang = makePerson({ name: '张三', gender: 'male', orgUnit: '高一1班', batch: '春装' })
  const project = makeProject([zhang])
  project.detailSnapshot = buildDetailSnapshot({ project, rule }, 'm.csv')
  // 班级保持不变（否则匹配不上）；改性别 + 批次
  const rows = [HEADER, ['张三', '女', '高一1班', '秋装', '170', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  const changed = rec.items.find((i) => i.kind === 'changed')!
  const fields = changed.changes.map((c) => c.field).sort()
  eq('性别+批次两字段改动', fields, ['batch', 'gender'])
  project.reconciliations.unshift(rec)
  const result = commitAdoption(project, rule, rec, new Set([changed.id]), '测试员')
  eq('文本字段采纳成功', result.gate.ok, true)
  const after = project.persons[0]
  eq('性别写回 female', after.gender, 'female')
  eq('批次写回', after.batch, '秋装')
}

console.log('场景 11b：学校把班级改了 → 按姓名回退匹配为「改了值」，班级是改动字段')
{
  const zhang = makePerson({ name: '张三', orgUnit: '高一1班' })
  const project = makeProject([zhang])
  const rows = [HEADER, ['张三', '男', '高一2班', '春装', '170', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  const changed = rec.items.find((i) => i.kind === 'changed')
  ok('按姓名回退匹配到张三', Boolean(changed))
  ok('班级是改动字段', changed?.changes.some((c) => c.field === 'orgUnit'))
  eq('不产生表有库无', rec.items.filter((i) => i.kind === 'sheet_only').length, 0)
  eq('不产生库有表无', rec.items.filter((i) => i.kind === 'db_only').length, 0)
}

console.log('场景 11c：无同名歧义时，转学生（真新人）仍判为表有库无')
{
  const zhang = makePerson({ name: '张三', orgUnit: '高一1班' })
  const project = makeProject([zhang])
  // 李四库里确实没有
  const rows = [HEADER, ['李四', '男', '高一2班', '春装', '170', '60', '88', '74']]
  const rec = parseSheet(project, rows)
  ok('李四判为表有库无', rec.items.some((i) => i.kind === 'sheet_only' && i.name === '李四'))
}

console.log('场景 12：库里手工改为准时，采纳后冲突字段保留库值、非冲突字段仍写回')
{
  const zhang = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const project = makeProject([zhang])
  project.detailSnapshot = buildDetailSnapshot({ project, rule }, 'm.csv')
  zhang.heightCm = 171 // 手工改身高
  runMerge(project, rule)
  // 回表：身高改173（与手工冲突），腰围改76（学校单方面改，不冲突）
  const rows = [HEADER, ['张三', '男', '高一1班', '春装', '173', '60', '88', '76']]
  const rec = parseSheet(project, rows, 'db_manual_wins')
  project.reconciliations.unshift(rec)
  const item = rec.items.find((i) => i.kind === 'changed')!
  const result = commitAdoption(project, rule, rec, new Set([item.id]), 'x')
  eq('采纳通过', result.gate.ok, true)
  eq('身高保留手工171', project.persons[0].heightCm, 171)
  eq('腰围写回76', project.persons[0].waistCm, 76)
}

console.log('场景 13：重名同班可手动把条目改对到另一个人')
{
  const a = makePerson({ name: '张伟', heightCm: 160, chestCm: 82, waistCm: 68 })
  const b = makePerson({ name: '张伟', heightCm: 180, chestCm: 96, waistCm: 84 })
  const project = makeProject([a, b])
  const rows = [HEADER, ['张伟', '男', '高一1班', '春装', '180', '60', '96', '84']]
  const rec = parseSheet(project, rows)
  project.reconciliations.unshift(rec)
  const matched = rec.items.find((i) => i.kind === 'changed')!
  eq('自动配到180', matched.personId, b.id)
  // 手动改配到 160 那位
  selectMatchedPerson(project, rec, matched, a.id)
  eq('手动改配到160', matched.personId, a.id)
  ok('改配后身高出现改动（库160 vs 回表180）', matched.changes.some((c) => c.field === 'heightCm'))
  // 180 那位应转为库有表无
  const dbOnly = rec.items.find((i) => i.kind === 'db_only')
  eq('180那位变为库有表无', dbOnly?.personId, b.id)
}

console.log('场景 14：回表与库里完全一致的人不进差异单')
{
  const a = makePerson({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 74 })
  const b = makePerson({ name: '李四', heightCm: 165, chestCm: 84, waistCm: 70 })
  const project = makeProject([a, b])
  const rows = [
    HEADER,
    ['张三', '男', '高一1班', '春装', '170', '60', '88', '74'],
    ['李四', '男', '高一1班', '春装', '167', '60', '84', '70']
  ]
  const rec = parseSheet(project, rows)
  eq('差异单只有李四一条', rec.items.filter((i) => i.kind === 'changed').length, 1)
  eq('那条是李四', rec.items[0].name, '李四')
  eq('张三不算库有表无', rec.items.filter((i) => i.kind === 'db_only').length, 0)
}

console.log(`\n补充场景通过，累计 ${passed} 个断言`)
void EMPTY_RECONCILE_MAPPING
void (null as unknown as ReconcileColumnMapping)
