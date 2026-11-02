// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Projection from AudiobookShelf's raw play-session payload to the wire shape
 * `POST /audiobooks/session` emits.
 *
 * Lives in `shared/` rather than beside the service so the STORE'S tests can
 * build their fixtures through the same function the endpoint uses. That is not
 * tidiness: this integration's signature failure is a correctly-typed read of a
 * shape that never carried the data, and a test that hand-rolls its own idea of
 * the payload cannot catch a projection that drops a field the client needs. Run
 * the real ABS fixture through this and the test payload is, by construction,
 * what the endpoint would have sent.
 *
 * Units are AudiobookShelf's own — SECONDS — and stay that way. The single
 * conversion to milliseconds happens in `buildAudiobookTimeline`.
 */

import type { AbsAudioTrack, AbsChapter } from '$lib/schemas/api-audiobook-session';
import { buildChapterSpans } from '$lib/utils/audiobook-timeline';
import {
    audiobookCodecNeedsRemux,
    isAudiobookCodecKnown,
    normalizeAudiobookCodec,
} from '$lib/shared/audiobook-remux-codecs';

/** The subset of ABS's `audioTracks[]` entry this projection reads. */
export interface RawAbsTrack {
    index?: number | null;
    ino?: string | null;
    startOffset?: number | null;
    duration?: number | null;
    mimeType?: string | null;
    codec?: string | null;
    title?: string | null;
    contentUrl?: string | null;
}

/** The subset of ABS's `chapters[]` entry this projection reads. */
export interface RawAbsChapter {
    id?: number | null;
    title?: string | null;
    start?: number | null;
    end?: number | null;
}

/**
 * Narrow ABS's tracks to what the timeline reads.
 *
 * Projected rather than forwarded: the live payload carries a ~40-field
 * `metadata` object and every ID3 tag per file, which on a 228-file book is
 * hundreds of kilobytes the client never looks at.
 */
export function projectAbsTracks(tracks: readonly RawAbsTrack[]): AbsAudioTrack[] {
    return tracks.map((track, i) => ({
        index: typeof track.index === 'number' ? track.index : i + 1,
        // Absent on the synthetic track of a transcode session, which the
        // timeline never addresses by inode. Emitting '' instead would make it
        // look like a real file the byte proxy could fetch.
        ...(typeof track.ino === 'string' && track.ino !== '' ? { ino: track.ino } : {}),
        startOffset: finiteOr(track.startOffset, 0),
        duration: typeof track.duration === 'number' ? track.duration : null,
        mimeType: track.mimeType ?? null,
        codec: track.codec ?? null,
        title: track.title ?? null,
    }));
}

/**
 * Stamp `needsRemux` onto each track from the PERSISTED per-file codec.
 *
 * The persisted value wins over the one AudiobookShelf reports on the session,
 * and that ordering is the whole point:
 *
 *  - ABS's own negotiation never looks at the codec (`checkCanDirectPlay` matches
 *    bare MIME types), so the field that decides playability has to come from
 *    somewhere ABS is not consulted — the sweep's
 *    `custom_metadata.audiobookshelf.audioFiles[].codec`.
 *  - On a TRANSCODE session ABS returns one synthetic whole-book track whose
 *    `codec` is `null` (measured). Reading the session payload alone would report
 *    "no codec, nothing to remux" for exactly the books that need it.
 *
 * The live value is still used as a FALLBACK, for the one case the persisted map
 * cannot answer: a file added since the last sweep has no entry for its inode.
 *
 * A track with no inode (the synthetic transcode track) is never flagged: there
 * is no file to remux, and the HLS path is a different mechanism entirely.
 *
 * ## A file with NO readable codec is not a file with a safe codec
 *
 * `audiobookCodecNeedsRemux('')` is `false`, which used to make an unreadable
 * codec indistinguishable from `aac` — so a file nobody could probe was
 * direct-played, and Chromium's `EncodingError` (the original bug) reproduced
 * with no error surfaced and no fallback. The two cases are separated here:
 *
 *  - **Some file in this book reported a codec, this one did not.** An anomaly
 *    about ONE file — ABS's ffprobe failed on it, and a file ABS itself could not
 *    read is the likeliest to be undecodable. Flagged, so the client asks its own
 *    engine (`engineCanDecodeAudiobookCodec` answers "no" for an unknown codec,
 *    by design) and remuxes rather than guessing.
 *  - **No file in this book reported a codec at all.** Then we have no codec
 *    information — an unswept library talking to an ABS build that does not report
 *    the field. Nothing is flagged: measured reality is that codecs are always
 *    present (see {@link isAudiobookCodecKnown}), so this state means the SOURCE is
 *    silent, and remuxing every file on that basis would pipe an entire library
 *    through ffmpeg to fix a problem it probably does not have.
 *
 * Deciding per BOOK rather than per file is what bounds the blast radius: the
 * worst case is one unnecessary remux of one anomalous file, never a library-wide
 * encode storm.
 *
 * @param persistedCodecs `{ ino: codec }` from
 *        {@link AudiobookPlaybackTarget.audioFileCodecs}. Pass `{}` and the live
 *        codec decides alone.
 */
