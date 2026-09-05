"""Freeze all arm inputs from one real task before its first model execution."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--instance', required=True)
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    p.add_argument('--panel', choices=['main', 'extension'], default='main')
    a = p.parse_args()
    a.runtime = a.runtime.resolve()
    a.output = a.output.resolve()
    a.preflight = a.preflight.resolve()
    a.previous_core = a.previous_core.resolve()
    scripts = Path(__file__).parent.resolve()
    core = scripts.parent.parent
    case_path = a.runtime / 'SWEContextBench/cases/SWEContextBench Full' / (a.instance + '.json')
    case = json.loads(case_path.read_text())
    reference = json.loads(a.preflight.read_text())
    if not reference['strictReferencePass'] or reference['caseSha256'] != digest(case_path) or not reference.get('imageDigests'):
        raise RuntimeError('A valid exact-case reference preflight and image digest are required')
    a.output.mkdir(parents=True, exist_ok=True)
    if (a.output / 'freeze.json').exists():
        print('Existing frozen inputs retained')
        return
    py = str(a.runtime / 'venv/bin/python')
    base = {k: case[k] for k in ['instance_id', 'problem_statement', 'base_commit']}
    base.update(image=reference['imageDigests'][0], context='')
    (a.output / 'none.json').write_text(json.dumps({**base, 'memory_arm': 'none', 'run_id': 'frozen'}, indent=2) + '\n')
    raw_history = a.runtime / 'admitted-histories' / a.panel / (a.instance + '.json')
    if a.panel == 'main':
        command = [py, str(scripts / 'prepare_history.py'), '--runtime', str(a.runtime), '--instance', a.instance, '--output', str(raw_history), '--image', base['image']]
    else:
        command = [py, str(scripts / 'extract_version_history.py'), '--input', str(a.output / 'none.json'), '--repo', case['repo'], '--output', str(raw_history)]
    subprocess.run(command, check=True)
    history = json.loads(raw_history.read_text())
    audit = {k: v for k, v in history.items() if k != 'tasks'}
    audit['records'] = [{k: v for k, v in r.items() if k != 'content'} | {'contentSha256': hashlib.sha256(r['content'].encode()).hexdigest()}
                        for r in history['tasks'][0]['records']]
    (a.output / 'history-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    contexts = {}
    for arm in ['global', 'previous', 'optimized']:
        context_path = a.output / (arm + '-recall.json')
        subprocess.run(['node', '--import', 'tsx', str(scripts / 'memory-context.ts'), '--input', str(raw_history),
                        '--output', str(context_path), '--arm', arm,
                        '--core-root', str(a.previous_core if arm == 'previous' else core)], cwd=core, check=True)
        context = json.loads(context_path.read_text())['rows'][0]['context']
        contexts[arm] = context
        (a.output / (arm + '.json')).write_text(json.dumps({**base, 'context': context, 'memory_arm': arm, 'run_id': 'frozen'}, indent=2) + '\n')
    artifacts = {p.name: digest(p) for p in sorted(a.output.glob('*.json'))}
    frozen = {'instance_id': a.instance, 'repo': case['repo'], 'panel': a.panel,
              'analysisCluster': case['repo'] + '#' + str(case.get('pull_number') or a.instance),
              'caseSha256': digest(case_path), 'protocolSha256': digest(scripts / 'protocol.json'),
              'files': artifacts, 'rawHistorySha256': digest(raw_history),
              'semanticContextSha256': {arm: hashlib.sha256(context.encode()).hexdigest() for arm, context in {'none': '', **contexts}.items()},
              'scriptsSha256': {p.name: digest(p) for p in sorted(scripts.iterdir()) if p.suffix in {'.py', '.ts', '.json'}},
              'frozenBeforeModelExecution': True}
    (a.output / 'freeze.json').write_text(json.dumps(frozen, indent=2) + '\n')
    print(json.dumps({'instance_id': a.instance, 'panel': a.panel, 'contexts': frozen['semanticContextSha256']}))


if __name__ == '__main__':
    main()
