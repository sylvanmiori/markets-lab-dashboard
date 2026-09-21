"""Regression: SEP21 complement poison — buy_yes@6 must not become buy_no@94."""
import unittest

from box_publisher.kalshi_labels import cash_delta_usd, label_fill, label_resting_order


class Sep21ComplementPoison(unittest.TestCase):
    """Kalshi echoes both prices; side must come from outcome_side/side."""

    def test_buy_yes_at_6_not_buy_no_at_94(self):
        row = {
            "action": "buy",
            "side": "yes",
            "outcome_side": "yes",
            "yes_price_dollars": "0.0600",
            "no_price_dollars": "0.9400",
            "count_fp": "20",
        }
        price_c, side_l = label_fill(row)
        self.assertEqual(side_l, "buy_yes")
        self.assertEqual(price_c, 6)
        self.assertAlmostEqual(cash_delta_usd(side_l, price_c, 20), -1.20)

    def test_genuine_buy_no_still_works(self):
        row = {
            "action": "buy",
            "side": "no",
            "outcome_side": "no",
            "yes_price_dollars": "0.26",
            "no_price_dollars": "0.74",
            "count_fp": "6",
        }
        price_c, side_l = label_fill(row)
        self.assertEqual(side_l, "buy_no")
        self.assertEqual(price_c, 74)
        self.assertAlmostEqual(cash_delta_usd(side_l, price_c, 6), -4.44)

    def test_sell_yes_ok(self):
        row = {
            "action": "sell",
            "side": "yes",
            "outcome_side": "yes",
            "yes_price_dollars": "0.11",
            "no_price_dollars": "0.89",
            "count_fp": "20",
        }
        price_c, side_l = label_fill(row)
        self.assertEqual(side_l, "sell_yes")
        self.assertEqual(price_c, 11)
        self.assertAlmostEqual(cash_delta_usd(side_l, price_c, 20), 2.20)

    def test_resting_buy_yes_not_buy_no(self):
        row = {
            "action": "buy",
            "side": "yes",
            "outcome_side": "yes",
            "book_side": "bid",
            "yes_price_dollars": "0.0600",
            "no_price_dollars": "0.9400",
            "remaining_count_fp": "20",
        }
        side_l, price_c = label_resting_order(row)
        self.assertEqual(side_l, "buy_yes")
        self.assertEqual(price_c, 6)

    def test_max_price_heuristic_would_poison(self):
        """Document the bug: max(no, yes) would pick buy_no@94."""
        yes_c, no_c = 6, 94
        self.assertGreater(no_c, yes_c)  # old bug used this to pick buy_no


if __name__ == "__main__":
    unittest.main()
