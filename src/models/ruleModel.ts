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

/**
 * 仅在整个输入空间被完整枚举后才能给出的结论。
 * 部分检查（complete === false）时 verdicts 为 null，
 * 未走完的分区不得参与不可达、遮蔽与整体覆盖的判断。
 */
export interface AnalysisVerdicts {
  unreachableRuleIds: string[];
  shadowedRuleIds: string[];
  fullyCovered: boolean;
  overlapFree: boolean;
}

export interface RuleAnalysis {
  checkedCases: number;
  totalCases: number;
  /** true 表示整个输入空间已完整枚举，verdicts 可信 */
  complete: boolean;
  coveredCases: number;
  /** 已分析分区内的覆盖率；仅当 complete 时才代表整个输入空间 */
  coveragePercent: number;
  /** 已确认的重叠（每条都有真实见证输入）；部分检查时可能还有更多 */
  overlaps: RuleOverlap[];
  /** 已确认可命中的规则（部分检查时同样可信） */
  reachableRuleIds: string[];
  /** 部分检查时未能确认命中与否的规则；不等于不可达 */
  undeterminedRuleIds: string[];
  /** 已确认的未覆盖输入样例；部分检查时未分析分区可能还有更多 */
  uncoveredExamples: SampleInput[];
  verdicts: AnalysisVerdicts | null;
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
