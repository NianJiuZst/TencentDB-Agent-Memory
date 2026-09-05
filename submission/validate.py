"""Recompute recall evidence from raw IDs. Standard-library only; no model calls."""
import hashlib
import json
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
for name in ['all-tests', 'benchmark-tests']:
    test = read(f'{name}.json')
    checks[name] = test['success'] and test['numFailedTests'] == 0
report = {'schemaVersion': 1, 'checks': checks, 'passed': all(checks.values()), 'groups': groups,
          'inputHashes': {f: hashlib.sha256((EVIDENCE/f).read_bytes()).hexdigest() for f in ['global.json','previous-strict.json','optimized.json','historical-revalidation.json']}}
(EVIDENCE / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'passed': report['passed'], 'checks': checks}, indent=2))
raise SystemExit(0 if report['passed'] else 1)
