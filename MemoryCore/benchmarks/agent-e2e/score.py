"""Independent official execution plus strict repair-and-regression scoring."""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


def strict_grade(case, before, after):
    f2p, p2p = case['FAIL_TO_PASS'], case['PASS_TO_PASS']
    baseline_valid = bool(f2p) and all(before.get(t) in {'FAILED', 'ERROR'} for t in f2p) and all(before.get(t) == 'PASSED' for t in p2p)
    repaired = [t for t in f2p if after.get(t) == 'PASSED']
    preserved = [t for t in p2p if after.get(t) == 'PASSED']
    return {
        'baselineValid': baseline_valid,
        'strictResolved': baseline_valid and len(repaired) == len(f2p) and len(preserved) == len(p2p),
        'f2pPassed': len(repaired), 'f2pTotal': len(f2p),
        'p2pPassed': len(preserved), 'p2pTotal': len(p2p),
        'regressions': [t for t in p2p if before.get(t) == 'PASSED' and after.get(t) != 'PASSED'],
        'missingAfter': [t for t in f2p + p2p if t not in after],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--instance', required=True)
    p.add_argument('--patch', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--preflight', type=Path, required=True)
    a = p.parse_args()
    reference = json.loads(a.preflight.read_text())
    if not reference['strictReferencePass']:
        raise RuntimeError('Reference preflight failed; task is not scorable')
    a.output.mkdir(parents=True, exist_ok=True)
    if (a.output / 'score.json').exists():
        print('Existing score retained')
        return
    sys.path.insert(0, str(a.runtime / 'SWEContextBench'))
    from swebench_memory.harness import run_evaluation as official
    if reference.get('imageDigests'):
        def pinned_image(instance_id, auto_pull=True):
            if instance_id != a.instance:
                raise RuntimeError('Unexpected instance requested by verifier')
            return reference['imageDigests'][0]
        official.find_docker_image = pinned_image
    if reference.get('network'):
        from verifier_network import install
        install(official, reference['network'])
    observed = {}
    original = official.compare_results

    def capture(before, after, f2p, p2p):
        observed.update(before=before, after=after)
        return original(before, after, f2p, p2p)

    official.compare_results = capture
    case_path = a.runtime / 'SWEContextBench/cases/SWEContextBench Full' / (a.instance + '.json')
    case = json.loads(case_path.read_text())
    if hashlib.sha256(case_path.read_bytes()).hexdigest() != reference['caseSha256']:
        raise RuntimeError('Dataset changed since reference preflight')
    patch = a.patch.read_text() if a.patch.exists() else ''
    started = time.time()
    if patch.strip():
        report = official.evaluate_instance(case, {'model_patch': patch, 'model_name_or_path': 'tdai-real-agent'},
                                           'tdai-' + hashlib.sha256(str(a.output).encode()).hexdigest()[:16],
                                           a.output / 'official', remove_instance_image=False)
    else:
        report = {'resolved': False, 'patch_applied': False, 'emptySubmission': True}
    # A failed application is a coding failure, with the unchanged validated base.
    before = observed.get('before', reference['observedTests']['before'])
    after = observed.get('after', before if not report.get('patch_applied') else {})
    result = {'instance_id': a.instance, 'officialResolved': bool(report.get('resolved')),
              **strict_grade(case, before, after), 'officialReport': report,
              'observedTests': {'before': before, 'after': after},
              'patchSha256': hashlib.sha256(patch.encode()).hexdigest(),
              'elapsedSeconds': time.time() - started}
    (a.output / 'score.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ['instance_id', 'officialResolved', 'strictResolved', 'f2pPassed', 'p2pPassed', 'elapsedSeconds']}))


if __name__ == '__main__':
    main()
