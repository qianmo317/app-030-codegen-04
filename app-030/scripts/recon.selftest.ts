/**
 * 回贴核对核心逻辑自测（无测试框架，node 直接跑断言）。
 * 运行：npm test（先由 scripts/run-selftest.mjs 用 esbuild 打包）。
 */
import assert from 'node:assert/strict'
import type { Person, Project, Reconciliation } from '../src/logic/types'
import { BUILTIN_RULES } from '../src/logic/sizeRules'
import { createPersonFromDraft, type ColumnMapping } from '../src/logic/importPlan'
import type { PersonDraft } from '../src/logic/analyze'
import { buildSummary, runMerge } from '../src/logic/merge'
import {
  adoptItems,
  buildReconciliation,
  findReconciliation,
  reconCounts,
  reconExportRows
} from '../src/logic/recon'

const rule = BUILTIN_RULES[0]

const MAPPING: ColumnMapping = {
  name: 0,
  gender: 1,
  orgUnit: 2,
  batch: 3,
  heightCm: 4,
  weightKg: 5,
  chestCm: 6,
  waistCm: 7,
  specialFlag: null,
  note: null
}

let personSeq = 0
function makePerson(
  name: string,
  orgUnit: string,
  gender: 'male' | 'female',
  height: number,
  weight: number,
  chest: number,
  waist: number
): Person {
  personSeq += 1
  const draft: PersonDraft = {
    name,
    gender,
    orgUnit,
    batch: '春装',
    heightCm: height,
    weightKg: weight,
    chestCm: chest,
    waistCm: waist,
    specialFlag: null,
    note: '',
    sourceRow: personSeq,
    source: 'import'
  }
  return createPersonFromDraft(draft, rule, null)
}

function sheetRow(name: string, gender: string, orgUnit: string, h: number, w: number, c: number, wa: number): string[] {
  return [name, gender, orgUnit, '春装', String(h), String(w), String(c), String(wa)]
}

function makeProject(persons: Person[]): Project {
  return {
    id: 'prj_test',
    name: '回贴核对自测',
    kind: 'school',
    ruleVersion: rule.version,
    batches: ['春装'],
    persons,
    imports: [],
    reconciliations: [],
    createdAt: 0,
    updatedAt: 0
  }
}

const FINGERPRINT = '回贴.xlsx|1234|deadbeef'

type Fixture = { project: Project; recon: Reconciliation }

