"""Admit public historical experience without exposing target solutions.

Same-repository reference changes must already exist in the untouched task base.
The verification container is destroyed before the separate agent container starts.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from timestamps import aware_timestamp


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--instance', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--image')
    a = p.parse_args()
    tables = json.loads((a.runtime / 'tables.json').read_text())
    cases_dir = a.runtime / 'SWEContextBench/cases/SWEContextBench Full'
    case = json.loads((cases_dir / (a.instance + '.json')).read_text())
    targets = {r['instance_id']: r for r in tables['Related']}
    target_patch_hashes = {sha(r['patch']) for r in targets.values()}
    target_prs = {r['related_pr_url'] for r in tables['Relationship']}
    blocked_experience_ids = {r['experience_instance_id'] for r in tables['Relationship'] if r['experience_pr_url'] in target_prs}
    experience = {r['instance_id']: r for r in tables['Experience']}
    cutoff = aware_timestamp(case['created_at'])
    eligible = [r for eid, r in experience.items() if eid not in targets and eid not in blocked_experience_ids
                and sha(r['patch']) not in target_patch_hashes and r.get('created_at')
                and cutoff is not None and aware_timestamp(r['created_at']) is not None
                and aware_timestamp(r['created_at']) < cutoff]
    same_repo = [r for r in eligible if r['repo'] == case['repo']]
    image = a.image or 'jiayuanz3/swecontextbench:' + a.instance.replace('__', '.').lower()
    script = '''import json,subprocess,sys
d=json.load(sys.stdin)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd='/testbed').decode().strip()
assert head==d['base_commit'], (head,d['base_commit'])
rows=[]
for r in d['rows']:
 p=subprocess.run(['git','apply','--reverse','--check','--whitespace=nowarn','-'],input=r['patch'].encode(),cwd='/testbed',stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 rows.append({'instance_id':r['instance_id'],'alreadyPresentAtTargetBase':p.returncode==0})
print(json.dumps({'head':head,'rows':rows}))
'''
    payload = {'base_commit': case['base_commit'], 'rows': [{'instance_id': r['instance_id'], 'patch': r['patch']} for r in same_repo]}
    probe = subprocess.run(['docker', 'run', '--rm', '-i', '--platform', 'linux/amd64', '--network', 'none',
                            '--cpus', '1', '--memory', '1g', image, 'python', '-c', script],
                           input=json.dumps(payload), capture_output=True, text=True, timeout=300, check=True)
    verification = json.loads(probe.stdout)
    admitted = {r['instance_id'] for r in verification['rows'] if r['alreadyPresentAtTargetBase']}
    records = []
    for r in sorted(eligible, key=lambda r: r['instance_id']):
        if r['repo'] == case['repo'] and r['instance_id'] not in admitted:
            continue
        # Excerpts preserve source text. They are not claimed to be agent-generated
        # summaries or successful prior agent trajectories.
        text = ('Historical reference experience in repository ' + r['repo'] + '.\n'
                + 'Task ' + r['instance_id'] + ', recorded ' + r['created_at'] + '.\n'
                + 'Issue excerpt:\n' + r['problem_statement'][:900] + '\n'
                + 'Historical source patch excerpt (may be truncated):\n' + r['patch'][:2500] + '\n'
                + 'This concerns an earlier task in the named repository. Verify its applicability against the current checkout.')
        records.append({'id': 'history-' + sha(r['instance_id'])[:20], 'source_task_id': r['instance_id'],
                        'created_at': r['created_at'], 'content': text,
                        'versionContext': {'schemaVersion': 1, 'repositoryId': 'repo-' + sha(r['repo'])[:24],
                                           'commitSha': r['base_commit'], 'scopeLevel': 'repository', 'source': 'imported'}})
    current = {'schemaVersion': 1, 'repositoryId': 'repo-' + sha(case['repo'])[:24],
               'branch': 'HEAD', 'commitSha': case['base_commit'], 'worktreeId': 'task-' + a.instance,
               'taskId': a.instance, 'scopeLevel': 'task', 'source': 'explicit'}
    result = {'tasks': [{'instance_id': a.instance, 'query': case['problem_statement'], 'current': current, 'records': records}],
              'admission': {'sameRepoVerification': verification, 'eligibleBeforeBaseCheck': len(eligible),
                            'sameRepositoryCandidates': len(same_repo), 'sameRepositoryAdmitted': len(admitted),
                            'totalAdmitted': len(records), 'targetGoldOrTestExposed': False,
                            'memoryOrigin': 'Public, earlier reference-experience excerpts; not generated agent experience.'}}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'instance_id': a.instance, **{k: v for k, v in result['admission'].items() if k != 'sameRepoVerification'}}))


if __name__ == '__main__':
    main()
