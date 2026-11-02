// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { adaptPublicBaseUrl } from './adapters.js';
import { ATTENTION_SOURCE_PREFIXES } from './attention-service.js';

it('surfaces an invalid saved Public Base URL with a safe, actionable re-save message', () => {
    const [alert] = adaptPublicBaseUrl('https://user:never-log-this@example.com', false);
    expect(alert.id).toBe('settings:public-base-url');
    expect(ATTENTION_SOURCE_PREFIXES).toContain(alert.id);
    expect(alert.severity).toBe('warning');
    expect(alert.detail).toMatch(/re-save/i);
    expect(alert.actions[0].href).toContain('highlight=PUBLIC_BASE_URL');
    expect(JSON.stringify(alert)).not.toContain('never-log-this');
});

it('asks the admin to configure an empty URL only when an integration needs it', () => {
    expect(adaptPublicBaseUrl('', false)).toEqual([]);
    expect(adaptPublicBaseUrl('', true)).toHaveLength(1);
    expect(adaptPublicBaseUrl('https://example.com/media/', true)).toEqual([]);
});
