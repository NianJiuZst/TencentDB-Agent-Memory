import unittest
from analyze_pilot import exact_mcnemar


class PairedInferenceTests(unittest.TestCase):
    def test_one_or_two_net_wins_are_not_stable_evidence(self):
        self.assertEqual(exact_mcnemar(0, 0), 1)
        self.assertEqual(exact_mcnemar(1, 0), 1)
        self.assertEqual(exact_mcnemar(2, 0), .5)
        self.assertAlmostEqual(exact_mcnemar(6, 0), .03125)
        self.assertEqual(exact_mcnemar(6, 2), exact_mcnemar(2, 6))


if __name__ == '__main__':
    unittest.main()
