// @ts-nocheck
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Announcement banner — mounted ESM widget ('below-hero' placement).
 *
 * Plain vanilla browser ESM (no build, no deps). The host imports this via the
 * GET /widget.js route and calls mount(el, { apiBase, theme, user }).
 *
 * Renders a single severity-colored banner under the home hero from
 * GET /announcement. All text is rendered via textContent (never innerHTML).
 * Dismissal is remembered per browser, keyed on the content `version` so editing
 * the message re-shows it. Disabled/empty/dismissed → renders nothing.
 */

export function mount(el, ctx) {
    const apiBase = (ctx && ctx.apiBase) || '';
    const theme = (ctx && ctx.theme) || {};

    const t = (key, fallback) => {
        const v = theme[key];
        return v && String(v).trim() ? String(v).trim() : fallback;
    };
    const tone = {
        info: { accent: t('--color-primary-500', '#6366f1'), icon: 'ℹ️' },
        warning: { accent: '#f59e0b', icon: '⚠️' },
        critical: { accent: '#ef4444', icon: '⛔' },
    };
    const textStrong = t('--text-hover', '#ffffff');
    const textBody = t('--text', '#d1d5db');

    let destroyed = false;
    el.replaceChildren();

    function rgba(hex, a) {
        const h = String(hex).replace('#', '');
        if (h.length !== 6) return hex;
        const n = parseInt(h, 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    const dismissKey = (version) => `announcement:dismissed:${version}`;

    function render(a) {
        if (!a || !a.enabled || !a.message) return; // collapse
        let dismissed;
        try {
            dismissed = a.dismissible && localStorage.getItem(dismissKey(a.version)) === '1';
        } catch {
            dismissed = false;
        }
        if (dismissed) return; // collapse

        const sev = tone[a.severity] || tone.info;

        const bar = document.createElement('div');
        Object.assign(bar.style, {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
            padding: '12px 14px',
            borderRadius: '12px',
            border: '1px solid ' + rgba(sev.accent, 0.5),
            borderLeft: '4px solid ' + sev.accent,
            background: rgba(sev.accent, 0.12),
            color: textBody,
            fontSize: '14px',
            lineHeight: '1.5',
        });

        const icon = document.createElement('span');
        icon.textContent = sev.icon;
        Object.assign(icon.style, { fontSize: '18px', lineHeight: '1.4', flex: '0 0 auto' });
        bar.appendChild(icon);

        const content = document.createElement('div');
        content.style.flex = '1 1 auto';
        content.style.minWidth = '0';
        if (a.title) {
            const h = document.createElement('div');
            h.textContent = a.title; // textContent — never innerHTML
            Object.assign(h.style, {
                fontWeight: '700',
                color: textStrong,
                marginBottom: '2px',
            });
            content.appendChild(h);
        }
        const msg = document.createElement('div');
        msg.textContent = a.message; // textContent — never innerHTML
        msg.style.whiteSpace = 'pre-wrap';
        msg.style.wordBreak = 'break-word';
        content.appendChild(msg);
        bar.appendChild(content);

        if (a.dismissible) {
            const x = document.createElement('button');
            x.type = 'button';
            x.textContent = '×';
            x.title = 'Dismiss';
            x.setAttribute('aria-label', 'Dismiss announcement');
            Object.assign(x.style, {
                flex: '0 0 auto',
                background: 'transparent',
                border: 'none',
                color: textBody,
                cursor: 'pointer',
                fontSize: '20px',
                lineHeight: '1',
                padding: '0 2px',
            });
            x.addEventListener('click', () => {
                try {
                    localStorage.setItem(dismissKey(a.version), '1');
                } catch {
                    /* ignore */
                }
                el.replaceChildren();
            });
            bar.appendChild(x);
        }

        el.appendChild(bar);
    }

    (async () => {
        let data = null;
        try {
            const res = await fetch(apiBase + '/announcement');
            if (res.ok) data = await res.json();
        } catch {
            data = null;
        }
        if (destroyed) return;
        render(data);
    })();

    return () => {
        destroyed = true;
        el.replaceChildren();
    };
}
