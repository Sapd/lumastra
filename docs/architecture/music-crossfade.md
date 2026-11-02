# Music Crossfade System

The crossfade engine handles seamless DJ-style transitions between tracks using the Web Audio API. It automatically selects the best fade mode based on audio features (BPM, energy, key, mood) and adapts timing to fit the remaining track duration.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  music-player.store.ts                                  │
│  - checkCrossfadeTrigger() — decides WHEN to fade       │
│  - triggerCrossfade()      — orchestrates the transition │
│  - Adaptive beat count for bass-swap                    │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  beat-math.ts                                           │
│  - determineCrossfadeStyle() — decides WHICH mode       │
│  - computePhaseAlignedStart() — beat alignment          │
│  - calculatePlaybackRate() — BPM matching               │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  crossfade-engine.ts                                    │
│  - startCrossfade() — runs the animation loop           │
│  - tick*Fade() methods — per-frame gain/EQ updates      │
│  - BPM rate-matching & time-stretch                     │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  web-audio-backend.ts / safari-audio-backend.ts         │
│  - A/B deck management                                  │
│  - Web Audio graph: source → eqLow → eqHigh → gain     │
│  - MediaSession, wake lock, shadow audio (Android)      │
└─────────────────────────────────────────────────────────┘
```

## Signal Chain (per deck)

```
HTMLAudioElement
       │
       ▼
MediaElementAudioSourceNode
       │
       ├── [filter] ◄── inserted only during filter-fade mode
       │
       ▼
BiquadFilterNode (lowshelf 200Hz, gain=0dB)    ◄── eqLow
       │
       ▼
BiquadFilterNode (highshelf 3000Hz, gain=0dB)  ◄── eqHigh
       │
       ▼
GainNode (master volume)
       │
       ▼
AudioContext.destination → speakers
```

At 0dB, the shelving EQ nodes are perfectly transparent. Bass-swap mode ramps their gain in dB to control per-band volume. All other modes ignore them.

## Decision Tree

```
determineCrossfadeStyle(outgoing, incoming, channelMood)
│
├─ No audio features? ──────────────────────► BLEND (4 beats)
│                                              "no audio data"
│
├─ Both have BPM?
│  │
│  ├─ BPM gap > 15%? ──────────────────────► CUT (2 beats)
│  │                                          "BPM gap XX%"
│  │
│  ├─ BPM gap 8-15%? ──────────────────────► FILTER (32 beats)
│  │                                          "BPM gap XX%"
│  │
│  └─ BPM gap ≤ 8%
│     │
│     └─ Both energy > 0.5
│        AND not chill channel? ────────────► BASS-SWAP (48 beats)
│                                              "bass-swap for synced
│                                               energetic tracks"
│
├─ Chill channel mood? ────────────────────► ECHO (48 beats)
│  (user's explicit intent overrides          "chill mood"
│   key clash — echo masks key clashes
│   well with its spacey reverb)
│
├─ Key clash (both have key data,
│  not Circle-of-Fifths neighbors)? ────────► FILTER (32 beats)
│                                              "key clash X→Y"
│
├─ Both energy > 0.7
│  AND energetic mood tag/channel? ─────────► BLEND (16 beats)
│                                              "high energy tracks"
│
├─ Chill mood tag on either track? ─────────► ECHO (48 beats)
│                                              "chill mood"
│
├─ Energy drop (out > 0.6, in < 0.4)? ─────► FILTER (32 beats)
│                                              "energy drop"
│
└─ Default ─────────────────────────────────► BLEND (48 beats)
                                               "compatible tracks"