function setup(): Fixture {
  const persons: Person[] = [
    makePerson('张三', '高一(3)班', 'male', 170, 65, 88, 72),
    makePerson('李四', '高一(3)班', 'female', 160, 52, 84, 68),
    makePerson('王五', '高一(3)班', 'male', 175, 70, 92, 76),
    makePerson('赵六', '高一(3)班', 'male', 165, 60, 86, 70), // 回贴里没了
    makePerson('小明', '高一(3)班', 'male', 168, 55, 85, 69), // 回贴里出现两行
    makePerson('陈晨', '高一(3)班', 'male', 172, 66, 90, 74), // 回贴把腰围改到胸腰差超区间
    makePerson('王芳', '高一(3)班', 'female', 158, 50, 82, 66), // 重名同班 A
    makePerson('王芳', '高一(3)班', 'female', 165, 58, 88, 72), // 重名同班 B
    makePerson('周杰', '高一(4)班', 'male', 170, 62, 88, 72), // 回贴里改了班级
    makePerson('刘冲突', '高一(3)班', 'male', 180, 80, 96, 80) // 库中有人工覆写
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  // 刘冲突：库中号型已被人工覆写
  const conflictPerson = project.persons.find((p) => p.name === '刘冲突')!
  conflictPerson.result = {
    sizeCode: '185/100A',
    ruleSizeCode: conflictPerson.result?.ruleSizeCode ?? '',
    fit: conflictPerson.result?.fit ?? null,
    ruleVersion: rule.version,
    manualOverride: { sizeCode: '185/100A', by: '测试员', reason: '肩宽特殊', at: Date.now() }
  }

  const sheetRows: string[][] = [
    sheetRow('张三', '男', '高一(3)班', 172, 66, 88, 72), // 改了身高+体重
    sheetRow('李四', '女', '高一(3)班', 160, 52, 84, 68), // 完全一致
    sheetRow('王五', '男', '高一(3)班', 175, 70, 92, 74), // 改了腰围
    sheetRow('小明', '男', '高一(3)班', 168, 55, 85, 69), // 同一人两行（行A与库一致）
    sheetRow('小明', '男', '高一(3)班', 169, 55, 85, 69), // 同一人两行（行B身高不同）
    sheetRow('陈晨', '男', '高一(3)班', 172, 66, 90, 60), // 腰围改到胸腰差 30，超区间
    sheetRow('王芳', '女', '高一(3)班', 158, 50, 82, 66), // 重名A，一致
    sheetRow('王芳', '女', '高一(3)班', 165, 58, 88, 72), // 重名B，一致
    sheetRow('周杰', '男', '高一(5)班', 170, 62, 88, 72), // 改了班级
    sheetRow('刘冲突', '男', '高一(3)班', 180, 80, 100, 80), // 改了胸围，与人工覆写冲突
    sheetRow('孙新', '男', '高一(3)班', 166, 58, 86, 70) // 表里有库里没有
  ]
  const dataRows = sheetRows.map((cells, index) => ({ cells, lineNo: index + 2 }))
  const recon = buildReconciliation(project, rule, dataRows, MAPPING, '回贴.xlsx', FINGERPRINT, '测试员')
  project.reconciliations.push(recon)
  return { project, recon }
}

function itemOf(recon: Reconciliation, name: string, kind?: string) {
  const found = recon.items.filter((item) => item.name === name && (!kind || item.kind === kind))
  assert.equal(found.length, 1, `应恰好有一条 ${name} 的 ${kind ?? ''} 差异，实际 ${found.length}`)
  return found[0]
}

let passed = 0
function test(label: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

/* ------------------------------- 比对与分类 ------------------------------- */

test('四类差异 + 完全一致行数 分类正确', () => {
  const { recon } = setup()
  const counts = reconCounts(recon)
  assert.equal(counts.changed, 5, `改了值应为 5（张三/王五/陈晨/周杰/刘冲突），实际 ${counts.changed}`)
  assert.equal(counts.sheetOnly, 1, '表里有库里没有应为 1（孙新）')
  assert.equal(counts.dbOnly, 1, '库里有表里没了应为 1（赵六）')
  assert.equal(counts.duplicate, 1, '同一人两行应为 1（小明）')
  assert.equal(recon.matchedCount, 3, '完全一致应为 3（李四 + 两个王芳）')
})

test('改了值：逐字段列出改了什么、改成多少', () => {
  const { recon } = setup()
  const item = itemOf(recon, '张三', 'changed')
  const fields = item.diffs.map((d) => d.field)
  assert.deepEqual(fields, ['heightCm', 'weightKg'])
  const height = item.diffs.find((d) => d.field === 'heightCm')!
  assert.equal(height.dbText, '170')
  assert.equal(height.sheetText, '172')
  const weight = item.diffs.find((d) => d.field === 'weightKg')!
  assert.equal(weight.dbText, '65')
  assert.equal(weight.sheetText, '66')
})

test('重名同班：两人去重分开、各自配对，不误判重复', () => {
  const { recon } = setup()
  const fangItems = recon.items.filter((item) => item.name === '王芳')
  assert.equal(fangItems.length, 0, '两个王芳数值完全一致，不应产生任何差异条目')
})

test('改了班级：按姓名唯一匹配为同一人，班级列入差异', () => {
  const { recon } = setup()
  const item = itemOf(recon, '周杰', 'changed')
  assert.ok(item.note.includes('按姓名唯一匹配'), '说明里应写明按姓名唯一匹配')
  const orgDiff = item.diffs.find((d) => d.field === 'orgUnit')!
  assert.equal(orgDiff.dbText, '高一(4)班')
  assert.equal(orgDiff.sheetText, '高一(5)班')
})

test('同一人两行：候选两行齐全，默认取与库中最接近的一行', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '小明', 'duplicate')
  const ming = project.persons.find((p) => p.name === '小明')!
  assert.equal(item.personId, ming.id)
  assert.equal(item.candidates.length, 2)
  assert.deepEqual(item.sheetLineNos, [5, 6])
  assert.equal(item.chosenLineNo, 5, '应默认选与库中一致的回贴行（第 5 行）')
})

