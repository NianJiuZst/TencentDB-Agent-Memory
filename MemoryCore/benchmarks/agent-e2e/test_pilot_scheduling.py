import itertools
import unittest
from run_pilot import guaranteed_selection, selected_prefix


class SchedulingTests(unittest.TestCase):
    def test_guaranteed_dispatch_is_selected_for_every_pending_reference_outcome(self):
        rows = [{'instance_id': str(i), 'analysisCluster': str(i // 2), 'rank': i} for i in range(10)]
        known = {'1': {'eligible': True}, '3': {'eligible': True}, '4': {'eligible': True}, '7': {'eligible': False}, '8': {'eligible': True}}
        guaranteed = {r['instance_id'] for r in guaranteed_selection(rows, known, 3)}
        unknown = [r['instance_id'] for r in rows if r['instance_id'] not in known]
        for outcomes in itertools.product([False, True], repeat=len(unknown)):
            completed = dict(known, **{task: {'eligible': result} for task, result in zip(unknown, outcomes)})
            selected = {r['instance_id'] for r in selected_prefix(rows, completed, 3)[0]}
            self.assertLessEqual(guaranteed, selected)
        self.assertEqual(guaranteed, {'4'})


if __name__ == '__main__':
    unittest.main()
