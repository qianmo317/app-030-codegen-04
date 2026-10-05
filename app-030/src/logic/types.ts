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

/** active = 计入有效人数；invalid = 无效行；duplicate = 被确认为重复并排除；removed = 回贴核对后库里有、表里没了，采纳后排除 */
export type PersonStatus = 'active' | 'invalid' | 'duplicate' | 'removed'

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
  source: 'manual' | 'import' | 'reconcile'
  result: PersonResult | null
  /** 回贴核对采纳：在第几次核对中采纳、操作人、时间；由表里新增的人也带此标记 */
  adoptedInReconcileId?: string | null
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
  /** 回贴核对差异单（含历史；最近一份在前） */
  reconciliations: Reconciliation[]
  /** 最近一次「导出量体明细给学校核对」时的字段值快照（按 姓名|班级 键），用于识别库里之后手工改过的值 */
  detailSnapshot?: DetailSnapshot | null
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }

/* ========================== 回贴核对（学校回表比对） ========================== */

/** 逐条比对的七个字段（规格：身高 / 体重 / 胸围 / 腰围 / 性别 / 班级 / 批次） */
export type ReconcileFieldKey =
  | 'heightCm'
  | 'weightKg'
  | 'chestCm'
  | 'waistCm'
  | 'gender'
  | 'orgUnit'
  | 'batch'

/** 差异四类 */
export type ReconcileKind = 'changed' | 'sheet_only' | 'db_only' | 'duplicate_sheet' | 'error'

/** 回贴值与库里手工改过的值冲突时的取舍策略 */
export type ReconcileConflictPolicy = 'sheet_wins' | 'db_manual_wins'

/** 差异单条目处理状态 */
export type ReconcileItemStatus = 'pending' | 'accepted' | 'rejected'

/** 可序列化的字段值（统一转成数字 / 字符串） */
export type ReconcileValue = number | string | null

export type ReconcileFieldChange = {
  field: ReconcileFieldKey
  /** 库里当前值（比对时快照） */
  dbValue: ReconcileValue
  /** 学校回表值 */
  sheetValue: ReconcileValue
  /** 本次核对前库里最后一个值（手工改过的基线）；未取到基线时与 dbValue 相同 */
  baselineValue: ReconcileValue
  /** 学校回表值与库里手工改过的值是否冲突（baseline 与 db、sheet 都不同） */
  conflict: boolean
  /** 该字段采纳时最终生效值（按冲突策略预演） */
  effectiveValue: ReconcileValue
  /** 该字段是否会在采纳时写入（冲突且策略为 db_manual_wins 时为 false） */
  willApply: boolean
}

/** 回表中的一行（解析结果） */
export type ReconcileSheetRow = {
  lineNo: number
  name: string
  gender: Gender
  orgUnit: string
  batch: string
  heightCm: number | null
  weightKg: number | null
  chestCm: number | null
  waistCm: number | null
}

/** 重名同班：库里同一个「姓名 + 班级」键下的候选人（用于人工分清） */
export type ReconcileCandidate = {
  personId: string
  gender: Gender
  batch: string
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  status: PersonStatus
}

export type ReconcileItem = {
  id: string
  kind: ReconcileKind
  status: ReconcileItemStatus
  /** 姓名 + 班级 匹配键 */
  matchKey: string
  name: string
  orgUnit: string
  /** 回表行号；duplicate_sheet 时可能有多行 */
  sheetLineNos: number[]
  /** duplicate_sheet：选中的回表行号；null 表示默认第一行 / 尚未选择 */
  selectedLineNo: number | null
  /** duplicate_sheet：其余重复回表行号（采纳选中行时这些行视为重复丢弃，不会再当新人） */
  extraLineNos: number[]
  /** 匹配到的库里记录 id（changed / db_only；duplicate_sheet 为当前选中的人） */
  personId: string | null
  /** duplicate_sheet：同键库里所有人，供逐条分清 */
  candidates: ReconcileCandidate[]
  /** duplicate_sheet：回表中同键每一行的值（持久化，刷新后仍可切换选中行） */
  duplicateRows: { lineNo: number; values: Record<ReconcileFieldKey, ReconcileValue> }[]
  changes: ReconcileFieldChange[]
  /** 库里当前值（全部比对字段快照），用于展示与导出 */
  dbValues: Record<ReconcileFieldKey, ReconcileValue>
  /** 回表值（选中行） */
  sheetValues: Record<ReconcileFieldKey, ReconcileValue>
  /** 解析错误行（kind = error） */
  parseError: string
  /** 重名同班去重提示 / 情况说明 */
  note: string
  decidedAt: number | null
  decidedBy: string
}

export type ReconcileCounts = {
  total: number
  changed: number
  sheetOnly: number
  dbOnly: number
  duplicateSheet: number
  error: number
  conflicts: number
  pending: number
  accepted: number
  rejected: number
}

/** 导出量体明细给学校时的逐字段值快照（值为 身高/体重/胸围/腰围/性别/班级/批次） */
export type DetailSnapshot = {
  at: number
  fileName: string
  operator: string
  values: Record<string, Record<ReconcileFieldKey, ReconcileValue>>
}

export type Reconciliation = {
  id: string
  projectId: string
  fileName: string
  /** 同一份回贴重复比对的幂等指纹（文件名 + 大小 + 内容哈希） */
  fingerprint: string
  conflictPolicy: ReconcileConflictPolicy
  operator: string
  createdAt: number
  items: ReconcileItem[]
  counts: ReconcileCounts
  /** 最近一次采纳 / 批量采纳时间 */
  lastAppliedAt: number | null
  /** 采纳后守恒复核：通过才允许落库 */
  lastGateBlocked: boolean
}