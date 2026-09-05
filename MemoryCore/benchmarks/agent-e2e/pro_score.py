"""Run SWE-bench Pro's pinned official scripts and parser in real containers.

Docker CLI transport replaces the optional SDK. No host directory is mounted:
evaluation files are copied into the container and results copied back out.
"""
import argparse
import ast
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from score import strict_grade


def literal_list(value):
    result = ast.literal_eval(value) if isinstance(value, str) else value
    if not isinstance(result, list) or not all(isinstance(x, str) for x in result):
        raise ValueError('Expected a literal list of test names')
    return result


def execute(official, sample, patch, out, repo):
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'execution.json').exists():
        return json.loads((out / 'execution.json').read_text())
    sample = dict(sample)
    # The upstream formatter uses eval; normalize its input to an already-validated
    # literal so dataset text is never evaluated as host Python code.
    sample['selected_test_files_to_run'] = repr(literal_list(sample['selected_test_files_to_run']))
    old = Path.cwd()
    try:
        os.chdir(repo)
        files, entryscript = official.assemble_workspace_files(sample['instance_id'], str(repo / 'run_scripts'), patch, sample)
    finally:
        os.chdir(old)
    workspace = out / 'workspace'
    workspace.mkdir(exist_ok=True)
    for name, content in files.items():
        (workspace / name).write_text(content)
    tag = 'jefzda/sweap-images:' + sample['dockerhub_tag']
    image = sample.get('_imageDigest')
    if not image:
        probe = subprocess.run(['docker', 'image', 'inspect', tag, '--format', '{{json .RepoDigests}}'], capture_output=True, text=True, check=True)
        image = json.loads(probe.stdout)[0]
    name = 'tdai-pro-verifier-' + uuid.uuid4().hex[:12]
    import shlex
    command = 'git -C /app reset --hard ' + shlex.quote(sample['base_commit'])
    if patch.strip():
        command += ' && git -C /app apply --check /workspace/patch.diff'
    command += ' && bash /workspace/entryscript.sh'
    started = time.time()
    result = {'image': image, 'imageDigest': image, 'tests': {}, 'errors': [], 'patchSha256': hashlib.sha256(patch.encode()).hexdigest()}
    try:
        subprocess.run(['docker', 'create', '--name', name, '--platform', 'linux/amd64', '--network', 'none',
                        '--cpus', '1.5', '--memory', '2g', '--pids-limit', '512', '--entrypoint', '/bin/bash',
                        image, '-c', command], capture_output=True, text=True, check=True, timeout=120)
        subprocess.run(['docker', 'cp', str(workspace) + '/.', name + ':/workspace'], capture_output=True, check=True, timeout=60)
        with (out / 'container.log').open('w') as log:
            run = subprocess.run(['docker', 'start', '-a', name], stdout=log, stderr=log, timeout=1800)
        result['returncode'] = run.returncode
        for filename in ['output.json', 'stdout.log', 'stderr.log']:
            copy = subprocess.run(['docker', 'cp', name + ':/workspace/' + filename, str(out / filename)], capture_output=True, timeout=60)
            if copy.returncode:
                result['errors'].append('Missing ' + filename)
        if (out / 'output.json').exists():
            original = json.loads((out / 'output.json').read_text())
            statuses = {}
            for test in original.get('tests', []):
                statuses.setdefault(test['name'], []).append(test['status'])
            result['tests'] = {name: values[-1] for name, values in statuses.items()}
            result['officialPassedTests'] = [name for name, values in statuses.items() if 'PASSED' in values]
            result['multipleStatuses'] = {name: values for name, values in statuses.items() if len(set(values)) > 1}
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        result['errors'].append(type(exc).__name__ + ': ' + str(exc))
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=60)
    result['elapsedSeconds'] = time.time() - started
    result['scriptHashes'] = {name: hashlib.sha256(content.encode()).hexdigest() for name, content in files.items()}
    (out / 'execution.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--instance', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--reference', action='store_true')
    p.add_argument('--patch', type=Path)
    p.add_argument('--preflight', type=Path)
    a = p.parse_args()
    repo = a.runtime / 'SWE-bench_Pro-os'
    sys.path.insert(0, str(repo))
    import swe_bench_pro_eval as official
    rows = json.loads((a.runtime / 'pro-tables.json').read_text())
    sample = next(r for r in rows if r['instance_id'] == a.instance)
    case = {'FAIL_TO_PASS': literal_list(sample['fail_to_pass']), 'PASS_TO_PASS': literal_list(sample['pass_to_pass'])}
    a.output.mkdir(parents=True, exist_ok=True)
    case_sha = hashlib.sha256(json.dumps(sample, sort_keys=True).encode()).hexdigest()
    if a.reference:
        base = execute(official, sample, '', a.output / 'base', repo)
        gold = execute(official, sample, sample['patch'], a.output / 'reference', repo)
        grade = strict_grade(case, base['tests'], gold['tests'])
        result = {'instance_id': a.instance, 'caseSha256': case_sha, 'strictReferencePass': grade['strictResolved'],
                  'baselineValid': grade['baselineValid'], 'observedTests': {'before': base['tests'], 'after': gold['tests']},
                  'baseExecution': base, 'referenceExecution': gold, 'network': 'none', 'grade': grade}
        (a.output / 'preflight.json').write_text(json.dumps(result, indent=2) + '\n')
    else:
        if not a.preflight or not a.patch:
            raise ValueError('Scoring requires --preflight and --patch')
        reference = json.loads(a.preflight.read_text())
        if not reference['strictReferencePass'] or reference['caseSha256'] != case_sha:
            raise RuntimeError('No valid reference preflight for this exact case')
        sample['_imageDigest'] = reference['baseExecution']['imageDigest']
        after = execute(official, sample, a.patch.read_text(), a.output / 'model', repo)
        result = {'instance_id': a.instance, **strict_grade(case, reference['observedTests']['before'], after['tests']), 'execution': after,
                  'officialResolved': set(case['FAIL_TO_PASS'] + case['PASS_TO_PASS']) <= set(after.get('officialPassedTests', [])),
                  'elapsedSeconds': after['elapsedSeconds']}
        (a.output / 'score.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result.get(k) for k in ['instance_id', 'strictReferencePass', 'baselineValid', 'strictResolved']}))


if __name__ == '__main__':
    main()
