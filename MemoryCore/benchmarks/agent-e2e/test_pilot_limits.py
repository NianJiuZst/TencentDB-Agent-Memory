"""Reject old-limit executions and incomplete reference reuse after amendment."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pilot_support import prior_reference_paths, sha, validate_reuse


class LimitAmendmentTests(unittest.TestCase):
    def test_identical_input_does_not_allow_old_step_or_time_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml'
            config.parent.mkdir(parents=True)
            config.write_text('fixed upstream')
            task = {'instance_id': 'example__repo-1', 'image': 'example:fixed'}
            (root / 'agent-input.json').write_text(json.dumps(task))
            (root / 'result.json').write_text(json.dumps({'input_sha256': sha(root / 'agent-input.json'), 'upstream_config_sha256': sha(config)}))
            for steps, seconds in [(80, 1200), (80, 1800), (160, 1200)]:
                with self.subTest(steps=steps, seconds=seconds):
                    (root / 'trajectory.json').write_text(json.dumps({'info': {'config': {'agent': {'step_limit': steps, 'wall_time_limit_seconds': seconds}, 'model': {}, 'environment': {}}}}))
                    with self.assertRaisesRegex(RuntimeError, 'different step/time limits'):
                        validate_reuse(root, task, root, {'steps': 160, 'seconds': 1800})

    def test_reference_without_final_decision_is_not_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pending = root / 'pilot-30/references/interrupted/preflight.json'
            pending.parent.mkdir(parents=True)
            pending.write_text('{"strictReferencePass": false}')
            with patch('pilot_support.load', return_value={'priorReferenceDirectories': ['pilot-30']}):
                self.assertEqual(prior_reference_paths(root), [])


if __name__ == '__main__':
    unittest.main()
