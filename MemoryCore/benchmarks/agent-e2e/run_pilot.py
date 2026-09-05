"""Run the user-requested 30-task, two-arm, one-repeat MiniMax pilot."""
import argparse
import concurrent.futures
import fcntl
import json
import time
from pathlib import Path

from pilot_support import load, now, pilot_root, prior_reference_paths, prepare_reference, run_pair, sha, write


def selected_prefix(candidates, decisions, count=30):
    chosen, dispositions, clusters = [], [], set()
    for row in candidates:
        task = row['instance_id']
        if row['analysisCluster'] in clusters:
            dispositions.append({'instance_id': task, 'rank': row['rank'], 'status': 'duplicate_repair_pr'})
            continue
        if task not in decisions:
            break
        decision = decisions[task]
        dispositions.append({'instance_id': task, 'rank': row['rank'], 'status': 'selected' if decision['eligible'] else 'reference_excluded'})
        if decision['eligible']:
            chosen.append(row)
            clusters.add(row['analysisCluster'])
            if len(chosen) == count:
                break
    return chosen, dispositions


def guaranteed_selection(candidates, decisions, count=30):
    """Dispatch only cases that must enter the final prefix under every pending outcome.

    Each unresolved earlier repair PR counts as potentially eligible. This is an
    upper bound, so later fast environment checks cannot displace an earlier task.
    """
    possible_earlier = set()
    guaranteed = []
    for row in candidates:
        decision = decisions.get(row['instance_id'])
        if decision is not None and not decision['eligible']:
            continue
        cluster = row['analysisCluster']
        if decision is not None and decision['eligible'] and cluster not in possible_earlier and len(possible_earlier) < count:
            guaranteed.append(row)
        possible_earlier.add(cluster)
    return guaranteed


def check_registration(scripts, evidence):
    registration = load(scripts / 'pilot-registration.json')
    for name, expected in registration['scriptHashes'].items():
        if sha(scripts / name) != expected:
            raise RuntimeError('Pilot code changed after registration: ' + name)
    if sha(evidence / 'pilot-candidate-order.json') != registration['candidateManifestSha256']:
        raise RuntimeError('Candidate order changed after registration')
    base = scripts / 'registration.json'
    if sha(base) != registration['baseRegistrationSha256']:
        raise RuntimeError('Original registration changed')
    for name, expected in load(base)['scriptHashes'].items():
        if sha(scripts / name) != expected:
            raise RuntimeError('Underlying experimental code changed: ' + name)
    for entry in load(base)['productionSources'].values():
        for name, expected in entry['hashes'].items():
            if sha(Path(entry['path']) / name) != expected:
                raise RuntimeError('Production implementation changed')
    return sha(scripts / 'pilot-registration.json')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--preparation-workers', type=int, default=2)
    p.add_argument('--task-workers', type=int, default=2)
    a = p.parse_args()
    for name in ['runtime', 'evidence', 'ledger', 'previous_core']:
        setattr(a, name, getattr(a, name).resolve())
    if not 1 <= a.preparation_workers <= 2 or not 1 <= a.task_workers <= 2:
        raise ValueError('The pilot allows at most two workers in each stage')
    scripts = Path(__file__).parent.resolve()
    registration = check_registration(scripts, a.evidence)
    out = pilot_root(a.evidence)
    out.mkdir(exist_ok=True)
    lock = (out / 'scheduler.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    candidates = load(a.evidence / 'pilot-candidate-order.json')['selected']
    decisions = {p.parent.name: load(p) for p in (out / 'references').glob('*/decision.json')}
    # Previously completed reference proof can be reused out of preparation order.
    # This scan reads no agent outputs. A guaranteed-selection bound below still
    # controls which tasks may consume model calls.
    previous_references = {}
    for path in prior_reference_paths(a.evidence):
        reference = load(path)
        if reference.get('strictReferencePass'):
            previous_references[reference['instance_id']] = path
    for row in candidates:
        if row['instance_id'] not in decisions and row['instance_id'] in previous_references:
            decisions[row['instance_id']] = prepare_reference(row, a.runtime, a.evidence)
    submitted = set()
    preparation, execution = {}, {}
    cursor = 0
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.preparation_workers) as prep_pool, concurrent.futures.ThreadPoolExecutor(max_workers=a.task_workers) as task_pool:
        while True:
            for future in list(preparation):
                if not future.done():
                    continue
                task = preparation.pop(future)
                decisions[task] = future.result()
                print(json.dumps({'stage': 'reference_decision', 'task': task, 'eligible': decisions[task]['eligible']}), flush=True)
            for future in list(execution):
                if not future.done():
                    continue
                task = execution.pop(future)
                try:
                    future.result()
                    print(json.dumps({'stage': 'pair_complete', 'task': task}), flush=True)
                except Exception as exc:
                    errors.append({'instance_id': task, 'error': type(exc).__name__ + ': ' + str(exc)})
                    print(json.dumps({'stage': 'pair_needs_attention', **errors[-1]}), flush=True)
            selected, dispositions = selected_prefix(candidates, decisions)
            snapshot = {'protocol': load(scripts / 'pilot-protocol.json')['id'],
                        'candidateManifestSha256': sha(a.evidence / 'pilot-candidate-order.json'),
                        'selectionComplete': len(selected) == 30, 'selected': selected, 'dispositions': dispositions,
                        'selectionRuleUsesAgentOutcomes': False}
            write(out / 'selection.json', snapshot)
            guaranteed = guaranteed_selection(candidates, decisions)
            for row in guaranteed:
                task = row['instance_id']
                if task in submitted or len(execution) >= a.task_workers:
                    continue
                submitted.add(task)
                selected_path = out / 'pairs' / task / 'selection-before-execution.json'
                if not selected_path.exists():
                    write(selected_path, {'recordedAtUtc': now(), 'row': row,
                          'referenceDecisionSha256': sha(out / 'references' / task / 'decision.json'),
                          'pilotRegistrationSha256': registration, 'selectionRuleUsesAgentOutcomes': False})
                execution[task_pool.submit(run_pair, row, decisions[task], a.runtime, a.evidence, a.ledger, a.previous_core, registration)] = task
            if len(selected) < 30:
                while cursor < len(candidates) and len(preparation) < a.preparation_workers:
                    row = candidates[cursor]
                    cursor += 1
                    if row['instance_id'] in decisions:
                        continue
                    preparation[prep_pool.submit(prepare_reference, row, a.runtime, a.evidence)] = row['instance_id']
            pairs = [p.parent.name for p in (out / 'pairs').glob('*/pair.json')]
            status = {'updatedAtUtc': now(), 'selected': len(selected), 'guaranteedSelected': len(guaranteed), 'completedPairs': len(pairs),
                      'referenceDecisions': len(decisions), 'activePreparations': list(preparation.values()),
                      'activeTasks': list(execution.values()), 'errors': errors,
                      'status': 'complete' if len(selected) == 30 and len(pairs) == 30 else 'running'}
            write(out / 'status.json', status)
            if status['status'] == 'complete':
                break
            if len(selected) == 30 and not execution and len(submitted) == 30:
                raise RuntimeError('Selected tasks remain incomplete; inspect recorded infrastructure errors')
            if cursor == len(candidates) and not preparation and len(selected) < 30:
                raise RuntimeError('The fixed candidate pool exhausted before 30 reference-valid repair PRs')
            time.sleep(5)


if __name__ == '__main__':
    main()
