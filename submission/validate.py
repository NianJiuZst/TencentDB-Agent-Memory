"""Recompute recall evidence from raw IDs. Standard-library only; no model calls."""
import hashlib
import json
import re
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / 'evidence'

def read(name):
    return json.loads((EVIDENCE / name).read_text())

arms = {name: read(file) for name, file in [('global', 'global.json'), ('previous', 'previous-strict.json'), ('optimized', 'optimized.json')]}
checks = {}
groups = {}
reference = arms['global']['rows']
for name, data in arms.items():
    rows = data['rows']
    checks[f'{name}_204_unique_cases'] = len(rows) == len({r['caseId'] for r in rows}) == 204
    checks[f'{name}_matched_cases_and_oracles'] = [(r['caseId'], r['expected']) for r in rows] == [(r['caseId'], r['expected']) for r in reference]
    checks[f'{name}_item_budget'] = all(len(r['actual']) <= r['k'] for r in rows)
    checks[f'{name}_raw_metrics'] = all(r['exact'] == (set(r['actual']) == set(r['expected'])) and r['contaminated'] == bool(set(r['actual']) - set(r['expected'])) for r in rows)
    checks[f'{name}_no_fallbacks'] = not any(r['fallback'] for r in rows)
    checks[f'{name}_protocol'] = data['protocolSha256'] == hashlib.sha256((ROOT.parent / 'MemoryCore/benchmarks/competition/protocol.json').read_bytes()).hexdigest()
    slices = {}
    for label, selected in [('all', rows), ('within_pool', [r for r in rows if r['slice'] in ('within_top_k', 'beyond_top_k')]),
                            ('beyond_top_k', [r for r in rows if r['slice'] == 'beyond_top_k']),
                            ('outside_pool', [r for r in rows if r['slice'] == 'outside_pool']),
                            ('missing_context', [r for r in rows if r['slice'] == 'missing_context'])]:
        recalls = [len(set(r['actual']) & set(r['expected'])) / len(r['expected']) for r in selected if r['expected']]
        times = sorted(r['elapsedMs'] for r in selected)
        import math
        slices[label] = {'cases': len(selected), 'exactCount': sum(set(r['actual']) == set(r['expected']) for r in selected),
                         'expectedRecall': mean(recalls) if recalls else None,
                         'contaminatedCount': sum(bool(set(r['actual']) - set(r['expected'])) for r in selected),
                         'meanTokens': mean(r['injectedTokens'] for r in selected), 'meanItems': mean(len(r['actual']) for r in selected),
                         'p50Ms': times[math.ceil(len(times)*.50)-1], 'p95Ms': times[math.ceil(len(times)*.95)-1]}
    groups[name] = slices
best = groups['optimized']
checks['optimized_within_pool_exact'] = best['within_pool']['exactCount'] == 180
checks['optimized_zero_contamination'] = best['all']['contaminatedCount'] == 0
checks['optimized_missing_abstains'] = best['missing_context']['exactCount'] == 12
checks['outside_pool_failure_disclosed'] = best['outside_pool']['exactCount'] == 0
historical = read('historical-revalidation.json')
checks['historical_raw_verdicts_recomputed'] = historical['status'] == 'passed' and historical['mismatchCount'] == 0
replay = json.loads((EVIDENCE / 'replayed-context/context-manifest.json').read_text())
checks['fresh_110_case_production_replay'] = replay['validation']['passed']
final_replay = read('final-context-replay/context-manifest.json')
frozen_contexts = {c['hash']: c for c in replay['contexts']}
final_contexts = {c['hash']: c for c in final_replay['contexts']}
final_cases = {c['caseId']: c for c in final_replay['cases']}
equivalence_rows = []
def remove_activity_timestamps(messages):
    return [{**m, 'content': re.sub(r'\(活动时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)', '(活动时间: <run-time>)', m['content'])} for m in messages]
for case in replay['cases']:
    for arm, frozen_hash in case['arms'].items():
        final_hash = final_cases[case['caseId']]['arms'][arm]
        before_messages = frozen_contexts[frozen_hash]['messages']
        after_messages = final_contexts[final_hash]['messages']
        equivalence_rows.append({'caseId': case['caseId'], 'arm': arm,
                                 'frozenHash': frozen_hash, 'finalHash': final_hash,
                                 'exact': before_messages == after_messages,
                                 'activityTimestampOnly': remove_activity_timestamps(before_messages) == remove_activity_timestamps(after_messages)})
checks['final_code_replay_valid'] = final_replay['validation']['passed']
checks['optimized_110_model_inputs_byte_identical'] = all(r['exact'] for r in equivalence_rows if r['arm'] == 'version_aware_multistate')
checks['all_330_inputs_equal_except_activity_timestamps'] = len(equivalence_rows) == 330 and all(r['activityTimestampOnly'] for r in equivalence_rows)
equivalence = {'finalSourceRevision': final_replay['preScoreSourceRevision'],
               'exactCount': sum(r['exact'] for r in equivalence_rows), 'totalCount': len(equivalence_rows),
               'note': 'No model messages were edited. A later production replay has newer wall-clock activity labels in 110 control-arm contexts; all optimized messages match byte-for-byte.',
               'rows': equivalence_rows}
(EVIDENCE / 'context-equivalence.json').write_text(json.dumps(equivalence, ensure_ascii=False, indent=2)+'\n')
model_validation = read('model-rerun/independent-validation.json')
models = read('model-rerun/summary.json')
budget = read('model-rerun/budget-ledger.json')
checks['fresh_500_verdicts_independently_recomputed'] = model_validation['status'] == 'passed' and model_validation['mismatchCount'] == 0 and model_validation['counts']['rawVerdictsRescored'] == 500
checks['model_validation_hashes_current'] = all(model_validation['inputs'][key] == hashlib.sha256((EVIDENCE / file).read_bytes()).hexdigest() for key, file in [('contextSha256','replayed-context/context-manifest.json'),('evaluationsSha256','model-rerun/evaluations.jsonl'),('summarySha256','model-rerun/summary.json')])
checks['fresh_model_run_complete'] = models['status'] == 'completed' and models['operationalIntegrity']['complete']
checks['budget_reconciles_and_within_200_cny'] = abs(sum(e['chargedUpperCny'] for e in budget['entries']) - budget['chargedUpperCny']) < 1e-8 and budget['chargedUpperCny'] <= budget['capCny'] == 200 and abs(budget['reservedUpperCny']) < 1e-8
checks['fresh_1000_successful_api_calls'] = len(budget['entries']) == 1000 and all(e['status'] == 200 for e in budget['entries'])
checks['budget_recovery_without_api_calls'] = read('budget-recovery.json')['passed'] and read('budget-recovery.json')['apiCalls'] == 0
for name in ['all-tests', 'benchmark-tests']:
    test = read(f'{name}.json')
    checks[name] = test['success'] and test['numFailedTests'] == 0
report = {'schemaVersion': 1, 'checks': checks, 'passed': all(checks.values()), 'groups': groups,
          'inputHashes': {f: hashlib.sha256((EVIDENCE/f).read_bytes()).hexdigest() for f in ['global.json','previous-strict.json','optimized.json','historical-revalidation.json','model-rerun/summary.json','model-rerun/evaluations.jsonl','model-rerun/independent-validation.json','model-rerun/budget-ledger.json']}}
(EVIDENCE / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'passed': report['passed'], 'checks': checks}, indent=2))
raise SystemExit(0 if report['passed'] else 1)