test('冲突：回贴改动与库中人工覆写冲突时写明以哪个为准', () => {
  const { recon } = setup()
  const item = itemOf(recon, '刘冲突', 'changed')
  assert.equal(item.conflict, true)
  assert.ok(item.conflictNote.includes('185/100A'), '冲突说明应包含库中人工覆写号型')
  assert.ok(item.conflictNote.includes('以库里人工覆写为准'), '冲突说明应写明默认取值')
  assert.equal(item.policy, 'keep_manual')
})

test('幂等：同一份回贴按指纹只出一份差异单', () => {
  const { project, recon } = setup()
  assert.equal(findReconciliation(project, FINGERPRINT)?.id, recon.id)
  assert.equal(findReconciliation(project, '别的指纹'), undefined)
  assert.equal(project.reconciliations.length, 1)
})

/* ------------------------------- 采纳写回 ------------------------------- */

test('采纳改了值：写回库中、标明是哪一次核对采纳的、人数套数仍守恒', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '张三', 'changed')
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const zhang = project.persons.find((p) => p.name === '张三')!
  assert.equal(zhang.heightCm, 172)
  assert.equal(zhang.weightKg, 66)
  assert.equal(zhang.reconMark?.reconId, recon.id, '库中记录应标明是哪一次核对采纳的')
  assert.equal(zhang.reconMark?.action, 'updated')
  assert.equal(item.decision, 'adopted')
  assert.ok(item.adoptedAt !== null)
  const summary = buildSummary(project, rule)
  assert.equal(summary.conserved, true, '采纳后守恒应成立')
})

test('已采纳的条目不会重复写回', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '张三', 'changed')
  assert.equal(adoptItems(project, rule, recon, [item.id]).ok, true)
  const again = adoptItems(project, rule, recon, [item.id])
  assert.equal(again.ok, false)
  assert.ok(again.message.includes('没有可采纳的条目'))
})

test('冲突默认以库里人工覆写为准：量体值更新、覆写保留', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '刘冲突', 'changed')
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const person = project.persons.find((p) => p.name === '刘冲突')!
  assert.equal(person.chestCm, 100, '量体值应按回贴更新')
  assert.equal(person.result?.manualOverride?.sizeCode, '185/100A', '人工覆写应保留')
  assert.equal(person.result?.sizeCode, '185/100A', '生效号型仍是覆写值')
})

test('冲突改选以回贴为准：清除覆写、按新量体值重新归并', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '刘冲突', 'changed')
  item.policy = 'sheet_wins'
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const person = project.persons.find((p) => p.name === '刘冲突')!
  assert.equal(person.chestCm, 100)
  assert.equal(person.result?.manualOverride, undefined, '人工覆写应被清除')
  assert.equal(person.result?.sizeCode, '180/100Y', '应按新量体值重新归并')
})

test('采纳表里有库里没有：新增入库并留痕', () => {
  const { project, recon } = setup()
  const before = project.persons.length
  const item = itemOf(recon, '孙新', 'sheet_only')
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  assert.equal(project.persons.length, before + 1)
  const added = project.persons.find((p) => p.name === '孙新')!
  assert.equal(added.heightCm, 166)
  assert.equal(added.reconMark?.action, 'added')
  assert.equal(added.reconMark?.reconId, recon.id)
  assert.equal(buildSummary(project, rule).conserved, true)
})

