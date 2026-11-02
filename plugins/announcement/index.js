// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Announcement — drop-in feature plugin.
 *
 * Shows a single site-wide announcement banner directly under the home hero
 * (`placement: 'below-hero'`). Admins author it via the plugin settings modal in
 * /admin (no DB, no inline composer); users can dismiss it (remembered per
 * browser, re-shown when the message changes). Demonstrates a SECOND plugin
 * mount surface alongside the shoutbox's home-grid widget.
 *
 * Drop into $PLUGINS_EXTERNAL_DIR to load.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').FeatureDefinition}
 */

/** Short, stable, dependency-free string hash → dismissal version key. */
function shortHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/** Read + normalize the announcement from plugin settings. */
async function readAnnouncement(ctx) {
    let cfg;
    try {
        cfg = (await ctx.settings()) ?? {};
    } catch {
        cfg = {};
    }
    const message = typeof cfg.message === 'string' ? cfg.message.trim() : '';
    const title = typeof cfg.title === 'string' ? cfg.title.trim() : '';
    const sev = cfg.severity === 'warning' || cfg.severity === 'critical' ? cfg.severity : 'info';
    const enabled = cfg.enabled === true && message.length > 0;
    const dismissible = cfg.dismissible !== false; // default true
    return {
        enabled,
        message: enabled ? message : '',
        title: enabled ? title : '',
        severity: sev,
        dismissible,
        // Version changes when the visible content changes → a dismissed banner
        // re-appears after the admin edits it.
        version: shortHash(`${sev}|${title}|${message}`),
    };
}

const announcement = {
    id: 'announcement',
    capabilities: { browserUi: true },
    settings: {
        fields: [
            {
                key: 'enabled',
                type: 'boolean',
                label: 'Show announcement',
                description: 'Display the announcement banner on the home page.',
                default: false,
            },
            {
                key: 'message',
                type: 'multiline',
                label: 'Message',
                description: 'The announcement text shown to all users.',
                default: '',
            },
            {
                key: 'title',
                type: 'string',
                label: 'Title (optional)',
                description: 'Optional bold heading above the message.',
                default: '',
            },
            {
                key: 'severity',
                type: 'select',
                label: 'Severity',
                description: 'Drives the banner color.',
                default: 'info',
                options: [
                    { value: 'info', label: 'Info' },
                    { value: 'warning', label: 'Warning' },
                    { value: 'critical', label: 'Critical' },
                ],
            },
            {
                key: 'dismissible',
                type: 'boolean',
                label: 'Users can dismiss',
                description: 'Show a × so users can hide the banner (remembered per browser).',
                default: true,
            },
        ],
    },
    widgets: [
        {
            id: 'banner',
            title: 'Announcement',
            entry: '/widget.js',
            placement: 'below-hero',
            defaultVisible: true,
        },
    ],
    routes: [
        {
            method: 'GET',
            path: '/announcement',
            handler: async (ctx) => {
                // Dispatcher already requires an authenticated user; be defensive.
                if (!ctx.user) return Response.json({ error: 'auth' }, { status: 401 });
                const data = await readAnnouncement(ctx);
                return Response.json(data, {
                    headers: { 'Cache-Control': 'no-store' },
                });
            },
        },
        {
            method: 'GET',
            path: '/widget.js',
            handler: async () => {
                const { readFile } = await import('node:fs/promises');
                const { fileURLToPath } = await import('node:url');
                const p = fileURLToPath(new URL('./widget.js', import.meta.url));
                const code = await readFile(p, 'utf8');
                return new Response(code, {
                    headers: {
                        'Content-Type': 'text/javascript; charset=utf-8',
                        'Cache-Control': 'public, max-age=300',
                    },
                });
            },
        },
    ],
};

export default announcement;
