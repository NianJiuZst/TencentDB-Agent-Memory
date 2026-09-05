"""Audit public task tables and freeze a model-independent task selection."""
import argparse, collections, hashlib, json
from pathlib import Path
import pyarrow.parquet as pq

p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
tables={name:pq.read_table(a.runtime/f'SWEContextBench_{name}.parquet').to_pylist() for name in ['Experience','Related','Relationship','Lite_Experience','Related_Lite']}
cases={p.stem:json.loads(p.read_text()) for p in (a.runtime/'SWEContextBench/cases/SWEContextBench Full').glob('*.json')}
related={r['instance_id']:r for r in tables['Related']}
experience={r['instance_id']:r for r in tables['Experience']}
# A deterministic selection is frozen before any model result is observed.
# Restrict the primary cohort to Python to share a reproducible runtime family.
python_repos={'django/django','sympy/sympy','matplotlib/matplotlib','sphinx-doc/sphinx','scikit-learn/scikit-learn','pydata/xarray','astropy/astropy','psf/requests','pytest-dev/pytest','pylint-dev/pylint','mwaskom/seaborn','pallets/flask'}
by_repo=collections.defaultdict(list)
excluded=[]
for task_id,r in related.items():
 if task_id not in cases: excluded.append({'instance_id':task_id,'reason':'no_official_case_json'});continue
 if r['repo'] not in python_repos: continue
 c=cases[task_id]
 if not c.get('FAIL_TO_PASS'):excluded.append({'instance_id':task_id,'reason':'no_fail_to_pass_tests'});continue
 if task_id=='psf__requests-5474':continue # environment/model smoke, held out from formal cohort
 by_repo[r['repo']].append(task_id)
for ids in by_repo.values():ids.sort(key=lambda x:hashlib.sha256(('20260905|'+x).encode()).hexdigest())
selected=[]
while len(selected)<100 and any(by_repo.values()):
 for repo in sorted(by_repo):
  if by_repo[repo] and len(selected)<100:selected.append(by_repo[repo].pop(0))
selection=[]
for tid in selected:
 c=cases[tid];past=[e for eid,e in experience.items() if eid not in related and e['repo']==c['repo'] and e.get('created_at','') and e['created_at']<c.get('created_at','')]
 selection.append({'instance_id':tid,'repo':c['repo'],'base_commit':c['base_commit'],'created_at':c.get('created_at'),'f2p':len(c['FAIL_TO_PASS']),'p2p':len(c['PASS_TO_PASS']),'eligible_past_experiences':len(past),'image':f"jiayuanz3/swecontextbench:{tid.replace('__','.').lower()}"})
manifest={'dataset':'jiayuanz3/SWEContextBench','revision':json.loads((a.runtime/'dataset-info.json').read_text())['sha'],'tableCounts':{k:len(v) for k,v in tables.items()},'tableColumns':{k:list(v[0]) if v else [] for k,v in tables.items()},'officialCaseJsonCount':len(cases),'excluded':excluded,'selectionMethod':'Repository round-robin over SHA256(20260905|instance_id), Python cohort, smoke task excluded; no model results used.','selected':selection,'hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(a.runtime.glob('*.parquet'))}}
(a.output/'dataset-audit.json').write_text(json.dumps(manifest,indent=2)+'\n')
(a.runtime/'tables.json').write_text(json.dumps(tables))
print(json.dumps({'counts':manifest['tableCounts'],'columns':manifest['tableColumns'],'selected':len(selection),'repos':dict(collections.Counter(r['repo'] for r in selection)),'history_counts':dict(collections.Counter(min(r['eligible_past_experiences'],10) for r in selection))},indent=2))
