import type {
  AnalysisVerdicts,
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
const CASE_COUNT_LIMIT = Number.MAX_SAFE_INTEGER;

export function analyzeRules(project: RuleProject): RuleAnalysis {
  const candidates = project.fields.map((field) => valuesForField(field, project));
  const totalCases = estimateTotalCases(candidates);
  const overlaps = new Map<string, RuleOverlap>();
  const seen = new Set<string>();
  const visible = new Set<string>();
  const processedMatchSets = new Set<string>();
  const uncoveredExamples: SampleInput[] = [];
  const ordered = [...project.rules].sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
  let checkedCases = 0;
  let coveredCases = 0;
  let truncated = false;

  const visit = (fieldIndex: number, values: SampleInput): void => {
    if (checkedCases >= MAX_CASES) {
      truncated = true;
      return;
    }
    if (fieldIndex < project.fields.length) {
      const field = project.fields[fieldIndex];
      for (const value of candidates[fieldIndex]) {
        values[field.id] = value;
        visit(fieldIndex + 1, values);
        if (truncated) break;
      }
      delete values[field.id];
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
  const complete = !truncated;
  const reachableRuleIds = project.rules.filter((rule) => seen.has(rule.id)).map((rule) => rule.id);
  // 未走完的分区不参与不可达与遮蔽判断：截断时这些结论一律不出具，
  // 未确认命中的规则只能标记为“待确认”，而不是被报成不可达。
  const undeterminedRuleIds = complete ? [] : project.rules.filter((rule) => !seen.has(rule.id)).map((rule) => rule.id);
  const verdicts: AnalysisVerdicts | null = complete
    ? {
        unreachableRuleIds: project.rules.filter((rule) => !seen.has(rule.id)).map((rule) => rule.id),
        shadowedRuleIds: project.rules.filter((rule) => seen.has(rule.id) && !visible.has(rule.id)).map((rule) => rule.id),
        fullyCovered: coveredCases === checkedCases,
        overlapFree: overlaps.size === 0,
      }
    : null;

  return {
    checkedCases,
    totalCases,
    complete,
    coveredCases,
    coveragePercent: checkedCases ? Math.round((coveredCases / checkedCases) * 100) : 0,
    overlaps: [...overlaps.values()],
    reachableRuleIds,
    undeterminedRuleIds,
    uncoveredExamples,
    verdicts,
  };
}

function estimateTotalCases(candidates: ScalarCandidate[][]): number {
  let total = 1;
  for (const values of candidates) {
    const count = Math.max(values.length, 1);
    total = total > CASE_COUNT_LIMIT / count ? CASE_COUNT_LIMIT : total * count;
  }
  return total;
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
