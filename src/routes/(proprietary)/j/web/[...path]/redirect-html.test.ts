// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import { buildDeeplinkRedirectHtml } from './redirect-html';

/** Run the page's inline script against a fake `location`; return where it went. */
function redirectFor(hash: string, base = ''): string | undefined {
    const html = buildDeeplinkRedirectHtml(base);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('no inline script');
    let target: string | undefined;
    const location = {
        hash,
        replace: (url: string): void => {
            target = url;
        },
    };
    new Function('location', script)(location);
    return target;
}

describe('/j/web deep-link redirect page', () => {
    it('sends a Quick Connect link (Moonfin sign-in QR) to the connect modal with the code', () => {
        expect(redirectFor('#/quickconnect?code=123456')).toBe(
            '/settings/connections?connect=jellyfin&code=123456',
        );
        expect(redirectFor('#!/quickconnect?code=654321', '/app')).toBe(
            '/app/settings/connections?connect=jellyfin&code=654321',
        );
    });

    it('ignores a Quick Connect link without a valid 6-digit code', () => {
        expect(redirectFor('#/quickconnect?code=12345')).toBe('/');
        expect(redirectFor('#/quickconnect?code=1234567')).toBe('/');
        expect(redirectFor('#/quickconnect?code=12a456')).toBe('/');
        expect(redirectFor('#/quickconnect')).toBe('/');
        // code= on another route is not a Quick Connect link
        expect(redirectFor('#/home?code=123456')).toBe('/');
    });

    it('still sends details links to /watch/<id>', () => {
        const id = '0123456789abcdef0123456789abcdef';
        expect(redirectFor(`#!/details?id=${id}&serverId=x`)).toBe(`/watch/${id}`);
        expect(redirectFor(`#!/details?id=${id}`, '/app')).toBe(`/app/watch/${id}`);
    });

    it('falls back to the app root', () => {
        expect(redirectFor('')).toBe('/');
        expect(redirectFor('', '/app')).toBe('/app/');
    });

    it('escapes the base path so it cannot close the script tag', () => {
        expect(buildDeeplinkRedirectHtml('</script><b>')).not.toContain('</script><b>');
    });
});
