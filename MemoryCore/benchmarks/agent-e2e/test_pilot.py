import unittest

from run_pilot import selected_prefix


class SelectionTests(unittest.TestCase):
    def test_no_completion_order_or_model_result_selection(self):
        candidates = [{'instance_id': str(i), 'analysisCluster': str(i), 'rank': i} for i in range(35)]
        decisions = {str(i): {'eligible': True, 'agentSuccess': i % 2 == 0} for i in range(35) if i != 2}
        self.assertEqual(len(selected_prefix(candidates, decisions)[0]), 2)
        decisions['2'] = {'eligible': False, 'agentSuccess': True}
        before = selected_prefix(candidates, decisions)[0]
        for value in decisions.values():
            value['agentSuccess'] = not value['agentSuccess']
        after = selected_prefix(candidates, decisions)[0]
        self.assertEqual(before, after)
        self.assertEqual(len(before), 30)
        self.assertEqual([r['instance_id'] for r in before], ['0', '1'] + [str(i) for i in range(3, 31)])

    def test_multiple_issue_variants_do_not_inflate_sample(self):
        rows = [{'instance_id': str(i), 'analysisCluster': 'same-pr' if i < 2 else str(i), 'rank': i} for i in range(4)]
        decisions = {str(i): {'eligible': True} for i in range(4)}
        selected, dispositions = selected_prefix(rows, decisions, 3)
        self.assertEqual([r['instance_id'] for r in selected], ['0', '2', '3'])
        self.assertEqual(dispositions[1]['status'], 'duplicate_repair_pr')


if __name__ == '__main__':
    unittest.main()
