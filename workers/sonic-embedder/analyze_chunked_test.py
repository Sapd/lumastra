#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fast tests for analyze_chunked.py's helpers. They run on the plain CI python3 (numpy is
stubbed when missing); the numpy-backed ones skip there. The end-to-end proof that the
chunked output equals the whole-track output is analyze_golden_test.py, which needs the
audio stack and therefore runs inside the sidecar image, not in CI.

Run: python3 -m unittest analyze_chunked_test -v
"""

import importlib.util
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HAVE_NUMPY = importlib.util.find_spec("numpy") is not None


def _import():
    if HAVE_NUMPY:
        import analyze_chunked
        return analyze_chunked
    with mock.patch.dict(sys.modules, {"numpy": mock.MagicMock()}):
        sys.modules.pop("analyze_chunked", None)
        import analyze_chunked
    sys.modules.pop("analyze_chunked", None)
    return analyze_chunked


ac = _import()


class ChunkRangesTest(unittest.TestCase):
    def test_pieces_cover_the_range_in_order_without_single_columns(self):
        for total in list(range(0, 40)) + [1000, 1001, 2583, 5167, 5168, 180686]:
            for size in (2, 3, 7, 64, 1001, 2583):
                with self.subTest(total=total, size=size):
                    pieces = ac.chunk_ranges(total, size)
                    if total == 0:
                        self.assertEqual(pieces, [])
                        continue
                    self.assertEqual(pieces[0][0], 0)
                    self.assertEqual(pieces[-1][1], total)
                    for (a, b), (c, _d) in zip(pieces, pieces[1:]):
                        self.assertEqual(b, c)
                    for a, b in pieces:
                        self.assertGreater(b, a)
                        if total > 1:
                            self.assertGreaterEqual(b - a, 2)  # numpy sums 1 column differently
                        self.assertLessEqual(b - a, max(size, 2) + max(size, 2) // 2 + 1)

    def test_n_frames_matches_a_centred_stft(self):
        self.assertEqual(ac.n_frames(0, 512), 1)
        self.assertEqual(ac.n_frames(511, 512), 1)
        self.assertEqual(ac.n_frames(512, 512), 2)
        self.assertEqual(ac.n_frames(44100 * 60, 512), 5168)  # 1 + 2646000 // 512


@unittest.skipUnless(HAVE_NUMPY, "needs numpy")
class NumpyHelpersTest(unittest.TestCase):
    def test_padded_segment_pads_like_a_centred_call(self):
        import numpy as np

        y = np.arange(1, 11, dtype=np.float32)
        padded_c = np.pad(y, (4, 4), mode="constant")
        padded_e = np.pad(y, (4, 4), mode="edge")
        for lo, hi in ((-4, 6), (-2, 14), (3, 9), (0, 10), (5, 14), (-4, 14)):
            with self.subTest(lo=lo, hi=hi):
                np.testing.assert_array_equal(ac.padded_segment(y, lo, hi, "constant"), padded_c[lo + 4 : hi + 4])
                np.testing.assert_array_equal(ac.padded_segment(y, lo, hi, "edge"), padded_e[lo + 4 : hi + 4])

    def test_danceability_lags_equal_the_full_correlation(self):
        import numpy as np

        rng = np.random.default_rng(7)
        for n in (8, 9, 399, 400, 401, 5000, 50000):
            with self.subTest(n=n):
                oe = rng.standard_normal(n).astype(np.float32)
                full = np.correlate(oe, oe, mode="full")[oe.size - 1 :][:400]
                np.testing.assert_array_equal(ac.danceability_autocorr(oe, 400), full)


if __name__ == "__main__":
    unittest.main()
