import type { AnalysisCoverage, BusinessRule, RuleAnalysis, RuleProject, RuleVersion, SampleInput } from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { InspectionViewModel } from './inspectionViewModel';

interface InspectionViewProps { state: WorkspaceState; viewModel: InspectionViewModel; onOpenRule: (ruleId: string) => void }

export function InspectionView({ state, viewModel, onOpenRule }: InspectionViewProps) {
  const project = state.project;
  const analysis = state.analysis;
  const isChecking = state.checkStatus === 'checking' || state.checkStatus === 'scheduled';
  const rules = project?.rules ?? [];
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  return (
    <section className="module-page inspection-page">
      <div className="page-heading">
        <div><span className="eyebrow">模块 04 / 完整性验证</span><h1>检查与版本</h1><p>定位冲突、遮蔽与遗漏，再保存或冻结一个可追溯版本。</p></div>
        <div className="button-row">{isChecking ? <button className="button button-quiet" onClick={() => viewModel.cancel()}>取消检查</button> : <button className="button button-primary" disabled={!rules.length || state.validationIssues.length > 0} onClick={() => void viewModel.check()}><span>⌕</span> 运行一致性检查</button>}</div>
      </div>

      {state.validationIssues.length > 0 && <div className="validation-banner"><strong>规则暂时无法检查</strong><span>{state.validationIssues[0].message}</span><button className="text-button" onClick={() => state.validationIssues[0].ruleId ? onOpenRule(state.validationIssues[0].ruleId) : undefined}>{state.validationIssues[0].ruleId ? '打开相关规则 →' : '修复项目定义'}</button></div>}
      {state.checkStatus === 'error' && !state.validationIssues.length && <div className="error-banner">检查失败：{state.notice}</div>}
      {!analysis && !state.validationIssues.length && <div className="loading-analysis card-surface"><div className={isChecking ? 'spinner' : 'analysis-orb'}>{isChecking ? '' : '✳'}</div><div><strong>{isChecking ? '正在分析条件空间' : '准备检查规则集合'}</strong><p>{isChecking ? '计算在独立工作线程中运行，可随时取消。' : '点击“运行一致性检查”查看覆盖与规则关系。'}</p></div>{state.checkStatus === 'success' && <span className="success-mark">✓</span>}</div>}
      {analysis && <AnalysisPanel analysis={analysis} project={project as RuleProject} byId={byId} onOpenRule={onOpenRule} />}

      <section className="versions-section">
        <div className="versions-heading"><div><span className="eyebrow">CHANGE HISTORY</span><h2>规则版本</h2><p>保存检查前后的结构快照。冻结后，当前规则只能通过复制版本继续修改。</p></div><div className="button-row"><button className="button button-subtle" disabled={!rules.length} onClick={() => viewModel.saveVersion()}>＋ 保存版本</button><button className="button button-outline" disabled={!rules.length || Boolean(project?.frozenVersionId)} onClick={() => viewModel.freeze()}>◈ 冻结当前</button></div></div>
        {project?.versions.length ? <div className="version-list">{project.versions.map((version, index) => <VersionRow key={version.id} version={version} index={index} current={project.frozenVersionId === version.id} onContinue={() => viewModel.continueFrom(version.id)} onCopy={() => viewModel.copyToProject(version.id)} />)}</div> : <div className="version-empty card-surface"><span>◷</span><p>还没有保存版本。规则结构和检查结果确认后，可以创建第一个快照。</p></div>}
      </section>
    </section>
  );
}

interface AnalysisPanelProps { analysis: RuleAnalysis; project: RuleProject; byId: Map<string, BusinessRule>; onOpenRule: (ruleId: string) => void }

function ScopeTag({ scope, completeLabel = '完整结论', partialLabel = '部分推断' }: { scope: RuleAnalysis['unreachableScope']; completeLabel?: string; partialLabel?: string }) {
  return scope === 'complete'
    ? <span className="scope-tag scope-complete">✓ {completeLabel}</span>
    : <span className="scope-tag scope-partial">◔ {partialLabel}</span>;
}

