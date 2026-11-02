// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schema ↔ config consistency guard.
 *
 * The config surface has two failure modes that type-checking cannot catch:
 *
 * 1. A schema-registered, admin-editable setting (no `requiresRestart`) backed
 *    by a ONCE-AT-BOOT value in config.ts — the admin UI presents it as
 *    live-apply, but saving it does nothing until the container restarts.
 *    This happened to 10 settings (HW_DECODE_10BIT, INTEL_LP_H264, …) before
 *    these tests existed.
 *
 * 2. The default in config.ts drifting from the default in schema.ts — the
 *    running app uses the schema default (via ConfigService) while standalone
 *    scripts use the config.ts fallback, silently disagreeing.
 *
 * Deliberate boot-time snapshots must either carry `requiresRestart: true` in
 * the schema (so the admin UI says so) or be listed here with a reason.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from './config/config.service.js';
import { configSchema } from '$lib/config/schema.js';
import * as configModule from './config.js';
import { parseList } from './utils/string-utils.js';

const { config } = configModule;

/**
 * Schema keys that are intentionally NOT live on the `config` object even
 * though the schema does not mark them `requiresRestart`. Every entry needs a
 * reason; prefer fixing the getter or flagging the schema over growing this.
 */
const KNOWN_BOOT_TIME_EXCEPTIONS: Record<string, string> = {};

/**
 * Keys whose config.ts fallback default legitimately differs from the schema
 * default (environment-derived or context-dependent).
 */
const KNOWN_DEFAULT_DIVERGENCES = new Set<string>([
    // NODE_ENV-dependent fallback ('debug' in dev/test, 'info' in prod).
    'LOG_LEVEL',
]);

const schemaByKey = new Map(configSchema.map((s) => [s.key, s]));

describe('schema ↔ config consistency', () => {
    it('offers the retention off switch through the admin UI schema', () => {
        const ui = getSchema().settings.find(
            (setting) => setting.key === 'UNAVAILABLE_MEDIA_RETENTION_DAYS',
        );
        expect(ui).toBe(schemaByKey.get('UNAVAILABLE_MEDIA_RETENTION_DAYS'));
        expect(ui?.validation).toMatchObject({ min: 0, max: 3650, integer: true });
        expect(ui?.description).toContain('0 to disable');
    });

    it('every admin-editable (non-requiresRestart) schema key on `config` is a live getter', () => {
        const offenders: string[] = [];
        for (const setting of configSchema) {
            if (setting.requiresRestart) continue;
            if (!Object.prototype.hasOwnProperty.call(config, setting.key)) continue;
            if (setting.key in KNOWN_BOOT_TIME_EXCEPTIONS) continue;
            const descriptor = Object.getOwnPropertyDescriptor(config, setting.key);
            if (typeof descriptor?.get !== 'function') {
                offenders.push(setting.key);
            }
        }
        expect(
            offenders,
            `these schema-registered settings are frozen at boot but the admin UI treats them ` +
                `as live-apply — make them getters, mark them requiresRestart, or document them ` +
                `in KNOWN_BOOT_TIME_EXCEPTIONS: ${offenders.join(', ')}`,
        ).toEqual([]);
    });

    it('every admin-editable schema key backed by a module-level export const is flagged requiresRestart', () => {
        // Module-level `export const` values (LUMASTRA_CONCURRENCY_*, …) are read
        // once at module load; `live()` bindings are exempt (they follow saves). If the schema
        // registers such a key WITHOUT requiresRestart, the admin UI implies
        // live-apply that cannot happen.
        const offenders: string[] = [];
        for (const setting of configSchema) {
            if (setting.requiresRestart) continue;
            if (Object.prototype.hasOwnProperty.call(config, setting.key)) continue; // handled above
            if (setting.key in KNOWN_BOOT_TIME_EXCEPTIONS) continue;
            // `export let X = live(...)` bindings are re-read on every config change.
            if (configModule.LIVE_SETTING_KEYS.has(setting.key)) continue;
            if (Object.prototype.hasOwnProperty.call(configModule, setting.key)) {
                offenders.push(setting.key);
            }
        }
        expect(
            offenders,
            `these schema keys are load-once export consts but not marked requiresRestart: ` +
                offenders.join(', '),
        ).toEqual([]);
    });

    it('config.ts fallback defaults match schema defaults', () => {
        // Only comparable when the running value actually resolves to a
        // default: skip keys overridden by the test process environment,
        // keys with environment-derived defaults, and complex types.
        const mismatches: string[] = [];
        for (const setting of configSchema) {
            if (!Object.prototype.hasOwnProperty.call(config, setting.key)) continue;
            if (setting.dynamicDefault) continue;
            if (KNOWN_DEFAULT_DIVERGENCES.has(setting.key)) continue;
            if (process.env[setting.key] !== undefined) continue;

            const actual = (config as Record<string, unknown>)[setting.key];
            let expected = setting.defaultValue;
            if (Array.isArray(actual) && typeof expected === 'string') {
                expected = parseList(expected);
            }
            if (
                typeof actual === 'string' ||
                typeof actual === 'number' ||
                typeof actual === 'boolean' ||
                Array.isArray(actual)
            ) {
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    mismatches.push(
                        `${setting.key}: config=${JSON.stringify(actual)} schema=${JSON.stringify(expected)}`,
                    );
                }
            }
        }
        expect(
            mismatches,
            `defaults drifted between schema.ts and config.ts:\n${mismatches.join('\n')}`,
        ).toEqual([]);
    });

    it('sanity: the schema map is populated', () => {
        expect(schemaByKey.size).toBeGreaterThan(100);
    });
});

it('makes the Live TV LAN opt-in discoverable without advanced mode or a restart', () => {
    const setting = getSchema().settings.find((s) => s.key === 'LIVETV_ALLOW_PRIVATE_URLS');
    expect(setting).toMatchObject({ type: 'boolean', section: 'livetv', defaultValue: false });
    expect(setting?.requiresRestart).not.toBe(true);
    expect(setting?.uiHints?.advanced).not.toBe(true);
});
