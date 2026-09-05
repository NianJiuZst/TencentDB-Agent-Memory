"""Post-run qualitative check of the unchanged example in xarray issue 7068.

This is one explanatory case, not an additional benchmark endpoint. It never
changes a task score, task selection, agent input, or submitted patch.
"""
import argparse
import json
import re
import subprocess
import uuid
from pathlib import Path

from pilot_support import load, now, pilot_root, sha, write

WORKER = '''import json,subprocess,sys,traceback
p=json.load(sys.stdin)
subprocess.run(["git","checkout","--detach",p["base_commit"]],check=True,capture_output=True)
subprocess.run(["git","diff","--exit-code"],check=True,capture_output=True)
if p["patch"]:
    subprocess.run(["git","apply","-"],input=p["patch"],text=True,check=True,capture_output=True)
try:
    exec(compile(p["example"],"<unchanged-public-issue-example>","exec"),{})
    print(json.dumps({"examplePassed":True}))
except Exception as e:
    print(json.dumps({"examplePassed":False,"exceptionType":type(e).__name__}))
    traceback.print_exc()
    sys.exit(1)
'''

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    task = 'pydata__xarray-7068'
    evidence = args.evidence.resolve()
    pilot = pilot_root(evidence)
    if not (pilot / 'pairs' / task / 'pair.json').exists():
        raise RuntimeError('Run this only after both original agent executions finish')
    case_path = args.runtime / 'SWEContextBench/cases/SWEContextBench Full' / (task + '.json')
    case = load(case_path)
    example = re.search(r'```Python\s*\n(.*?)```', case['problem_statement'], re.S).group(1)
    if 'assert res.coords["x"].attrs["units"] == "m"' not in example:
        raise RuntimeError('The expected unmodified public example changed')
    reference = load(pilot / 'references' / task / 'preflight.json')
    if not reference['strictReferencePass'] or reference['caseSha256'] != sha(case_path):
        raise RuntimeError('Reference proof mismatch')
    image = reference['imageDigests'][0]
    patch_path = pilot / 'runs' / task / 'optimized/model.patch'
    out = pilot / 'qualitative-notes/xarray-minimal-example'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'issue-example.py').write_text(example)
    record = {'createdAtUtc': now(), 'instance_id': task, 'image': image,
              'caseSha256': sha(case_path), 'exampleSha256': sha(out / 'issue-example.py'),
              'submittedPatchSha256': sha(patch_path), 'scriptSha256': sha(Path(__file__)),
              'purpose': 'Post-run explanation of one failed task; no aggregate score changes or causal inference.',
              'modelCalls': 0, 'results': {}}
    for label, patch in [('baseline', ''), ('submitted_optimized', patch_path.read_text()),
                         ('reference', case['patch'])]:
        payload = {'base_commit': case['base_commit'], 'patch': patch, 'example': example}
        container = 'tdai-issue-example-' + uuid.uuid4().hex[:10]
        command = ['docker', 'run', '--rm', '--name', container, '--network', 'none',
                   '--platform', 'linux/amd64', '--cpus', '1.5', '--memory', '2g',
                   '--pids-limit', '512', '-i', '-w', '/testbed', '--entrypoint', 'python', image, '-c', WORKER]
        try:
            result = subprocess.run(command, input=json.dumps(payload), text=True,
                                    capture_output=True, timeout=120)
            record['results'][label] = {'returncode': result.returncode,
                                       'stdout': result.stdout, 'stderr': result.stderr}
            write(out / 'result.json', record)
        finally:
            subprocess.run(['docker', 'rm', '-f', container], capture_output=True, timeout=30)
    before = record['results']['baseline']
    gold = record['results']['reference']
    record['validExampleProbe'] = (before['returncode'] == 1 and '"exceptionType": "AssertionError"' in before['stdout']
                                  and gold['returncode'] == 0 and '"examplePassed": true' in gold['stdout'])
    write(out / 'result.json', record)
    print(json.dumps({'validExampleProbe': record['validExampleProbe'],
                      'returncodes': {k: v['returncode'] for k, v in record['results'].items()}}))
