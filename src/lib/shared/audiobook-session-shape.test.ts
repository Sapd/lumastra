// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `annotateRemuxTracks` is where the PERSISTED per-file codec becomes something
 * the client can act on, so these cases are about provenance, not shape: which of
 * the two available codec values wins, and what happens when only one of them
 * exists.
 *
 * The ordering matters because the live session payload lies in a specific way —
 * a transcode session's synthetic whole-book track reports `codec: null`
 * (measured), i.e. exactly the books that need a remux are the ones the live
 * payload cannot describe.
 */

import { describe, it, expect } from 'vitest';
import { annotateRemuxTracks, projectAbsTracks } from './audiobook-session-shape';

describe('annotateRemuxTracks', () => {
    it('flags a file from the PERSISTED codec even when the live payload has none', () => {
        const tracks = projectAbsTracks([
            { index: 1, ino: '9001', startOffset: 0, duration: 60, mimeType: 'audio/mp4' },
        ]);
        expect(tracks[0].codec).toBeNull();

        const [annotated] = annotateRemuxTracks(tracks, { '9001': 'eac3' });
        expect(annotated.needsRemux).toBe(true);
    });

    it('lets the PERSISTED codec override a disagreeing live one', () => {
        // The persisted value comes from our own sweep; the live one comes from a
        // negotiation that never looks at the codec. When they disagree, the file
        // is what the file is.
        const tracks = projectAbsTracks([
            { index: 1, ino: '9001', startOffset: 0, duration: 60, codec: 'aac' },
        ]);
        const [annotated] = annotateRemuxTracks(tracks, { '9001': 'eac3' });
        expect(annotated.needsRemux).toBe(true);
    });

    it('does not flag a persisted codec that needs nothing, whatever the live one says', () => {
        const tracks = projectAbsTracks([
            { index: 1, ino: '9001', startOffset: 0, duration: 60, codec: 'eac3' },
        ]);
        const [annotated] = annotateRemuxTracks(tracks, { '9001': 'mp3' });
        expect(annotated.needsRemux).toBeUndefined();
    });

    it('falls back to the live codec for a file the sweep has not seen', () => {
        // A file added since the last sweep has no entry for its inode. Reporting
        // "nothing to remux" there would leave a brand-new E-AC-3 book unplayable
        // in Chromium until the next sweep.
        const tracks = projectAbsTracks([
            { index: 1, ino: 'new-file', startOffset: 0, duration: 60, codec: 'eac3' },
        ]);
        const [annotated] = annotateRemuxTracks(tracks, { '9001': 'mp3' });
        expect(annotated.needsRemux).toBe(true);
    });

    it('leaves ordinary files untouched rather than stamping them false', () => {
        // 48888 of the library's files are mp3. An explicit `needsRemux: false` on
        // every one of them is pure payload weight on a 228-file book.
        const tracks = projectAbsTracks([
            { index: 1, ino: '1', startOffset: 0, duration: 60, codec: 'mp3' },
        ]);
        const [annotated] = annotateRemuxTracks(tracks, { '1': 'mp3' });
        expect(annotated).not.toHaveProperty('needsRemux');
    });

    it('never flags the inode-less synthetic transcode track', () => {
        // It stands for the whole book and is fetched as an HLS playlist; there is
        // no file to remux and `…/remux/undefined` is not a thing. The codec here
        // is deliberately one that WOULD be flagged on a real file — with a null
        // codec (what ABS actually sends) the case would pass whether the inode
        // guard existed or not, and prove nothing.
        const tracks = projectAbsTracks([
            {
                index: 1,
                startOffset: 0,
                duration: 3600,
                codec: 'eac3',
                mimeType: 'application/x-mpegURL',
            },
        ]);
        expect(tracks[0].ino).toBeUndefined();
        const [annotated] = annotateRemuxTracks(tracks, {});
        expect(annotated.needsRemux).toBeUndefined();
    });

    it('flags every affected file of a multi-file book', () => {
        // Both measured E-AC-3 books are 100% E-AC-3 (20 and 19 files).
        const tracks = projectAbsTracks(
            Array.from({ length: 3 }, (_unused, i) => ({
                index: i + 1,
                ino: String(i),
                startOffset: i * 60,
                duration: 60,
                codec: 'eac3',
            })),
        );
        const annotated = annotateRemuxTracks(tracks, { '0': 'eac3', '1': 'eac3', '2': 'eac3' });
        expect(annotated.map((t) => t.needsRemux)).toEqual([true, true, true]);
    });

    it('works with an empty persisted map (live codec alone)', () => {
        const tracks = projectAbsTracks([
            { index: 1, ino: '1', startOffset: 0, duration: 60, codec: 'eac3' },
            { index: 2, ino: '2', startOffset: 60, duration: 60, codec: 'mp3' },
        ]);
        const annotated = annotateRemuxTracks(tracks, {});
        expect(annotated[0].needsRemux).toBe(true);
        expect(annotated[1].needsRemux).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // A file with NO readable codec
    //
    // `audiobookCodecNeedsRemux('')` is false, exactly like `aac`, so an
    // unreadable codec used to be indistinguishable from a safe one and got
    // direct-played — reproducing the original EncodingError with no error
    // surfaced and no fallback. Measured on the reference server (2026-07-30):
    // `codec` is present on all 1514 files of a 40-book sample and on every
    // live `audioTracks[]` entry, so an empty codec means something is wrong
    // with THAT file — unless nothing in the book has one, which means the
    // source is silent and remuxing everything would be worse.
    // -----------------------------------------------------------------------

    it('flags a codec-less file when its siblings DID report a codec', () => {
        const tracks = projectAbsTracks([
            { index: 1, ino: '1', startOffset: 0, duration: 60, codec: 'mp3' },
            // ABS's ffprobe failed on this one: no codec, while the rest of the
            // book has them.
            { index: 2, ino: '2', startOffset: 60, duration: 60, mimeType: 'audio/mp4' },
            { index: 3, ino: '3', startOffset: 120, duration: 60, codec: 'mp3' },
        ]);
        expect(tracks[1].codec).toBeNull();

        const annotated = annotateRemuxTracks(tracks, {});
        expect(annotated[1].needsRemux).toBe(true);
        // ...and only that one — the anomaly is per file, not per book.
        expect(annotated[0].needsRemux).toBeUndefined();
        expect(annotated[2].needsRemux).toBeUndefined();
    });

    it('flags a file the sweep has not seen and the live payload cannot describe', () => {
        // The persisted map answers for the other file, so "some codec is known"
        // holds through the persisted source as well as the live one.
        const tracks = projectAbsTracks([
            { index: 1, ino: 'known', startOffset: 0, duration: 60 },
            { index: 2, ino: 'unswept', startOffset: 60, duration: 60 },
        ]);
        const annotated = annotateRemuxTracks(tracks, { known: 'mp3' });
        expect(annotated[0].needsRemux).toBeUndefined();
        expect(annotated[1].needsRemux).toBe(true);
    });

    it('flags NOTHING when no file in the book reported a codec at all', () => {
        // An unswept library plus a server that does not report the field. We have
        // no codec information, and flagging on that basis would pipe every file
        // of every book through ffmpeg to fix a problem it probably does not have.
        const tracks = projectAbsTracks(
            Array.from({ length: 4 }, (_unused, i) => ({
                index: i + 1,
                ino: String(i),
                startOffset: i * 60,
                duration: 60,
                mimeType: 'audio/mpeg',
            })),
        );
        expect(tracks.every((t) => t.codec === null)).toBe(true);

        const annotated = annotateRemuxTracks(tracks, {});
        expect(annotated.map((t) => t.needsRemux)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });

    it('does not let the inode-less synthetic track count as a known codec', () => {
        // The transcode session's whole-book track is not a file. If it were
        // allowed to vouch for "some codec is known", a real codec-less file
        // sharing the payload would be flagged on the strength of a track that
        // has no inode to remux.
        const tracks = projectAbsTracks([
            {
                index: 1,
                startOffset: 0,
                duration: 3600,
                codec: 'eac3',
                mimeType: 'application/x-mpegURL',
            },
            { index: 2, ino: '2', startOffset: 0, duration: 60 },
        ]);
        expect(tracks[0].ino).toBeUndefined();

        const annotated = annotateRemuxTracks(tracks, {});
        expect(annotated[0].needsRemux).toBeUndefined();
        expect(annotated[1].needsRemux).toBeUndefined();
    });

    it('lets a blank persisted codec lose to the live one instead of erasing it', () => {
        // The persisted value wins because it is BETTER information; '' is not
        // information. A sweep that wrote a blank for a file it could not probe
        // must not throw away a codec ABS did report — least of all into the
        // "unknown, so remux" branch.
        const tracks = projectAbsTracks([
            { index: 1, ino: '1', startOffset: 0, duration: 60, codec: 'mp3' },
            { index: 2, ino: '2', startOffset: 60, duration: 60, codec: 'eac3' },
        ]);
        const annotated = annotateRemuxTracks(tracks, { '1': '   ', '2': '' });
        expect(annotated[0].needsRemux).toBeUndefined();
        // Fell back to the live `eac3`, so it is flagged for the RIGHT reason.
        expect(annotated[1].needsRemux).toBe(true);
    });

    it('treats blank on both sides as unknown', () => {
        const tracks = projectAbsTracks([
            { index: 1, ino: '1', startOffset: 0, duration: 60, codec: 'mp3' },
            { index: 2, ino: '2', startOffset: 60, duration: 60 },
        ]);
        const annotated = annotateRemuxTracks(tracks, { '1': 'mp3', '2': '  ' });
        expect(annotated[0].needsRemux).toBeUndefined();
        expect(annotated[1].needsRemux).toBe(true);
    });
});
