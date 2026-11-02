// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyset-cursor builder tests (E4 foundation gate).
 *
 * Proves the two invariants the effort exists to guarantee:
 *  1. The cursor codec round-trips a microsecond-precision timestamp
 *     byte-for-byte — NO millisecond truncation, because the codec never
 *     touches `Date`.
 *  2. `pgTextTimestamp` pins the bind parameter's wire OID to `text` (25), not
 *     `timestamptz` (1184), so postgres.js ships the raw string and Postgres
 *     parses it server-side losslessly.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import {
    PG_TEXT_OID,
    pgTextTimestamp,
    encodeKeysetCursor,
    decodeKeysetCursor,
} from './keyset-cursor.builder.js';
import type { KeysetCursor } from './keyset-cursor.builder.js';

// Never connected — we only inspect the Parameter object it produces and the
// serializer registry postgres.js would use to put it on the wire.
const sql = postgres('postgres://localhost');

/**
 * The OID → serializer map postgres.js itself consults at bind time.
 * `connection.js` serializes every bound value with `options.serializers[type](x)`
 * where `type` is the Parameter's OID, so this is the exact function that decides
 * what bytes reach Postgres. Reaching it here lets the unit suite prove the
 * on-the-wire behaviour (not just the constructed Parameter's shape) with no
 * live connection.
 */
interface PostgresSerializerRegistry {
    options: { serializers: Record<number, ((value: string) => string) | undefined> };
}

/**
 * Resolve the serializer postgres.js would apply to a bind parameter of this OID.
 * An OID with no registered serializer ships the value verbatim, so fall back to
 * identity to model that faithfully.
 */
function wireSerializerFor(oid: number): (value: string) => string {
    const registry = sql as unknown as PostgresSerializerRegistry;
    return registry.options.serializers[oid] ?? ((v: string): string => v);
}

// Postgres OID for `timestamptz` — the OID pgTextTimestamp exists to AVOID
// inferring from a `::timestamptz` cast. Its serializer truncates to ms.
const PG_TIMESTAMPTZ_OID = 1184;

describe('PG_TEXT_OID', () => {
    it('is the Postgres OID for text', () => {
        expect(PG_TEXT_OID).toBe(25);
    });
});

describe('encodeKeysetCursor / decodeKeysetCursor', () => {
    it('round-trips a microsecond-precision ts byte-for-byte (no ms truncation)', () => {
        const cursor: KeysetCursor = {
            ts: '2026-07-22 01:02:03.456789+00',
            id: '9f8e7d6c-1234-4a5b-8c9d-abcdef012345',
        };
        const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
        expect(decoded).toEqual(cursor);
        // The sub-millisecond digits survive intact.
        expect(decoded?.ts).toBe('2026-07-22 01:02:03.456789+00');
    });

    it('produces URL-safe base64 (no +, /, or = padding chars)', () => {
        // A payload whose standard-base64 encoding contains +, / and padding.
        const cursor: KeysetCursor = {
            ts: '2026-07-22 01:02:03.999999+00',
            id: '???>>>ÿþ',
        };
        const encoded = encodeKeysetCursor(cursor);
        expect(encoded).not.toMatch(/[+/=]/);
        expect(decodeKeysetCursor(encoded)).toEqual(cursor);
    });

    it('splits on the LAST colon so the colon-bearing ts is preserved whole', () => {
        // Encoding is "<ts>:<id>"; the ts always contains colons and the id
        // (task_history.id / playlists.id) does not. lastIndexOf keeps the ts
        // greedy and takes the final segment as the id.
        const cursor: KeysetCursor = {
            ts: '2026-07-22 01:02:03.456789+00',
            id: '9f8e7d6c-1234-4a5b-8c9d-abcdef012345',
        };
        const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
        expect(decoded).toEqual(cursor);
        expect(decoded?.ts).toBe('2026-07-22 01:02:03.456789+00');
    });

    it('preserves a ts that (as a timestamp always does) contains colons', () => {
        const cursor: KeysetCursor = { ts: '2026-01-01 00:00:00+00', id: '1' };
        const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
        expect(decoded?.ts).toBe('2026-01-01 00:00:00+00');
        expect(decoded?.id).toBe('1');
    });

    it('returns null (never throws) on non-base64 input', () => {
        expect(decodeKeysetCursor('not base64 @#$%^&*')).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(decodeKeysetCursor('')).toBeNull();
    });

    it('returns null when the decoded payload has no separator', () => {
        const noSep = Buffer.from('noseparatorhere', 'utf-8').toString('base64url');
        expect(decodeKeysetCursor(noSep)).toBeNull();
    });

    it('returns null on a leading-separator payload (empty ts)', () => {
        const leading = Buffer.from(':justanid', 'utf-8').toString('base64url');
        expect(decodeKeysetCursor(leading)).toBeNull();
    });

    it('accepts an id that is empty (trailing separator)', () => {
        // "<ts>:" — id is empty but ts is present; this is a valid decode.
        const trailing = Buffer.from('2026-01-01 00:00:00+00:', 'utf-8').toString('base64url');
        const decoded = decodeKeysetCursor(trailing);
        expect(decoded).toEqual({ ts: '2026-01-01 00:00:00+00', id: '' });
    });
});

