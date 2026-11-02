// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * config.ts getter fallbacks ↔ schema defaults, with the ConfigService OFF.
 *
 * `config.schema-consistency.test.ts` compares `config.KEY` with the schema
 * default, but in a normal test process the ConfigService initialises and
 * resolves every unset key to the SCHEMA default — so the literal passed to
 * `getNumber(...)` / `getString(...)` is never reached and that test compares
 * the schema with itself. PREVIEW_MAX_WIDTH/HEIGHT drifted to 1280/720 against
 * a schema default of 640/360 that way.
 *
 * The literal is what standalone scripts (migrations, CLI tools) get, because
 * there `initConfigServiceSync` throws and config.ts falls back to env + the
 * literal. This file forces that path and compares again.
 */

import { describe, it, expect, vi } from 'vitest';

// A plain flag, not a vi.fn(): the suite's mock reset between tests would
// wipe a spy's call history before the sanity check below reads it.
const initState = vi.hoisted(() => ({ refused: 0 }));

vi.mock('./config/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./config/index.js')>();
    return {
        ...actual,
        initConfigServiceSync: () => {
            initState.refused++;
            throw new Error('ConfigService disabled: exercising the standalone fallback path');
        },
    };
});

const { configSchema } = await import('$lib/config/schema.js');
const { config } = await import('./config.js');
const { parseList } = await import('./utils/string-utils.js');

/**
 * Keys whose getter fallback legitimately differs from the schema default.
 * Every entry needs a reason.
 */
const KNOWN_FALLBACK_DIVERGENCES: Record<string, string> = {
    LOG_LEVEL: "NODE_ENV-dependent fallback ('debug' in dev/test, 'info' in prod)",
    SHOW_DEVELOPER_TOOLS: 'falls back to devFeaturesEnabled (on in dev/test, off in prod)',
};

describe('config.ts fallback literals (ConfigService unavailable)', () => {
    it('match the schema defaults', () => {
        const mismatches: string[] = [];
        for (const setting of configSchema) {
            if (!Object.prototype.hasOwnProperty.call(config, setting.key)) continue;
            if (setting.dynamicDefault) continue;
            if (setting.key in KNOWN_FALLBACK_DIVERGENCES) continue;
            if (process.env[setting.key] !== undefined) continue;

            let actual: unknown;
            try {
                actual = (config as Record<string, unknown>)[setting.key];
            } catch {
                continue; // getters that require a secret (master key, …) in this path
            }
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
                        `${setting.key}: config.ts=${JSON.stringify(actual)} schema=${JSON.stringify(expected)}`,
                    );
                }
            }
        }
        expect(
            mismatches,
            `getter fallbacks drifted from schema defaults:\n${mismatches.join('\n')}`,
        ).toEqual([]);
    });

    it('sanity: config.ts really ran without the ConfigService', () => {
        // Guards the mock above: if the ConfigService still initialised, the
        // comparison would be schema-vs-schema again and prove nothing.
        expect(initState.refused).toBeGreaterThan(0);
    });
});
