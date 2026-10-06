import type {
  AnalysisScope,
  MatchWitness,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleOverlap,
  RuleProject,
  SampleInput,
} from '../models/ruleModel';
import { matchesRule } from './conditionEvaluator';

const MAX_CASES = 120_000;
const MAX_EXAMPLES = 4;
/** 总分区数超过该值时不再展示具体总数，只提示“超过上限” */
const TOTAL_DISPLAY_LIMIT = 1_000_000_000_000;

interface EnumeratedField {
  field: RuleField;
  values: ScalarCandidate[];
}

export function analyzeRules(project: RuleProject): RuleAnalysis {
  // 候选值少的字段排在外层：DFS 截断时，已完整扫过的“字段后缀”最大，
  // 从而能对尽可能多的规则给出可证明的结论，而不是一刀切全部标成不可达。
  const enumerated: EnumeratedField[] = project.fields
    .map((field, originalIndex) => ({ field, originalIndex, values: valuesForField(field, project) }))
    .sort((a, b) => a.values.length - b.values.length || a.originalIndex - b.originalIndex)
    .map(({ field, values }) => ({ field, values }));
  const lengths = enumerated.map((entry) => entry.values.length);

  const overlaps = new Map<string, RuleOverlap>();
  const seen = new Set<string>();
  const visible = new Set<string>();
  const processedMatchSets = new Set<string>();
  const uncoveredExamples: SampleInput[] = [];
  const ordered = [...project.rules].sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
  const referencedByRule = new Map<string, Set<string>>(
    project.rules.map((rule) => [rule.id, collectReferencedFields(rule.conditions)]),
  );

  let rawTotal = 1;
  for (const length of lengths) {
    rawTotal *= length;
    if (rawTotal > TOTAL_DISPLAY_LIMIT) {
      rawTotal = Number.POSITIVE_INFINITY;
      break;
    }
  }
  const totalCases = Number.isFinite(rawTotal) ? rawTotal : undefined;

  let checkedCases = 0;
  let coveredCases = 0;
  let truncated = false;

  const visit = (fieldIndex: number, values: SampleInput): void => {
    if (checkedCases >= MAX_CASES) {
      truncated = true;
      return;
    }
    if (fieldIndex < enumerated.length) {
      for (const value of enumerated[fieldIndex].values) {
        values[enumerated[fieldIndex].field.id] = value;
        visit(fieldIndex + 1, values);
        if (truncated) break;
      }
      delete values[enumerated[fieldIndex].field.id];
      return;
    }
    checkedCases += 1;
    const matched = ordered.filter((rule) => matchesRule(rule, values));
    for (const rule of matched) seen.add(rule.id);
    if (matched.length) coveredCases += 1;
    else if (uncoveredExamples.length < MAX_EXAMPLES) uncoveredExamples.push({ ...values });
    if (matched[0]) visible.add(matched[0].id);
    const matchSetKey = matched.length > 1 ? matched.map((rule) => rule.id).sort().join('|') : '';
    if (matched.length > 1 && !processedMatchSets.has(matchSetKey)) {
      processedMatchSets.add(matchSetKey);
      for (let left = 0; left < matched.length; left += 1) {
        for (let right = left + 1; right < matched.length; right += 1) {
          const ruleA = matched[left];
          const ruleB = matched[right];
          const key = [ruleA.id, ruleB.id].sort().join('|');
          if (!overlaps.has(key)) {
            overlaps.set(key, {
              ruleAId: ruleA.id,
              ruleBId: ruleB.id,
              conflict: ruleA.priority === ruleB.priority && ruleA.result !== ruleB.result,
              witness: { ...values },
            });
          }
        }
      }
    }
  };

  visit(0, {});

  // 截断时精确找出“已被完整枚举”的字段后缀：
  // suffix[i] 是字段 i 及其后所有字段的组合数（超过上限钳为 Infinity）。
  // 前 checkedCases 个叶子天然包含字段 cut..n-1 的一整轮全组合，
  // 因此只引用这些字段的规则，其可达性结论与未访问区域无关，可以直接证明。
  let provableFieldIds: Set<string> | null = null;
  if (truncated) {
    const suffix = new Array<number>(lengths.length + 1);
    suffix[lengths.length] = 1;
    for (let index = lengths.length - 1; index >= 0; index -= 1) {
      const product = suffix[index + 1] * lengths[index];
      suffix[index] = product > MAX_CASES ? Number.POSITIVE_INFINITY : product;
    }
    let cut = 0;
    while (cut < lengths.length && suffix[cut] > checkedCases) cut += 1;
    provableFieldIds = new Set(enumerated.slice(cut).map((entry) => entry.field.id));
  }

  const unreachableRuleIds: string[] = [];
  const unconfirmedRuleIds: string[] = [];
  const shadowedRuleIds: string[] = [];
  const shadowedCandidateIds: string[] = [];

  for (const rule of project.rules) {
    const hit = seen.has(rule.id);
    if (!hit) {
      if (!truncated) {
        unreachableRuleIds.push(rule.id);
      } else {
        const referenced = referencedByRule.get(rule.id) ?? new Set<string>();
        let provable = true;
        for (const fieldId of referenced) {
          if (!provableFieldIds?.has(fieldId)) {
            provable = false;
            break;
          }
        }
        // 仅当该规则依赖的所有字段都在已完整扫过的后缀内，才能下不可达结论；
        // 否则它可能在未访问区域命中，只能列为“待确认”，绝不报不可达。
        if (provable) unreachableRuleIds.push(rule.id);
        else unconfirmedRuleIds.push(rule.id);
      }
    } else if (!visible.has(rule.id)) {
      // 遮蔽依赖其他更高优先级规则在未访问区域的行为，只有完整枚举才能证明。
      if (!truncated) shadowedRuleIds.push(rule.id);
      else shadowedCandidateIds.push(rule.id);
    }
  }

  const scope: AnalysisScope = truncated ? 'partial' : 'complete';
  const percent = checkedCases ? Math.round((coveredCases / checkedCases) * 100) : 0;

  return {
    coverage: {
      checkedCases,
      totalCases,
      coveredCases,
      percent,
      scope,
    },
    complete: !truncated,
    overlaps: [...overlaps.values()],
    overlapsScope: scope,
    unreachableRuleIds,
    unreachableScope: scope,
    unconfirmedRuleIds,
    shadowedRuleIds,
    shadowedScope: scope,
    shadowedCandidateIds,
    uncoveredExamples,
    uncoveredScope: scope,
  };
}

