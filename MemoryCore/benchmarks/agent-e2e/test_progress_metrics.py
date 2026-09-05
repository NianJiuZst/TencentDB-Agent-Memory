import unittest

from analyze_pilot import repair_progress


class ProgressMetricsTests(unittest.TestCase):
    def test_unchanged_regression_tests_are_not_repair_progress(self):
        result = repair_progress({'bug'}, {'existing'}, {'existing'})
        self.assertEqual(result['targetRepairFraction'], 0)
        self.assertFalse(result['anyTargetRepair'])
        self.assertEqual(result['regressionTestPreservation'], 1)

    def test_partial_repair_is_distinct_from_full_target_repair(self):
        result = repair_progress({'bug1', 'bug2'}, {'existing'}, {'bug1', 'existing'})
        self.assertEqual(result['targetRepairFraction'], .5)
        self.assertTrue(result['partialTargetRepair'])
        self.assertFalse(result['targetRepairSuccess'])

    def test_target_repair_does_not_hide_a_regression(self):
        result = repair_progress({'bug'}, {'existing'}, {'bug'})
        self.assertTrue(result['targetRepairSuccess'])
        self.assertEqual(result['regressionTestPreservation'], 0)
        self.assertFalse(result['partialTargetRepair'])


if __name__ == '__main__':
    unittest.main()
