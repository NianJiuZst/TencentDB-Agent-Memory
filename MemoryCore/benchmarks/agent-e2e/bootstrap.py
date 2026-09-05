"""Fetch immutable public inputs and verify the committed sample selections."""
import argparse
import collections
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def fetch(url, target, expected=None):
    if target.exists() and (expected is None or hashlib.sha256(target.read_bytes()).hexdigest() == expected):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                raw = response.read()
            if expected and hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError('Source checksum mismatch: ' + target.name)
            target.write_bytes(raw)
            return
        except OSError:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--skip-install', action='store_true')
    a = p.parse_args()
    rt = a.runtime.resolve()
    rt.mkdir(parents=True, exist_ok=True)
    if platform.system() == 'Darwin' and platform.machine() == 'arm64':
        binary = rt / 'regctl'
        fetch('https://github.com/regclient/regclient/releases/download/v0.11.5/regctl-darwin-arm64', binary,
              'f4d536d64d0c3cc1db7400902175a1c314675991d22e87e15c319501a2676d3f')
        os.chmod(binary, 0o755)
    scripts = Path(__file__).parent.resolve()
    evidence = scripts.parents[2] / 'submission/evidence/agent-e2e'
    protocol = json.loads((scripts / 'protocol.json').read_text())
    projects = [('SWEContextBench', 'jiayuanz3/SWEContextBench', protocol['mainDataset']['officialHarnessCommit']),
                ('SWE-bench_Pro-os', 'scaleapi/SWE-bench_Pro-os', protocol['supplement']['officialHarnessCommit']),
                ('mini-swe-agent', 'SWE-agent/mini-swe-agent', protocol['agent']['commit'])]
    for directory, repo, commit in projects:
        path = rt / directory
        if not path.exists():
            subprocess.run(['git', 'clone', 'https://github.com/' + repo + '.git', str(path)], check=True)
            subprocess.run(['git', '-C', str(path), 'checkout', '--detach', commit], check=True)
        actual = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != commit:
            raise RuntimeError('Existing checkout differs from the fixed version: ' + str(path))
    py = rt / 'venv/bin/python'
    if not py.exists():
        subprocess.run([sys.executable, '-m', 'venv', str(rt / 'venv')], check=True)
    if not a.skip_install:
        pinned = sorted({line for line in (evidence / 'python-environment.txt').read_text().splitlines()
                         if line and not line.startswith('mini-swe-agent')})
        requirements = rt / 'requirements-reproduction.txt'
        requirements.write_text('\n'.join(pinned) + '\n')
        subprocess.run([str(py), '-m', 'pip', 'install', '-r', str(requirements), '-e', str(rt / 'mini-swe-agent')], check=True)
    main_manifest = json.loads((evidence / 'dataset-audit.json').read_text())
    revision = main_manifest['revision']
    fetch(f'https://huggingface.co/api/datasets/jiayuanz3/SWEContextBench/revision/{revision}', rt / 'dataset-info.json')
    # Reproduce in a scratch directory containing only the five main tables;
    # the original pre-score manifest predates the supplemental Pro download.
    scratch = rt / 'main-manifest-reproduction'
    scratch.mkdir(exist_ok=True)
    for name, expected in main_manifest['hashes'].items():
        target = rt / name
        fetch(f'https://huggingface.co/datasets/jiayuanz3/SWEContextBench/resolve/{revision}/data/{name}', target, expected)
        if not (scratch / name).exists():
            (scratch / name).symlink_to(target)
    for name in ['SWEContextBench', 'dataset-info.json']:
        if not (scratch / name).exists():
            (scratch / name).symlink_to(rt / name, target_is_directory=name == 'SWEContextBench')
    verification = rt / 'reproduced-manifests'
    subprocess.run([str(py), str(scripts / 'prepare_dataset.py'), '--runtime', str(scratch), '--output', str(verification)], check=True)
    if json.loads((verification / 'dataset-audit.json').read_text()) != main_manifest:
        raise RuntimeError('Reconstructed main manifest differs from the registered selection')
    (rt / 'tables.json').write_bytes((scratch / 'tables.json').read_bytes())
    pro = json.loads((evidence / 'pro-dataset-audit.json').read_text())
    fetch(f"https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro/resolve/{pro['revision']}/data/test-00000-of-00001.parquet",
          rt / 'SWE-bench-Pro.parquet', pro['parquetSha256'])
    command = "import pyarrow.parquet as pq,json,sys;from pathlib import Path;p=Path(sys.argv[1]);rows=pq.read_table(p/'SWE-bench-Pro.parquet').to_pylist();(p/'pro-tables.json').write_text(json.dumps(rows))"
    subprocess.run([str(py), '-c', command, str(rt)], check=True)
    rows = json.loads((rt / 'pro-tables.json').read_text())
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row['repo']].append(row)
    for group in groups.values():
        group.sort(key=lambda r: hashlib.sha256(('20260905|' + r['instance_id']).encode()).hexdigest())
    selected = []
    while len(selected) < 20:
        for repo in sorted(groups):
            if groups[repo] and len(selected) < 20:
                selected.append(groups[repo].pop(0)['instance_id'])
    if selected != [r['instance_id'] for r in pro['selected']]:
        raise RuntimeError('Reconstructed Pro selection differs from the registered selection')
    print('Pinned public sources and both task selections reproduced exactly; no models called.')


if __name__ == '__main__':
    main()
