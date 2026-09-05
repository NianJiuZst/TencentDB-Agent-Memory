"""Independently audit and summarize the paired, single-run MiniMax pilot."""
import argparse
import collections
import hashlib
import json
import math
import sqlite3
from pathlib import Path

from analyze_results import cluster_interval
from pilot_support import load, sha, validate_reuse, write
from run_pilot import selected_prefix


def exact_mcnemar(improved, harmed):
    discordant = improved + harmed
    if not discordant:
        return 1.0
    return min(1.0, 2 * sum(math.comb(discordant, k) for k in range(min(improved, harmed) + 1)) / 2**discordant)


def analyze(runtime, evidence, ledger):
    scripts = Path(__file__).parent
    pilot = evidence / 'pilot-30'
    protocol = load(scripts / 'pilot-protocol.json')
    allowed_registrations = {sha(scripts / 'pilot-registration.json')}
    allowed_registrations.update(sha(p) for p in (evidence / 'registrations').glob('pilot-*.json')
                                 if load(p).get('candidateManifestSha256') == sha(evidence / 'pilot-candidate-order.json')
                                 and load(p).get('scriptHashes', {}).get('pilot-protocol.json') == sha(scripts / 'pilot-protocol.json'))
    candidates = load(evidence / 'pilot-candidate-order.json')['selected']
    decisions = {p.parent.name: load(p) for p in (pilot / 'references').glob('*/decision.json')}
    for task, decision in decisions.items():
        reference_path = evidence / decision['reference']
        if sha(reference_path) != decision['referenceSha256']:
            raise RuntimeError('Reference evidence changed: ' + task)
        reference = load(reference_path)
        if reference['instance_id'] != task or decision['eligible'] != bool(reference.get('strictReferencePass')):
            raise RuntimeError('Selection decision disagrees with reference evidence')
        observed = reference.get('observedTests')
        reference_success = False
        if observed:
            case = load(runtime / 'SWEContextBench/cases/SWEContextBench Full' / (task + '.json'))
            f2p, p2p = set(case['FAIL_TO_PASS']), set(case['PASS_TO_PASS'])
            before, after = observed['before'], observed['after']
            reference_success = bool(f2p) and all(before.get(t) in {'FAILED', 'ERROR'} for t in f2p) and all(before.get(t) == 'PASSED' for t in p2p) and all(after.get(t) == 'PASSED' for t in f2p | p2p)
        if reference_success != decision['eligible']:
            raise RuntimeError('Independently recomputed reference eligibility disagrees: ' + task)
    chosen, dispositions = selected_prefix(candidates, decisions)
    selection = load(pilot / 'selection.json')
    if selection['selected'] != chosen or selection['dispositions'] != dispositions:
        raise RuntimeError('Saved selection differs from the fixed metadata/reference-only rule')
    con = sqlite3.connect('file:' + str(ledger.resolve()) + '?mode=ro', uri=True)
    costs = collections.defaultdict(lambda: {'knownUsageCny': 0, 'unknownUsageUpperCny': 0, 'requests': 0,
                                           'promptTokens': 0, 'completionTokens': 0, 'cacheTokens': 0})
    ledger_rows = []
    for call_id, run_id, state, reserved, charged, usage, model in con.execute('SELECT id,run_id,state,reserved,charged,usage,model FROM calls'):
        u = json.loads(usage) if usage else {}
        ledger_rows.append({'id': call_id, 'runId': run_id, 'state': state, 'reservedCny': reserved, 'chargedCny': charged, 'usage': u, 'model': model})
        if state != 'settled':
            continue
        record = costs[run_id]
        record['requests'] += 1
        if 'prompt_tokens' in u and 'completion_tokens' in u:
            inp, output = u['prompt_tokens'], u['completion_tokens']
            cached = min(inp, max(0, u.get('prompt_cache_hit_tokens', (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)) or 0))
            expected = ((inp-cached)*3 + cached*.1 + output*9) / 1e6 if model == 'deepseek-v4-flash' else ((inp-cached)*2.1 + cached*.42 + output*8.4) * (2 if inp > 512000 else 1) / 1e6
            record['knownUsageCny'] += charged
            record['promptTokens'] += inp
            record['completionTokens'] += output
            record['cacheTokens'] += cached
        else:
            expected = reserved
            record['unknownUsageUpperCny'] += charged
        if abs(charged - expected) > 1e-8:
            raise RuntimeError('Independent usage pricing check failed: request ' + str(call_id))
    con.close()
    rows = []
    checked = []
    pair_hashes = {}
    seen_run_ids = set()
    for selected in chosen:
        task = selected['instance_id']
        pair_path = pilot / 'pairs' / task / 'pair.json'
        if not pair_path.exists():
            continue
        pair = load(pair_path)
        if not pair.get('complete') or len(pair['rows']) != 2 or {r['arm'] for r in pair['rows']} != {'none', 'optimized'}:
            raise RuntimeError('Invalid paired artifact')
        if pair['pilotProtocolSha256'] != sha(scripts / 'pilot-protocol.json') or pair['pilotRegistrationSha256'] not in allowed_registrations:
            raise RuntimeError('Pair protocol/registration changed')
        if pair['referenceDecisionSha256'] != sha(pilot / 'references' / task / 'decision.json'):
            raise RuntimeError('Pair reference decision changed')
        frozen = evidence / 'frozen/main' / task
        if sha(frozen / 'freeze.json') != pair['freezeSha256']:
            raise RuntimeError('Frozen descriptor changed')
        descriptor = load(frozen / 'freeze.json')
        for name, expected in descriptor['files'].items():
            if sha(frozen / name) != expected:
                raise RuntimeError('Frozen input changed')
        case_path = runtime / 'SWEContextBench/cases/SWEContextBench Full' / (task + '.json')
        if sha(case_path) != selected['caseSha256']:
            raise RuntimeError('Dataset case changed')
        case = load(case_path)
        for row in pair['rows']:
            if row['runId'] in seen_run_ids or row['model'] != 'MiniMax-M3' or row['replicate'] != 0:
                raise RuntimeError('Duplicated execution or mixed model/repeat')
            seen_run_ids.add(row['runId'])
            out = evidence / row['artifactDirectory']
            for name, field in [('result.json', 'resultSha256'), ('grading/score.json', 'scoreSha256'), ('trajectory.json', 'trajectorySha256')]:
                if sha(out / name) != row[field]:
                    raise RuntimeError('Evidence changed: ' + str(out / name))
            task_input = load(frozen / (row['arm'] + '.json'))
            result = validate_reuse(out, task_input, runtime, protocol['agentLimits'])
            if result['environment_probe']['output'].splitlines()[0] != case['base_commit']:
                raise RuntimeError('Agent initial checkout differs')
            if result.get('future_history_probe', {}).get('output', '').strip():
                raise RuntimeError('Agent environment exposed reachable future commits')
            score = load(out / 'grading/score.json')
            if score.get('adapterVersion') != 'digest-alias-v2' or score.get('scorable') is not True:
                raise RuntimeError('Legacy or unscorable grading')
            before, after = score['observedTests']['before'], score['observedTests']['after']
            f2p, p2p = set(case['FAIL_TO_PASS']), set(case['PASS_TO_PASS'])
            broken = {t for t, s in before.items() if s in {'FAILED', 'ERROR'}}
            passed_before = {t for t, s in before.items() if s == 'PASSED'}
            passed_after = {t for t, s in after.items() if s == 'PASSED'}
            baseline = bool(f2p) and f2p <= broken and p2p <= passed_before
            success = baseline and (f2p | p2p) <= passed_after
            regressions = p2p & passed_before - passed_after
            if not baseline or score['baselineValid'] != baseline or score['strictResolved'] != success or row['strictResolved'] != success:
                raise RuntimeError('Independently recomputed success disagrees')
            if set(score['regressions']) != regressions or row['regressions'] != len(regressions):
                raise RuntimeError('Independently recomputed regression disagrees')
            if sha(out / 'model.patch') != result['patch_sha256'] or sha(out / 'model.patch') != score['patchSha256']:
                raise RuntimeError('Scored patch differs from submitted patch')
            actual = collections.Counter(m.get('extra', {}).get('response', {}).get('model') for m in load(out / 'trajectory.json')['messages'] if isinstance(m.get('extra', {}).get('response'), dict))
            if not actual or set(actual) - {'MiniMax-M3', 'openai/MiniMax-M3'}:
                raise RuntimeError('Actual response model differs: ' + str(actual))
            if row['runId'] not in costs:
                raise RuntimeError('Missing billing evidence')
            row['usage'] = dict(costs[row['runId']])
            row['contextChars'] = len(task_input['context'])
            row['recallMs'] = 0
            row['recalledMemories'] = 0
            row['foreignRepositoryMemories'] = 0
            if row['arm'] == 'optimized':
                recall = load(frozen / 'optimized-recall.json')['rows'][0]
                history = {r['id']: r for r in load(frozen / 'history-audit.json')['records']}
                row['recallMs'] = recall['recallMs']
                row['recalledMemories'] = len(recall['memoryIds'])
                row['foreignRepositoryMemories'] = sum(history[mid]['versionContext']['repositoryId'] != recall['current']['repositoryId'] for mid in recall['memoryIds'])
            rows.append(row)
            checked.append({'runId': row['runId'], 'actualModels': dict(actual), 'strictResolved': success,
                            'f2pPassed': len(f2p & passed_after), 'p2pPassed': len(p2p & passed_after), 'baselineValid': baseline})
        pair_hashes[str(pair_path.relative_to(evidence))] = sha(pair_path)
    tasks = collections.defaultdict(dict)
    for row in rows:
        tasks[row['instance_id']][row['arm']] = row
    n = len(tasks)
    improved = sum(r['optimized']['strictResolved'] and not r['none']['strictResolved'] for r in tasks.values())
    harmed = sum(r['none']['strictResolved'] and not r['optimized']['strictResolved'] for r in tasks.values())
    both = sum(r['none']['strictResolved'] and r['optimized']['strictResolved'] for r in tasks.values())
    differences = [(r['none']['analysisCluster'], int(r['optimized']['strictResolved']) - int(r['none']['strictResolved'])) for r in tasks.values()]
    summary = {'status': 'completed' if len(chosen) == 30 and n == 30 else 'interim',
               'protocol': protocol['id'], 'selectedTasks': len(chosen), 'completedTasks': n, 'executions': len(rows),
               'repairClusters': len({r['analysisCluster'] for r in rows}), 'arms': {},
               'paired': {'improved': improved, 'harmed': harmed, 'bothSucceeded': both, 'bothFailed': n-improved-harmed-both,
                          'delta': cluster_interval(differences), 'exactMcNemarP': exact_mcnemar(improved, harmed)},
               'reusedExecutions': sum(r['reusedPriorExecution'] for r in rows), 'repositories': {},
               'referenceDecisions': len(decisions), 'referenceDispositions': dispositions,
               'pairHashes': pair_hashes, 'rows': rows,
               'validation': {'status': 'passed', 'executionsChecked': len(checked), 'independentVerdicts': checked},
               'usage': {'pilotKnownUsageCny': sum(r['usage']['knownUsageCny'] for r in rows),
                         'pilotUnknownUsageUpperCny': sum(r['usage']['unknownUsageUpperCny'] for r in rows),
                         'allWorkChargedCny': sum(r['chargedCny'] for r in ledger_rows),
                         'allWorkUnknownUsageUpperCny': sum(r['chargedCny'] for r in ledger_rows if not r['usage']),
                         'allWorkPendingReservationsCny': sum(r['reservedCny'] for r in ledger_rows if r['state'] == 'pending'),
                         'callRecords': ledger_rows}}
    for arm in ['none', 'optimized']:
        selected_rows = [r for r in rows if r['arm'] == arm]
        summary['arms'][arm] = {'successes': sum(r['strictResolved'] for r in selected_rows),
                                'successRate': sum(r['strictResolved'] for r in selected_rows)/n if n else None,
                                'regressionRuns': sum(r['regressions'] > 0 for r in selected_rows),
                                'meanAgentSeconds': sum(r['agentSeconds'] for r in selected_rows)/n if n else None,
                                'contextCoverage': sum(r['contextChars'] > 0 for r in selected_rows),
                                'totalContextChars': sum(r['contextChars'] for r in selected_rows),
                                'foreignRepositoryMemories': sum(r['foreignRepositoryMemories'] for r in selected_rows),
                                'totalRecallMs': sum(r['recallMs'] for r in selected_rows),
                                'exitStatuses': dict(collections.Counter(r['exitStatus'] for r in selected_rows)),
                                'usage': {k: sum(r['usage'][k] for r in selected_rows) for k in ['knownUsageCny', 'unknownUsageUpperCny', 'requests', 'promptTokens', 'completionTokens', 'cacheTokens']}}
    for repo in sorted({r['repo'] for r in rows}):
        group = [r for r in tasks.values() if r['none']['repo'] == repo]
        summary['repositories'][repo] = {'tasks': len(group), 'noneSuccesses': sum(r['none']['strictResolved'] for r in group),
                                       'optimizedSuccesses': sum(r['optimized']['strictResolved'] for r in group)}
    return summary


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    a = p.parse_args()
    summary = analyze(a.runtime.resolve(), a.evidence.resolve(), a.ledger.resolve())
    write(a.evidence / 'pilot-30/analysis.json', summary)
    print(json.dumps({k: summary[k] for k in ['status', 'completedTasks', 'executions', 'reusedExecutions', 'paired']}))
