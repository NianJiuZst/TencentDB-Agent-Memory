import unittest

from analyze_results import cluster_interval, summarize


class AnalysisTests(unittest.TestCase):
    def test_variants_share_a_repair_cluster(self):
        result = cluster_interval([('one-pr', 0), ('one-pr', 1), ('another-pr', 0)], draws=5000)
        self.assertEqual(result['clusters'], 2)
        self.assertAlmostEqual(result['mean'], 1 / 3)
        self.assertEqual(result['lower'], 0)
        self.assertEqual(result['upper'], .5)

    def test_aliases_do_not_inflate_execution_or_cost(self):
        rows = []
        for replicate in range(3):
            for arm in ['none', 'global', 'previous', 'optimized']:
                rows.append({'instance_id': 'task', 'repo': 'repo', 'analysisCluster': 'pr', 'arm': arm,
                             'replicate': replicate, 'strictResolved': arm == 'optimized', 'officialResolved': True,
                             'regressions': 0, 'peakPriceCny': 1, 'agentSeconds': 30,
                             'independentExecution': arm in ['none', 'optimized']})
        result = summarize(rows)
        self.assertEqual(result['independentExecutions'], 6)
        self.assertEqual(result['nominalAssignments'], 12)
        self.assertEqual(result['actualModelCny'], 6)
        self.assertEqual(result['comparisons']['optimized_vs_none']['passAt1Delta']['mean'], 1)
        self.assertEqual(result['comparisons']['optimized_vs_none']['improvedTasks'], 1)
        with self.assertRaises(ValueError):
            summarize(rows + [rows[0]])


if __name__ == '__main__':
    unittest.main()
