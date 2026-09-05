"""Independently check saved test verdicts, patches, model IDs and usage costs."""
import argparse
import ast
import collections
import gzip
import hashlib
import json
import sqlite3
from pathlib import Path


def raw(path):
    return path.read_bytes() if path.exists() else gzip.decompress(Path(str(path) + '.gz').read_bytes())


def load(path):
    return json.loads(raw(path))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--evidence', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    pro = {r['instance_id']: r for r in load(a.runtime / 'pro-tables.json')}
    checked = {}
    mismatches = []
    for matrix_file in sorted((a.evidence / 'formal').glob('*/*/matrix.json')):
        matrix = load(matrix_file)
        if not matrix.get('complete'):
            continue
        for row in matrix['rows']:
            out = matrix_file.parent / row['artifactDirectory']
            if str(out) in checked:
                continue
            result = load(out / 'result.json')
            score = load(out / 'grading/score.json')
            if row['panel'] != 'pro' and (score.get('adapterVersion') != 'digest-alias-v2' or score.get('scorable') is not True):
                mismatches.append({'runId': row['runId'], 'field': 'legacy_or_unscorable_grading'})
                continue
            patch = raw(out / 'model.patch')
            task = row['instance_id']
            if row['panel'] == 'pro':
                case = pro[task]
                f2p, p2p = (ast.literal_eval(case[k]) if isinstance(case[k], str) else case[k] for k in ['fail_to_pass', 'pass_to_pass'])
                candidates = [load(f) for f in (a.evidence / 'pro-preflight').rglob('preflight.json')]
                reference = next(r for r in candidates if r['instance_id'] == task and r['strictReferencePass']
                                 and r.get('baseExecution', {}).get('imageDigest') == score['execution']['imageDigest'])
                before = reference['observedTests']['before']
                after = score['execution']['tests']
                scored_patch_sha = score['execution']['patchSha256']
            else:
                case = load(a.runtime / 'SWEContextBench/cases/SWEContextBench Full' / (task + '.json'))
                f2p, p2p = case['FAIL_TO_PASS'], case['PASS_TO_PASS']
                before = score['observedTests']['before']
                after = score['observedTests']['after']
                scored_patch_sha = score['patchSha256']
            initially_broken = {name for name, state in before.items() if state in ('FAILED', 'ERROR')}
            initially_passed = {name for name, state in before.items() if state == 'PASSED'}
            finally_passed = {name for name, state in after.items() if state == 'PASSED'}
            baseline = bool(f2p) and set(f2p) <= initially_broken and set(p2p) <= initially_passed
            success = baseline and (set(f2p) | set(p2p)) <= finally_passed
            regression = set(p2p) & initially_passed - finally_passed
            verdict = {'baselineValid': baseline, 'strictResolved': success,
                       'f2pPassed': sum(t in finally_passed for t in f2p), 'p2pPassed': sum(t in finally_passed for t in p2p)}
            for name, actual in verdict.items():
                if score[name] != actual:
                    mismatches.append({'runId': row['runId'], 'field': name})
            if set(score['regressions']) != regression or bool(row['strictResolved']) != success:
                mismatches.append({'runId': row['runId'], 'field': 'row_or_regressions'})
            if hashlib.sha256(patch).hexdigest() != result['patch_sha256'] or hashlib.sha256(patch).hexdigest() != scored_patch_sha:
                mismatches.append({'runId': row['runId'], 'field': 'patch_digest'})
            trajectory = load(out / 'trajectory.json')
            observed_models = collections.Counter()
            for message in trajectory['messages']:
                response = message.get('extra', {}).get('response')
                if isinstance(response, dict):
                    observed_models[response.get('model')] += 1
            allowed = {row['model'], 'openai/' + row['model']}
            if not observed_models or any(name not in allowed for name in observed_models):
                mismatches.append({'runId': row['runId'], 'field': 'actual_model', 'observed': dict(observed_models)})
            if (result.get('environment_probe', {}).get('output', '').splitlines() or [''])[0] != case['base_commit']:
                mismatches.append({'runId': row['runId'], 'field': 'initial_commit'})
            checked[str(out)] = {'runId': row['runId'], 'strictResolved': success, 'actualModels': dict(observed_models),
                                 'trajectorySha256': hashlib.sha256(raw(out / 'trajectory.json')).hexdigest()}
    con = sqlite3.connect('file:' + str(a.ledger.resolve()) + '?mode=ro', uri=True)
    calls = 0
    for call_id, state, reserved, charged, usage, model in con.execute('SELECT id,state,reserved,charged,usage,model FROM calls'):
        if state != 'settled':
            continue
        calls += 1
        u = json.loads(usage)
        expected = reserved
        if 'prompt_tokens' in u and 'completion_tokens' in u:
            prompt, output = u['prompt_tokens'], u['completion_tokens']
            cached = u.get('prompt_cache_hit_tokens', (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)) or 0
            cached = min(prompt, max(0, cached))
            if model == 'deepseek-v4-flash':
                expected = ((prompt - cached) * 3 + cached * .1 + output * 9) / 1_000_000
            elif model == 'MiniMax-M3':
                expected = ((prompt - cached) * 2.1 + cached * .42 + output * 8.4) / 1_000_000 * (2 if prompt > 512000 else 1)
            else:
                mismatches.append({'callId': call_id, 'field': 'unpriced_model'})
        if abs(expected - charged) > 1e-8:
            mismatches.append({'callId': call_id, 'field': 'usage_charge'})
    result = {'status': 'passed' if not mismatches else 'failed', 'completeMatrixExecutionsChecked': len(checked),
              'settledRequestsChecked': calls, 'mismatchCount': len(mismatches), 'mismatches': mismatches,
              'note': 'Checks saved complete matrices only; a passing integrity check does not mean the overall experiment is complete.',
              'executions': checked}
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ['status', 'completeMatrixExecutionsChecked', 'settledRequestsChecked', 'mismatchCount']}))
    raise SystemExit(bool(mismatches))


if __name__ == '__main__':
    main()
