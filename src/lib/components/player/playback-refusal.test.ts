// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import {
    describeInfoRefusal,
    describeManifestRefusal,
    describePolicyRefusal,
    parseRefusalDetails,
} from './playback-refusal.js';

/**
 * Regression: a `POST /play-sessions` 422 for anything but the stream limit
 * reached the user as the raw identifier ("Stream not allowed:
 * transcode_not_allowed"), and the stream-limit text was hard-coded English
 * inside an otherwise German player.
 */
describe('describePolicyRefusal', () => {
    // The wire shape: details is a JSON STRING (ApiResponses.unprocessableEntity).
    const wire = (obj: Record<string, unknown>) => obj;

    it('stream limit with counts from the JSON-string details', () => {
        expect(
            describePolicyRefusal(
                'stream_limit',
                wire({ error: 'stream_limit', active: 2, limit: 2 }),
            ),
        ).toBe(m.playback_refusal_stream_limit({ active: 2, limit: 2 }));
    });

    it('stream limit without usable counts falls back to the count-free text', () => {
        expect(describePolicyRefusal('stream_limit', 'not json')).toBe(
            m.playback_refusal_stream_limit_generic(),
        );
        expect(describePolicyRefusal('stream_limit', { active: 'x' })).toBe(
            m.playback_refusal_stream_limit_generic(),
        );
    });

    it('transcode_not_allowed points at the admin', () => {
        expect(
            describePolicyRefusal(
                'transcode_not_allowed',
                wire({ allowedMethods: ['direct'], suggestion: 'direct' }),
            ),
        ).toBe(m.playback_refusal_transcode_not_allowed());
    });

    it('ip_restricted rounds the grace up to whole minutes', () => {
        expect(describePolicyRefusal('ip_restricted', wire({ graceRemainingSeconds: 61 }))).toBe(
            m.playback_refusal_ip_restriction({ minutes: 2 }),
        );
        expect(describePolicyRefusal('ip_restricted', wire({ graceRemainingSeconds: 5 }))).toBe(
            m.playback_refusal_ip_restriction({ minutes: 1 }),
        );
        expect(describePolicyRefusal('ip_restricted', undefined)).toBe(
            m.playback_refusal_ip_restriction_generic(),
        );
    });

    it('source_incompatible', () => {
        expect(describePolicyRefusal('source_incompatible', wire({ reason: 'x' }))).toBe(
            m.playback_refusal_source_incompatible(),
        );
    });

    it("plugin_denied shows the plugin's own reason, or the admin fallback", () => {
        expect(
            describePolicyRefusal(
                'plugin_denied',
                wire({ plugin: 'p', reason: 'Not during school hours' }),
            ),
        ).toBe(m.playback_refusal_blocked_reason({ reason: 'Not during school hours' }));
        expect(describePolicyRefusal('plugin_denied', wire({ plugin: 'p', reason: ' ' }))).toBe(
            m.playback_refusal_not_allowed(),
        );
    });

    it('never echoes an unknown kind', () => {
        const msg = describePolicyRefusal('some_future_kind', undefined);
        expect(msg).toBe(m.playback_refusal_not_allowed());
        expect(msg).not.toContain('some_future_kind');
    });

    it('every kind maps to a non-empty message', () => {
        for (const kind of [
            'stream_limit',
            'transcode_not_allowed',
            'ip_restricted',
            'source_incompatible',
            'plugin_denied',
        ]) {
            const msg = describePolicyRefusal(kind, undefined);
            expect(msg.length).toBeGreaterThan(0);
            expect(msg).not.toContain(kind);
        }
    });
});

describe('describeManifestRefusal', () => {
    it('429 (stream count or per-user job cap) is the stream-limit message', () => {
        expect(describeManifestRefusal(429)).toBe(m.playback_refusal_stream_limit_generic());
    });

    it('404 / 401 / 403 / other', () => {
        expect(describeManifestRefusal(404)).toBe(m.playback_refusal_file_missing());
        expect(describeManifestRefusal(401)).toBe(m.playback_refusal_not_authorized());
        expect(describeManifestRefusal(403)).toBe(m.playback_refusal_not_authorized());
        expect(describeManifestRefusal(undefined)).toBe(m.playback_refusal_unavailable());
    });

    // A 403 used to mean only "not authorized"; the diagnostic code decides.
    it('403 with playback-method-not-allowed is the transcode-not-allowed message', () => {
        expect(describeManifestRefusal(403, 'playback-method-not-allowed')).toBe(
            m.playback_refusal_transcode_not_allowed(),
        );
        expect(describeManifestRefusal(403, 'concurrency-limit')).toBe(
            m.playback_refusal_not_authorized(),
        );
        expect(describeManifestRefusal(403, undefined)).toBe(m.playback_refusal_not_authorized());
    });
});

describe('describeInfoRefusal', () => {
    it('404 gives no reason (access-denied is a 404 by design)', () => {
        const msg = describeInfoRefusal(404, 'Media not found');
        expect(msg).toBe(m.playback_refusal_not_available());
        expect(msg).not.toContain('Media not found');
    });

    it('403 is a plugin veto whose error is the reason', () => {
        expect(describeInfoRefusal(403, 'Blocked by policy')).toBe(
            m.playback_refusal_blocked_reason({ reason: 'Blocked by policy' }),
        );
        expect(describeInfoRefusal(403, undefined)).toBe(m.playback_refusal_not_allowed());
    });

    it('anything else is the generic unavailable text, never the raw server error', () => {
        expect(describeInfoRefusal(500, 'Internal server error')).toBe(
            m.playback_refusal_unavailable(),
        );
    });
});

describe('parseRefusalDetails', () => {
    it('accepts a JSON string or an object, rejects the rest', () => {
        expect(parseRefusalDetails('{"a":1}')).toBeUndefined();
        expect(parseRefusalDetails({ a: 1 })).toEqual({ a: 1 });
        expect(parseRefusalDetails('[1]')).toBeUndefined();
        expect(parseRefusalDetails('{bad')).toBeUndefined();
        expect(parseRefusalDetails(undefined)).toBeUndefined();
    });
});
