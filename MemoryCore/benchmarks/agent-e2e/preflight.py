"""Run the official verifier against a real reference patch, without model calls."""
import argparse, fcntl, hashlib, json, os, subprocess, sys, time
from pathlib import Path
from score import strict_grade
p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--instance',required=True);p.add_argument('--network');a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
lockfile=(a.output/'.reference.lock').open('a')
fcntl.flock(lockfile,fcntl.LOCK_EX)
if (a.output/'preflight.json').exists():
 cached=json.loads((a.output/'preflight.json').read_text())
 print('Existing reference evidence retained')
 raise SystemExit(0 if cached['strictReferencePass'] else 2)
sys.path.insert(0,str(a.runtime/'SWEContextBench'))
from swebench_memory.harness import run_evaluation as official
if a.network:
 from verifier_network import install
 install(official,a.network)
evaluate_instance=official.evaluate_instance
observed={}
original_compare=official.compare_results
def capture_compare(before, after, f2p, p2p):
 observed.update(before=before, after=after)
 return original_compare(before,after,f2p,p2p)
official.compare_results=capture_compare
source=a.runtime/'SWEContextBench/cases/SWEContextBench Full'/f'{a.instance}.json'
case=json.loads(source.read_text());a.output.mkdir(parents=True,exist_ok=True)
started=time.time()
report=evaluate_instance(case,{'model_patch':case['patch'],'model_name_or_path':'reference-preflight'},'tdai-preflight-'+a.instance,a.output/'reference',remove_instance_image=False)
status=report.get('tests_status',{})
f2p=status.get('FAIL_TO_PASS',{});p2p=status.get('PASS_TO_PASS',{})
strict=bool(case['FAIL_TO_PASS']) and report.get('patch_applied') and len(f2p.get('success',[]))==len(case['FAIL_TO_PASS']) and not f2p.get('failure') and len(p2p.get('success',[]))==len(case['PASS_TO_PASS']) and not p2p.get('failure')
baseline_valid=bool(observed) and strict_grade(case, observed.get('before',{}), observed.get('after',{}))['baselineValid']
strict = strict and strict_grade(case, observed.get('before',{}), observed.get('after',{}))['strictResolved']
image='jiayuanz3/swecontextbench:'+a.instance.replace('__','.').lower()
probe=subprocess.run(['docker','image','inspect',image,'--format','{{json .RepoDigests}}'],capture_output=True,text=True)
result={'instance_id':a.instance,'strictReferencePass':bool(strict),'baselineValid':baseline_valid,'network':a.network,'observedTests':observed,'officialResolved':report.get('resolved',False),'elapsedSeconds':time.time()-started,'caseSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'image':image,'imageDigests':json.loads(probe.stdout) if probe.returncode==0 else [],'report':report,'note':'Official verifier runs held-out tests before and after applying the reference patch. No model is called, and the reference/test patch is never supplied to the task agent.'}
(a.output/'preflight.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['report','observedTests']},indent=2))
raise SystemExit(0 if strict else 2)