function ScopeBanner({ coverage }: { coverage: AnalysisCoverage }) {
  if (coverage.scope === 'complete') {
    return <div className="scope-banner scope-complete-banner"><span className="scope-banner-icon">✓</span><div><strong>完整结论：全部 {formatCount(coverage.checkedCases)} 个逻辑分区均已枚举完毕</strong><p>下列覆盖、不可达与遮蔽结论覆盖整个合法输入空间，可直接据此调整规则。</p></div></div>;
  }
  const enumeratedProgress = coverage.totalCases === undefined
    ? undefined
    : Math.round((coverage.checkedCases / coverage.totalCases) * 100);
  const progressWidth = Math.max(2, enumeratedProgress ?? 2);
  return (
    <div className="scope-banner scope-partial-banner">
      <span className="scope-banner-icon">◔</span>
      <div>
        <strong>本次为部分推断：仅完整枚举了 {formatCount(coverage.checkedCases)} / {formatCount(coverage.totalCases)} 个逻辑分区{enumeratedProgress !== undefined ? `（${enumeratedProgress}%）` : ''}</strong>
        <p>未走完的区域不参与“不可达规则”和“未覆盖输入”的判断。下列结论已逐条标注可信范围；标为“部分推断”的条目不能作为调整优先级或条件的依据。</p>
        <div className="scope-progress"><span style={{ width: `${progressWidth}%` }} /></div>
      </div>
    </div>
  );
}

