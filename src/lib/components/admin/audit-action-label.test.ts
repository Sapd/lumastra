// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatAuditAction } from './audit-action-label';

describe('formatAuditAction', () => {
    it.each([
        ['pat.create', 'API tokens · created'],
        ['settings.save', 'Settings · saved'],
        ['plugin.external.install', 'Plugins · installed (external)'],
        ['play_session.kill', 'Play sessions · stopped'],
        ['user.reset_password', 'Users · password reset'],
    ])('%s → %s', (action, label) => {
        expect(formatAuditAction(action)).toBe(label);
    });

    it('falls back to the humanised id for unknown namespaces and verbs', () => {
        expect(formatAuditAction('widget.frobnicate_all')).toBe('Widget · frobnicate all');
        expect(formatAuditAction('widget')).toBe('Widget');
    });
});
