"""Inspect leakage and schema consistency before exposing past experience."""
import argparse
import ast
import collections
import hashlib
import json
from pathlib import Path
from timestamps import aware_timestamp


def audit(tables, cases):
    experience = {r['instance_id']: r for r in tables['Experience']}
    related = {r['instance_id']: r for r in tables['Related']}
    links = tables['Relationship']
    findings = collections.defaultdict(list)
    for table_name in ['Experience', 'Related']:
        grouped = collections.defaultdict(list)
        for row in tables[table_name]:
            grouped[row['instance_id']].append(row)
            if aware_timestamp(row.get('created_at')) is None:
                findings['ambiguous_timestamp_rows'].append({'table': table_name, 'instance_id': row['instance_id']})
        for task_id, rows in grouped.items():
            if len(rows) < 2:
                continue
            fields = [key for key in rows[0] if len({json.dumps(row[key], sort_keys=True) for row in rows}) > 1]
            if fields:
                findings['conflicting_duplicate_ids'].append({'table': table_name, 'instance_id': task_id, 'fields': fields})
    for link in links:
        tid, eid = link['related_instance_id'], link['experience_instance_id']
        target, prior = related.get(tid), experience.get(eid)
        if not target or not prior:
            findings['orphan_relationship'].append(link)
            continue
        if link['related_pr_url'] == link['experience_pr_url']:
            findings['same_pull_request'].append({'target': tid, 'experience': eid})
        if target['patch'] == prior['patch']:
            findings['identical_reference_patch'].append({'target': tid, 'experience': eid})
        if not prior.get('created_at') or not target.get('created_at') or prior['created_at'] >= target['created_at']:
            findings['experience_timestamp_not_earlier'].append({'target': tid, 'experience': eid})
    for tid, target in related.items():
        if tid not in cases:
            findings['no_official_case_json'].append(tid)
            continue
        for field in ['base_commit', 'patch', 'test_patch', 'problem_statement', 'FAIL_TO_PASS', 'PASS_TO_PASS']:
            lhs, rhs = target[field], cases[tid][field]
            if field in ['FAIL_TO_PASS', 'PASS_TO_PASS'] and isinstance(lhs, str):
                try:
                    lhs = json.loads(lhs)
                except json.JSONDecodeError:
                    lhs = ast.literal_eval(lhs)
            if lhs != rhs:
                findings['hf_official_case_mismatch'].append({'target': tid, 'field': field})
    return {
        'grain': 'One target programming task per Related.instance_id; Experience and Lite tables are not additional target runs.',
        'table_counts': {k: len(v) for k, v in tables.items()},
        'unique_task_counts': {name: len({r['instance_id'] for r in rows}) for name, rows in tables.items() if rows and 'instance_id' in rows[0]},
        'duplicate_ids': {name: [key for key, count in collections.Counter(r['instance_id'] for r in rows).items() if count > 1]
                          for name, rows in tables.items() if rows and 'instance_id' in rows[0]},
        'experience_target_id_overlap': sorted(experience.keys() & related.keys()),
        'relationship_count': len(links),
        'findings': dict(findings),
        'finding_counts': {k: len(v) for k, v in findings.items()},
        'interpretation': 'Relationships can describe the same PR or a later experience. This is a leakage risk for our independent future-task interpretation, not proof that the source benchmark violates its own task definition.',
        'policy': 'Use official case JSON for executable grading. Exclude target IDs, all target PRs, exact target reference patches, and non-earlier or timezone-ambiguous timestamps from past-memory candidates. For same-repository solution excerpts, additionally require the historical patch to reverse-apply cleanly to the untouched target base; otherwise omit it. Never expose target test/reference patches or hints_text.',
    }


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    tables = json.loads((a.runtime / 'tables.json').read_text())
    cases = {p.stem: json.loads(p.read_text()) for p in (a.runtime / 'SWEContextBench/cases/SWEContextBench Full').glob('*.json')}
    result = audit(tables, cases)
    a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ['table_counts', 'finding_counts']}, indent=2))
