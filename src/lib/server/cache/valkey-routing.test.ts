// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Routing table for the two-instance Valkey split: coordination keys (noeviction
// instance) vs cache keys (evictable instance). The dangerous failure mode is a
// coordination key misclassified as cache → evicted → double-run/stuck/lost auth.
// These cases cover coordination keys used by the application.

import { describe, it, expect } from 'vitest';
import { isCoordinationKey } from './valkey.js';

describe('isCoordinationKey — coordination keyspace (→ noeviction instance)', () => {
    const coordinationKeys = [
        'livetv:v2:psess:session',
        'livetv:v2:viewer-psess:viewer',
        'livetv:v2:session:viewer',
        'livetv:v2:session:*',
        'lock:orch:io',
        'lock:scheduler:sync-tmdb:42',
        'lock:sessions-cache-refresh:9999',
        'lock:cache-warming:nightly',
        'task:run:active:abc-123',
        'task:run:terminal:abc-123',
        'task:identity:embed-metadata:global',
        'task:active-count:media-probe',
        'task:resource-budget:cpu',
        'task:pending-writes',
        'task:cancel:run-1',
        'task:log:run-1',
        'task:heartbeat:reconciler',
        'task:sse:replay',
        'circuit:metadata-sync',
        'circuit-open:tmdb',
        'stage:main:total',
        'scheduler:lastTick',
        'scheduled-wait:x',
        'schedule-overdue:trickplay',
        'cluster:node:web-1',
        'apiconf:2026-10-16',
        'apiconf:s:2026-10-16',
        'jfcompat:session:tok-abc',
        'v1:jf:pat-deny-notice:42',
        'jfcompat:auth_key_plaintext:uuid',
        'jfcompat:auth_key_nonce_for_pat:pat-1',
        // Security review 2026-09-16, task 6 fix round 1 (Important 1): a Quick
        // Connect secret/code is a single-use, short-TTL pending-auth handle,
        // same category as jfcompat:auth_key_/oidc:tx: below — an eviction mid
        // flow silently breaks the pairing, and revokeSessionsForUser()'s QC
        // fan-out sweep SCANs the coordination client specifically.
        'jfcompat:qc:secret:abc123',
        'jfcompat:qc:code:123456',
        // Jellyfin remote control: device / capability / presence hashes are
        // cross-replica session state an app reports only at startup.
        'jfcompat:rc:v1:devices',
        'jfcompat:rc:v1:caps',
        'jfcompat:rc:v1:viewing',
        'jfcompat:rc:v1:online',
        'rate-bucket:anidb',
        'music-transcode:concurrent',
        'v1:playback-plan:550e8400-e29b',
        'livetv:v1:session:denis',
        'livetv:v1:kicked:denis',
        'sessions:v1:kicked:denis',
        'preview:session:v1:abc',
        'preview:user-livetv:v1:denis',
        'preview:livetv:count',
        'playback:livetv:session:xyz',
        'playback:livetv:watchers',
        // Fail-open-if-evicted state: rate limits, revocation markers, single-use
        // sign-in transactions, direct-play tokens, device commands, Watch Together.
        'ratelimit:login:1.2.3.4:123',
        'pat-revoked:abc',
        'stream-token-revoked:x',
        'svc-token-revoked:x',
        'device-session-revoked:v1:x',
        'plugin-auth:tx:v1:x',
        'directplay:token:x',
        'preview:admin-disabled',
        'bandwidth:sessions:v1:x',
        'devcmd:v1:stream:x',
        'watch:v2:session:ABC',
        'livetv:failures:pending',
        'mal:oauth:state-1',
        'trakt:oauth:state-1',
        'assistant-confirm:user:media',
        'device:online:abc',
        'v1:maintenance:notice',
        'oidc:bcl:jti:v1:abc',
    ];
    for (const key of coordinationKeys) {
        it(`routes "${key}" to coordination`, () => {
            expect(isCoordinationKey(key)).toBe(true);
        });
    }
});

it('keeps the legacy Live TV lock routing compatible during a rolling upgrade', () => {
    expect(isCoordinationKey('livetv:v2:psess-lock:viewer')).toBe(false);
});

describe('isCoordinationKey — cache keyspace (→ evictable instance)', () => {
    const cacheKeys = [
        'image-metadata:itemid',
        'local-artwork:itemid',
        'subtitle-resolver:abc',
        'trickplay-sprites:abc',
        'media_id:tmdb:550:movie',
        'plugin:tmdb-metadata-sync:somekey',
        'trending:movies',
        'similar:js:tmdb:550:movie',
        'v1:obs:failure-patterns:tmdb',
        'v1:admin:status',
        'v2:binge-worthy:user:1',
        'bandwidth:pod:v1:x',
        'bandwidth:history:v1:x',
        // Auth-looking UnifiedCache namespaces — recomputable read-through caches.
        'pat:hashabc',
        'service-token:tok',
        'jellyfin-tokens:user-1',
        'streaming-session:tok',
        // Distinct-prefix traps that must NOT match coordination prefixes:
        'preview-livetv-sessions:abc', // 'preview-' not 'preview:'
        'musicLibraryGenres:default',
        'newEpisodes:user-1',
    ];
    for (const key of cacheKeys) {
        it(`routes "${key}" to cache`, () => {
            expect(isCoordinationKey(key)).toBe(false);
        });
    }
});
