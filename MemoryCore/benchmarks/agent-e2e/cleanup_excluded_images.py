"""Reclaim only unused image tags belonging to finally excluded pilot tasks.

The default is a read-only plan. No containers, volumes, build cache, OCI cache,
selected task images, or other repositories are removed. Deletions never force.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from pilot_support import load, now, pilot_root, sha, write


def docker_json(*args):
    return json.loads(subprocess.check_output(['docker', *args], text=True))


def plan(evidence):
    pilot = pilot_root(evidence)
    manifest = load(evidence / 'pilot-candidate-order.json')
    candidates = {r['instance_id']: r for r in manifest['selected']}
    excluded = {}
    for path in (pilot / 'references').glob('*/decision.json'):
        decision = load(path)
        task = decision['instance_id']
        reference = evidence / decision['reference']
        if sha(reference) != decision['referenceSha256']:
            raise RuntimeError('Reference evidence changed: ' + task)
        if not decision['eligible'] and not load(reference).get('strictReferencePass'):
            excluded[task] = {'base': candidates[task]['image'],
                              'decision': str(path.relative_to(evidence)),
                              'decisionSha256': sha(path)}
    container_ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
    used = {c['Image'] for c in docker_json('inspect', *container_ids)} if container_ids else set()
    image_ids = subprocess.check_output(['docker', 'image', 'ls', '-q', '--no-trunc',
                                       '--filter', 'reference=jiayuanz3/swecontextbench:*'], text=True).split()
    images = docker_json('image', 'inspect', *sorted(set(image_ids))) if image_ids else []
    result = []
    for info in images:
        if info['Id'] in used:
            continue
        for tag in info.get('RepoTags') or []:
            for task, entry in excluded.items():
                if tag == entry['base'] or re.fullmatch(re.escape(entry['base']) + r'_[0-9a-f]+_(?:testpatch|modelpatch)(?:_[a-z0-9_]+)?', tag):
                    result.append({'instance_id': task, 'tag': tag, 'imageId': info['Id'],
                                   'repoDigests': info.get('RepoDigests'), **entry})
                    break
    # Remove temporary derived tags first. Docker itself retains shared layers.
    return sorted(result, key=lambda r: (r['tag'] == r['base'], r['tag']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    entries = plan(evidence)
    stamp = now().replace(':', '').replace('.', '-')
    out = evidence / 'excluded-image-cleanup' / (stamp + '.json')
    record = {'createdAtUtc': now(), 'mode': 'apply' if args.apply else 'plan',
              'scope': 'Unused official or temporary tags for finally excluded tasks only; no force or global prune.',
              'entries': entries, 'results': []}
    write(out, record)
    if args.apply:
        for row in entries:
            decision_path = evidence / row['decision']
            if sha(decision_path) != row['decisionSha256'] or load(decision_path)['eligible']:
                raise RuntimeError('Exclusion decision changed')
            current = docker_json('image', 'inspect', row['tag'])[0]
            if current['Id'] != row['imageId']:
                raise RuntimeError('Image tag changed before removal')
            # Without --force Docker refuses removal of an image still in use.
            done = subprocess.run(['docker', 'image', 'rm', row['tag']], capture_output=True,
                                  text=True, timeout=120)
            record['results'].append({'tag': row['tag'], 'returncode': done.returncode,
                                      'stdout': done.stdout, 'stderr': done.stderr})
            write(out, record)
    print(json.dumps({'record': str(out), 'plannedTags': len(entries),
                      'removedTags': sum(r['returncode'] == 0 for r in record['results'])}))
