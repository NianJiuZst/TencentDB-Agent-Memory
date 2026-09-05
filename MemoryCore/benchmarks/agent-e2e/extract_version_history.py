"""Collect real, pre-fix source observations from Git history for a separate extension.

This is a workspace-resumption protocol, not the unmodified public leaderboard:
all arms share an initial source inspection; only its persisted memory differs.
No target reference or hidden tests enter this extractor.
"""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

EXTRACTOR = r'''
import collections, hashlib, json, math, pathlib, re, subprocess, sys
request=json.load(sys.stdin)
root=pathlib.Path('/testbed')
def git(*args):
 return subprocess.check_output(['git',*args],cwd=root,stderr=subprocess.DEVNULL).decode('utf-8','replace')
head=git('rev-parse','HEAD').strip()
assert head==request['base_commit']
stop=set('the and that this with from have when then does not should would could into are for you use using can error expected actual result code file line return none true false python issue test tests self def class import github com org request requests'.split())
words=[w.lower() for w in re.findall(r'[A-Za-z_][A-Za-z_0-9]{3,}',request['problem_statement']) if w.lower() not in stop]
query=collections.Counter(words)
terms=[k for k,v in query.most_common(40)]
paths=git('ls-files','*.py').splitlines()
documents=[]
for path in paths:
 if any(part.lower().startswith(('test','doc','example','benchmark')) for part in pathlib.PurePosixPath(path).parts):continue
 if pathlib.PurePosixPath(path).name in ('setup.py','conftest.py'):continue
 try:
  file=root/path
  if file.is_symlink() or file.stat().st_size>512000:continue
  text=file.read_text(errors='replace')
 except (OSError,ValueError):continue
 counts={t:len(re.findall(r'\b'+re.escape(t)+r'\b',text.lower())) for t in terms}
 documents.append((path,text,counts))
idf={t:math.log(1+len(documents)/(1+sum(bool(c[t]) for _,_,c in documents))) for t in terms}
def score(text):
 lower=text.lower()
 return sum(min(8,len(re.findall(r'\b'+re.escape(t)+r'\b',lower)))*idf[t] for t in terms)
ranked=sorted(documents,key=lambda d:(-sum(min(8,d[2][t])*idf[t] for t in terms),d[0]))[:3]
def excerpt(text):
 lines=text.splitlines(); windows=[(score('\n'.join(lines[i:i+40])),i) for i in range(0,max(1,len(lines)),10)]
 _,start=max(windows,key=lambda x:(x[0],-x[1]))
 return start+1,'\n'.join(lines[start:start+40])[:4000]
observations=[]
for path,current,counts in ranked:
 variants=[(head,current)]
 seen={hashlib.sha256(current.encode()).hexdigest()}
 for commit in git('log','-n','18','--format=%H','HEAD','--',path).splitlines():
  if commit==head:continue
  try:old=git('show',commit+':'+path)
  except subprocess.CalledProcessError:continue
  digest=hashlib.sha256(old.encode()).hexdigest()
  if digest in seen:continue
  seen.add(digest);variants.append((commit,old))
  if len(variants)==6:break
 for commit,text in variants:
  # Every source state must be an ancestor, never a future solution.
  assert subprocess.run(['git','merge-base','--is-ancestor',commit,head],cwd=root).returncode==0
  line,snippet=excerpt(text)
  observations.append({'path':path,'commit':commit,'date':git('show','-s','--format=%cI',commit).strip(),'line':line,'snippet':snippet,'fileSha256':hashlib.sha256(text.encode()).hexdigest(),'isCurrent':commit==head})
print(json.dumps({'head':head,'selection':'Top 3 non-test Python source files by bounded term-frequency/IDF over the public problem statement, 40-line best windows; current plus at most 5 distinct earlier file states','queryTerms':terms,'sourceFilesConsidered':len(documents),'observations':observations}))
'''


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', type=Path, required=True, help='Allowlisted agent input; never a full gold dataset row')
    p.add_argument('--repo', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    task = json.loads(a.input.read_text())
    payload = {k: task[k] for k in ['base_commit', 'problem_statement']}
    started = time.perf_counter()
    run = subprocess.run(['docker', 'run', '--rm', '-i', '--platform', 'linux/amd64', '--network', 'none',
                          '--cpus', '1', '--memory', '2g', task['image'], 'python', '-c', EXTRACTOR],
                         input=json.dumps(payload), text=True, capture_output=True, timeout=300, check=True)
    observed = json.loads(run.stdout)
    repository_id = 'repo-' + hashlib.sha256(a.repo.encode()).hexdigest()[:24]
    records = []
    for row in observed['observations']:
        identity = row['commit'] + ':' + row['path']
        records.append({'id': 'source-' + hashlib.sha256(identity.encode()).hexdigest()[:24],
                        'source_task_id': 'git-observation:' + identity, 'created_at': row['date'],
                        'content': 'Observed source in repository ' + a.repo + ', file ' + row['path'] +
                                   ', starting at line ' + str(row['line']) + ':\n' + row['snippet'],
                        'versionContext': {'schemaVersion': 1, 'repositoryId': repository_id,
                                           'scopeLevel': 'branch', 'branch': 'HEAD', 'commitSha': row['commit'], 'source': 'imported'}})
    current = {'schemaVersion': 1, 'repositoryId': repository_id, 'scopeLevel': 'branch',
               'branch': 'HEAD', 'commitSha': task['base_commit'], 'source': 'explicit'}
    result = {'tasks': [{'instance_id': task['instance_id'], 'query': task['problem_statement'],
                         'current': current, 'records': records}], 'observations': observed,
              'sourceInspectionSeconds': time.perf_counter() - started,
              'protocol': 'Historical-source workspace-resumption extension; report separately from the public benchmark',
              'sourceInspectionSharedAcrossArms': True, 'targetReferenceOrHiddenTestsRead': False,
              'extractorSha256': hashlib.sha256(EXTRACTOR.encode()).hexdigest()}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'instance_id': task['instance_id'], 'records': len(records),
                      'currentRecords': sum(r['isCurrent'] for r in observed['observations'])}))


if __name__ == '__main__':
    main()