```

**Note on mood tags:** Essentia's SVM-based mood classifiers (`mood_acoustic`, `mood_happy`, etc.) require a Gaia-enabled binary which the pre-built static extractor does not include. Track-level mood tags are currently always empty. The "chill mood tag" and "energetic mood tag" rules only trigger via channel mood (user-selected). A heuristic mood classifier was considered but skipped — the energy/danceability/BPM features already captured by embeddings provide equivalent clustering, and the effort-to-value ratio for duplicating those signals as mood labels is low.

## Fade Modes

### Blend (equal-power crossfade)

Standard A/B deck fade. The default for compatible tracks.

```
Volume
  1 ┤ ╲outgoing              incoming╱
    │   ╲╲                        ╱╱
    │     ╲╲                    ╱╱
    │       ╲╲                ╱╱        ← 12% incoming delay
    │         ╲╲            ╱╱            prevents both at full
    │           ╲╲        ╱╱              volume simultaneously
    │             ╲╲    ╱╱
    │               ╲╲╱╱
  0 ┤─────────────────────────────────
    0%              50%             100%
```

- **Gain curves:** `cos(t·π/2)` out, `sin((t-0.12)/0.88·π/2)` in
- **Beats:** 48 (default), 4 (no audio data)
- **When:** Compatible tracks, similar BPM, no special conditions

---

### Bass-Swap (DJ EQ kill technique)

Swaps the kick/bass first, holds the vocal, then fades mids/highs. Uses shelving EQ filters (not signal splitting) — same approach as Pioneer DJM mixers.

```
                  Phase 1        Hold      Phase 2
                Bass swap     (mashup)   Mids/highs swap
               ◄─────────► ◄─────────► ◄──────────────►

Out bass    ████████▓▓▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (eqLow: 0→-40dB)
In  bass    ░░░░░░░░▒▒▓▓████████████████████████████████  (eqLow: -40→0dB)

Out vocal   ████████████████████████████████▓▓▒▒░░░░░░░░  (gain: holds, then fades)
Out highs   ████████████████████████████████████▓▓▒▒░░░░  (eqHigh: 0→-40dB)
In  highs   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▓▓████  (eqHigh: -40→0dB)

In  master  ████████████████████████████████████████████  (constant at target vol)
Out master  ████████████████████████████▓▓▓▒▒▒░░░░░░░░░  (fades from 55%)

            0%       40%      55%  65%              100%
            │         │        │    │                 │
            │         │        │    └─ Highs start    │
            │         │        │       swapping       │
            │         │        │                      │
            │         │        └─ Master gain starts  │
            │         │           fading (catches     │
            │         │           mid-range leakage)  │
            │         │                               │
            │         └─ Bass fully swapped           │
            │            Hold begins: new kick +      │
            │            old vocal at full volume      │
            │                                         │
            └─ Crossfade starts                       └─ Complete
```

- **EQ filters:** lowshelf at 200Hz, highshelf at 3000Hz (always in signal path)
- **Beats:** 48 default, adaptive 16-48 based on remaining track time
- **Timing:** 40% bass / 25% hold / 35% highs (with master gain fade from 55%)
- **Master gains:** outgoing untouched until 55%, incoming set at start (EQ keeps it silent)
- **When:** BPM gap ≤8%, both tracks energy > 0.5, not chill mood
- **Why it works:** Two competing kicks at the same time sounds muddy. By swapping bass first, the listener locks onto the new groove while the old melody plays on.

---

### Filter (DJ filter sweep)

A resonant lowpass filter sweeps from fully open to ~80Hz on the outgoing track, creating the characteristic "DJ filter" sound. The filter naturally reduces perceived loudness as highs are removed.

```
Volume/Freq
  1 ┤ outgoing                    incoming
    │ (filtered) ╲                    ╱╱
    │             ╲╲                ╱╱
    │     filter    ╲╲            ╱╱
    │     sweeps      ╲╲        ╱╱
    │     20kHz→80Hz    ╲╲    ╱╱
    │                     ╲╲╱╱
  0 ┤──────────────────────────────────
    0%                              100%

Filter frequency (outgoing deck):
22kHz ┤─╲
      │   ╲╲
      │     ╲╲
      │       ╲╲         ← exponential sweep
      │         ╲╲╲        (perceptually even)
      │            ╲╲╲╲╲
 80Hz ┤──────────────────╲╲╲
      0%                 100%
