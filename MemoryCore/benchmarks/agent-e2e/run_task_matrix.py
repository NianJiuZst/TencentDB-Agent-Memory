"""Execute a frozen four-arm task matrix with independent repeated agent runs."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def semantic_input_key(task):
    semantic = {k: v for k, v in task.items() if k not in {'run_id', 'memory_arm'}}
    return hashlib.sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--frozen', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--model', choices=['deepseek-v4-flash', 'MiniMax-M3'], default='deepseek-v4-flash')
    a = p.parse_args()
    for name in ['runtime', 'frozen', 'preflight', 'output', 'ledger']:
        setattr(a, name, getattr(a, name).resolve())
    scripts = Path(__file__).parent.resolve()
    protocol = json.loads((scripts / 'protocol.json').read_text())
    frozen = json.loads((a.frozen / 'freeze.json').read_text())
    reference = json.loads(a.preflight.read_text())
    if not reference['strictReferencePass'] or not reference['baselineValid']:
        raise RuntimeError('Reference preflight did not establish a valid task')
    if frozen['caseSha256'] != reference['caseSha256']:
        raise RuntimeError('Case differs from reference preflight')
    if frozen['protocolSha256'] != sha(scripts / 'protocol.json'):
        raise RuntimeError('Protocol changed after task inputs were frozen')
    for name, expected in frozen['files'].items():
        if sha(a.frozen / name) != expected:
            raise RuntimeError('Frozen artifact changed: ' + name)
    # Registration is written and committed before any formal agent call.
    registration_path = scripts / 'registration.json'
    if not registration_path.exists():
        raise RuntimeError('Pre-score registration is missing')
    registration = json.loads(registration_path.read_text())
    if registration['protocolSha256'] != sha(scripts / 'protocol.json'):
        raise RuntimeError('Protocol no longer matches pre-score registration')
    for name, expected in registration['scriptHashes'].items():
        if sha(scripts / name) != expected:
            raise RuntimeError('Registered experiment code changed: ' + name)
    for core_name, entry in registration['productionSources'].items():
        for name, expected in entry['hashes'].items():
            if sha(Path(entry['path']) / name) != expected:
                raise RuntimeError('Registered production source changed: ' + core_name + '/' + name)
    a.output.mkdir(parents=True, exist_ok=True)
    py = str(a.runtime / 'venv/bin/python')
    inputs = {arm: json.loads((a.frozen / (arm + '.json')).read_text()) for arm in protocol['arms']}
    rows = []
    for replicate in range(protocol['replicates']):
        order = sorted(protocol['arms'], key=lambda arm: hashlib.sha256(f'20260905|{frozen["instance_id"]}|{replicate}|{arm}'.encode()).hexdigest())
        completed = {}
        for arm in order:
            context_hash = frozen['semanticContextSha256'][arm]
            semantic_hash = semantic_input_key(inputs[arm])
            if semantic_hash in completed:
                previous = completed[semantic_hash]
                rows.append({**previous, 'arm': arm, 'reusedFromArm': previous['arm'], 'independentExecution': False})
                continue
            run_id = f'{frozen["panel"]}--{frozen["instance_id"]}--{a.model}--r{replicate}--{arm}'
            out = a.output / f'r{replicate}-{arm}'
            out.mkdir(exist_ok=True)
            task = {**inputs[arm], 'run_id': run_id}
            input_path = out / 'agent-input.json'
            if input_path.exists() and json.loads(input_path.read_text()) != task:
                raise RuntimeError('An existing run has different inputs')
            input_path.write_text(json.dumps(task, indent=2) + '\n')
            network = reference.get('network') or 'none'
            args = [py, '-u', str(scripts / 'run_agent.py'), '--runtime', str(a.runtime), '--input', str(input_path),
                    '--output', str(out), '--ledger', str(a.ledger), '--cap', str(protocol['budget']['additionalLedgerCapCny']),
                    '--model', a.model, '--thinking', 'enabled', '--max-output', str(protocol['agent']['maxOutputTokensPerCall']),
                    '--steps', str(protocol['agent']['maxModelSteps']), '--seconds', str(protocol['agent']['maxWallSeconds']),
                    '--network', network]
            with (out / 'runner.log').open('a') as log:
                subprocess.run(args, stdout=log, stderr=log, check=True)
            result = json.loads((out / 'result.json').read_text())
            if result.get('exit_status') == 'BudgetExceeded':
                raise RuntimeError('Authorized budget reached; matrix remains incomplete')
            if result.get('exit_status') in {'EnvironmentError', 'AuthenticationError', 'PermissionDeniedError', 'APIConnectionError', 'APITimeoutError', 'RateLimitError', 'ServiceUnavailableError', 'InternalServerError'}:
                raise RuntimeError('Infrastructure failure; do not score as a coding failure: ' + str(out))
            grader = 'pro_score.py' if frozen['panel'] == 'pro' else 'score.py'
            args = [py, '-u', str(scripts / grader), '--runtime', str(a.runtime), '--instance', frozen['instance_id'],
                    '--patch', str(out / 'model.patch'), '--preflight', str(a.preflight), '--output', str(out / 'grading')]
            with (out / 'grader.log').open('a') as log:
                subprocess.run(args, stdout=log, stderr=log, check=True)
            score = json.loads((out / 'grading/score.json').read_text())
            row = {'instance_id': frozen['instance_id'], 'repo': frozen['repo'], 'panel': frozen['panel'],
                   'analysisCluster': frozen['analysisCluster'],
                   'model': a.model, 'replicate': replicate, 'arm': arm, 'runId': run_id,
                   'independentExecution': True, 'contextSha256': context_hash,
                   'semanticInputSha256': semantic_hash,
                   'strictResolved': score['strictResolved'], 'officialResolved': score['officialResolved'],
                   'regressions': len(score['regressions']), 'exitStatus': result['exit_status'],
                   'apiCalls': result.get('api_calls'), 'peakPriceCny': result.get('peak_price_cny'),
                   'agentSeconds': result['elapsed_seconds'], 'gradeSeconds': score['elapsedSeconds'],
                   'artifactDirectory': out.name, 'resultSha256': sha(out / 'result.json'),
                   'scoreSha256': sha(out / 'grading/score.json')}
            completed[semantic_hash] = row
            rows.append(row)
            (a.output / 'progress.json').write_text(json.dumps(rows, indent=2) + '\n')
            print(json.dumps({k: row[k] for k in ['runId', 'strictResolved', 'apiCalls', 'peakPriceCny']}), flush=True)
    result = {'instance_id': frozen['instance_id'], 'protocolSha256': frozen['protocolSha256'],
              'preScoreCommit': registration['sourceCommit'], 'freezeSha256': sha(a.frozen / 'freeze.json'),
              'nominalAssignments': len(rows), 'independentExecutions': sum(r['independentExecution'] for r in rows),
              'rows': rows, 'complete': len(rows) == len(protocol['arms']) * protocol['replicates']}
    (a.output / 'matrix.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
