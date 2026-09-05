"""Consume completed reference preflights and run every eligible fixed task."""
import argparse
import concurrent.futures
import json
import subprocess
import time
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--preflights', type=Path, required=True)
    p.add_argument('--frozen', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--panel', choices=['main', 'extension', 'pro'], default='main')
    p.add_argument('--model', choices=['deepseek-v4-flash', 'MiniMax-M3'], default='deepseek-v4-flash')
    p.add_argument('--limit', type=int, default=100)
    p.add_argument('--workers', type=int, default=2)
    p.add_argument('--wait', action='store_true')
    a = p.parse_args()
    for name in ['runtime', 'manifest', 'preflights', 'frozen', 'output', 'previous_core', 'ledger']:
        setattr(a, name, getattr(a, name).resolve())
    a.output.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).parent.resolve()
    py = str(a.runtime / 'venv/bin/python')
    selected = json.loads(a.manifest.read_text())['selected'][:a.limit]
    state = {r['instance_id']: {'instance_id': r['instance_id'], 'status': 'awaiting_preflight'} for r in selected}

    def run_one(task_id, reference_path):
        out = a.output / task_id
        out.mkdir(exist_ok=True)
        frozen = a.frozen / task_id
        freezer = 'freeze_pro_task.py' if a.panel == 'pro' else 'freeze_task.py'
        args = [py, '-u', str(scripts / freezer), '--runtime', str(a.runtime), '--instance', task_id,
                '--previous-core', str(a.previous_core), '--preflight', str(reference_path), '--output', str(frozen)]
        if a.panel != 'pro':
            args += ['--panel', a.panel]
        with (out / 'cohort-task.log').open('a') as log:
            subprocess.run(args, stdout=log, stderr=log, check=True)
            subprocess.run([py, '-u', str(scripts / 'run_task_matrix.py'), '--runtime', str(a.runtime),
                            '--frozen', str(frozen), '--preflight', str(reference_path), '--output', str(out),
                            '--ledger', str(a.ledger), '--model', a.model], stdout=log, stderr=log, check=True)
        return {'instance_id': task_id, 'status': 'complete', 'reference': str(reference_path), 'matrix': str(out / 'matrix.json')}

    futures = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        while True:
            references = {}
            for path in sorted(a.preflights.rglob('preflight.json')):
                try:
                    ref = json.loads(path.read_text())
                except (OSError, ValueError):
                    continue
                key = ref.get('instance_id')
                if key not in state:
                    continue
                # Prefer valid, digest-pinned evidence; original failed attempts remain.
                pinned = bool(ref.get('imageDigests') or ref.get('baseExecution', {}).get('imageDigest'))
                priority = (bool(ref.get('strictReferencePass')), pinned)
                if key not in references or priority > references[key][0]:
                    references[key] = (priority, path, ref)
            for future in list(futures):
                if not future.done():
                    continue
                task_id = futures.pop(future)
                try:
                    state[task_id] = future.result()
                except Exception as exc:
                    state[task_id].update(status='incomplete_error', error=type(exc).__name__ + ': ' + str(exc))
                print(json.dumps(state[task_id]), flush=True)
            for task_id, record in state.items():
                if record['status'] in {'running', 'complete', 'incomplete_error'}:
                    continue
                if task_id not in references:
                    continue
                priority, path, reference = references[task_id]
                if not priority[0]:
                    record.update(status='reference_excluded', reference=str(path))
                    continue
                if len(futures) >= a.workers:
                    break
                record.update(status='running', reference=str(path))
                futures[pool.submit(run_one, task_id, path)] = task_id
                print(json.dumps(record), flush=True)
            snapshot = {'panel': a.panel, 'model': a.model, 'selected': len(state), 'tasks': list(state.values())}
            (a.output / 'cohort.json').write_text(json.dumps(snapshot, indent=2) + '\n')
            pending = any(r['status'] in {'awaiting_preflight', 'running'} for r in state.values())
            if not pending or (not a.wait and not futures):
                break
            time.sleep(5)


if __name__ == '__main__':
    main()
