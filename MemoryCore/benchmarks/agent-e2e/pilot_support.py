"""Outcome-blind reference selection and exact-input execution reuse for pilot30."""
import hashlib
import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fetch_image import fetch


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def now():
    return datetime.now(timezone.utc).isoformat()


def prepare_reference(row, runtime, evidence):
    """Reads reference artifacts only. No model-output directory is accessed."""
    task = row['instance_id']
    out = evidence / 'pilot-30/references' / task
    decision_path = out / 'decision.json'
    if decision_path.exists():
        return load(decision_path)
    out.mkdir(parents=True, exist_ok=True)
    found = []
    for path in sorted((evidence / 'preflight-cohort').rglob('preflight.json')):
        try:
            reference = load(path)
        except ValueError:
            continue
        if reference.get('instance_id') == task:
            found.append((path, reference))
    valid = [(p, r) for p, r in found if r.get('strictReferencePass')]
    # Actual reference tests have a final disposition; do not recheck them based
    # on an agent result. Only pure transport failures receive recovery.
    final = [(p, r) for p, r in found if r.get('stage') != 'image_unavailable']
    chosen = valid[0] if valid else final[0] if final else None
    if chosen is None:
        attempts = []
        try:
            if shutil.disk_usage(runtime).free < 25 * 1024**3:
                raise RuntimeError('Host disk reserve reached')
            disk = subprocess.check_output(['colima', 'ssh', '--', 'df', '-Pk', '/var/lib/docker'], text=True)
            if int(disk.splitlines()[-1].split()[3]) < 15 * 1024**2:
                raise RuntimeError('Docker VM disk reserve reached')
            available = subprocess.run(['docker', 'image', 'inspect', row['image']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if not available:
                with (out / 'image-download.log').open('a') as log:
                    try:
                        pulled = subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', row['image']], stdout=log, stderr=log, timeout=900)
                        available = pulled.returncode == 0
                        attempts.append({'transport': 'docker', 'returncode': pulled.returncode})
                    except subprocess.TimeoutExpired:
                        attempts.append({'transport': 'docker', 'timeout': True})
                if not available:
                    recovery = fetch(row['image'], runtime, out)
                    attempts.append({'transport': 'verified-oci', 'result': recovery})
            command = [str(runtime / 'venv/bin/python'), '-u', str(Path(__file__).with_name('preflight.py')),
                       '--runtime', str(runtime), '--instance', task, '--output', str(out)]
            if row['repo'] == 'psf/requests':
                command += ['--network', 'tdai-benchmark-20260905']
            with (out / 'verifier.log').open('a') as log:
                result = subprocess.run(command, stdout=log, stderr=log, timeout=3600)
            attempts.append({'stage': 'reference', 'returncode': result.returncode})
        except Exception as exc:
            if 'disk reserve' in str(exc):
                raise  # Capacity is a resumable scheduler issue, not task exclusion.
            attempts.append({'error': type(exc).__name__ + ': ' + str(exc)})
        write(out / 'attempts.json', attempts)
        reference_path = out / 'preflight.json'
        if not reference_path.exists():
            write(reference_path, {'instance_id': task, 'strictReferencePass': False, 'baselineValid': False,
                                   'environmentUnavailable': True, 'attempts': attempts})
        chosen = (reference_path, load(reference_path))
    path, reference = chosen
    if reference.get('strictReferencePass') and reference.get('caseSha256') != row['caseSha256']:
        raise RuntimeError('Reference case differs from the fixed candidate manifest')
    decision = {'instance_id': task, 'rank': row['rank'], 'analysisCluster': row['analysisCluster'],
                'eligible': bool(reference.get('strictReferencePass')), 'reference': str(path.relative_to(evidence)),
                'referenceSha256': sha(path), 'decidedAtUtc': now(), 'basis': 'Reference proof only; no agent result read',
                'earlierReferences': [str(p.relative_to(evidence)) for p, _ in found]}
    write(decision_path, decision)
    return decision


def validate_reuse(out, task, runtime, limits):
    existing = load(out / 'agent-input.json')
    if {k: v for k, v in existing.items() if k != 'run_id'} != {k: v for k, v in task.items() if k != 'run_id'}:
        raise RuntimeError('Existing run has different frozen inputs')
    result = load(out / 'result.json')
    if result.get('input_sha256') != sha(out / 'agent-input.json'):
        raise RuntimeError('Existing run input hash differs')
    cfg_path = runtime / 'mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml'
    if result.get('upstream_config_sha256') != sha(cfg_path):
        raise RuntimeError('Existing run used another upstream configuration')
    cfg = load(out / 'trajectory.json')['info']['config']
    agent, model, env = cfg['agent'], cfg['model'], cfg['environment']
    if agent['step_limit'] != limits['steps'] or agent['wall_time_limit_seconds'] != limits['seconds']:
        raise RuntimeError('Existing run used different step/time limits')
    expected = {'api_base': 'https://api.minimaxi.com/v1', 'temperature': limits['temperature'],
                'max_tokens': limits['maxOutput'], 'timeout': 180, 'num_retries': 0,
                'extra_body': {'thinking': {'type': 'adaptive'}}}
    if model['model_name'] != 'openai/MiniMax-M3' or model['model_kwargs'] != expected:
        raise RuntimeError('Existing run used another model or model settings')
    args = env['run_args']
    if env['image'] != task['image'] or env['timeout'] != limits['commandSeconds'] or env['forward_env'] or env['cwd'] != '/testbed':
        raise RuntimeError('Existing environment does not match')
    for flag, value in [('--platform', 'linux/amd64'), ('--cpus', str(limits['cpu'])), ('--memory', limits['memory']), ('--pids-limit', '512')]:
        if flag not in args or args[args.index(flag) + 1] != value:
            raise RuntimeError('Existing container limits differ')
    expected_network = 'tdai-benchmark-20260905' if task['instance_id'].startswith('psf__requests-') else 'none'
    if args[args.index('--network') + 1] != expected_network:
        raise RuntimeError('Existing network differs')
    return result


def run_pair(row, decision, runtime, evidence, ledger, previous_core, registration):
    scripts = Path(__file__).parent.resolve()
    protocol = load(scripts / 'pilot-protocol.json')
    limits = protocol['agentLimits']
    py = str(runtime / 'venv/bin/python')
    task_id = row['instance_id']
    frozen = evidence / 'frozen/main' / task_id
    reference = evidence / decision['reference']
    if sha(reference) != decision['referenceSha256']:
        raise RuntimeError('Selected reference changed')
    pair_out = evidence / 'pilot-30/pairs' / task_id
    pair_out.mkdir(parents=True, exist_ok=True)
    if (pair_out / 'pair.json').exists():
        return load(pair_out / 'pair.json')
    with (pair_out / 'freeze.log').open('a') as log:
        subprocess.run([py, str(scripts / 'freeze_task.py'), '--runtime', str(runtime), '--instance', task_id,
                        '--previous-core', str(previous_core), '--preflight', str(reference), '--output', str(frozen)],
                       stdout=log, stderr=log, check=True)
    descriptor = load(frozen / 'freeze.json')
    for name, expected in descriptor['files'].items():
        if sha(frozen / name) != expected:
            raise RuntimeError('Frozen artifact changed')
    rows = []
    order = sorted(protocol['arms'], key=lambda arm: hashlib.sha256(f'20260905|{task_id}|0|{arm}'.encode()).hexdigest())
    for arm in order:
        task = load(frozen / (arm + '.json'))
        old = evidence / 'formal/main-minimax' / task_id / ('r0-' + arm)
        reused = (old / 'result.json').exists() and not (old / 'user-cancelled.json').exists()
        # A prior, still-active MiniMax run is retained to completion, not replaced.
        if (old / 'agent-input.json').exists() and not (old / 'result.json').exists():
            deadline = time.time() + 2400
            while not (old / 'result.json').exists() and time.time() < deadline:
                time.sleep(5)
            if not (old / 'result.json').exists():
                raise RuntimeError('Existing matching MiniMax execution needs attention')
            reused = True
        out = old if reused else evidence / 'pilot-30/runs' / task_id / arm
        out.mkdir(parents=True, exist_ok=True)
        if not reused:
            task['run_id'] = 'pilot30--' + task_id + '--MiniMax-M3--' + arm
            inp = out / 'agent-input.json'
            if inp.exists() and load(inp) != task:
                raise RuntimeError('Existing pilot input differs')
            write(inp, task)
            command = [py, '-u', str(scripts / 'run_agent.py'), '--runtime', str(runtime), '--input', str(inp),
                                '--output', str(out), '--ledger', str(ledger), '--cap', str(load(scripts / 'budget-authorization.json')['additionalLedgerCapCny']),
                                '--model', 'MiniMax-M3', '--thinking', 'enabled', '--max-output', str(limits['maxOutput']),
                                '--steps', str(limits['steps']), '--seconds', str(limits['seconds']),
                                '--network', load(reference).get('network') or 'none']
            started_path = out / 'execution-start.json'
            if not (out / 'result.json').exists() and started_path.exists():
                started = load(started_path)
                while not (out / 'result.json').exists():
                    try:
                        os.kill(started['pid'], 0)
                    except ProcessLookupError:
                        raise RuntimeError('Interrupted attempt retained; do not silently rerun it') from None
                    time.sleep(5)
            if not (out / 'result.json').exists():
                with (out / 'runner.log').open('a') as log:
                    process = subprocess.Popen(command, stdout=log, stderr=log)
                    write(started_path, {'pid': process.pid, 'startedAtUtc': now(), 'inputSha256': sha(inp)})
                    returncode = process.wait()
                    if returncode:
                        raise RuntimeError('Agent process failed with return code ' + str(returncode))
        result = validate_reuse(out, task, runtime, limits)
        if result.get('exit_status') not in {'Submitted', 'LimitsExceeded', 'TimeExceeded', 'RepeatedFormatError'}:
            raise RuntimeError('Infrastructure/interruption requires attention, not a coding failure: ' + str(out))
        with (out / 'grader.log').open('a') as log:
            subprocess.run([py, '-u', str(scripts / 'score.py'), '--runtime', str(runtime), '--instance', task_id,
                            '--patch', str(out / 'model.patch'), '--preflight', str(reference), '--output', str(out / 'grading')],
                           stdout=log, stderr=log, check=True)
        score = load(out / 'grading/score.json')
        if score.get('adapterVersion') != 'digest-alias-v2' or not score.get('scorable'):
            raise RuntimeError('Corrected executable grading is required')
        rows.append({'instance_id': task_id, 'repo': row['repo'], 'analysisCluster': row['analysisCluster'], 'arm': arm,
                     'model': 'MiniMax-M3', 'replicate': 0, 'runId': result['run_id'], 'reusedPriorExecution': reused,
                     'artifactDirectory': str(out.relative_to(evidence)), 'resultSha256': sha(out / 'result.json'),
                     'scoreSha256': sha(out / 'grading/score.json'), 'trajectorySha256': sha(out / 'trajectory.json'),
                     'strictResolved': score['strictResolved'], 'officialResolved': score['officialResolved'],
                     'regressions': len(score['regressions']), 'exitStatus': result['exit_status'],
                     'agentSeconds': result['elapsed_seconds'], 'gradeSeconds': score['elapsedSeconds'],
                     'contextSha256': descriptor['semanticContextSha256'][arm], 'inputSha256': result['input_sha256']})
        write(pair_out / 'progress.json', rows)
        print(json.dumps({'stage': 'graded', 'task': task_id, 'arm': arm, 'success': score['strictResolved'], 'reused': reused}), flush=True)
    pair = {'instance_id': task_id, 'complete': True, 'rows': rows, 'freezeSha256': sha(frozen / 'freeze.json'),
            'pilotProtocolSha256': sha(scripts / 'pilot-protocol.json'), 'pilotRegistrationSha256': registration,
            'referenceDecisionSha256': sha(evidence / 'pilot-30/references' / task_id / 'decision.json')}
    write(pair_out / 'pair.json', pair)
    return pair