test('采纳库里有表里没了：移出有效人数（标无效留痕，不物理删除）', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '赵六', 'db_only')
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const zhao = project.persons.find((p) => p.name === '赵六')!
  assert.equal(zhao.status, 'invalid')
  assert.ok(zhao.statusReason.includes('回贴核对采纳'))
  assert.equal(zhao.reconMark?.action, 'removed')
  const summary = buildSummary(project, rule)
  assert.equal(summary.conserved, true, '移出后守恒仍成立')
})

test('采纳同一人两行：按选用行写回库中此人', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '小明', 'duplicate')
  item.chosenLineNo = 6 // 改用第 6 行（身高 169）
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const ming = project.persons.find((p) => p.name === '小明')!
  assert.equal(ming.heightCm, 169)
  assert.equal(project.persons.filter((p) => p.name === '小明').length, 1, '不应新增第二行')
})

test('不采纳的条目留着下次再看', () => {
  const { recon } = setup()
  const item = itemOf(recon, '王五', 'changed')
  item.decision = 'skipped'
  const counts = reconCounts(recon)
  assert.equal(counts.skipped, 1)
  assert.equal(itemOf(recon, '王五', 'changed').decision, 'skipped', '不采纳的条目应留在差异单里')
})

/* ------------------------------- 守恒拦截 ------------------------------- */

test('采纳后人数与套数对不上：整体拦下、回滚、指出肇事条目', () => {
  const { project, recon } = setup()
  const item = itemOf(recon, '陈晨', 'changed')
  const before = buildSummary(project, rule)
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, false, '胸腰差 30 超区间导致无法归并，必须拦下')
  assert.equal(result.culprits.length, 1)
  assert.equal(result.culprits[0].name, '陈晨')
  assert.deepEqual(result.culprits[0].lineNos, [7])
  const chen = project.persons.find((p) => p.name === '陈晨')!
  assert.equal(chen.waistCm, 74, '被拦下后库中数据应整体回滚')
  assert.equal(item.decision, 'pending', '被拦下的条目保持待处理')
  const after = buildSummary(project, rule)
  assert.equal(after.totals.validRows, before.totals.validRows)
  assert.equal(after.conserved, before.conserved)
})

test('批量采纳里混进一条破坏守恒的：整批拦下，一条都不写回', () => {
  const { project, recon } = setup()
  const good = itemOf(recon, '张三', 'changed')
  const bad = itemOf(recon, '陈晨', 'changed')
  const result = adoptItems(project, rule, recon, [good.id, bad.id])
  assert.equal(result.ok, false)
  assert.equal(result.culprits.length, 1)
  assert.equal(result.culprits[0].name, '陈晨')
  const zhang = project.persons.find((p) => p.name === '张三')!
  assert.equal(zhang.heightCm, 170, '整批回滚，张三也不应被写回')
  assert.equal(itemOf(recon, '张三', 'changed').decision, 'pending')
})

/* ------------------------------- 差异单导出 ------------------------------- */

test('差异单导出：四类齐全、冲突取值写清楚、可逐行看', () => {
  const { project, recon } = setup()
  const rows = reconExportRows(project, recon)
  const text = rows.map((row) => row.join('|')).join('\n')
  assert.ok(text.includes('改了值'), '导出应包含改了值')
  assert.ok(text.includes('表里有·库里没有'), '导出应包含表里有库里没有')
  assert.ok(text.includes('库里有·表里没了'), '导出应包含库里有表里没了')
  assert.ok(text.includes('同一人两行'), '导出应包含同一人两行')
  assert.ok(text.includes('以库里人工覆写为准'), '导出应写明冲突以哪个为准')
  assert.ok(text.includes('张三'), '导出应能逐条看到人')
  const headerIndex = rows.findIndex((row) => row[0] === '类别' && row[1] === '姓名')
  assert.ok(headerIndex > 0, '导出应包含表头')
})

/* ------------------------------- 边界场景 ------------------------------- */

