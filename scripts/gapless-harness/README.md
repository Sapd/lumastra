# Gapless boundary harness

Measures what actually happens to the audio at an audiobook file boundary, in a
real browser, against the **shipped** `GaplessAdvanceScheduler`.

```bash
node scripts/gapless-harness/run.mjs                 # chromium, mp3 + m4a
node scripts/gapless-harness/run.mjs --engine=webkit # if the WebKit build is installed
node scripts/gapless-harness/run.mjs --format=mp3    # one container only
```

Needs `ffmpeg` on PATH and Playwright browsers installed. Everything else is
generated into `scripts/gapless-harness/.fixtures/` (gitignored).

## What it measures, and why the previous version could not

Prototype 4a measured **gaps** — silence at the join — and reported 0 ms for the
predictive A/B strategy on every engine. That number cannot distinguish a
perfect join from one that clipped the head off the incoming file: both are 0 ms
of silence. And a clipped head is not hypothetical, it is structural. The
incoming deck must ALREADY be rendering at the swap instant (that is the whole
difference between 0 ms and 21 ms), so by then it has consumed `leadMs` of its
own audio and nobody heard it.

So the fixtures changed. File A is a constant 440 Hz tone. **File B is a linear
chirp** whose instantaneous frequency rises 1000 Hz per second from 500 Hz. The
frequency heard at the join therefore says _where in B playback entered_:

```
contentLostMs = (frequencyAtJoin − 500 Hz) / 1000 Hz-per-s × 1000
```

500 Hz at the join → nothing lost. 650 Hz → 150 ms of B was never heard.

Frequency is estimated per window by zero crossings, then a straight line is
fitted across the whole post-join region and extrapolated back to the join
instant — so the answer comes from hundreds of windows rather than from the one
window that happens to straddle the boundary.

## Two controls, because one is not enough

The harness is unfalsifiable without them, which is the lesson from the first
version:

| Control            | Forces                              | Proves the instrument can see |
| ------------------ | ----------------------------------- | ----------------------------- |
| `control_gap_200`  | 200 ms of silence between the files | **gaps**                      |
| `control_clip_200` | B started 200 ms in, no silence     | **content loss**              |

`control_clip_200` is the new one. If it does not report ≈200 ms lost, the
content-loss column means nothing that run and the numbers should be thrown
away — exactly as a `control_gap_200` that does not report ≈200 ms of silence
invalidates the gap column.

## Measured, 2026-07-29, headless Chromium on an M-series Mac, localhost

```
format strategy               gap(ms)  lost(ms)  join(ms)    slope     r²
mp3    control_gap_200          206.0      13.5    3208.0      986  0.979
mp3    control_clip_200          29.3     208.8    3027.3      986  0.979
mp3    naive_ended                5.3      14.0    3004.7      985  0.977
mp3    predictive_lead_50         0.0      36.6    3000.0      992  0.989
mp3    predictive_lead_150        0.0     136.9    2998.7      990  0.987
mp3    predictive_lead_250        0.0     240.8    3000.7      989  0.985
m4a    control_gap_200          223.3       5.0    3225.3      994  0.995
m4a    control_clip_200          23.3     202.1    3021.3      994  0.993
m4a    naive_ended               23.3       3.4    3022.7      995  0.994
m4a    predictive_lead_50         0.0      34.9    3000.7      991  0.990
m4a    predictive_lead_150        0.0     138.9    3000.7      990  0.987
m4a    predictive_lead_250        0.0     235.9    2999.3      989  0.987
```

**The 4a result stands, and its price is now on the table.** The predictive A/B
swap really is gapless on both containers — and it discards almost exactly
`leadMs` of the incoming file, on both containers, at every lead tested. That
is the analytical prediction confirmed by measurement rather than assumed from
it: at the shipped default of 150 ms, every file boundary silently drops ~137 ms
of audio — roughly a syllable of speech, roughly every nine minutes on a real
multi-file book.

The naive cold start is the mirror image: 3–14 ms of content lost, but a 5–23 ms
gap. So the choice is not "gapless vs not", it is **~20 ms of audible
discontinuity vs ~140 ms of missing words**, and the second is not obviously the
better trade.

`lead_50` was gapless here too, at a quarter of the loss. That is NOT grounds to
drop the default on its own: this ran against localhost with warm buffers on a
fast machine, which is the most favourable case for a short lead. The lead
exists to cover a _slow_ element start, and the failure it guards against —
the deck not rendering in time — shows up as a gap or as the scheduler giving up,
neither of which a localhost run can provoke. Re-measure over a throttled
connection and on a real phone before changing `DEFAULT_GAPLESS_LEAD_MS`.

### Headless WebKit does not produce usable numbers

Every control fails there (joins detected at ~300 ms into a 3-second file), so
the harness refuses the run rather than reporting it. Consistent with 4a, whose
WebKit control reported 2549 ms for a forced 200 ms gap. Real Safari on a real
device is the only way to answer the WebKit question.

## Reading the output

`join(ms)` is when B first became audible on the output timeline; it should sit
at file A's decoded duration. `slope` is the recovered chirp rate in Hz/s and
should be ~1000 — a different value means playback was not at rate 1. A low
`fit r²` means the frequency estimate was noisy and `lost` should not be quoted.

**Still needs a human.** Whether the measured loss is _audible_ in speech, and
what happens on a real iOS device, are not questions this harness answers.
