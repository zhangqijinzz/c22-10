import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountAtLeast = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });

describe('field and project validation', () => {
  it('accepts inclusive boundary ranges and rejects reversed or empty definitions', () => {
    expect(validateField({ ...amount, min: 5, max: 5 })).toEqual([]);
    expect(validateField({ ...amount, min: 11, max: 10 }).map((issue) => issue.code)).toContain('number-range-order');
    expect(validateField({ id: 'tier', name: '等级', type: 'enum', enumValues: [] }).map((issue) => issue.code)).toContain('enum-values-required');
  });

  it('checks enum and boolean predicate types without depending on React', () => {
    const rules = [
      makeRule('gold', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }),
      makeRule('active', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
    ];
    expect(validateProject(project(rules))).toEqual([]);
    expect(evaluateSample(project(rules), { amount: 12, tier: 'gold', active: true }).matchedRules.map((rule) => rule.id)).toEqual(['gold', 'active']);
  });
});

describe('rule consistency analysis', () => {
  it('finds partial overlap, same-priority conflicts, lower-priority shadowing, unreachable rules, and gaps', () => {
    const rules = [
      makeRule('base', amountAtLeast(500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', amountAtLeast(700), 20, 'different'),
      makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
      makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
      makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
    ];
    const analysis = analyzeRules(project(rules));
    expect(analysis.complete).toBe(true);
    expect(analysis.totalCases).toBe(analysis.checkedCases);
    expect(analysis.undeterminedRuleIds).toEqual([]);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.verdicts?.unreachableRuleIds).toContain('impossible');
    expect(analysis.verdicts?.shadowedRuleIds).toContain('hidden');
    expect(analysis.verdicts?.fullyCovered).toBe(false);
    expect(analysis.verdicts?.overlapFree).toBe(false);
    expect(analysis.reachableRuleIds).toEqual(expect.arrayContaining(['base', 'partial', 'conflict', 'no-overlap']));
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.checkedCases).toBeGreaterThan(0);
  });

  it('reports full-space verdicts only when every combination was visited', () => {
    const rules = [
      makeRule('on', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
      makeRule('off', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isFalse', value: false }] }),
    ];
    const analysis = analyzeRules(project(rules, [active]));
    expect(analysis.complete).toBe(true);
    expect(analysis.verdicts).toEqual({ unreachableRuleIds: [], shadowedRuleIds: [], fullyCovered: true, overlapFree: true });
    expect(analysis.coveragePercent).toBe(100);
  });

  it('withholds unreachable and shadowed verdicts when the input space is truncated', () => {
    const values = Array.from({ length: 50 }, (_, index) => `v${String(index).padStart(2, '0')}`);
    const fields: RuleField[] = [
      { id: 'first', name: '第一维', type: 'enum', enumValues: values },
      { id: 'second', name: '第二维', type: 'enum', enumValues: values },
      { id: 'third', name: '第三维', type: 'enum', enumValues: values },
    ];
    const matchFirst = (value: string): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'first', operator: 'eq', value }] });
    const rules = [
      makeRule('early', matchFirst('v00'), 10, 'visited region'),
      makeRule('late', matchFirst('v49'), 10, 'beyond the truncation cut'),
    ];
    const analysis = analyzeRules(project(rules, fields));
    expect(analysis.complete).toBe(false);
    expect(analysis.totalCases).toBe(125_000);
    expect(analysis.checkedCases).toBeLessThan(analysis.totalCases);
    // 未走完的分区不参与不可达判断：不出具任何全空间结论
    expect(analysis.verdicts).toBeNull();
    // 命中输入落在未分析分区的规则只能标记为待确认，而不是被报成不可达
    expect(analysis.reachableRuleIds).toContain('early');
    expect(analysis.reachableRuleIds).not.toContain('late');
    expect(analysis.undeterminedRuleIds).toContain('late');
    expect(analysis.undeterminedRuleIds).not.toContain('early');
    // 已确认的未覆盖样例仍然报告，但覆盖率只描述已分析分区
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.coveragePercent).toBeLessThan(100);
  });

  it('evaluates OR groups and validates missing sample inputs precisely', () => {
    const rule = makeRule('either', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
      { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
    ] });
    const result = evaluateSample(project([rule]), { amount: 10, tier: 'basic', active: true });
    expect(result.valid).toBe(true);
    expect(result.winner?.id).toBe('either');
    const missing = evaluateSample(project([rule]), { amount: 10, tier: 'gold' });
    expect(missing.errors).toEqual(['请填写“启用”']);
  });
});