function AnalysisPanel({ analysis, project, byId, onOpenRule }: AnalysisPanelProps) {
  const conflictCount = analysis.overlaps.filter((overlap) => overlap.conflict).length;
  const overlapCount = analysis.overlaps.length;
  const { coverage } = analysis;
  const hitCount = project.rules.length - analysis.unreachableRuleIds.length - analysis.unconfirmedRuleIds.length;
  const coverageTone = coverage.scope === 'partial' ? 'blue' : analysis.uncoveredExamples.length ? 'amber' : 'green';
  const hitTone = coverage.scope === 'partial' ? (analysis.unreachableRuleIds.length ? 'amber' : 'blue') : analysis.unreachableRuleIds.length ? 'amber' : 'green';
  const enumeratedPercent = coverage.totalCases === undefined
    ? undefined
    : Math.round((coverage.checkedCases / coverage.totalCases) * 100);
  const coverageValue = coverage.scope === 'complete'
    ? `${coverage.percent}%`
    : enumeratedPercent === undefined ? '—' : `${enumeratedPercent}%`;
  const coverageDetail = coverage.scope === 'complete'
    ? `${formatCount(coverage.coveredCases)} / ${formatCount(coverage.checkedCases)} 个逻辑分区`
    : `数字为枚举进度；已分析分区内覆盖率 ${coverage.percent}%，不代表全局（共 ${formatCount(coverage.totalCases)} 个分区）`;
  const hitDetail = coverage.scope === 'complete'
    ? `${analysis.unreachableRuleIds.length} 条不可达 · ${analysis.shadowedRuleIds.length} 条被遮蔽`
    : `已命中 ${hitCount} 条 · 已证不可达 ${analysis.unreachableRuleIds.length} 条 · 待确认 ${analysis.unconfirmedRuleIds.length} 条`;
  return <>
    <ScopeBanner coverage={coverage} />
    <div className="analysis-summary">
      <MetricCard label="输入空间覆盖" value={coverageValue} detail={coverageDetail} icon="◌" tone={coverageTone} scope={coverage.scope} />
      <MetricCard label="规则关系" value={`${overlapCount}`} detail={`${conflictCount} 个同优先级结果冲突`} icon="⇄" tone={conflictCount ? 'red' : 'blue'} scope={analysis.overlapsScope} />
      <MetricCard label="可命中规则" value={`${hitCount} / ${project.rules.length}`} detail={hitDetail} icon="⌁" tone={hitTone} scope={analysis.unreachableScope} />
    </div>
    <div className="analysis-grid">
      <section className="analysis-card card-surface">
        <header className="analysis-card-heading"><span className="analysis-icon conflict-icon">⇄</span><div><h2>重叠与冲突</h2><p>同一输入命中多条规则；同优先级且结果不同会产生冲突。</p></div><div className="analysis-heading-side"><ScopeTag scope={analysis.overlapsScope} completeLabel="全空间" partialLabel="已分析区域" /><b>{overlapCount}</b></div></header>
        {overlapCount ? <div className="finding-list">{analysis.overlaps.slice(0, 6).map((overlap) => <div className="finding-row" key={`${overlap.ruleAId}-${overlap.ruleBId}`}><div className="finding-copy"><div><button className="inline-rule-link" onClick={() => onOpenRule(overlap.ruleAId)}>{byId.get(overlap.ruleAId)?.name ?? overlap.ruleAId}</button><span className="finding-join">↔</span><button className="inline-rule-link" onClick={() => onOpenRule(overlap.ruleBId)}>{byId.get(overlap.ruleBId)?.name ?? overlap.ruleBId}</button></div><span>{formatWitness(overlap.witness, project)}</span></div><span className={overlap.conflict ? 'severity-tag severity-danger' : 'severity-tag severity-warn'}>{overlap.conflict ? '结果冲突' : '条件重叠'}</span></div>)}</div>
          : <SuccessEmpty text={analysis.overlapsScope === 'complete' ? '没有发现规则重叠' : '已分析分区内没有发现重叠；其余区域尚未检查'} partial={analysis.overlapsScope === 'partial'} />}
      </section>

      <section className="analysis-card card-surface">
        <header className="analysis-card-heading"><span className="analysis-icon coverage-icon">◔</span><div><h2>未覆盖输入</h2><p>没有任何规则命中的合法输入组合。</p></div><div className="analysis-heading-side"><ScopeTag scope={analysis.uncoveredScope} completeLabel="全空间" partialLabel="已分析区域" /><b>{analysis.uncoveredExamples.length ? '有' : '无'}</b></div></header>
        {analysis.uncoveredExamples.length ? <div className="finding-list">{analysis.uncoveredExamples.map((example, index) => <div className="uncovered-row" key={index}><span className="uncovered-index">0{index + 1}</span><div><strong>未命中输入组合</strong><span>{formatWitness(example, project)}</span></div><span className="severity-tag severity-warn">未覆盖</span></div>)}</div>
          : analysis.uncoveredScope === 'complete'
            ? <SuccessEmpty text="输入空间已完整覆盖" />
            : <PendingEmpty text={`已分析的 ${formatCount(coverage.checkedCases)} 个分区均有规则命中`} note={`还有 ${formatCount(diffCases(coverage.totalCases, coverage.checkedCases))} 个分区未走完，不能据此确认无遗漏`} />}
      </section>

      <section className="analysis-card card-surface">
        <header className="analysis-card-heading"><span className="analysis-icon unreachable-icon">⊘</span><div><h2>不可达规则</h2><p>在字段合法取值范围内，条件组合从未成立。</p></div><div className="analysis-heading-side"><ScopeTag scope={analysis.unreachableScope} /><b>{analysis.unreachableRuleIds.length}</b></div></header>
        {analysis.unreachableRuleIds.length ? <div className="compact-findings">{analysis.unreachableRuleIds.map((id) => <button className="compact-rule" key={id} onClick={() => onOpenRule(id)}><span>⌁</span><strong>{byId.get(id)?.name ?? id}</strong><i>编辑条件 →</i></button>)}</div>
          : analysis.unreachableScope === 'complete'
            ? <SuccessEmpty text="所有规则都存在可命中输入" />
            : <PendingEmpty text="已分析区域内没有可证明不可达的规则" note="未检查区域的情况见下方“待确认”列表" />}
        {analysis.unconfirmedRuleIds.length > 0 && <div className="unconfirmed-block"><div className="unconfirmed-heading"><span>◌</span><strong>{analysis.unconfirmedRuleIds.length} 条待确认</strong><em>未检查区域可能命中，不能报为不可达</em></div>{analysis.unconfirmedRuleIds.map((id) => <button className="compact-rule pending-rule" key={id} onClick={() => onOpenRule(id)}><span>?</span><strong>{byId.get(id)?.name ?? id}</strong><i>缩小输入空间后复查 →</i></button>)}</div>}
      </section>

      <section className="analysis-card card-surface">
        <header className="analysis-card-heading"><span className="analysis-icon hidden-icon">◉</span><div><h2>被完全遮蔽</h2><p>存在命中输入，但优先级路径上总有更早规则先命中。</p></div><div className="analysis-heading-side"><ScopeTag scope={analysis.shadowedScope} /><b>{analysis.shadowedRuleIds.length}</b></div></header>
        {analysis.shadowedRuleIds.length ? <div className="compact-findings">{analysis.shadowedRuleIds.map((id) => <button className="compact-rule" key={id} onClick={() => onOpenRule(id)}><span>◉</span><strong>{byId.get(id)?.name ?? id}</strong><i>调整优先级 →</i></button>)}</div>
          : analysis.shadowedScope === 'complete'
            ? <SuccessEmpty text="没有被完全遮蔽的规则" />
            : <PendingEmpty text="遮蔽结论需要完整枚举后才能成立" note={`已分析区域中有 ${analysis.shadowedCandidateIds.length} 条规则从未成为最高优先级，但未检查区域可能让它们生效，请勿据此调整优先级`} />}
        {analysis.shadowedScope === 'partial' && analysis.shadowedCandidateIds.length > 0 && <div className="unconfirmed-block"><div className="unconfirmed-heading"><span>◔</span><strong>{analysis.shadowedCandidateIds.length} 条观察中</strong><em>仅代表已分析区域，不是最终结论</em></div>{analysis.shadowedCandidateIds.map((id) => <button className="compact-rule pending-rule" key={id} onClick={() => onOpenRule(id)}><span>◉</span><strong>{byId.get(id)?.name ?? id}</strong><i>完整枚举后确认 →</i></button>)}</div>}
      </section>
    </div>
  </>;
}

