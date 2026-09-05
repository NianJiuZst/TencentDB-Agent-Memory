"""Freeze a disjoint-repository public coding task and its irrelevant-memory control."""
import argparse
import datetime
import hashlib
import json
import subprocess
from pathlib import Path
from timestamps import aware_timestamp


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--instance', required=True)
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.runtime = a.runtime.resolve()
    a.output = a.output.resolve()
    a.preflight = a.preflight.resolve()
    a.previous_core = a.previous_core.resolve()
    scripts = Path(__file__).parent.resolve()
    core = scripts.parent.parent
    samples = json.loads((a.runtime / 'pro-tables.json').read_text())
    case = next(r for r in samples if r['instance_id'] == a.instance)
    case_sha = sha(json.dumps(case, sort_keys=True))
    reference = json.loads(a.preflight.read_text())
    if not reference['strictReferencePass'] or reference['caseSha256'] != case_sha:
        raise RuntimeError('Valid exact-case reference preflight is required')
    a.output.mkdir(parents=True, exist_ok=True)
    if (a.output / 'freeze.json').exists():
        print('Existing frozen inputs retained')
        return
    image = reference['baseExecution']['imageDigest']
    probe = subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--cpus', '1', '--memory', '1g',
                            '--entrypoint', 'git', image, '-C', '/app', 'show', '-s', '--format=%cI', case['base_commit']],
                           capture_output=True, text=True, check=True, timeout=60)
    cutoff = aware_timestamp(probe.stdout.strip())
    if cutoff is None:
        raise RuntimeError('Git did not provide an unambiguous commit timestamp')
    tables = json.loads((a.runtime / 'tables.json').read_text())
    experiences = {r['instance_id']: r for r in tables['Experience']}
    if any(r['repo'].lower() == case['repo'].lower() for r in experiences.values()):
        raise RuntimeError('The predeclared disjoint-repository control no longer applies')
    target_ids = {r['instance_id'] for r in tables['Related']}
    target_prs = {r['related_pr_url'] for r in tables['Relationship']}
    blocked = {r['experience_instance_id'] for r in tables['Relationship'] if r['experience_pr_url'] in target_prs}
    target_patches = {sha(r['patch']) for r in samples + tables['Related']}
    records = []
    for eid, r in sorted(experiences.items()):
        if eid in target_ids or eid in blocked or sha(r['patch']) in target_patches or not r.get('created_at'):
            continue
        stamp = aware_timestamp(r['created_at'])
        if stamp is None or stamp >= cutoff:
            continue
        content = ('Historical reference experience in repository ' + r['repo'] + '.\n'
                   + 'Task ' + eid + ', recorded ' + r['created_at'] + '.\nIssue excerpt:\n'
                   + r['problem_statement'][:900] + '\nHistorical source patch excerpt (may be truncated):\n'
                   + r['patch'][:2500] + '\nThis concerns an earlier task in the named repository. Verify its applicability against the current checkout.')
        records.append({'id': 'history-' + sha(eid)[:20], 'source_task_id': eid, 'created_at': r['created_at'], 'content': content,
                        'versionContext': {'schemaVersion': 1, 'repositoryId': 'repo-' + sha(r['repo'])[:24],
                                           'commitSha': r['base_commit'], 'scopeLevel': 'repository', 'source': 'imported'}})
    problem = case['problem_statement']
    for label, field in [('Requirements', 'requirements'), ('Interface', 'interface')]:
        if case.get(field):
            problem += '\n\n' + label + ':\n' + str(case[field])
    base = {'instance_id': a.instance, 'problem_statement': problem, 'base_commit': case['base_commit'],
            'image': image, 'workspace': '/app', 'harden_history': True, 'run_id': 'frozen'}
    current = {'schemaVersion': 1, 'repositoryId': 'repo-' + sha(case['repo'])[:24],
               'branch': 'HEAD', 'commitSha': case['base_commit'], 'scopeLevel': 'branch', 'source': 'explicit'}
    history = {'tasks': [{'instance_id': a.instance, 'query': problem, 'current': current, 'records': records}]}
    raw = a.runtime / 'admitted-histories/pro' / (a.instance + '.json')
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text(json.dumps(history, indent=2) + '\n')
    audit = {'cutoffCommitDate': probe.stdout.strip(), 'disjointRepositories': True,
             'memoryOrigin': 'Earlier-dated public reference-experience excerpts from other repositories',
             'records': [{k: v for k, v in r.items() if k != 'content'} | {'contentSha256': sha(r['content'])} for r in records]}
    (a.output / 'history-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    contexts = {'none': ''}
    for arm in ['global', 'previous', 'optimized']:
        output = a.output / (arm + '-recall.json')
        subprocess.run(['node', '--import', 'tsx', str(scripts / 'memory-context.ts'), '--input', str(raw), '--output', str(output),
                        '--arm', arm, '--core-root', str(a.previous_core if arm == 'previous' else core)], cwd=core, check=True)
        contexts[arm] = json.loads(output.read_text())['rows'][0]['context']
    for arm, context in contexts.items():
        (a.output / (arm + '.json')).write_text(json.dumps({**base, 'context': context, 'memory_arm': arm}, indent=2) + '\n')
    frozen = {'instance_id': a.instance, 'repo': case['repo'], 'panel': 'pro', 'caseSha256': case_sha,
              'analysisCluster': a.instance.rsplit('-v', 1)[0],
              'protocolSha256': sha((scripts / 'protocol.json').read_bytes()),
              'files': {p.name: sha(p.read_bytes()) for p in sorted(a.output.glob('*.json'))},
              'rawHistorySha256': sha(raw.read_bytes()), 'semanticContextSha256': {arm: sha(c) for arm, c in contexts.items()},
              'scriptsSha256': {p.name: sha(p.read_bytes()) for p in sorted(scripts.iterdir()) if p.suffix in {'.py', '.ts', '.json'}},
              'frozenBeforeModelExecution': True}
    (a.output / 'freeze.json').write_text(json.dumps(frozen, indent=2) + '\n')
    print(json.dumps({'instance_id': a.instance, 'memoryRecords': len(records), 'contextHashes': frozen['semanticContextSha256']}))


if __name__ == '__main__':
    main()