test('库里没有这个人且表里出现两行：归为同一人两行，采纳只新增一条', () => {
  const project = makeProject([])
  const rows = [
    sheetRow('新生', '男', '高一(1)班', 170, 60, 88, 72),
    sheetRow('新生', '男', '高一(1)班', 170, 60, 88, 72)
  ].map((cells, index) => ({ cells, lineNo: index + 2 }))
  const recon = buildReconciliation(project, rule, rows, MAPPING, '回贴2.xlsx', 'fp2', '测试员')
  const counts = reconCounts(recon)
  assert.equal(counts.duplicate, 1, '库中无人时表里两行应归为同一人两行')
  assert.equal(counts.sheetOnly, 0)
  const item = recon.items[0]
  assert.equal(item.personId, null)
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  assert.equal(project.persons.filter((p) => p.name === '新生').length, 1, '同一人两行采纳后只应新增一条')
})

test('回贴空单元格视为未填写：不产生差异、采纳不覆盖库中值', () => {
  const project = makeProject([makePerson('张三', '高一(3)班', 'male', 170, 65, 88, 72)])
  runMerge(project, rule)
  // 体重留空、身高改 172
  const rows = [['张三', '男', '高一(3)班', '春装', '172', '', '88', '72']].map((cells, index) => ({ cells, lineNo: index + 2 }))
  const recon = buildReconciliation(project, rule, rows, MAPPING, '回贴3.xlsx', 'fp3', '测试员')
  const item = itemOf(recon, '张三', 'changed')
  assert.deepEqual(item.diffs.map((d) => d.field), ['heightCm'], '空体重不应产生差异')
  const result = adoptItems(project, rule, recon, [item.id])
  assert.equal(result.ok, true, result.message)
  const zhang = project.persons.find((p) => p.name === '张三')!
  assert.equal(zhang.heightCm, 172)
  assert.equal(zhang.weightKg, 65, '空单元格不应覆盖库中体重')
})

test('同名两人分属表里两侧且数量不等：不做姓名唯一配对，保持原分类', () => {
  const project = makeProject([
    makePerson('同名', '高一(1)班', 'male', 170, 60, 88, 72),
    makePerson('同名', '高一(2)班', 'male', 175, 70, 92, 76)
  ])
  runMerge(project, rule)
  // 表里只有一个「同名」，在第三个班 → 无法唯一配对
  const rows = [sheetRow('同名', '男', '高一(3)班', 170, 60, 88, 72)].map((cells, index) => ({ cells, lineNo: index + 2 }))
  const recon = buildReconciliation(project, rule, rows, MAPPING, '回贴4.xlsx', 'fp4', '测试员')
  const counts = reconCounts(recon)
  assert.equal(counts.sheetOnly, 1)
  assert.equal(counts.dbOnly, 2, '库中两个同名都应列为库里有表里没了，不应被唯一配对吃掉')
  assert.equal(counts.changed, 0)
})

test('采纳后学校又发新回贴：已采纳的不再出现，不采纳的仍在', () => {
  const { project, recon } = setup()
  const zhang = itemOf(recon, '张三', 'changed')
  const wang = itemOf(recon, '王五', 'changed')
  wang.decision = 'skipped'
  assert.equal(adoptItems(project, rule, recon, [zhang.id]).ok, true)
  // 学校按第一次的结果重新发了一份（张三已是 172/66，王五仍是 74 腰围）
  const rows = [
    sheetRow('张三', '男', '高一(3)班', 172, 66, 88, 72),
    sheetRow('王五', '男', '高一(3)班', 175, 70, 92, 74)
  ].map((cells, index) => ({ cells, lineNo: index + 2 }))
  const next = buildReconciliation(project, rule, rows, MAPPING, '回贴5.xlsx', 'fp5', '测试员')
  assert.equal(next.items.filter((item) => item.name === '张三').length, 0, '已采纳写回的值与库一致，不应再出差异')
  assert.equal(next.matchedCount, 1)
  const wangNext = itemOf(next, '王五', 'changed')
  assert.equal(wangNext.decision, 'pending', '新一份差异单里该差异重新待处理')
  assert.equal(itemOf(recon, '王五', 'changed').decision, 'skipped', '原差异单里不采纳的记录保持不动')
})

console.log(`\n全部 ${passed} 组自测通过`)
