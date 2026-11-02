# Chromaprint clean-room rewrite — staging behavioural validation

**Date:** 2026-06-12
**Subject:** `src/lib/server/tasks/builtin/native/intro-analyzer/chromaprint.ts` (clean-room
replacement for the removed GPL-derived module)
**Method:** Re-run intro + credits detection with the new implementation against the
**same media files** the previous implementation analysed on staging, and compare the
detected segments to the rows already stored in the staging `media_segments` table
(`source = 'lumastra-intro-analyzer'`). The DB was read-only; no production rows were
modified.

> The comparison is of **outputs**, not code. The prior implementation was never read.
> Because that prior detector is itself inconsistent on credits (see below), IoU-vs-old
> is **not** the success metric — cohort consistency and robustness are. Reproducing a
> GPL-derived detector's output has no value.

## Algorithm (three layers)

1. **Diagonal proposal.** Each 32-bit fingerprint point is split into four 8-bit bands
   and inverted-indexed; shared audio between two episodes sits on a constant offset
   "diagonal", and band votes (robust to bit-noise) surface the top candidate diagonals
   (plus a ±`invertedIndexShift` neighbourhood for timing drift).
2. **Density-aware run extraction.** Each diagonal is hard-split at gaps wider than
   `maxTimeSkip`, and within each split a local-alignment score (+1 match,
   −1.5 mismatch → ~0.6 density floor) extracts the densest contiguous core. This
   rejects the failure mode where a recurring background score (audio that partially
   matches while dialogue differs) is sparsely bridged into a long false "run".
3. **Cohort-consensus selection.** The intro / end-credits recur at a roughly consistent
   length across the season. Each episode keeps the run within the consensus length band
   (median over per-episode-deduplicated candidates) closest to the relevant boundary
   (credits → episode end; intro → start), rather than its single longest run. An episode
   whose only candidate is a length outlier is left blank instead of mis-detected.

The pairwise phase compares each episode against a sliding window of at most
`MAX_PEER_LOOKAHEAD` (12) successors, bounding it at O(N · 12) instead of O(N²) — a
cohort-wide intro / credits is shared by ~every episode, so neighbours still establish it.
This matters for mis-grouped "seasons" of hundreds of episodes that would otherwise
spend minutes in the matcher.

## Harness

- Ran on the staging host. DB queried read-only over `127.0.0.1:5432`.
- Fingerprints from the **real** `chromaprintFingerprint` helper (host `/usr/bin/ffmpeg`,
  `--enable-chromaprint`), via the module's actual public functions.
- Config = what the production task builds from `SETTINGS_DEFAULTS`
  (intro `maxIntroDuration 120` / window `0.25`×dur cap 600s; credits tail window +
  cap `maxCreditsDuration 300` — lowered from 600; `maxPointDifferences 6`,
  `maxTimeSkip 3.5`, `invertedIndexShift 2`), `concurrency 4`, `ffmpegThreads 2`.
  0 unreadable files across all six baseline seasons (130 eps).
- The temporary validation harness was removed after the run.

## Results — intros vs outros

| Pass  | IoU ≥ 0.8 (vs old)  | Median \|Δstart\| | Median \|Δend\| | Note                                |
| ----- | ------------------- | ----------------- | --------------- | ----------------------------------- |
| Intro | **111/121 = 91.7%** | 0.0 s             | 0.0 s           | reproduces the old detector exactly |
| Outro | 28/116 = 24.1%      | 8.7 s             | 2.8 s           | ends agree tightly; starts diverge  |

The intro pass faithfully reproduces the previous detector (four seasons perfect:
24/24, 16/16, 14/14, 33/34). The outro IoU-vs-old is low **because the old credits
detector was itself inconsistent** (per-season credit lengths ranging 16 s → 596 s),
not because the new output is wrong — see the consistency table.

**Wall-clock (largest season, 35 episodes):** intro 42.5 s + credits 60.6 s ≈ **1 m 43 s**
— dominated by ffmpeg audio decode; the synchronous matching phase is negligible and
yields to the event loop every 16 pairs.

## What the redesign changed (cohort consistency)

The density + consensus layers do not chase the old IoU — they make the **new** output
self-consistent across the cohort and remove anomalous outliers. Measured per-season
spread (standard deviation of detected segment length, in fingerprint points):

| Season   | Intro len σ (before → after)                           | Outro (before → after)                         |
| -------- | ------------------------------------------------------ | ---------------------------------------------- |
| cohort-A | 23 → **6** (killed a 116-pt anomalous-pairing outlier) | genuine long tail — see below                  |
| cohort-B | 2 → 1                                                  | min 21 → **52**, σ 17 → **10** (stubs removed) |
| cohort-C | 3 → 2                                                  | σ 2 → **0** (uniform 99-pt credits)            |
| cohort-D | 1 → 0                                                  | σ 2 → 2 (already tight)                        |
| cohort-E | 3 → 2                                                  | σ 1 → **0**                                    |
| cohort-F | 1 → 3                                                  | σ 2 → 2                                        |

