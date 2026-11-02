// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Stream a music track',
        stability: 'protocol',
        description:
            'Streams audio for a music track. Auth via Bearer or a `grant` query param for AVPlayer.',
        auth: 'bearer-or-grant',
        query: z.object({
            grant: z
                .string()
                .optional()
                .meta({ description: 'Playback delivery grant (URL auth)' }),
            format: z
                .enum(['raw', 'mp3', 'aac', 'm4a', 'opus'])
                .optional()
                .meta({
                    description:
                        'Target format. `raw` requests the original file; conflicting bitrate controls are refused. `mp3` is the broadest-compatibility rung. ' +
                        '`m4a` is AAC in an MP4 container — use this rather than `aac`, ' +
                        'which emits a raw ADTS stream that plays over HTTP but cannot be ' +
                        'opened from disk by AVFoundation, so a downloaded file fails. ' +
                        'Omitted, the source is served as-is.',
                }),
            bitrateKbps: z.coerce
                .number()
                .int()
                .optional()
                .meta({
                    description:
                        'Encode bitrate in kbps. Snapped down to the codec ladder ' +
                        '(mp3/aac/m4a: 64, 96, 128, 160, 192, 256, 320; opus: 32–192). ' +
                        'Unlike `maxBitrateKbps` this FORCES a re-encode even when the source ' +
                        'is already the target codec, which is what makes the rungs of a ' +
                        'quality ladder actually differ. Check the X-Audio-Bitrate-Kbps response ' +
                        'header for the applied encoder rate.',
                }),
            maxBitrateKbps: z.coerce
                .number()
                .int()
                .optional()
                .meta({
                    description:
                        'Subsonic-style CAP in kbps: transcodes only when the source exceeds ' +
                        'it, and `0` means no cap. Prefer `bitrateKbps` for a quality ladder.',
                }),
            startPositionSeconds: z.coerce
                .number()
                .nonnegative()
                .optional()
                .meta({ description: 'Start offset in seconds. Forces a transcode.' }),
            download: z
                .enum(['1', 'true'])
                .optional()
                .meta({
                    description:
                        'Marks this as a file transfer rather than playback: no play session ' +
                        "is opened, the user's other music sessions are left alone, and the " +
                        'response carries Content-Disposition: attachment. Set this when ' +
                        'fetching for offline use, or a 12-track album download registers as ' +
                        '12 plays.',
                }),
        }),
        responses: {
            200: {
                binary: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'],
                description:
                    'Audio stream. Responses carry X-Audio-Codec, ' +
                    'X-Audio-Container and X-Audio-Bitrate-Kbps describing what was ' +
                    'actually delivered, which may differ from the requested rate when the ' +
                    'encoder ladder clamps it.',
            },
            401: 'Authentication required',
            404: 'Not found',
            422: 'Unsupported format or incompatible audio controls',
            500: 'Internal server error',
        },
    },
};
