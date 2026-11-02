#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Tests for the crop choice in windowed_embed.py.

The bounded /embed decode must draw its crop exactly like msclap 1.3.4: a start from
random.randrange(C*N - W) over the flattened channels, N the length of torchaudio's
44.1 kHz resample. That keeps stored embeddings comparable without a re-embed. The
decode itself was checked on preprod against msclap sample for sample (see the module
docstring); these pin the arithmetic, on the plain CI python3.

Run: python3 -m unittest windowed_embed_test -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import windowed_embed as we  # noqa: E402
from windowed_embed import WINDOW, AudioInfo  # noqa: E402


class FixedRng:
    def __init__(self, value):
        self.value = value
        self.seen = None

    def randrange(self, n):
        self.seen = n
        return self.value


class ResampledLengthTest(unittest.TestCase):
    def test_matches_torchaudio_ceil(self):
        # torchaudio: ceil(new_freq * length / orig_freq) after dividing by the gcd.
        self.assertEqual(we.resampled_length(48000, 44100), 48000)
        self.assertEqual(we.resampled_length(48000, 48000), 44100)
        self.assertEqual(we.resampled_length(1, 48000), 1)
        self.assertEqual(we.resampled_length(161, 48000), 148)  # ceil(161 * 147 / 160)


class ResamplerFeasibilityTest(unittest.TestCase):
    def test_common_rates_pass_odd_ones_are_refused(self):
        for sr in (8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000):
            self.assertTrue(we.resampler_is_feasible(sr), sr)
        # gcd 1 with 44100: torchaudio would build a kernel of ~2e9 floats.
        self.assertFalse(we.resampler_is_feasible(44101))
        self.assertFalse(we.resampler_is_feasible(47999))


class ChooseStartTest(unittest.TestCase):
    def test_draws_over_the_flattened_channels_like_msclap(self):
        info = AudioInfo(duration_s=100.0, sample_rate=44100, channels=2)
        n = 100 * 44100
        rng = FixedRng(n + 5)
        self.assertEqual(we.choose_start(info, rng), (1, 5))
        self.assertEqual(rng.seen, 2 * n - WINDOW)

    def test_uses_the_resampled_length(self):
        info = AudioInfo(duration_s=60.0, sample_rate=48000, channels=2)
        n = we.resampled_length(60 * 48000, 48000)
        self.assertEqual(n, 60 * 44100)
        rng = FixedRng(0)
        we.choose_start(info, rng)
        self.assertEqual(rng.seen, 2 * n - WINDOW)

    def test_short_files_keep_msclaps_path(self):
        self.assertIsNone(we.choose_start(AudioInfo(29.9, 44100, 2), FixedRng(0)))
        self.assertIsNotNone(we.choose_start(AudioInfo(30.0, 44100, 2), FixedRng(0)))


if __name__ == "__main__":
    unittest.main()