export function annotateRemuxTracks(
    tracks: readonly AbsAudioTrack[],
    persistedCodecs: Readonly<Record<string, string>>,
): AbsAudioTrack[] {
    /**
     * The codec each addressable track resolved to — persisted first, live second.
     * `null` marks a track with no inode (nothing to remux, and no codec claim it
     * is entitled to make on behalf of the others).
     *
     * A persisted entry that is BLANK loses to the live codec rather than
     * overriding it: the persisted value wins because it is *better information*,
     * and an empty string is not information at all. A sweep that wrote `''` for a
     * file it could not probe must not erase a codec ABS did report.
     */
    const resolved = tracks.map((track) => {
        if (track.ino === undefined) return null;
        const persisted = normalizeAudiobookCodec(persistedCodecs[track.ino]);
        return persisted !== '' ? persisted : normalizeAudiobookCodec(track.codec);
    });

    const anyCodecKnown = resolved.some((codec) => codec !== null && isAudiobookCodecKnown(codec));

    return tracks.map((track, i) => {
        const codec = resolved[i];
        if (codec === null) return track;
        if (audiobookCodecNeedsRemux(codec)) return { ...track, needsRemux: true };
        // Unknown here, known elsewhere → verify. Unknown everywhere → the source
        // told us nothing, so keep the historical behaviour.
        if (!isAudiobookCodecKnown(codec) && anyCodecKnown) return { ...track, needsRemux: true };
        return track;
    });
}

/**
 * Narrow AND normalise ABS's chapters into the spans the wire promises.
 *
 * A chapter with no numeric `start` is dropped rather than defaulted to 0: only
 * `start` is trusted upstream, and a run of synthetic zeros would collapse into
 * one span and make every real chapter after it unreachable behind
 * `findChapterAt`'s backward scan.
 *
 * ## Why the server normalises rather than each client
 *
 * The spans this returns are contiguous and cover `[0, durationMs]`, so every
 * `end` equals the next `start` exactly. That is the whole point. Given RAW ABS
 * chapters, a client that bounds a span by the NEXT start and a client that
 * trusts `end` disagree — measured, on the two real clients: the web player
 * showed a 28-second chapter as 17 minutes long, and the iOS player found NO
 * chapter at all for the last 16m52s of Milo Farrow and the Keeper of
 * Starhaven, silently widening its chapter scrubber to the whole 12-hour book.
 * On normalised spans both strategies produce the same answer, so no client can
 * pick the wrong one.
 *
 * `durationMs` of 0 means "not known" and normalises nothing — see
 * {@link buildChapterSpans}.
 */
export function projectAbsChapters(
    chapters: readonly RawAbsChapter[],
    durationMs: number,
): AbsChapter[] {
    const spans = buildChapterSpans(
        chapters.filter(
            (chapter) => typeof chapter.start === 'number' && Number.isFinite(chapter.start),
        ),
        durationMs,
    );
    return spans.map((span, i) => ({
        id: i,
        // The invented span carries NO title: the API negotiates language
        // independently of the client's UI locale, so a title written here
        // could reach a German app in English. Geometry is the server's,
        // wording is the client's.
        title: span.untagged === true ? null : span.title,
        start: span.startMs / 1000,
        end: span.endMs / 1000,
        ...(span.untagged === true ? { synthetic: true } : {}),
    }));
}

function finiteOr(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