```

- **Filter:** BiquadFilterNode lowpass, Q=5 (resonant peak for DJ character)
- **Sweep:** exponential from Nyquist → 80Hz (avoids frequency warping artifacts)
- **Gain curves:** t² on outgoing (stays loud, filter does the work), delayed sin on incoming
- **Beats:** 32
- **When:** BPM gap 8-15%, key clash, or energy drop

---

### Echo (dub echo fade-out)

The outgoing track gets a musical echo (dotted 8th note delay) that builds as the track fades, creating a spacey, reverberant trail. The incoming track fades in clean.

```
Volume
  1 ┤ outgoing                        incoming
    │ (dry) ╲                             ╱╱
    │ + echo  ╲╲      echo              ╱╱
    │           ╲╲   ◗ ◗ ◗ ◗          ╱╱
    │     dry:    ╲╲  (wet peak     ╱╱
    │     cos fade  ╲╲  at ~40%) ╱╱
    │                 ╲╲       ╱╱
    │                   ╲╲  ╱╱
  0 ┤───────────────────────────────────
    0%         40%                   100%

Echo wet level (bell curve):
0.6 ┤        ╱╲
    │      ╱╱  ╲╲
    │    ╱╱      ╲╲
    │  ╱╱          ╲╲╲
  0 ┤╱╱                ╲╲╲──────────
    0%    40%                 77%  100%
```

- **Delay time:** dotted 8th note (3/4 beat), beat-synced to BPM
- **Feedback:** peaks at 0.45 (4-6 audible repeats before decay)
- **Wet level:** bell curve peaking at ~40% through, 0.6 × outgoing volume
- **Echo adds energy intentionally** — the spacey trail is the artistic effect
- **Beats:** 48
- **When:** chill/ambient mood on either track or channel
- **Cleanup:** 5ms linearRamp to zero before disconnect (prevents click/pop)

---

### Cut (instant DJ splice)

Near-instant transition with a 15ms click-prevention ramp. Bypasses the animation loop entirely.

```
Volume
  1 ┤ out│in
    │    │
    │    │    ← 15ms linear ramp
    │    │      (imperceptible but click-free)
    │    │
  0 ┤────┼──────────────────────────
         t
