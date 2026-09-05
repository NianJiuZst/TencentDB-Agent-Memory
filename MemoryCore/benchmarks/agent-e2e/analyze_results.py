"""Recompute task-level paired estimates from complete, executable matrices."""
import argparse
import collections
import gzip
import hashlib
import json
import random
import sqlite3
from pathlib import Path

ARMS = ['none', 'global', 'previous', 'optimized']


def load(path):
    if path.exists():
        return json.loads(path.read_text())
    return json.loads(gzip.decompress(Path(str(path) + '.gz').read_bytes()))


def percentile(values, q):
    values = sorted(values)
    pos = (len(values) - 1) * q
    i = int(pos)
    return values[i] + (values[min(i + 1, len(values) - 1)] - values[i]) * (pos - i)


def cluster_interval(items, draws=5000):
    """Items are (repair cluster, task-level value); keep all variants together."""
    grouped = collections.defaultdict(list)
    for key, value in items:
        grouped[key].append(value)
    if not items:
        return {'mean': None, 'lower': None, 'upper': None, 'clusters': 0}
    groups = list(grouped.values())
    rng = random.Random(20260905)
    stats = [(sum(values), len(values)) for values in groups]
    bootstrap = []
    for _ in range(draws):
        sampled = [stats[rng.randrange(len(stats))] for _ in stats]
        bootstrap.append(sum(x[0] for x in sampled) / sum(x[1] for x in sampled))
    return {'mean': sum(v for _, v in items) / len(items),
            'lower': percentile(bootstrap, .025), 'upper': percentile(bootstrap, .975),
            'clusters': len(groups), 'tasks': len(items), 'draws': draws,
            'interpretation': 'Descriptive only: fewer than 10 repair clusters' if len(groups) < 10 else 'Repair-cluster percentile bootstrap'}


