// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres error codes that a client resubmitting the SAME payload can never
 * get past.
 *
 * These describe the DATA, not the moment: a numeric value out of range or a
 * bad text representation fails identically on every attempt. Classifying one
 * as transient is what turns a single malformed event into a permanent
 * resident of a client's retry queue, resubmitted on every flush forever.
 *
 * Deliberately a short allow-list rather than "anything that isn't a
 * connection error". The asymmetry matters: calling a transient failure
 * permanent DISCARDS real user data, while calling a permanent one transient
 * only wastes a retry slot — so anything unrecognised stays retryable.
 */
const PERMANENT_PG_ERROR_CODES = new Set([
    '22003', // numeric_value_out_of_range — e.g. a ms value past int4
    '22P02', // invalid_text_representation
    '22001', // string_data_right_truncation
    '22007', // invalid_datetime_format
    '22008', // datetime_field_overflow
]);

/**
 * Whether a write failure is a property of the payload rather than of the
 * moment it was attempted.
 */
export function isPermanentWriteError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && PERMANENT_PG_ERROR_CODES.has(code);
}