describe('pgTextTimestamp', () => {
    it('pins the bind parameter OID to text (25), not timestamptz (1184)', () => {
        const value = '2026-07-22 01:02:03.456789+00';
        const param = pgTextTimestamp(sql, value);
        // postgres.js Parameter carries { value, type } at runtime; `type` is the OID.
        expect(param.value).toBe(value);
        expect(param.type).toBe(PG_TEXT_OID);
        expect(param.type).toBe(25);
        expect(param.type).not.toBe(1184);
    });

    it('passes the value through verbatim (never round-trips through Date)', () => {
        const value = '2026-07-22 01:02:03.000001+00';
        const param = pgTextTimestamp(sql, value);
        expect(param.value).toBe(value);
    });

    it('serializes the bind byte-for-byte through postgres.js own OID-keyed serializer (no ms truncation on the wire)', () => {
        const value = '2026-07-22 01:02:03.456789+00';
        const param = pgTextTimestamp(sql, value);

        // The serializer postgres.js actually invokes at bind time is keyed by the
        // Parameter's OID (connection.js: `options.serializers[param.type](value)`).
        // Because the OID is pinned to text (25), that serializer is the identity
        // string serializer, so every microsecond digit reaches Postgres intact —
        // Postgres then parses the raw string server-side, losslessly.
        const onTheWire = wireSerializerFor(param.type)(param.value!);
        expect(onTheWire).toBe(value);
        expect(onTheWire).toContain('.456789');
    });

    it('would truncate to ms had the bind inferred timestamptz (1184) — the loss the text pin prevents', () => {
        // Guard rail proving the pin is load-bearing, not cosmetic. Left as a bare
        // `${x}::timestamptz`, postgres.js infers OID 1184 and routes the value
        // through the date serializer (`new Date(x).toISOString()`), silently
        // dropping sub-millisecond precision. pgTextTimestamp exists to dodge this
        // exact code path, so it must never emit OID 1184.
        const value = '2026-07-22 01:02:03.456789+00';
        const param = pgTextTimestamp(sql, value);
        expect(param.type).not.toBe(PG_TIMESTAMPTZ_OID);

        const truncatedByTimestamptz = wireSerializerFor(PG_TIMESTAMPTZ_OID)(value);
        expect(truncatedByTimestamptz).toBe('2026-07-22T01:02:03.456Z');
        expect(truncatedByTimestamptz).not.toContain('456789');

        // Same input, the OID we DO pin: full precision survives. The two serializers
        // diverging on one input is the whole justification for the module.
        expect(wireSerializerFor(param.type)(value)).toBe(value);
    });
});