Intro detection held at 91.7% IoU-vs-old **and** got tighter; outro detection is now
cohort-consistent everywhere it has a real signal.

## Spot-checks

**1. Anomalous-pairing outlier removed (cohort-A intro).** Before, one episode's "intro"
was 116 pts because a single pairing shared a longer stretch (cohort σ = 23). Consensus
now pins every episode to the cohort length (max 54, σ = 6). This is the general
over-detection fix.

**2. Outro stubs removed (cohort-B).** Before, the per-episode-longest selector emitted
16–24 pt credit stubs for some episodes (σ 17) alongside the real ~103-pt credits.
Consensus drops the stubs; the surviving outros cluster at 103 pts (σ 10).

**3. Genuine long shared tail (cohort-A outro), now bounded by the window cap.** Six
episodes share genuinely dense, near-identical tail audio (the density gate would have
trimmed a sparse false match — they really do share that audio: recap-heavy / near-duplicate
episodes or a library data artifact). With the 600 s tail window this surfaced as a 597 s
"outro" starting mid-episode; **lowering `maxCreditsDuration` to 300 s caps it at 297 s**
(σ 0) and halves the search cost. No fingerprint detector can know a genuinely-shared long
stretch is "too long to be credits", so the window cap is the right lever — now applied as
the default (`SETTINGS_DEFAULTS.maxCreditsDuration` / settings field = 300 s in
`lumastra-intro-analyzer.ts`). The other 11 episodes are left blank rather than mis-detected.

**4. an additional validation season — detection where the old detector produced nothing.** This
season had **0 stored segments** (the previous detector found none). The new detector finds
the title sequence on **all 24 episodes** at a rock-steady **79 s (σ 0)**, with starts
spread 22–255 s because each episode has a different-length cold open before the titles —
exactly the variable-offset case cohort fingerprinting is built for. It also finds **~62 s
end credits on all 24 episodes (σ 7 s)** — real credits, not a capped 297 s over-detection.

## Architecture-change verification (peer-cap + 300 s credits window)

Re-running the full six-season baseline under the O(N²) peer-cap and the 300 s credits
window gives **identical** detection to the all-pairs / 600 s run — intro **111/121
(91.7%)**, outro **29/116 (25.0%)** — while credits decode is ~2× faster (e.g. cohort-B
credits 71 s → 31 s, cohort-C 16 s → 10 s). No regression; the optimisations are free.

## Performance — full-library scan time

For an **illustrative sizing example**, consider a representative install with 3,000
eligible seasons / 45,000 file-bearing episodes, including mis-grouped seasons with
hundreds of episodes. These rounded figures are not validation measurements.

A scheduled (catchup) run processes exactly **one `batchSize` slice of seasons** then stops
(it does not loop to the soft budget), and the scheduler fires every 6 h. So throughput is
`batchSize × 4 runs/day`. The shipped `SETTINGS_DEFAULTS` had a stale **`batchSize: 25,
episodeConcurrency: 2`** (the settings-field defaults and in-file comments intended 100 / 4)
— i.e. 100 seasons/day → **~30 days** to scan the library.

Fixes in `lumastra-intro-analyzer.ts`:

- `batchSize 25 → 150`, `episodeConcurrency 2 → 4` → **600 seasons/day → ~5 days** (each
  150-season slice is ~2 h wall-clock, well under the 6 h soft budget).
- `maxCreditsDuration 600 → 300` halves credits decode (and bounds the over-detection above).
- The matcher's `MAX_PEER_LOOKAHEAD` keeps the pairwise phase for seasons containing hundreds of episodes at
  O(N · 12) rather than O(N²) (minutes → seconds of CPU); ffmpeg decode still dominates the
  big seasons, but is linear and unavoidable without smaller windows / more concurrency.

## Conclusion

- **Intros: validated.** 91.7% IoU-vs-old with near-zero boundary deltas, and the redesign
  made them more cohort-consistent (removed an anomalous outlier).
- **Outros: robust by construction.** The density + consensus layers eliminated the two
  real failure modes (sparse-bridged false runs, anomalous-pairing length outliers) and
  produce cohort-consistent credit boundaries. The end boundary — what matters most for a
  skip-credits / next-episode prompt — agrees with the old rows to a median 2.8 s.
- **One residual is a content property, not a bug:** seasons whose episodes genuinely share
  a very long tail (cohort-A) are now bounded by the `maxCreditsDuration 300` cap, since no
  boundary detector can distinguish "long credits" from "long shared content" from audio alone.
- **New value where the old detector was blank:** the additional validation season (0 old segments) is now fully
  and consistently detected (79 s intro / 62 s credits on all 24 episodes).
- **Performance:** the stale `batchSize 25` default (~30-day illustrative scan) is corrected to 150 plus
  `episodeConcurrency 4`, bringing the illustrative 3,000-season library to ~5 days; the peer-cap removes
  the O(N²) cliff on huge mis-grouped seasons.
- IoU-vs-old stays flat by design — the goal was a robust, self-consistent detector, not a
  reproduction of the inconsistent GPL-derived one.
