export type FieldType = 'number' | 'enum' | 'boolean';
export type ScalarValue = string | number | boolean;
export type ModuleId = 'fields' | 'rules' | 'samples' | 'inspection';

export interface RuleField {
  id: string;
  name: string;
  type: FieldType;
  enumValues?: string[];
  min?: number;
  max?: number;
}

export interface NumberRange {
  min: number;
  max: number;
}

export type PredicateCondition =
  | { kind: 'predicate'; fieldId: string; operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { kind: 'predicate'; fieldId: string; operator: 'between'; value: NumberRange }
  | { kind: 'predicate'; fieldId: string; operator: 'eq' | 'notEq'; value: string }
  | { kind: 'predicate'; fieldId: string; operator: 'isTrue' | 'isFalse'; value: boolean };

export interface ConditionGroup {
  kind: 'group';
  operator: 'and' | 'or';
  conditions: RuleCondition[];
}

export type RuleCondition = PredicateCondition | ConditionGroup;

export interface BusinessRule {
  id: string;
  name: string;
  conditions: ConditionGroup;
  priority: number;
  result: string;
}

export type SampleInput = Record<string, ScalarValue | ''>;

export interface RuleVersion {
  id: string;
  name: string;
  savedAt: number;
  frozen: boolean;
  fields: RuleField[];
  rules: BusinessRule[];
  sampleInputs: SampleInput;
}

export interface RuleProject {
  id: string;
  title: string;
  fields: RuleField[];
  rules: BusinessRule[];
  sampleInputs: SampleInput;
  versions: RuleVersion[];
  frozenVersionId?: string;
  updatedAt: number;
}

export interface WorkspaceDocument {
  schemaVersion: 1;
  projects: RuleProject[];
  activeProjectId: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  fieldId?: string;
  ruleId?: string;
}

export interface MatchWitness {
  values: SampleInput;
  ruleIds: string[];
}

export interface RuleOverlap {
  ruleAId: string;
  ruleBId: string;
  conflict: boolean;
  witness: SampleInput;
}

/** 结论的可信范围：complete = 整个输入空间已枚举完毕；partial = 仅在已分析的部分子空间内成立 */
export type AnalysisScope = 'complete' | 'partial';

export interface AnalysisCoverage {
  /** 已枚举的逻辑分区数 */
  checkedCases: number;
  /** 输入空间的分区总数；超过可计数上限时为 undefined（仅知道“非常大”） */
  totalCases: number | undefined;
  /** 已枚举分区中被至少一条规则覆盖的数量 */
  coveredCases: number;
  /** 覆盖率分母始终是 totalCases（完整时）或 checkedCases（部分时），由 scope 标明口径 */
  percent: number;
  scope: AnalysisScope;
}

export interface RuleAnalysis {
  coverage: AnalysisCoverage;
  /** 整个输入空间是否被完整枚举（等价于 coverage.scope === 'complete'） */
  complete: boolean;
  overlaps: RuleOverlap[];
  /** 重叠/冲突是存在性证据（已观测到即成立），部分枚举时仍可信；此处标明结论范围 */
  overlapsScope: AnalysisScope;
  /** 已确认不可达的规则：完整枚举时为全部不可达规则；部分枚举时只包含“引用字段全部位于已完整扫过的子空间”的规则 */
  unreachableRuleIds: string[];
  /** 不可达结论的可信范围；partial 时 unreachableRuleIds 是可证明的子集 */
  unreachableScope: AnalysisScope;
  /** 部分枚举且无法证明是否可达的规则——绝不能报成不可达 */
  unconfirmedRuleIds: string[];
  /** 已确认被完全遮蔽的规则（遮蔽结论依赖所有规则，只有完整枚举才可证明） */
  shadowedRuleIds: string[];
  shadowedScope: AnalysisScope;
  /** 部分枚举时“在已分析区域始终被遮蔽”的观察，仅供参考，不能作为调整优先级的依据 */
  shadowedCandidateIds: string[];
  /** 未覆盖样本：属于真实观察，始终可展示；只有 scope=complete 且为空才能下“已完整覆盖”结论 */
  uncoveredExamples: SampleInput[];
  uncoveredScope: AnalysisScope;
}

export interface SampleEvaluation {
  valid: boolean;
  errors: string[];
  matchedRules: BusinessRule[];
  winner?: BusinessRule;
}

export interface DomainChecker {
  analyze(project: RuleProject): RuleAnalysis;
  validateProject(project: RuleProject): ValidationIssue[];
}

export const fieldLabel = (field: RuleField): string => field.name || '未命名字段';