def summarize(rows):
    task_rows = collections.defaultdict(lambda: collections.defaultdict(list))
    for row in rows:
        task_rows[row['instance_id']][row['arm']].append(row)
    tasks = {}
    for tid, arms in task_rows.items():
        if set(arms) != set(ARMS) or any({r['replicate'] for r in arms[a]} != {0, 1, 2} or len(arms[a]) != 3 for a in ARMS):
            raise ValueError('Incomplete or duplicated task matrix: ' + tid)
        first = arms['none'][0]
        tasks[tid] = {'repo': first['repo'], 'cluster': first['analysisCluster'], 'arms': {}}
        for arm, runs in arms.items():
            tasks[tid]['arms'][arm] = {
                'passAt1': sum(bool(r['strictResolved']) for r in runs) / 3,
                'officialResolved': sum(bool(r['officialResolved']) for r in runs) / 3,
                'observedPassWithin3': int(any(r['strictResolved'] for r in runs)),
                'regressionRunRate': sum(r['regressions'] > 0 for r in runs) / 3,
                'meanModelCny': sum(r['peakPriceCny'] for r in runs) / 3,
                'meanAgentSeconds': sum(r['agentSeconds'] for r in runs) / 3,
                'meanSourceInspectionSeconds': sum(r.get('sourceInspectionSeconds', 0) for r in runs) / 3,
                'meanRecallSeconds': sum(r.get('recallSeconds', 0) for r in runs) / 3,
                'meanContextChars': sum(r.get('contextChars', 0) for r in runs) / 3,
                'memoryCoverage': sum(r.get('recalledMemories', 0) > 0 for r in runs) / 3,
                'foreignScopeMemoryRate': sum(r.get('foreignScopeMemories', 0) / max(r.get('recalledMemories', 0), 1) for r in runs) / 3,
            }
    summary = {'tasks': len(tasks), 'repairClusters': len({t['cluster'] for t in tasks.values()}),
               'nominalAssignments': len(rows), 'independentExecutions': sum(r['independentExecution'] for r in rows),
               'actualModelCny': sum(r['peakPriceCny'] for r in rows if r['independentExecution']),
               'unknownUsageUpperCny': sum(r.get('requestUsage', {}).get('unknownUsageUpperCny', 0) for r in rows if r['independentExecution']),
               'actualApiRequests': sum(r.get('requestUsage', {}).get('requests', 0) for r in rows if r['independentExecution']),
               'promptTokens': sum(r.get('requestUsage', {}).get('promptTokens', 0) for r in rows if r['independentExecution']),
               'completionTokens': sum(r.get('requestUsage', {}).get('completionTokens', 0) for r in rows if r['independentExecution']),
               'cacheHitTokens': sum(r.get('requestUsage', {}).get('cacheHitTokens', 0) for r in rows if r['independentExecution']),
               'arms': {}, 'comparisons': {}, 'repositories': {}, 'taskResults': tasks}
    for arm in ARMS:
        stats = [t['arms'][arm] for t in tasks.values()]
        summary['arms'][arm] = {metric: sum(t[metric] for t in stats) / len(stats) if stats else None
                                for metric in ['passAt1', 'officialResolved', 'observedPassWithin3', 'regressionRunRate', 'meanModelCny', 'meanAgentSeconds', 'meanSourceInspectionSeconds', 'meanRecallSeconds', 'meanContextChars', 'memoryCoverage', 'foreignScopeMemoryRate']}
        summary['arms'][arm]['passAt1Interval'] = cluster_interval([(t['cluster'], t['arms'][arm]['passAt1']) for t in tasks.values()])
        summary['arms'][arm]['successfulRuns'] = sum(bool(r['strictResolved']) for r in rows if r['arm'] == arm)
        summary['arms'][arm]['nominalRuns'] = len(stats) * 3
    for baseline in ['none', 'global', 'previous']:
        differences = [(t['cluster'], t['arms']['optimized']['passAt1'] - t['arms'][baseline]['passAt1']) for t in tasks.values()]
        summary['comparisons']['optimized_vs_' + baseline] = {
            'passAt1Delta': cluster_interval(differences),
            'improvedTasks': sum(v > 0 for _, v in differences), 'tiedTasks': sum(v == 0 for _, v in differences),
            'harmedTasks': sum(v < 0 for _, v in differences)}
    for repo in sorted({t['repo'] for t in tasks.values()}):
        selected = [t for t in tasks.values() if t['repo'] == repo]
        summary['repositories'][repo] = {'tasks': len(selected), 'arms': {
            arm: sum(t['arms'][arm]['passAt1'] for t in selected) / len(selected) for arm in ARMS}}
    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    con = sqlite3.connect('file:' + str(a.ledger.resolve()) + '?mode=ro', uri=True)
    usage_rows = []
    per_run_usage = collections.defaultdict(lambda: {'chargedCny': 0, 'unknownUsageUpperCny': 0, 'requests': 0, 'promptTokens': 0, 'completionTokens': 0, 'cacheHitTokens': 0})
    for run_id, state, charged, reserved, usage, model in con.execute('SELECT run_id,state,charged,reserved,usage,model FROM calls'):
        u = json.loads(usage) if usage else {}
        usage_rows.append({'runId': run_id, 'model': model, 'state': state, 'chargedCny': charged,
                           'reservedCny': reserved, 'usage': u})
        stats = per_run_usage[run_id]
        stats['chargedCny'] += charged
        stats['requests'] += 1
        if not u:
            stats['unknownUsageUpperCny'] += charged
        stats['promptTokens'] += u.get('prompt_tokens', 0)
        stats['completionTokens'] += u.get('completion_tokens', 0)
        stats['cacheHitTokens'] += u.get('prompt_cache_hit_tokens', (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)) or 0
    con.close()
    panels = collections.defaultdict(list)
    artifacts = {}
    for f in sorted((a.evidence / 'formal').glob('*/*/matrix.json')):
        matrix = load(f)
        if not matrix.get('complete'):
            continue
        if matrix['nominalAssignments'] != 12:
            raise ValueError('Unexpected matrix size')
        first = matrix['rows'][0]
        frozen_dir = a.evidence / 'frozen' / first['panel'] / first['instance_id']
        freeze_path = frozen_dir / 'freeze.json'
        if hashlib.sha256(freeze_path.read_bytes()).hexdigest() != matrix['freezeSha256']:
            raise ValueError('Freeze descriptor changed: ' + str(freeze_path))
        descriptor = load(freeze_path)
        for name, expected_hash in descriptor['files'].items():
            if hashlib.sha256((frozen_dir / name).read_bytes()).hexdigest() != expected_hash:
                raise ValueError('Frozen input changed: ' + name)
        for row in matrix['rows']:
            if row['runId'] not in per_run_usage:
                raise ValueError('Missing ledger evidence for a completed execution')
            row['reportedAgentCny'] = row['peakPriceCny']
            row['requestUsage'] = per_run_usage[row['runId']]
            row['peakPriceCny'] = row['requestUsage']['chargedCny']
            out = f.parent / row['artifactDirectory']
            for name, field in [('result.json', 'resultSha256'), ('grading/score.json', 'scoreSha256')]:
                original = out / name
                data = original.read_bytes() if original.exists() else gzip.decompress(Path(str(original) + '.gz').read_bytes())
                if hashlib.sha256(data).hexdigest() != row[field]:
                    raise ValueError('Run evidence changed: ' + str(original))
            frozen = a.evidence / 'frozen' / row['panel'] / row['instance_id']
            history = load(frozen / 'history-audit.json')
            row['sourceInspectionSeconds'] = history.get('sourceInspectionSeconds', 0)
            inp = load(frozen / (row['arm'] + '.json'))
            row['contextChars'] = len(inp['context'])
            row['recallSeconds'] = 0
            row['recalledMemories'] = 0
            row['foreignScopeMemories'] = 0
            if row['arm'] != 'none':
                recall = load(frozen / (row['arm'] + '-recall.json'))['rows'][0]
                record_map = {r['id']: r for r in history['records']}
                row['recallSeconds'] = recall['recallMs'] / 1000
                row['recalledMemories'] = len(recall['memoryIds'])
                for mid in recall['memoryIds']:
                    scope = record_map[mid]['versionContext']
                    current = recall['current']
                    wrong_repo = scope['repositoryId'] != current['repositoryId']
                    wrong_commit = scope['scopeLevel'] != 'repository' and scope.get('commitSha') != current.get('commitSha')
                    row['foreignScopeMemories'] += int(wrong_repo or wrong_commit)
            panels[(row['panel'], row['model'])].append(row)
        artifacts[str(f.relative_to(a.evidence))] = hashlib.sha256(f.read_bytes()).hexdigest()
    result = {'status': 'interim', 'protocol': load(Path(__file__).with_name('protocol.json'))['id'],
              'panels': {panel + '/' + model: summarize(rows) for (panel, model), rows in panels.items()},
              'matrixHashes': artifacts, 'coverage': {}, 'usage': {}}
    for name, directory in [('main', 'preflight-cohort'), ('pro', 'pro-preflight')]:
        manifest = load(a.evidence / ('dataset-audit.json' if name == 'main' else 'pro-dataset-audit.json'))
        references = collections.defaultdict(list)
        for f in (a.evidence / directory).rglob('preflight.json'):
            d = load(f)
            references[d['instance_id']].append((f, d))
        coverage = []
        for row in manifest['selected']:
            refs = references[row['instance_id']]
            valid = [r for r in refs if r[1]['strictReferencePass']]
            status = 'eligible' if valid else ('excluded' if refs else 'pending')
            coverage.append({'instance_id': row['instance_id'], 'repo': row['repo'], 'status': status,
                             'attempts': [str(f.relative_to(a.evidence)) for f, _ in refs]})
        result['coverage'][name] = {'selected': len(coverage), 'counts': dict(collections.Counter(r['status'] for r in coverage)), 'tasks': coverage}
    formal_ids = {r['runId'] for rows in panels.values() for r in rows if r['independentExecution']}
    for row in usage_rows:
        row['includedInCompleteMatrices'] = row['runId'] in formal_ids
    result['usage'] = {'totalChargedCny': sum(r['chargedCny'] for r in usage_rows),
                       'pendingReservationsCny': sum(r['reservedCny'] for r in usage_rows if r['state'] == 'pending'),
                       'completeMatricesChargedCny': sum(r['chargedCny'] for r in usage_rows if r['includedInCompleteMatrices']),
                       'unknownUsageUpperCny': sum(r['chargedCny'] for r in usage_rows if not r['usage']),
                       'callRecords': usage_rows}
    transport = a.evidence / 'transport-cohorts.json'
    if transport.exists():
        result['transport'] = load(transport)
        initial = result['transport']['initialProxyTasks']
        result['directTransportSensitivity'] = {panel + '/' + model: summarize([
            r for r in rows if r['instance_id'] not in initial.get(panel, [])]) for (panel, model), rows in panels.items()}
    expected = [('main', 'deepseek-v4-flash', 100), ('main', 'MiniMax-M3', 20), ('extension', 'deepseek-v4-flash', 20), ('pro', 'deepseek-v4-flash', 20)]
    complete = True
    for panel, model, limit in expected:
        coverage = result['coverage']['pro' if panel == 'pro' else 'main']['tasks'][:limit]
        expected_ids = {r['instance_id'] for r in coverage if r['status'] == 'eligible'}
        actual_ids = {r['instance_id'] for r in panels[(panel, model)]}
        if any(r['status'] == 'pending' for r in coverage) or expected_ids != actual_ids:
            complete = False
    result['status'] = 'completed' if complete else 'interim'
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'panels': {k: {m: v[m] for m in ['tasks', 'repairClusters', 'independentExecutions', 'actualModelCny']} for k, v in result['panels'].items()},
                      'coverage': {k: v['counts'] for k, v in result['coverage'].items()}, 'chargedCny': result['usage']['totalChargedCny']}))


if __name__ == '__main__':
    main()