function collectReferencedFields(condition: RuleCondition): Set<string> {
  const fieldIds = new Set<string>();
  const walk = (node: RuleCondition): void => {
    if (node.kind === 'group') {
      node.conditions.forEach(walk);
      return;
    }
    fieldIds.add(node.fieldId);
  };
  walk(condition);
  return fieldIds;
}

type ScalarCandidate = string | number | boolean;

function valuesForField(field: RuleField, project: RuleProject): ScalarCandidate[] {
  if (field.type === 'boolean') return [false, true];
  if (field.type === 'enum') return field.enumValues ?? [];
  const min = field.min ?? 0;
  const max = field.max ?? min;
  const breaks = new Set<number>([min, max]);
  for (const rule of project.rules) collectBreaks(rule.conditions, field.id, min, max, breaks);
  const sorted = [...breaks].sort((a, b) => a - b);
  const values = new Set<number>(sorted);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    values.add(sorted[index] + (sorted[index + 1] - sorted[index]) / 2);
  }
  return [...values].sort((a, b) => a - b);
}

function collectBreaks(
  condition: RuleCondition,
  fieldId: string,
  min: number,
  max: number,
  breaks: Set<number>,
): void {
  if (condition.kind === 'group') {
    condition.conditions.forEach((child) => collectBreaks(child, fieldId, min, max, breaks));
    return;
  }
  if (condition.fieldId !== fieldId) return;
  let boundaries: number[];
  if (typeof condition.value === 'number') boundaries = [condition.value];
  else if (typeof condition.value === 'object' && condition.value !== null && 'min' in condition.value && 'max' in condition.value) boundaries = [condition.value.min, condition.value.max];
  else return;
  for (const value of boundaries) if (value >= min && value <= max) breaks.add(value);
}

export const ruleAnalysisService = { analyze: analyzeRules };

export function firstOverlapWitness(analysis: RuleAnalysis): MatchWitness | undefined {
  const overlap = analysis.overlaps[0];
  return overlap ? { values: overlap.witness, ruleIds: [overlap.ruleAId, overlap.ruleBId] } : undefined;
}
