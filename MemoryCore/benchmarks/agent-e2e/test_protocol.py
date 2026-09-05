"""Proof that unavailable tests, regressions and concurrent spending fail closed."""
import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from budget import Budget
from score import strict_grade
from extract_version_history import EXTRACTOR
from run_task_matrix import semantic_input_key
from timestamps import aware_timestamp


class ProtocolTests(unittest.TestCase):
    case = {'FAIL_TO_PASS': ['fix'], 'PASS_TO_PASS': ['old']}

    def test_embedded_extractor_is_valid_source_without_control_characters(self):
        import ast
        ast.parse(EXTRACTOR)
        self.assertFalse(any(ord(c) < 32 and c not in '\n\r\t' for c in EXTRACTOR))

    def test_reuse_requires_full_semantic_identity(self):
        base = {'instance_id': 'x', 'problem_statement': 'fix x', 'context': '', 'image': 'same', 'base_commit': 'a'}
        self.assertEqual(semantic_input_key(base | {'memory_arm': 'none', 'run_id': '1'}), semantic_input_key(base | {'memory_arm': 'optimized', 'run_id': '2'}))
        for changed in [{'problem_statement': 'fix y'}, {'image': 'different'}, {'base_commit': 'b'}, {'context': 'extra'}]:
            self.assertNotEqual(semantic_input_key(base), semantic_input_key(base | changed))

    def test_ambiguous_history_dates_are_not_assumed_to_be_past(self):
        self.assertIsNone(aware_timestamp('2022-08-01'))
        self.assertIsNone(aware_timestamp('2022-08-01T10:00:00'))
        self.assertEqual(aware_timestamp('2022-08-01T10:00:00+08:00'), aware_timestamp('2022-08-01T02:00:00Z'))

    def test_regression_is_not_success(self):
        r = strict_grade(self.case, {'fix': 'FAILED', 'old': 'PASSED'}, {'fix': 'PASSED', 'old': 'FAILED'})
        self.assertFalse(r['strictResolved'])
        self.assertEqual(r['regressions'], ['old'])

    def test_missing_or_skipped_tests_never_count_as_pass(self):
        for status in ['MISSING', 'SKIPPED', 'ERROR', 'TIMEOUT']:
            r = strict_grade(self.case, {'fix': 'FAILED', 'old': 'PASSED'}, {'fix': 'PASSED', 'old': status})
            self.assertFalse(r['strictResolved'])
        self.assertFalse(strict_grade(self.case, {'fix': 'FAILED', 'old': 'PASSED'}, {'fix': 'PASSED'})['strictResolved'])

    def test_reference_must_prove_original_bug(self):
        self.assertFalse(strict_grade(self.case, {'fix': 'PASSED', 'old': 'PASSED'}, {'fix': 'PASSED', 'old': 'PASSED'})['strictResolved'])
        self.assertTrue(strict_grade(self.case, {'fix': 'FAILED', 'old': 'PASSED'}, {'fix': 'PASSED', 'old': 'PASSED'})['strictResolved'])

    def test_concurrent_reservation_and_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'budget.sqlite'
            budget = Budget(path, .05)
            def attempt(_):
                try:
                    return budget.reserve('same-experiment', 0, 0)
                except RuntimeError:
                    return None
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                reservations = list(pool.map(attempt, range(16)))
            self.assertEqual(sum(r is not None for r in reservations), 4)
            restored = Budget(path, .05)
            with self.assertRaises(RuntimeError):
                restored.reserve('after-crash', 0, 0)
            self.assertAlmostEqual(restored.summary()['unsettledReservationsCny'], .049152)

    def test_null_cache_details_and_unknown_usage(self):
        with tempfile.TemporaryDirectory() as d:
            b = Budget(Path(d) / 'budget.sqlite', 1)
            key, reserved = b.reserve('r', 1000, 100)
            charged = b.settle(key, reserved, {'prompt_tokens': 100, 'completion_tokens': 10, 'prompt_tokens_details': None})
            self.assertAlmostEqual(charged, .00039)
            key, reserved = b.reserve('interrupted-request', 1000, 100)
            self.assertEqual(b.settle(key, reserved), reserved)


if __name__ == '__main__':
    unittest.main()