function MetricCard({ label, value, detail, icon, tone, scope }: { label: string; value: string; detail: string; icon: string; tone: string; scope: RuleAnalysis['coverage']['scope'] }) {
  return <article className={`metric-card card-surface metric-${tone}`}><span className="metric-icon">{icon}</span><span className="metric-label">{label}{scope === 'partial' && <em className="metric-scope">部分推断</em>}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></article>;
}

function SuccessEmpty({ text, partial = false }: { text: string; partial?: boolean }) { return <div className={`success-empty${partial ? ' success-empty-muted' : ''}`}><span>{partial ? '◔' : '✓'}</span>{text}</div>; }

function PendingEmpty({ text, note }: { text: string; note: string }) {
  return <div className="pending-empty"><span>◌</span><div><strong>{text}</strong><p>{note}</p></div></div>;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '超过计数上限' : value.toLocaleString('zh-CN');
}

function diffCases(total: number | undefined, checked: number): number | undefined {
  if (total === undefined) return undefined;
  return Math.max(0, total - checked);
}

function formatWitness(values: SampleInput, project: RuleProject): string {
  return project.fields.map((field) => {
    const value = values[field.id];
    return `${field.name} ${typeof value === 'boolean' ? value ? '是' : '否' : value ?? '—'}`;
  }).join(' · ');
}

function VersionRow({ version, index, current, onContinue, onCopy }: { version: RuleVersion; index: number; current: boolean; onContinue: () => void; onCopy: () => void }) {
  return <article className={`version-row${current ? ' version-current' : ''}`}><span className="version-number">{String(index + 1).padStart(2, '0')}</span><div className="version-copy"><strong>{version.name}{current && <em>当前冻结</em>}</strong><span>{formatDate(version.savedAt)} · {version.fields.length} 字段 · {version.rules.length} 条规则</span></div><div className="version-actions">{!version.frozen && <button className="text-button" onClick={onContinue}>从此版本继续</button>}<button className="text-button" onClick={onCopy}>复制为项目</button><span className={version.frozen ? 'version-state frozen' : 'version-state'}>{version.frozen ? '◈ 已冻结' : '◷ 快照'}</span></div></article>;
}

function formatDate(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time);
}
