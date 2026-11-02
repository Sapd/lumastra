// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard over the REAL config schema. A new setting breaks this file until it is
 * classified, so no new free-text value reaches a debug report unreviewed.
 */

import { describe, it, expect } from 'vitest';
import { configSchema, type SettingDefinition } from '$lib/config/schema';
import { redactConfigValues } from '$lib/shared/diagnostics-report';
import { DEBUG_REPORT_STRING_ALLOWLIST, configValueVisible, looksSecretName } from './redact.js';

const CLASSIFY =
    'Classify the new key in the config schema: a secret needs uiHints.sensitive: true; ' +
    'a free string may be shown only after it is added to DEBUG_REPORT_STRING_ALLOWLIST in ' +
    'src/lib/server/debug-report/redact.ts, with a comment giving the reason. Otherwise it stays hidden.';

function hasClosedOptions(def: SettingDefinition): boolean {
    return (def.options?.length ?? 0) > 0 || (def.validation?.options?.length ?? 0) > 0;
}

describe('debug report config visibility (real schema)', () => {
    it('hides the value of every uiHints.sensitive key', () => {
        const sensitive = configSchema.filter((def) => def.uiHints?.sensitive === true);
        expect(sensitive.length).toBeGreaterThan(0);
        for (const def of sensitive) {
            expect(configValueVisible(def.key, def), `${def.key} is sensitive. ${CLASSIFY}`).toBe(
                false,
            );
        }
    });

    it('hides every string key without a closed option list unless it is on the allow-list', () => {
        const freeStrings = configSchema.filter(
            (def) => def.type === 'string' && !hasClosedOptions(def),
        );
        expect(freeStrings.length).toBeGreaterThan(0);
        for (const def of freeStrings) {
            const allowed = DEBUG_REPORT_STRING_ALLOWLIST.includes(def.key);
            expect(
                configValueVisible(def.key, def),
                `${def.key} is a free string. ${CLASSIFY}`,
            ).toBe(allowed);
        }
    });

    it('shows boolean and number keys unless the redaction rules mask them', () => {
        const scalars = configSchema.filter(
            (def) => def.type === 'boolean' || def.type === 'number',
        );
        expect(scalars.length).toBeGreaterThan(0);
        for (const def of scalars) {
            const masked =
                redactConfigValues({ [def.key]: 'probe' }, () => def.uiHints?.sensitive === true)[
                    def.key
                ] !== 'probe';
            expect(configValueVisible(def.key, def), `${def.key} visibility. ${CLASSIFY}`).toBe(
                !masked &&
                    !looksSecretName(def.key) &&
                    !(
                        def.type === 'number' &&
                        /(^|_)(ID|IDS|UID|GID|CHAT_ID|USER_ID|GROUP_ID|ACCOUNT)($|_)/.test(def.key)
                    ),
            );
        }
    });

    it('keeps every allow-listed key in the schema, as a non-sensitive string without options', () => {
        expect(new Set(DEBUG_REPORT_STRING_ALLOWLIST).size).toBe(
            DEBUG_REPORT_STRING_ALLOWLIST.length,
        );
        for (const key of DEBUG_REPORT_STRING_ALLOWLIST) {
            const def = configSchema.find((candidate) => candidate.key === key);
            expect(
                def,
                `${key} is on the allow-list but not in the schema. ${CLASSIFY}`,
            ).toBeDefined();
            if (def === undefined) continue;
            expect(
                def.uiHints?.sensitive,
                `${key} is sensitive and cannot be allow-listed`,
            ).not.toBe(true);
            expect(def.type, `${key} must be a string setting`).toBe('string');
            expect(
                hasClosedOptions(def),
                `${key} has a closed option list; it needs no allow-list entry`,
            ).toBe(false);
        }
    });
});

describe('numeric identifiers', () => {
    it.each([
        'UID',
        'GID',
        'TELEGRAM_CHAT_ID',
        'USER_ID',
        'GROUP_ID',
        'ACCOUNT',
        'PLUGIN_IDS',
        'EXTERNAL_ACCOUNT_NUMBER',
    ])('hides %s', (key) => {
        const def = {
            ...configSchema.find((entry) => entry.type === 'number')!,
            key,
            type: 'number',
            uiHints: {},
        } as SettingDefinition;
        expect(configValueVisible(key, def)).toBe(false);
    });

    it.each(['PORT', 'HTTP_PORT', 'TIMEOUT', 'TASK_LIMIT', 'MAX_RETRIES'])(
        'keeps operational number %s visible',
        (key) => {
            const def = {
                ...configSchema.find((entry) => entry.type === 'number')!,
                key,
                type: 'number',
                uiHints: {},
            } as SettingDefinition;
            expect(configValueVisible(key, def)).toBe(true);
        },
    );
});
