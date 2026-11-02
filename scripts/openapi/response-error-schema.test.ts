// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { PlaybackSessionEndedSchema } from '../../src/lib/schemas/livetv-playback-sessions.js';
import { convertResponse } from './generate-public.js';

describe('custom error response schemas', () => {
    it('documents Live TV session endings as problem+json without losing their reason', () => {
        const response = convertResponse(410, {
            schema: PlaybackSessionEndedSchema,
            contentType: 'application/problem+json',
            description: 'Session ended',
            headers: { 'X-Request-Id': { description: 'Request identifier' } },
        });
        expect(response).toHaveProperty(
            'content.application/problem+json.schema',
            PlaybackSessionEndedSchema,
        );
        expect(response).not.toHaveProperty('content.application/json');
        expect(response).toHaveProperty('headers.shape.X-Request-Id');
        expect(
            PlaybackSessionEndedSchema.parse({
                code: 'gone',
                error: 'playback_session_ended',
                status: 410,
                reason: 'evicted',
            }).reason,
        ).toBe('evicted');
    });

    it('preserves legacy custom JSON errors unless problem+json is explicitly declared', () => {
        const response = convertResponse(410, { schema: PlaybackSessionEndedSchema });
        expect(response).toHaveProperty(
            'content.application/json.schema',
            PlaybackSessionEndedSchema,
        );
    });

    it('keeps successful custom schemas as application/json', () => {
        const response = convertResponse(200, { schema: PlaybackSessionEndedSchema });
        expect(response).toHaveProperty(
            'content.application/json.schema',
            PlaybackSessionEndedSchema,
        );
        expect(response).not.toHaveProperty('content.application/problem+json');
    });
});
