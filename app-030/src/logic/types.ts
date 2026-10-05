/** 领域模型：量体数据、号型规则、归并结果与汇总 */

export type Gender = 'male' | 'female'
export type PatternFit = 'Y' | 'A' | 'B' | 'C'
/** 边界规则：round_up = 边界归上（167.5 → 170）；nearest = 就近归下（167.5 → 165） */
export type BoundaryRule = 'round_up' | 'nearest'
export type ProjectKind = 'school' | 'factory' | 'other'

export type FitRange = { fit: PatternFit; minCm: number; maxCm: number }
export type GenderFitRule = { gender: Gender; ranges: FitRange[] }
export type SpecialFlag = { code: string; label: string }

/** 身高体重 → 建议初始号型的估算参数（仅作录入参考） */
export type SizeEstimateConfig = {
  standardWeightBaseCm: number
  maleWeightFactor: number
  femaleWeightFactor: number
  maleChestRatio: number
  femaleChestRatio: number
  maleBmiRef: number
  femaleBmiRef: number
  bmiChestFactor: number
  maleDefaultDiffCm: number
  femaleDefaultDiffCm: number
}

/** 号型规则（版本化，项目锁定版本后不随规则改版而变） */
export type SizeRule = {
  version: string
  label: string
  builtin: boolean
  heightStepCm: number
  heightAnchor: number
  chestStepCm: number
  chestAnchor: number
  boundaryRule: BoundaryRule
  fitByChestWaistDiff: GenderFitRule[]
  specialFlags: SpecialFlag[]
  heightRangeCm: { minCm: number; maxCm: number }
  chestRangeCm: { minCm: number; maxCm: number }
  estimate: SizeEstimateConfig
  effectiveFrom: string
  note: string
}

/** 数值异常标记 */
export type AnomalyCode =
  | 'height_out_of_range'
  | 'chest_out_of_range'
  | 'missing_chest'
  | 'missing_height'
  | 'missing_waist'
  | 'diff_out_of_range'

/** active = 计入有效人数；invalid = 无效行；duplicate = 被确认为重复并排除 */
export type PersonStatus = 'active' | 'invalid' | 'duplicate'

export type ManualOverride = { sizeCode: string; by: string; reason: string; at: number }

export type PersonResult = {
  /** 生效号型（人工覆写后为覆写值） */
  sizeCode: string
  /** 按规则归并出的号型，便于对比「按规则归并 / 人工覆写」 */
  ruleSizeCode: string
  fit: PatternFit | null
  ruleVersion: string
  manualOverride?: ManualOverride
}

/** 回贴核对采纳后在人员记录上的留痕：标明是哪一次核对采纳的 */
export type ReconMark = {
  reconId: string
  fileName: string
  at: number
  action: 'updated' | 'added' | 'removed'
}

export type Person = {
  id: string
  name: string
  gender: Gender
  /** 班级 / 车间 */
  orgUnit: string
  batch: string
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  specialFlag: string | null
  note: string
  status: PersonStatus
  /** 无效 / 排除的原因说明 */
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  /** 导入来源行号（用于差异定位） */
  sourceRow: number | null
  source: 'manual' | 'import'
  result: PersonResult | null
  /** 最近一次回贴核对采纳的留痕（未参与过核对为 null/缺省） */
  reconMark?: ReconMark | null
  createdAt: number
}

export type ImportRecord = {
  fingerprint: string
  fileName: string
  at: number
  rows: number
  added: number
  updated: number
  invalid: number
  skipped: number
}

export type Project = {
  id: string
  name: string
  kind: ProjectKind
  /** 项目锁定的规则版本：规则改版后旧项目仍按旧版本解释 */
  ruleVersion: string
  batches: string[]
  persons: Person[]
  imports: ImportRecord[]
  /** 回贴核对差异单（本机持久化；同一份回贴指纹幂等，只出一份） */
  reconciliations: Reconciliation[]
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }

/* ------------------------------- 回贴核对 ------------------------------- */

/** 参与比对的字段：身高 / 体重 / 胸围 / 腰围 / 性别 / 班级 / 批次 */
export type ReconFieldKey = 'heightCm' | 'weightKg' | 'chestCm' | 'waistCm' | 'gender' | 'orgUnit' | 'batch'

export type ReconFieldDiff = {
  field: ReconFieldKey
  label: string
  /** 库中值（展示文本） */
  dbText: string
  /** 回贴值（展示文本） */
  sheetText: string
}

/**
 * 四类差异：
 * - changed：改了值的（同人同班，字段值不一致）
 * - sheet_only：表里有而库里没有这个人
 * - db_only：库里有而表里没了
 * - duplicate：同一个人在表里出现两行
 */
export type ReconItemKind = 'changed' | 'sheet_only' | 'db_only' | 'duplicate'

/** pending = 待处理；adopted = 已采纳写回；skipped = 不采纳（留着下次再看） */
export type ReconDecision = 'pending' | 'adopted' | 'skipped'

/**
 * 冲突取值（回贴改动与库中人工覆写冲突时以哪个为准）：
 * - keep_manual：以库里人工覆写为准 —— 量体值按回贴更新，号型仍保留人工覆写
 * - sheet_wins：以回贴为准 —— 清除人工覆写，按新量体值重新归并
 */
export type ReconConflictPolicy = 'keep_manual' | 'sheet_wins'

/** 回贴行的解析快照（差异单持久化在本机，采纳时凭快照写回，不依赖原文件） */
export type ReconDraftSnapshot = {
  name: string
  gender: Gender | null
  orgUnit: string
  batch: string
  heightCm: number | null
  weightKg: number | null
  chestCm: number | null
  waistCm: number | null
  specialFlag: string | null
  note: string
  sourceRow: number | null
}

/** 重复行候选：同一人出现多行时，供选择「以哪一行为准」 */
export type ReconCandidate = {
  lineNo: number
  draft: ReconDraftSnapshot
  /** 一行关键值摘要，便于人工辨认 */
  summary: string
}

export type ReconItem = {
  id: string
  kind: ReconItemKind
  name: string
  /** 匹配用的班级（库侧为准） */
  orgUnit: string
  /** 匹配到的库中记录（表里有库里没有时为 null） */
  personId: string | null
  sheetLineNos: number[]
  diffs: ReconFieldDiff[]
  /** 回贴行快照（changed / sheet_only 采纳写回用） */
  draft: ReconDraftSnapshot | null
  /** duplicate 专用：候选行与当前选用行 */
  candidates: ReconCandidate[]
  chosenLineNo: number | null
  /** 回贴改动与库中人工覆写冲突 */
  conflict: boolean
  conflictNote: string
  policy: ReconConflictPolicy
  /** 配对说明（重名同班去重、按姓名唯一匹配等） */
  note: string
  decision: ReconDecision
  adoptedAt: number | null
}

export type ReconParseError = { lineNo: number; reason: string }

export type Reconciliation = {
  id: string
  /** 回贴文件指纹：同一份回贴重复比对只出一份差异单 */
  fingerprint: string
  fileName: string
  at: number
  operator: string
  sheetRows: number
  dbCount: number
  /** 完全一致的行数（未进差异单） */
  matchedCount: number
  parseErrors: ReconParseError[]
  items: ReconItem[]
}