```

- **Ramp:** 15ms linear (scheduled via `linearRampToValueAtTime`, no animation loop)
- **Beats:** 2
- **When:** Large BPM gap (>15%) only. Cut is reserved exclusively for incompatible tempos where gradual blending sounds bad. High-energy tracks now use a short blend (16 beats) instead of cut to avoid jarring mid-song switches.
- **Trigger timing:** Cut transitions skip the `outro_start_ms` trigger and only use dynamic lead time (~6s before track end). The outro boundary is designed for gradual transitions and fires too early for instant cuts.
- **Why not 0ms:** A true zero-length cut creates a click from splicing the waveform at a non-zero-crossing point

## BPM Rate Matching

```
BPM gap between tracks
│
├─ ≤ 15%  ──► Native playbackRate
│             (slight pitch shift, masked by crossfade,
│              normalizePlaybackRate corrects after)
│
├─ 15-25% ──► SoundTouch WSOLA time-stretch
│             (pitch-preserving but can have artifacts,
│              only used with cut mode where it's short)
│
└─ > 25%  ──► No BPM matching
              (tracks too different, let them play at native tempo)
```

After crossfade completes, `normalizePlaybackRate()` gradually brings the playback rate back to 1.0 over ~2 seconds.

## Crossfade Trigger Timing

```
Track duration
├────────────────────────────────────────────────┤

                    ▼ outro_start_ms (if detected)
├──── playing ──────┼───── crossfade ─────┼─ buf ─┤
                    │                     │       │
                    └─ trigger point      └─ fade │
                                            ends  └─ track ends

For bass-swap (adaptive):
├──── playing ────────────┼───── crossfade ──────┼─┤
                          │                      │ │
                          │  ◄── up to 48 beats ─► │
                          │  (adapts to 16 min)  │ │
                          │                      │ └─ 1s buffer
                          │                      │    (vs 5s for others)
                          └─ can start during
                             vocals — first 55%
                             doesn't touch them
```

**Bass-swap adaptive timing:**

- Default 48 beats (~24s at 120 BPM)
- Scales down to minimum 16 beats when near track end
- Only 1s post-fade buffer (other modes use 5s)
- Can trigger over vocals — bass swap phase doesn't affect mids/highs

**Cut transition timing:**

Cut transitions skip the `outro_start_ms` trigger entirely and only use the dynamic lead time calculation (~6s before track end). This prevents the instant switch from firing at the outro boundary (8-16s from end), where the track is still in full swing.

## Outro Detection (outro_start_ms)

Three methods determine where the outro starts, in priority order:

| Method                  | Source                                             | Accuracy      | Used for                             |
| ----------------------- | -------------------------------------------------- | ------------- | ------------------------------------ |
| **Per-frame fade**      | `spectral_rms` from `outputFrames: 1`              | ±2s           | Tracks with artistic fade-out        |
| **Downbeat counting**   | Beat grid (last 4 bars vocal, 8 bars instrumental) | ±1 bar        | Tracks with clear beat structure     |
| **Percentage fallback** | 90% vocal / 85% instrumental                       | ~15% of track | Very short tracks (<30s) or no beats |

**Per-frame fade detection** (new): Essentia runs with `outputFrames: 1` profile, producing a `_frames` file with per-frame `spectral_rms` (~10K frames per track). The detector scans backwards from the end with a 2-second sliding window, finding where RMS drops below 30% of the track average. This is typically 7-20 seconds from the end — much more accurate than the previous fixed 85% heuristic which triggered 35-55 seconds too early.

## DJ Intro Detection (dj_intro_end_ms)

Extended mixes (5-7 minute electronic tracks) have long percussive DJ intros — 16-64 bars of kicks with no melody, designed for DJ mixing. When a track has `dj_intro_end_ms`, the crossfade uses it instead of `intro_end_ms` as the incoming track's entry point, skipping the monotonous kick intro.

Detection uses Essentia's aggregate statistics (no per-frame data needed):

| Signal                              | What it detects                                  | Threshold             |
| ----------------------------------- | ------------------------------------------------ | --------------------- |
| `spectral_complexity.var`           | Distinct sections (simple intro vs complex body) | >120                  |
| `beats_loudness_band_ratio.mean[0]` | Bass-dominant energy (kicks)                     | >0.4 with mid <0.15   |
| `beats_loudness_band_ratio.var[0]`  | Energy distribution changes                      | >0.06                 |
| Danceability                        | Electronic/DJ signal                             | >1.0 (Essentia scale) |

Pre-filters: duration >4 min, BPM 100-160, sufficient downbeats. Intro length estimated from duration (16/32/48 bars), snapped to nearest downbeat.

## LUFS Loudness Normalization

Each track's loudness is measured in LUFS. During crossfade, per-deck gains are LUFS-adjusted so quiet and loud tracks transition at matched perceived volume.

```
applyLufsGain(userVolume, trackLufs)
│
├─ Target: -14 LUFS
├─ Gain = 10^((targetLufs - trackLufs) / 20)
├─ Clamped to [0.25, 2.0] (±12 dB range)
└─ Applied only during crossfade, NOT during normal playback
   (setVolume doesn't apply LUFS — that would fight user intent)
```

**Exception:** Bass-swap leaves the outgoing master gain untouched to prevent a volume discontinuity. The EQ shelves control the per-band fade instead.

## Phase Alignment

When beat data is available, the incoming track is positioned so its downbeats align with the outgoing track's bar position:

```
Outgoing: ... ◆───◆───◆───◆───◆───◆ ...
                          ▲
                     current position
                     (62% through bar)

Incoming:         ... ◆───◆───◆───◆ ...
                          ▲
                     start here
                     (62% into bar = phase-aligned)
```

**Priority order:**

1. Full phase alignment (outgoing downbeats + incoming downbeats)
2. Snap to incoming downbeat near intro end
3. Snap to incoming beat grid
4. Raw intro end position
5. Track start (0s)

## Key Files

| File                                                                                                       | Purpose                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/utils/crossfade-engine.ts`                                                                        | Core engine: animation loop, gain/EQ automation, filter/echo nodes             |
| `src/lib/utils/beat-math.ts`                                                                               | Style selection, phase alignment, BPM calculations, `getEffectiveIntroEndMs`   |
| `src/lib/utils/soundtouch-worklet.ts`                                                                      | WSOLA time-stretch AudioWorklet wrapper                                        |
| `src/lib/utils/lufs-gain.ts`                                                                               | LUFS normalization gain computation                                            |
| `src/lib/audio/web-audio-backend.ts`                                                                       | Desktop/Android: A/B deck Web Audio graph, EQ nodes                            |
| `src/lib/audio/safari-audio-backend.ts`                                                                    | Safari: HTMLAudioElement.volume animation (no Web Audio)                       |
| `src/lib/audio/plain-audio-backend.ts`                                                                     | iOS: single audio element, no crossfade                                        |
| `src/lib/audio/types.ts`                                                                                   | AudioBackend interface, CrossfadeOptions, debug info types                     |
| `src/lib/stores/music-player.store.ts`                                                                     | Trigger logic, adaptive timing, queue management                               |
| `src/lib/server/services/essentia-analysis.service.ts`                                                     | Audio analysis: BPM, key, energy, fade detection, DJ intro, voice/instrumental |
| `src/lib/schemas/music.ts`                                                                                 | AudioFeaturesSchema (Zod) — single source of truth for audio feature types     |
| `src/lib/server/tasks/builtin/native/` (music-analysis task; see its `__tests__/music-analysis-*.test.ts`) | Analysis scheduling, processing version, concurrency control                   |

## Voice/Instrumental Classification

Affects outro boundary length: vocal tracks get 4-bar outros, instrumental tracks get 8-bar outros (more time for the crossfade to breathe).

| Method                 | Priority           | Accuracy | How it works                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SVM classifier**     | 1st (if available) | High     | Essentia `highlevel.voice_instrumental` — requires Gaia-enabled binary (not available in pre-built static binary)                                                                                                                                                     |
| **Lowlevel heuristic** | 2nd (fallback)     | Moderate | Scores 4 spectral features: ZCR <0.055, spectral entropy <7.3, spectral centroid <1200, dynamic complexity >4.0. Needs 3+ features present and 3+ matching to classify as instrumental. Conservative: only catches orchestral scores and clearly instrumental tracks. |
| **Default**            | 3rd                | —        | Defaults to "voice" (safer — shorter outro avoids awkward silence)                                                                                                                                                                                                    |

## Design Decisions

**Why shelving EQ instead of band-splitting for bass-swap:**
Parallel crossover filters (Butterworth, Linkwitz-Riley) cause phase cancellation at crossover frequencies and filter settling transients when connected mid-playback. Shelving EQ filters in series (lowshelf + highshelf, always connected at 0dB) are perfectly transparent and avoid both issues. This matches how Pioneer DJM mixers implement EQ kills.

**Why native playbackRate up to 15% instead of WSOLA:**
The WSOLA algorithm produces audible overlap-add artifacts when its AudioWorklet is connected to an already-playing HTMLAudioElement. Native playbackRate shifts pitch but this is masked by the crossfade and corrected by `normalizePlaybackRate()` afterward. WSOLA is reserved for 15-25% gaps where only cut mode (2 beats) is used.

**Why Q=5 for filter sweep instead of Q=0.707:**
The resonant peak at the cutoff frequency is the signature sound of a DJ filter sweep (Pioneer DJM uses Q=8-12). Butterworth (Q=0.707) produces a flat, neutral rolloff that sounds lifeless as a creative effect.

**Why 15ms for cut mode instead of 0ms:**
A true zero-length cut splices the waveform at a non-zero-crossing point, producing an audible click. 15ms is imperceptible as a fade but eliminates the click (industry standard per Web Audio best practices).
