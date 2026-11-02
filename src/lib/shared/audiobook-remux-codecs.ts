// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which audiobook audio codecs need a Lumastra-side remux, and how an engine is
 * asked whether it can decode one.
 *
 * ## Why this exists at all
 *
 * AudiobookShelf negotiates direct-play against **bare container MIME types**
 * (`checkCanDirectPlay`, `PlaybackSessionManager.js`). An E-AC-3 track inside an
 * `.m4b` advertises `audio/mp4`, every client claims `audio/mp4`, so ABS
 * direct-plays it — and Chromium then throws `EncodingError: Unable to decode
 * audio data`. ABS cannot see the codec through its own negotiation, which is
 * exactly why the sweep persists it per file in
 * `custom_metadata.audiobookshelf.audioFiles[].codec`.
 *
 * ## The table below is MEASURED, not inferred
 *
 * `canPlayType` in real Google Chrome (channel `chrome`) and real WebKit, via
 * Playwright, 2026-07-30:
 *
 * | probe                          | Chrome       | WebKit       |
 * | ------------------------------ | ------------ | ------------ |
 * | `audio/mp4; codecs="ec-3"`     | `""`         | `"probably"` |
 * | `audio/mp4; codecs="ac-3"`     | `""`         | `"probably"` |
 * | `audio/mp4; codecs="alac"`     | `""`         | `"probably"` |
 * | `audio/eac3` / `audio/ac3`     | `""`         | `""`         |
 * | `audio/x-ms-wma`               | `""`         | `""`         |
 * | `audio/vnd.dts`, `…"dtsc"`     | `""`         | `""`         |
 * | `audio/mp4; codecs="mlpa"`     | `""`         | `""`         |
 * | `audio/mp4; codecs="mp4a.40.2"`| `"probably"` | `"probably"` |
 * | `audio/aac`                    | `"probably"` | `"maybe"`    |
 *
 * And the decisive one, on a real 6-channel E-AC-3 `.m4b` slice from the live
 * library, `AudioContext.decodeAudioData`:
 *
 * - Chrome: **`FAIL EncodingError: Unable to decode audio data`**
 * - WebKit: `OK dur=10.01 ch=6`
 * - the remuxed ADTS/AAC of the same slice: `OK` in **both** (Chrome
 *   `dur=10.03 ch=2`)
 *
 * Two things follow, and both are load-bearing:
 *
 *  1. **`audio/eac3` and `audio/ac3` are dead probes** — `""` even on the engine
 *     that plays the codec. Only the `audio/mp4; codecs="…"` form answers
 *     truthfully. A probe list built from the bare types would remux on Safari
 *     too, for nothing.
 *  2. **The codec alone is not the decision.** WebKit plays E-AC-3 natively, so
 *     a per-engine probe decides; this module only says "this file's codec is
 *     one an engine may not have", which is a fact about the FILE.
 *
 * ## DOM-free on purpose
 *
 * The server decides `needsRemux` from the persisted codec and the client
 * decides whether it matters, so both need this table — and a second copy is how
 * the two would drift apart on exactly the axis that matters. The engine probe
 * is injected as a function so this module never touches `document`.
 */

/**
 * Codecs AudiobookShelf will happily direct-play that at least one supported
 * engine cannot decode, mapped to the `canPlayType` probes that answer
 * truthfully for them.
 *
 * An **empty** probe list means "no engine measured here plays it" — the client
 * then always remuxes, because there is no probe that could say otherwise.
 *
 * Keys are ffmpeg codec names, which is what AudiobookShelf reports (its own
 * ffprobe fills the field the sweep persists).
 */
const REMUX_CODEC_PROBES: Readonly<Record<string, readonly string[]>> = {
    // Measured in this library: 39 files across 2 books, all `audio/mp4`.
    eac3: ['audio/mp4; codecs="ec-3"'],
    // Same Dolby family, same Chrome-no/WebKit-yes split (measured). No file in
    // the library carries it today; the split is not a guess.
    ac3: ['audio/mp4; codecs="ac-3"'],
    // Apple Lossless: WebKit yes, Chrome no (measured).
    alac: ['audio/mp4; codecs="alac"'],
    // Neither engine offers any playable type for these (measured), so there is
    // no probe to offer — they always remux.
    wmav1: [],
    wmav2: [],
    wmapro: [],
    dts: [],
    truehd: [],
    mlp: [],
};

/**
 * Codec strings arrive from two places (AudiobookShelf's live session payload
 * and our own persisted sweep output) and neither guarantees case or padding.
 */
export function normalizeAudiobookCodec(codec: string | null | undefined): string {
    return (codec ?? '').trim().toLowerCase();
}

/**
 * Does this file's codec need a Lumastra remux on at least one supported engine?
 *
 * A fact about the FILE. Whether the remux is actually used is the engine's
 * answer to {@link engineCanDecodeAudiobookCodec}.
 *
 * **Answers about the RISKY set only.** `false` means "not one of the codecs
 * measured to fail", which for a missing or unreadable codec is *not* the same
 * claim as "safe" — `''` is not a key here and never will be. Callers that need
 * to tell those two apart must ask {@link isAudiobookCodecKnown}; conflating them
 * is how an undecodable file gets direct-played with no error and no fallback.
 */
export function audiobookCodecNeedsRemux(codec: string | null | undefined): boolean {
    return normalizeAudiobookCodec(codec) in REMUX_CODEC_PROBES;
}

/**
 * Did we read a codec for this file at all?
 *
 * The third state {@link audiobookCodecNeedsRemux} cannot express. Measured on
 * the reference AudiobookShelf (2026-07-30): `codec` is present on **every** file
 * — 1514 audio files across a 40-book sample (`mp3` 1492, `eac3` 19, `aac` 3) —
 * and on every `audioTracks[]` entry of a live direct-play session. So an empty
 * codec is not a normal state on a working server; it means ABS's own ffprobe
 * failed on that file (it then carries an `error`), or the field was not reported
 * at all.
 *
 * That measurement is what makes the two unknown cases genuinely different, and
 * why {@link annotateRemuxTracks} distinguishes them instead of picking one rule:
 * one file unknown among files with codecs is an anomaly worth verifying, while
 * *nothing* carrying a codec means we have no codec information at all and
 * remuxing on that basis would pipe an entire library through ffmpeg.
 */
export function isAudiobookCodecKnown(codec: string | null | undefined): boolean {
    return normalizeAudiobookCodec(codec) !== '';
}

/** The `canPlayType` strings that answer truthfully for this codec. */
export function audiobookCodecProbeTypes(codec: string | null | undefined): readonly string[] {
    return REMUX_CODEC_PROBES[normalizeAudiobookCodec(codec)] ?? [];
}

/**
 * Can THIS engine decode the codec?
 *
 * @param canPlayType the engine's own `HTMLMediaElement.canPlayType`
 *
 * Returns false for an unknown or missing codec **by design**: the caller only
 * reaches here for a file the server flagged, and a flagged file whose codec we
 * cannot read is safer remuxed (costs CPU) than direct-played (a silent dead
 * element). Guessing "probably fine" is how the E-AC-3 books ended up
 * unplayable in the first place.
 */
export function engineCanDecodeAudiobookCodec(
    codec: string | null | undefined,
    canPlayType: (type: string) => string,
): boolean {
    const probes = audiobookCodecProbeTypes(codec);
    if (probes.length === 0) return false;
    // `canPlayType` returns '' | 'maybe' | 'probably'; only '' is a no.
    return probes.some((type) => canPlayType(type) !== '');
}
