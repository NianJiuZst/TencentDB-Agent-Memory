"""Create a pre-score registration from a committed experiment implementation."""
import argparse
import datetime
import hashlib
import json
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--previous-core', type=Path, required=True)
    a = p.parse_args()
    scripts = Path(__file__).parent.resolve()
    core = scripts.parent.parent
    root = core.parent
    target = scripts / 'registration.json'
    if target.exists():
        raise RuntimeError('Registration already exists; do not overwrite it')
    git = lambda *args: subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if git('status', '--porcelain', '--', str(scripts)):
        raise RuntimeError('Commit the experiment implementation before registration')
    data = {
        'registeredAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceCommit': git('rev-parse', 'HEAD'),
        'protocolSha256': sha(scripts / 'protocol.json'),
        'scriptHashes': {f.name: sha(f) for f in sorted(scripts.iterdir()) if f.suffix in {'.py', '.ts', '.json'}},
        'productionSources': {},
        'externalCommits': {},
        'manifestHashes': {name: sha(root / 'submission/evidence/agent-e2e' / name)
                           for name in ['dataset-audit.json', 'pro-dataset-audit.json', 'quality-audit.json']},
        'formalModelCallsBeforeRegistration': 0,
    }
    for name, path in [('optimized', core), ('previous', a.previous_core.resolve())]:
        data['productionSources'][name] = {'path': str(path), 'hashes': {
            str(f.relative_to(path)): sha(f) for f in sorted((path / 'src').rglob('*.ts'))}}
    for name in ['SWEContextBench', 'SWE-bench_Pro-os', 'mini-swe-agent']:
        data['externalCommits'][name] = subprocess.check_output(
            ['git', '-C', str(a.runtime.resolve() / name), 'rev-parse', 'HEAD'], text=True).strip()
    target.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'sourceCommit': data['sourceCommit'], 'scriptCount': len(data['scriptHashes'])}))


if __name__ == '__main__':
    main()
