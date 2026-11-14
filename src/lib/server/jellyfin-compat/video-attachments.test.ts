// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { attachmentContentType, parseAttachmentProbe, wantsAttachments } from './video-attachments';

describe('parseAttachmentProbe', () => {
    it('reads index, codec, tags (any case) and drops the null codec tag', () => {
        const out = parseAttachmentProbe(
            JSON.stringify({
                streams: [
                    {
                        index: 4,
                        codec_name: 'ttf',
                        codec_tag_string: '[0][0][0][0]',
                        tags: { filename: 'Fancy.ttf', mimetype: 'font/ttf' },
                    },
                    {
                        index: 5,
                        codec_name: 'otf',
                        codec_tag_string: 'abcd',
                        tags: { FILENAME: 'B.otf', MIMETYPE: 'font/otf', COMMENT: 'c' },
                    },
                    { codec_name: 'broken' },
                ],
            }),
        );
        expect(out).toEqual([
            {
                index: 4,
                codec: 'ttf',
                codecTag: null,
                fileName: 'Fancy.ttf',
                mimeType: 'font/ttf',
                comment: null,
            },
            {
                index: 5,
                codec: 'otf',
                codecTag: 'abcd',
                fileName: 'B.otf',
                mimeType: 'font/otf',
                comment: 'c',
            },
        ]);
    });

    it('tolerates a probe without streams', () => {
        expect(parseAttachmentProbe('{}')).toEqual([]);
    });
});

describe('wantsAttachments', () => {
    it.each([
        ['mkv', ['ass'], true],
        ['MKV', ['subrip', 'ssa'], true],
        ['webm', ['ASS'], true],
        ['mkv', ['subrip', 'hdmv_pgs_subtitle'], false],
        ['mp4', ['ass'], false],
        ['mkv', [], false],
        [null, ['ass'], false],
    ] as const)('%s with %j -> %s', (container, codecs, expected) => {
        expect(wantsAttachments(container, codecs)).toBe(expected);
    });
});

describe('attachmentContentType', () => {
    it("uses the attachment's mimetype only for font types, else octet-stream", () => {
        const base = { index: 1, codec: null, codecTag: null, fileName: null, comment: null };
        expect(attachmentContentType({ ...base, mimeType: 'font/ttf' })).toBe('font/ttf');
        expect(attachmentContentType({ ...base, mimeType: 'Application/X-TrueType-Font' })).toBe(
            'application/x-truetype-font',
        );
        for (const hostile of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml']) {
            expect(attachmentContentType({ ...base, mimeType: hostile })).toBe(
                'application/octet-stream',
            );
        }
        expect(attachmentContentType({ ...base, mimeType: null })).toBe('application/octet-stream');
    });
});
