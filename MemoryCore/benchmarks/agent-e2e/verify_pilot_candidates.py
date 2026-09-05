"""Rebuild the fixed pilot candidate order from public source data only."""
import argparse
import collections
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(runtime, evidence):
    import pyarrow.parquet as pq
    original = json.loads((evidence / 'dataset-audit.json').read_text())
    manifest_path = evidence / 'pilot-candidate-order.json'
    manifest = json.loads(manifest_path.read_text())
    source = runtime / 'SWEContextBench_Related.parquet'
    if digest(source) != original['hashes'][source.name]:
        raise RuntimeError('Source table differs from its fixed revision')
    related = {r['instance_id']: r for r in pq.read_table(source).to_pylist()}
    repos = {'django/django', 'sympy/sympy', 'matplotlib/matplotlib', 'sphinx-doc/sphinx',
             'scikit-learn/scikit-learn', 'pydata/xarray', 'astropy/astropy', 'psf/requests',
             'pytest-dev/pytest', 'pylint-dev/pylint', 'mwaskom/seaborn', 'pallets/flask'}
    groups = collections.defaultdict(list)
    cases = {}
    for task, row in related.items():
        path = runtime / 'SWEContextBench/cases/SWEContextBench Full' / (task + '.json')
        if not path.exists() or row['repo'] not in repos or task == 'psf__requests-5474':
            continue
        case = json.loads(path.read_text())
        if not case.get('FAIL_TO_PASS'):
            continue
        cases[task] = (case, path)
        groups[row['repo']].append(task)
    for group in groups.values():
        group.sort(key=lambda task: hashlib.sha256(('20260905|' + task).encode()).hexdigest())
    order = []
    while any(groups.values()):
        for repo in sorted(groups):
            if groups[repo]:
                order.append(groups[repo].pop(0))
    rebuilt = []
    for rank, task in enumerate(order):
        case, path = cases[task]
        rebuilt.append({'rank': rank, 'instance_id': task, 'repo': case['repo'],
                        'analysisCluster': case['repo'] + '#' + str(case['pull_number']),
                        'base_commit': case['base_commit'],
                        'image': 'jiayuanz3/swecontextbench:' + task.replace('__', '.').lower(),
                        'caseSha256': digest(path)})
    if rebuilt != manifest['selected'] or len(rebuilt) != manifest['candidateCount']:
        raise RuntimeError('Reconstructed pilot candidates differ from the fixed manifest')
    if digest(evidence / 'dataset-audit.json') != manifest['priorManifestSha256']:
        raise RuntimeError('Original 100-task manifest changed')
    if order[:100] != [row['instance_id'] for row in original['selected']]:
        raise RuntimeError('The original 100-task prefix was not preserved')
    return {'verifiedAtUtc': datetime.now(timezone.utc).isoformat(), 'status': 'passed',
            'candidateCount': len(rebuilt), 'repairClusters': len({r['analysisCluster'] for r in rebuilt}),
            'original100TaskPrefixMatches': True, 'candidateManifestSha256': digest(manifest_path),
            'sourceRelatedTableSha256': digest(source), 'modelOutputsRead': False, 'modelCalls': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = verify(args.runtime.resolve(), args.evidence.resolve())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
