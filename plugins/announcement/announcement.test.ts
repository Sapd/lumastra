// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import announcement from './index.js';

function route(method: string, path: string) {
    const r = announcement.routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route ${method} ${path} not found`);
    return r;
}

function ctx(
    settings: Record<string, unknown>,
    user: unknown = { username: 'admin', groups: ['admins'], isAdmin: true },
) {
    return { user, settings: async () => settings } as never;
}

async function getAnnouncement(settings: Record<string, unknown>, user?: unknown) {
    const res = await route('GET', '/announcement').handler(
        ctx(settings, user),
        new Request('http://x/announcement'),
        {},
    );
    return { status: res.status, body: await res.json() };
}

describe('announcement plugin', () => {
    it('declares a below-hero banner widget + browserUi capability', () => {
        expect(announcement.capabilities?.browserUi).toBe(true);
        expect(announcement.widgets?.[0].placement).toBe('below-hero');
        expect(announcement.widgets?.[0].entry).toBe('/widget.js');
    });

    it('returns the announcement when enabled with a message', async () => {
        const { status, body } = await getAnnouncement({
            enabled: true,
            message: '  Maintenance at 22:00  ',
            title: 'Heads up',
            severity: 'warning',
            dismissible: true,
        });
        expect(status).toBe(200);
        expect(body.enabled).toBe(true);
        expect(body.message).toBe('Maintenance at 22:00'); // trimmed
        expect(body.title).toBe('Heads up');
        expect(body.severity).toBe('warning');
        expect(body.dismissible).toBe(true);
        expect(typeof body.version).toBe('string');
    });

    it('is NOT shown when enabled but the message is empty', async () => {
        const { body } = await getAnnouncement({ enabled: true, message: '   ' });
        expect(body.enabled).toBe(false);
        expect(body.message).toBe('');
    });

    it('is NOT shown when disabled (message hidden, not leaked)', async () => {
        const { body } = await getAnnouncement({
            enabled: false,
            message: 'secret upcoming feature',
        });
        expect(body.enabled).toBe(false);
        expect(body.message).toBe('');
        expect(body.title).toBe('');
    });

    it('normalizes an unknown severity to info; dismissible defaults true', async () => {
        const { body } = await getAnnouncement({ enabled: true, message: 'hi', severity: 'bogus' });
        expect(body.severity).toBe('info');
        expect(body.dismissible).toBe(true);
    });

    it('version changes when the visible content changes (re-show after edit)', async () => {
        const a = (await getAnnouncement({ enabled: true, message: 'v1', severity: 'info' })).body;
        const b = (await getAnnouncement({ enabled: true, message: 'v2', severity: 'info' })).body;
        const c = (await getAnnouncement({ enabled: true, message: 'v1', severity: 'critical' }))
            .body;
        expect(a.version).not.toBe(b.version); // message changed
        expect(a.version).not.toBe(c.version); // severity changed
    });

    it('401s without an authenticated user', async () => {
        const { status } = await getAnnouncement({ enabled: true, message: 'hi' }, null);
        expect(status).toBe(401);
    });
});
