// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-unused-vars */
/**
 * Example Feature Plugin — drop-in reference for FeatureDefinition.
 *
 * Demonstrates how external authors expose HTTP routes from a feature plugin.
 * Companion to `hello-world` (which shows ProviderDefinition). Together they
 * cover the two SDK shapes most external authors will reach for first.
 *
 * Drop into $PLUGINS_EXTERNAL_DIR (default: /app/plugins) to load.
 * Disable at runtime via `DISABLE_EXAMPLE_FEATURE_PLUGIN=true`.
 *
 * See ../hello-world/README.md for the full external-plugin authoring guide.
 */

// In-memory config — drop-in plugins shouldn't reach for ctx.db unless they
// declared `capabilities: { database: true }` AND really need persistence.
const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    widgetTitle: 'Featured Content',
    maxItems: 10,
    refreshIntervalMinutes: 60,
});

/** @type {typeof DEFAULT_CONFIG} */
let config = { ...DEFAULT_CONFIG };

function isEnabled() {
    if (process.env.DISABLE_EXAMPLE_FEATURE_PLUGIN?.trim().toLowerCase() === 'true') {
        return false;
    }
    return config.enabled;
}

function createPlaceholderImage(index, title) {
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];
    const bgColor = colors[index % colors.length];
    const svg =
        `<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#1e293b"/>` +
        `<rect x="20" y="20" width="260" height="410" rx="8" fill="${bgColor}" opacity="0.3"/>` +
        `<text x="150" y="200" font-family="Arial, sans-serif" font-size="14" fill="#e2e8f0" text-anchor="middle">${title.substring(0, 20)}</text>` +
        `<text x="150" y="230" font-family="Arial, sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">Demo Item</text>` +
        `</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function generateMockItems(count) {
    const categories = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Documentary'];
    const items = [];
    for (let i = 0; i < count; i++) {
        const title = `Featured Item ${i + 1}`;
        items.push({
            id: `item-${i + 1}`,
            title,
            description: `Description for featured item ${i + 1}. Demonstrates external plugin content patterns.`,
            imageUrl: createPlaceholderImage(i, title),
            rating: Math.round((Math.random() * 4 + 6) * 10) / 10,
            category: categories[i % categories.length],
        });
    }
    return items;
}

/** @type {import('@sapd/lumastra-plugin-sdk').FeatureDefinition} */
const exampleFeaturePlugin = {
    id: 'example-feature-plugin',

    settings: {
        fields: [
            {
                key: 'widgetTitle',
                type: 'string',
                label: 'Widget Title',
                description: 'Title displayed at the top of the widget',
                default: 'Featured Content',
            },
            {
                key: 'maxItems',
                type: 'number',
                label: 'Maximum Items',
                description: 'Maximum number of items to display (1-50)',
                default: 10,
                validation: { min: 1, max: 50 },
            },
            {
                key: 'refreshIntervalMinutes',
                type: 'number',
                label: 'Refresh Interval (minutes)',
                description: 'How often to refresh the featured items',
                default: 60,
                validation: { min: 5, max: 1440 },
            },
        ],
    },

    async onStartup(ctx) {
        config = { ...DEFAULT_CONFIG };
        ctx.logger.info('example-feature-plugin initialized');
    },

    routes: [
        {
            method: 'GET',
            path: '/items',
            handler: async (_ctx, _req) => {
                if (!isEnabled()) {
                    return Response.json({ error: 'Plugin disabled' }, { status: 503 });
                }
                const items = generateMockItems(config.maxItems);
                return Response.json(items, {
                    headers: { 'Cache-Control': 'public, max-age=300' },
                });
            },
        },
        {
            method: 'GET',
            path: '/items/:id',
            handler: async (_ctx, req) => {
                if (!isEnabled()) {
                    return Response.json({ error: 'Plugin disabled' }, { status: 503 });
                }
                const url = new URL(req.url);
                const segments = url.pathname.split('/');
                const id = segments[segments.length - 1];
                if (!id) {
                    return Response.json({ error: 'Missing id' }, { status: 400 });
                }
                const item = generateMockItems(1)[0];
                item.id = id;
                return Response.json(item);
            },
        },
        {
            method: 'POST',
            path: '/settings',
            handler: async (ctx, req) => {
                // security review 2026-09-13, C26: this used to be `_ctx`,
                // unread — `dispatchFeatureRequest` only enforces "some user
                // is authenticated" (401 for none); it does NOT check
                // `isAdmin`. A `FeatureRoute` has no host-enforced `access`
                // gate (unlike `FeaturePage.access`), so ANY authenticated
                // viewer could rewrite this process-wide demo config for
                // everyone. Route-level authorization is the plugin
                // author's own job — do it explicitly, per route.
                if (!ctx.user?.isAdmin) {
                    return Response.json({ error: 'Not found' }, { status: 404 });
                }
                let raw;
                try {
                    raw = await req.json();
                } catch {
                    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
                }
                // `as` casts don't validate at runtime — guard null + arrays.
                if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                    return Response.json({ error: 'Expected JSON object' }, { status: 400 });
                }
                const body = raw;

                if (typeof body.enabled === 'boolean') config.enabled = body.enabled;
                if (typeof body.widgetTitle === 'string') config.widgetTitle = body.widgetTitle;
                if (typeof body.maxItems === 'number') {
                    config.maxItems = Math.max(1, Math.min(50, body.maxItems));
                }
                if (typeof body.refreshIntervalMinutes === 'number') {
                    config.refreshIntervalMinutes = Math.max(
                        5,
                        Math.min(1440, body.refreshIntervalMinutes),
                    );
                }

                // Demo plugin — settings live in-memory only and reset on reload.
                return Response.json({
                    success: true,
                    message: 'Settings received (not persisted in demo mode)',
                });
            },
        },
    ],
};

export default exampleFeaturePlugin;
