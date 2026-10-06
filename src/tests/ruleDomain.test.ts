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
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    expect(analysis.shadowedRuleIds).toContain('hidden');
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.coverage.checkedCases).toBeGreaterThan(0);
    expect(analysis.complete).toBe(true);
    expect(analysis.coverage.scope).toBe('complete');
  });

  it('reports complete analysis for a fully enumerated input space', () => {
    const rule = makeRule('gold-only', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
    ] });
    const analysis = analyzeRules(project([rule]));
    expect(analysis.complete).toBe(true);
    expect(analysis.unreachableScope).toBe('complete');
    expect(analysis.unconfirmedRuleIds).toEqual([]);
    expect(analysis.shadowedCandidateIds).toEqual([]);
  });

  it('never reports unproven rules as unreachable when enumeration is truncated', () => {
    // 6 个各 8 值的枚举字段 => 262,144 个组合，超过单次枚举上限。
    const bigFields: RuleField[] = Array.from({ length: 6 }, (_unused, index) => ({
      id: `dim-${index}`, name: `维度 ${index}`, type: 'enum' as const, enumValues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    }));
    // 该规则只在“最稀有”的组合上成立：截断前缀（外层字段取首个值）永远看不到，
    // 旧逻辑会把它误报为不可达；新逻辑必须把它放进待确认，而不是不可达。
    const lateRule = makeRule('late-hit', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'dim-0', operator: 'eq', value: 'h' },
      { kind: 'predicate', fieldId: 'dim-1', operator: 'eq', value: 'h' },
    ] }, 10, 'late');
    // 自相矛盾的规则（同字段等于两个互斥值）在任何输入下都不可能命中，
    // 即使只看部分空间也可证明。
    const impossibleRule = makeRule('impossible', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'dim-2', operator: 'eq', value: 'a' },
      { kind: 'predicate', fieldId: 'dim-2', operator: 'eq', value: 'b' },
    ] }, 10, 'impossible');
    const analysis = analyzeRules(project([lateRule, impossibleRule], bigFields));
    expect(analysis.complete).toBe(false);
    expect(analysis.coverage.scope).toBe('partial');
    expect(analysis.coverage.totalCases).toBe(8 ** 6);
    expect(analysis.coverage.checkedCases).toBeLessThan(8 ** 6);
    expect(analysis.unreachableRuleIds).not.toContain('late-hit');
    expect(analysis.unconfirmedRuleIds).toContain('late-hit');
    // 互斥条件与未访问区域无关，仍然可以证明不可达。
    expect(analysis.unreachableRuleIds).toContain('impossible');
    // 部分枚举时不得给出任何确定的遮蔽结论。
    expect(analysis.shadowedRuleIds).toEqual([]);
  });

  it('still reports observed overlaps and uncovered inputs during partial enumeration', () => {
    const bigFields: RuleField[] = Array.from({ length: 6 }, (_unused, index) => ({
      id: `dim-${index}`, name: `维度 ${index}`, type: 'enum' as const, enumValues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    }));
    const conflictA = makeRule('conflict-a', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'dim-5', operator: 'eq', value: 'a' },
    ] }, 10, 'result-a');
    const conflictB = makeRule('conflict-b', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'dim-5', operator: 'eq', value: 'a' },
    ] }, 10, 'result-b');
    const analysis = analyzeRules(project([conflictA, conflictB], bigFields));
    expect(analysis.complete).toBe(false);
    expect(analysis.overlaps.some((overlap) => overlap.conflict)).toBe(true);
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    // 但不能下“完整覆盖”或“无不可达”的结论。
    expect(analysis.uncoveredScope).toBe('partial');
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
