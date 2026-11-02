// @ts-nocheck
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shoutbox mounted widget (Layer B, Task 8).
 *
 * Plain vanilla browser ESM — NO build step, NO framework, NO dependencies.
 * The host loads this module via `import('/api/plugins/shoutbox/widget.js')`
 * (served by the GET /widget.js route in index.js) and calls `mount(el, ctx)`.
 *
 * Contract:
 *   mount(el, { apiBase, theme, user }) => () => void
 *
 * Design: renders a complete, self-contained home-dashboard section (its own
 * header + card chrome) styled to match the host — the host widget wrapper
 * provides no header, so each component supplies its own (like Trending/ForYou).
 * All colors come from the host theme tokens with dark fallbacks.
 *
 * Security posture:
 *   - ALL user-supplied text (message bodies, usernames, chip titles) is rendered
 *     as text nodes / textContent. We NEVER assign innerHTML with user data.
 *   - Avatars load from the host `/api/image/user/<username>/avatar` endpoint
 *     (username URL-encoded); on 404 we fall back to a generated initial badge.
 *   - Media tokens become clickable chips ONLY when the per-viewer
 *     `chips[token].allowed` is true; denied/missing tokens render as inert,
 *     muted text with no href and no click handler (no detail leak).
 *   - The server is the real access boundary; this is presentation only.
 */

const TOKEN_RE = /\{\{media:([0-9a-fA-F-]{36}):([a-z]+)\}\}/g;

// Minimal inline i18n: the widget is served as a standalone ESM module (no
// bundler, no access to $lib/paraglide), so it cannot import the host's
// message catalog. `ctx.locale` (the host's current UI language) selects one
// of these two tables; anything not covered here falls back to English.
const STRINGS = {
    en: {
        send: 'Send',
        sayHint: 'Say something…',
        emptyHint: 'No messages yet — say hello 👋',
        loading: 'Loading…',
        linkMedia: 'Link media',
        deleteMessage: 'Delete message',
        deleteYourMessage: 'Delete your message',
        searchMedia: 'Search media to link…',
        untitled: 'Untitled',
        couldNotLoad: 'Could not load messages.',
        noAccess: 'You do not have access to the shoutbox.',
        unavailable: 'Shoutbox unavailable.',
        realtimeConnecting: 'Realtime: connecting…',
    },
    de: {
        send: 'Senden',
        sayHint: 'Schreib etwas…',
        emptyHint: 'Noch keine Nachrichten — sag hallo 👋',
        loading: 'Wird geladen…',
        linkMedia: 'Medium verknüpfen',
        deleteMessage: 'Nachricht löschen',
        deleteYourMessage: 'Eigene Nachricht löschen',
        searchMedia: 'Medium zum Verknüpfen suchen…',
        untitled: 'Ohne Titel',
        couldNotLoad: 'Nachrichten konnten nicht geladen werden.',
        noAccess: 'Du hast keinen Zugriff auf die Shoutbox.',
        unavailable: 'Shoutbox nicht verfügbar.',
        realtimeConnecting: 'Echtzeit: verbinde…',
    },
};

export function mount(el, ctx) {
    const apiBase = (ctx && ctx.apiBase) || '';
    const theme = (ctx && ctx.theme) || {};
    const user = (ctx && ctx.user) || null;
    const tr = STRINGS[ctx && ctx.locale] || STRINGS.en;

    // ---- theme tokens (live theme vars > host ctx values > dark fallbacks) --
    // The host's runtime themes ([data-theme] overrides on <html>) publish
    // --color-* custom properties; read them COMPUTED so the widget follows
    // the active theme. ctx.theme historically never carried these keys, so
    // the widget silently rendered its legacy indigo fallbacks in every theme.
    const rootStyles =
        typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    const t = (key, fallback) => {
        const live = rootStyles ? rootStyles.getPropertyValue(key) : '';
        if (live && String(live).trim()) return String(live).trim();
        const v = theme[key];
        return v && String(v).trim() ? String(v).trim() : fallback;
    };
    const c = {
        card: t('--color-surface-900', '#242c46'),
        raised: t('--color-surface-800', '#2c3656'),
        line: t('--color-surface-700', '#313d61'),
        primary: t('--color-primary-500', '#6366f1'),
        accent: t('--color-primary-300', '#a78bfa'),
        text: t('--text', '#d1d5db'),
        textStrong: t('--text-hover', '#ffffff'),
        muted: t('--text-muted', '#9ca3af'),
        link: t('--link-color', t('--color-primary-500', '#6366f1')),
    };

    // ---- runtime state -----------------------------------------------------
    let groupColors = {};
    let canPost = false;
    let maxLength = 280;
    const isAdmin = !!(user && user.isAdmin);
    const known = new Set();
    let es = null;
    let destroyed = false;
    let inputEl = null;
    let liveDot = null;

    // ---- scoped stylesheet (hover/scrollbar/focus that inline styles can't) -
    const styleEl = document.createElement('style');
    const SCOPE = 'sbx-' + Math.random().toString(36).slice(2, 8);
    styleEl.textContent = `
.${SCOPE} *{box-sizing:border-box}
.${SCOPE} .sbx-list{scrollbar-width:thin;scrollbar-color:${c.line} transparent}
.${SCOPE} .sbx-list::-webkit-scrollbar{width:8px}
.${SCOPE} .sbx-list::-webkit-scrollbar-thumb{background:${c.line};border-radius:8px}
.${SCOPE} .sbx-row{border-radius:10px;transition:background .12s ease}
.${SCOPE} .sbx-row:hover{background:rgba(255,255,255,.04)}
.${SCOPE} .sbx-row:hover .sbx-del{opacity:1}
.${SCOPE} .sbx-del{opacity:0;transition:opacity .12s ease,color .12s ease}
.${SCOPE} .sbx-del:hover{color:#f87171}
.${SCOPE} .sbx-chip{transition:background .12s ease,border-color .12s ease}
.${SCOPE} .sbx-chip.is-link:hover{background:${c.line};border-color:${c.accent}}
.${SCOPE} .sbx-send:hover{filter:brightness(1.08)}
.${SCOPE} .sbx-ghost:hover{background:${c.line}}
.${SCOPE} .sbx-input:focus{border-color:${c.link}!important;box-shadow:0 0 0 2px ${rgba(c.link, 0.18)}}
.${SCOPE} .sbx-pickrow:hover{background:${c.raised}}
@keyframes sbxpulse{0%,100%{opacity:1}50%{opacity:.35}}
.${SCOPE} .sbx-live{animation:sbxpulse 2s ease-in-out infinite}
`;

    // ---- card scaffold -----------------------------------------------------
    el.replaceChildren();
    el.appendChild(styleEl);
    const root = div('', {
        className: SCOPE,
        style: {
            display: 'flex',
            flexDirection: 'column',
            // Starts compact (auto height) — updateEmptyLayout() expands to a
            // fixed, scrollable height once we know there are messages to show.
            height: 'auto',
            maxHeight: '60vh',
            background: c.card,
            color: c.text,
            border: '1px solid ' + c.line,
            borderRadius: '14px',
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.18)',
            fontSize: '14px',
            lineHeight: '1.45',
        },
    });

    // header
    const header = div('', {
        style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '13px 16px',
            borderBottom: '1px solid ' + c.line,
            flex: '0 0 auto',
        },
    });
    const badge = div('💬', {
        style: {
            width: '28px',
            height: '28px',
            borderRadius: '9px',
            display: 'grid',
            placeItems: 'center',
            fontSize: '15px',
            background: rgba(c.primary, 0.16),
            border: '1px solid ' + rgba(c.primary, 0.4),
            flex: '0 0 auto',
        },
    });
    const title = div('Shoutbox', {
        style: { fontWeight: '700', fontSize: '15px', color: c.textStrong, letterSpacing: '.2px' },
    });
    liveDot = div('', {
        className: 'sbx-live',
        style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: c.muted,
            flex: '0 0 auto',
            marginLeft: '2px',
        },
    });
    liveDot.title = tr.realtimeConnecting;
    const spacer = div('', { style: { flex: '1 1 auto' } });
    header.append(badge, title, liveDot, spacer);

    // scrollable message list
    const list = div('', {
        className: 'sbx-list',
        style: {
            flex: '1 1 auto',
            overflowY: 'auto',
            padding: '8px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
        },
    });
    list.setAttribute('aria-live', 'polite');
    list.setAttribute('role', 'log');

    // status / empty line (overlays inside the list area)
    const status = div(tr.loading, {
        style: { padding: '16px', color: c.muted, fontSize: '13px', textAlign: 'center' },
    });

    root.append(header, list, status);
    el.appendChild(root);
    // Establish the initial compact (zero-messages) layout immediately —
    // avoids a flash of the tall empty panel before the first fetch resolves.
    updateEmptyLayout();

    // ---- small DOM helpers -------------------------------------------------
    function div(text, opts) {
        const d = document.createElement('div');
        if (opts && opts.className) d.className = opts.className;
        if (opts && opts.style) Object.assign(d.style, opts.style);
        if (text) d.textContent = text;
        return d;
    }
    function rgba(hex, a) {
        const h = String(hex).replace('#', '');
        if (h.length !== 6) return hex;
        const n = parseInt(h, 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    function hashHue(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % 360;
    }
    function isNearBottom() {
        return list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    }
    // Zero-messages layout: collapse the tall scrollable list down to a
    // single compact bar (header + composer only) instead of an empty
    // 440px scroll area. The "say hello" hint moves into the composer's
    // input placeholder rather than sitting on its own empty-state line.
    const EMPTY_HINT = tr.emptyHint;
    function updateEmptyLayout() {
        const hasMessages = list.children.length > 0;
        list.style.display = hasMessages ? 'flex' : 'none';
        root.style.height = hasMessages ? '440px' : 'auto';
        if (inputEl) inputEl.placeholder = hasMessages ? tr.sayHint : EMPTY_HINT;
    }
    function scrollToBottom() {
        list.scrollTop = list.scrollHeight;
    }
    function colorForGroup(group) {
        if (group && groupColors && typeof groupColors[group] === 'string')
            return groupColors[group];
        return c.link;
    }
    function fmtTime(iso) {
        try {
            const d = new Date(iso);
            return {
                short: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                full: d.toLocaleString(),
            };
        } catch {
            return { short: '', full: '' };
        }
    }

    // ---- avatar (img with generated-initial fallback) ----------------------
    function buildAvatar(username, group, isBot) {
        const wrap = div(isBot ? '🤖' : '', {
            style: {
                width: '30px',
                height: '30px',
                borderRadius: '50%',
                flex: '0 0 auto',
                display: 'grid',
                placeItems: 'center',
                overflow: 'hidden',
                fontSize: isBot ? '15px' : '12.5px',
                fontWeight: '700',
                color: '#fff',
                userSelect: 'none',
                marginTop: '1px',
            },
        });
        if (isBot) {
            wrap.style.background = rgba(c.accent, 0.9);
            return wrap;
        }
        const initial = (String(username || '?').trim()[0] || '?').toUpperCase();
        const hue = hashHue(String(username || ''));
        wrap.textContent = initial;
        wrap.style.background = `hsl(${hue} 45% 42%)`;
        // Try the real avatar; on error keep the initial badge.
        const img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        Object.assign(img.style, {
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
        });
        img.addEventListener('load', () => {
            wrap.textContent = '';
            wrap.appendChild(img);
        });
        img.addEventListener('error', () => {
            /* keep the initial badge */
        });
        img.src = '/api/image/user/' + encodeURIComponent(String(username || '')) + '/avatar';
        return wrap;
    }

    // ---- media chips -------------------------------------------------------
    function renderChip(chip) {
        const span = document.createElement('span');
        span.className = 'sbx-chip';
        Object.assign(span.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 8px',
            margin: '0 2px',
            borderRadius: '999px',
            fontSize: '12px',
            lineHeight: '18px',
            verticalAlign: 'middle',
        });
        if (chip && chip.allowed && chip.openHref) {
            const label = chip.title ? String(chip.title) : 'media';
            const yr = chip.year ? ' (' + String(chip.year) + ')' : '';
            span.textContent = '🎬 ' + label + yr; // textContent only
            span.classList.add('is-link');
            Object.assign(span.style, {
                background: c.raised,
                color: c.link,
                cursor: 'pointer',
                border: '1px solid ' + rgba(c.link, 0.55),
            });
            span.setAttribute('role', 'link');
            span.setAttribute('tabindex', '0');
            const href = chip.openHref;
            span.addEventListener('click', () => openMedia(href));
            span.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    openMedia(href);
                }
            });
        } else {
            span.textContent = '🔒 ' + tr.untitled;
            Object.assign(span.style, {
                background: 'transparent',
                color: c.muted,
                border: '1px dashed ' + rgba(c.muted, 0.6),
                cursor: 'default',
            });
        }
        return span;
    }
    function renderBody(body, chips) {
        const frag = document.createDocumentFragment();
        const text = typeof body === 'string' ? body : '';
        const map = chips && typeof chips === 'object' ? chips : {};
        let last = 0;
        TOKEN_RE.lastIndex = 0;
        let m;
        while ((m = TOKEN_RE.exec(text)) !== null) {
            if (m.index > last)
                frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            frag.appendChild(renderChip(map[m[1] + ':' + m[2]]));
            last = TOKEN_RE.lastIndex;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        return frag;
    }
    function openMedia(href) {
        if (!href) return;
        import('$app/navigation')
            .then((m) => m.goto(href))
            .catch(() => {
                try {
                    window.location.assign(href);
                } catch {
                    /* ignore */
                }
            });
    }

    // ---- message rows ------------------------------------------------------
    function buildRow(msg) {
        const isBot = msg.author_kind === 'ai';
        const row = div('', {
            className: 'sbx-row',
            style: { display: 'flex', gap: '9px', padding: '6px 8px', alignItems: 'flex-start' },
        });
        row.dataset.id = msg.id;

        row.appendChild(buildAvatar(msg.username, msg.user_group, isBot));

        const col = div('', { style: { flex: '1 1 auto', minWidth: '0' } });

        const meta = div('', {
            style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' },
        });
        const name = div('', {
            style: {
                fontWeight: '600',
                fontSize: '13px',
                color: isBot ? c.accent : colorForGroup(msg.user_group),
            },
        });
        name.textContent = String(msg.username ?? ''); // user-controlled → textContent
        meta.appendChild(name);
        if (isBot) {
            const pill = div('AI', {
                style: {
                    fontSize: '9.5px',
                    fontWeight: '700',
                    letterSpacing: '.5px',
                    padding: '0 5px',
                    borderRadius: '6px',
                    background: rgba(c.accent, 0.18),
                    color: c.accent,
                    lineHeight: '15px',
                },
            });
            meta.appendChild(pill);
        }
        if (msg.created_at) {
            const tm = fmtTime(msg.created_at);
            const time = div(tm.short, { style: { fontSize: '11px', color: c.muted } });
            time.title = tm.full;
            meta.appendChild(time);
        }
        col.appendChild(meta);

        const bodyEl = div('', {
            style: { fontSize: '13.5px', color: c.text, wordBreak: 'break-word', marginTop: '1px' },
        });
        bodyEl.appendChild(renderBody(msg.body, msg.chips));
        col.appendChild(bodyEl);

        row.appendChild(col);

        // Moderators can remove anything; an author can remove their own.
        // `mine` is computed server-side per viewer (see toWireMessage) — the
        // client is never given other people's account ids to compare against,
        // and the server re-checks ownership on the DELETE regardless, so this
        // only decides whether the affordance is shown.
        if (isAdmin || msg.mine) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'sbx-del';
            del.textContent = '×';
            del.title = isAdmin ? tr.deleteMessage : tr.deleteYourMessage;
            del.setAttribute('aria-label', del.title);
            Object.assign(del.style, {
                flex: '0 0 auto',
                background: 'transparent',
                border: 'none',
                color: c.muted,
                cursor: 'pointer',
                fontSize: '17px',
                lineHeight: '1',
                padding: '0 2px',
            });
            del.addEventListener('click', () => void deleteMessage(msg.id));
            row.appendChild(del);
        }
        return row;
    }

    function appendMessage(msg) {
        if (!msg || !msg.id || known.has(msg.id)) return;
        known.add(msg.id);
        const stick = isNearBottom();
        list.appendChild(buildRow(msg));
        updateEmptyLayout();
        if (stick) scrollToBottom();
    }
    function removeMessage(id) {
        if (!id) return;
        known.delete(id);
        const node = list.querySelector('[data-id="' + cssEscape(id) + '"]');
        if (node) node.remove();
        updateEmptyLayout();
    }
    function cssEscape(s) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
        return String(s).replace(/["\\]/g, '\\$&');
    }

    // ---- network -----------------------------------------------------------
    async function deleteMessage(id) {
        try {
            await fetch(apiBase + '/messages/' + encodeURIComponent(id), { method: 'DELETE' });
            removeMessage(id);
        } catch {
            /* realtime / reload reconciles */
        }
    }
    async function fetchMessageById(id) {
        try {
            const res = await fetch(apiBase + '/messages/' + encodeURIComponent(id));
            if (!res.ok) return null;
            const data = await res.json();
            return data && data.message ? data.message : null;
        } catch {
            return null;
        }
    }

    // ---- composer ----------------------------------------------------------
    function buildComposer() {
        const bar = div('', {
            style: {
                display: 'flex',
                gap: '7px',
                padding: '9px 10px',
                borderTop: '1px solid ' + c.line,
                background: c.card,
                position: 'relative',
                flex: '0 0 auto',
            },
        });
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sbx-input';
        input.placeholder = tr.sayHint;
        input.maxLength = Number(maxLength) || 280;
        Object.assign(input.style, {
            flex: '1 1 auto',
            minWidth: '0',
            background: c.raised,
            color: c.text,
            border: '1px solid ' + c.line,
            borderRadius: '10px',
            padding: '8px 11px',
            fontSize: '14px',
            outline: 'none',
            fontFamily: 'inherit',
        });
        inputEl = input;

        const linkBtn = btn('🔗', false);
        linkBtn.title = tr.linkMedia;
        linkBtn.setAttribute('aria-label', tr.linkMedia);
        const sendBtn = btn(tr.send, true);
        sendBtn.className += ' sbx-send';

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                void send();
            }
        });
        sendBtn.addEventListener('click', () => void send());
        linkBtn.addEventListener('click', () => togglePicker(bar));

        bar.append(input, linkBtn, sendBtn);
        return bar;
    }
    function btn(label, primary) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.className = primary ? 'sbx-send' : 'sbx-ghost';
        Object.assign(b.style, {
            flex: '0 0 auto',
            borderRadius: '10px',
            border: primary ? 'none' : '1px solid ' + c.line,
            padding: '8px 14px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: primary ? '600' : '400',
            fontFamily: 'inherit',
            background: primary ? c.primary : c.raised,
            color: primary ? '#fff' : c.text,
        });
        return b;
    }
    async function send() {
        if (!inputEl) return;
        const body = inputEl.value.trim();
        if (!body) return;
        inputEl.disabled = true;
        try {
            const res = await fetch(apiBase + '/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            });
            if (res.ok) {
                inputEl.value = '';
                if (!es) {
                    let created = null;
                    try {
                        const data = await res.json();
                        created = data && data.message ? data.message : null;
                    } catch {
                        created = null;
                    }
                    if (!destroyed && created && created.id) {
                        const full = await fetchMessageById(created.id);
                        if (!destroyed) appendMessage(full || created);
                    }
                }
            } else if (res.status === 429) flashStatus('Slow down — rate limited.');
            else if (res.status === 403) flashStatus('You are not allowed to post.');
            else flashStatus('Could not send message.');
        } catch {
            flashStatus('Network error.');
        } finally {
            inputEl.disabled = false;
            inputEl.focus();
        }
    }
    let statusTimer = null;
    function flashStatus(text) {
        status.textContent = text;
        status.style.display = '';
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    }

    // ---- media link picker -------------------------------------------------
    let picker = null;
    function togglePicker(bar) {
        if (picker) {
            picker.remove();
            picker = null;
            return;
        }
        picker = div('', {
            style: {
                position: 'absolute',
                bottom: '100%',
                left: '10px',
                right: '10px',
                background: c.raised,
                border: '1px solid ' + c.line,
                borderRadius: '10px',
                padding: '8px',
                marginBottom: '6px',
                maxHeight: '240px',
                overflowY: 'auto',
                zIndex: '5',
                boxShadow: '0 8px 24px rgba(0,0,0,.45)',
            },
        });
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'sbx-input';
        search.placeholder = tr.searchMedia;
        Object.assign(search.style, {
            width: '100%',
            background: c.card,
            color: c.text,
            border: '1px solid ' + c.line,
            borderRadius: '8px',
            padding: '7px 9px',
            fontSize: '13px',
            outline: 'none',
            fontFamily: 'inherit',
        });
        const results = div('', {
            style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '1px' },
        });
        let debounce = null;
        let seq = 0;
        search.addEventListener('input', () => {
            const q = search.value.trim();
            if (debounce) clearTimeout(debounce);
            if (!q) {
                results.replaceChildren();
                return;
            }
            debounce = setTimeout(async () => {
                const mySeq = ++seq;
                const items = await searchMedia(q);
                if (mySeq !== seq || !picker) return;
                renderResults(results, items);
            }, 220);
        });
        picker.append(search, results);
        bar.appendChild(picker);
        search.focus();
    }
    async function searchMedia(q) {
        try {
            const res = await fetch(apiBase + '/media-search?q=' + encodeURIComponent(q));
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data && data.results) ? data.results : [];
        } catch {
            return [];
        }
    }
    function renderResults(container, items) {
        container.replaceChildren();
        if (!items.length) {
            container.appendChild(
                div('No results.', { style: { color: c.muted, padding: '6px', fontSize: '13px' } }),
            );
            return;
        }
        for (const it of items) {
            if (!it || !it.id || !it.mediaType) continue;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sbx-pickrow';
            const yr = it.year ? ' (' + String(it.year) + ')' : '';
            b.textContent = (it.title ? String(it.title) : tr.untitled) + yr; // textContent only
            Object.assign(b.style, {
                textAlign: 'left',
                background: 'transparent',
                color: c.text,
                border: 'none',
                borderRadius: '7px',
                padding: '7px 9px',
                cursor: 'pointer',
                fontSize: '13px',
                fontFamily: 'inherit',
            });
            const ref = { id: String(it.id), mediaType: String(it.mediaType) };
            b.addEventListener('click', () => insertToken(ref));
            container.appendChild(b);
        }
    }
    function insertToken(ref) {
        if (!inputEl) return;
        const token = '{{media:' + ref.id + ':' + ref.mediaType + '}}';
        const cur = inputEl.value;
        inputEl.value = cur ? cur.replace(/\s*$/, '') + ' ' + token + ' ' : token + ' ';
        if (picker) {
            picker.remove();
            picker = null;
        }
        inputEl.focus();
    }

    // ---- realtime ----------------------------------------------------------
    function setLive(on) {
        if (!liveDot) return;
        liveDot.style.background = on ? '#34d399' : c.muted;
        liveDot.title = on ? 'Realtime: live' : 'Realtime: offline';
    }
    function openRealtime() {
        try {
            es = new EventSource(apiBase + '/realtime');
            es.addEventListener('open', () => setLive(true));
            es.addEventListener('message', async (ev) => {
                let payload;
                try {
                    payload = JSON.parse(ev.data);
                } catch {
                    return;
                }
                if (!payload || !payload.id || known.has(payload.id)) return;
                let full = await fetchMessageById(payload.id);
                if (destroyed) return;
                if (!full) {
                    full = await fetchMessageById(payload.id);
                    if (destroyed) return;
                }
                if (full) {
                    appendMessage(full);
                    return;
                }
                appendMessage({
                    id: payload.id,
                    username: payload.username,
                    user_group: payload.group,
                    author_kind: payload.group === 'ai' ? 'ai' : 'user',
                    body: payload.hasMedia ? '🔗 (media)' : '…',
                    chips: {},
                    created_at: payload.ts ? new Date(payload.ts).toISOString() : undefined,
                });
            });
            es.addEventListener('delete', (ev) => {
                let payload;
                try {
                    payload = JSON.parse(ev.data);
                } catch {
                    return;
                }
                if (payload && payload.id) removeMessage(payload.id);
            });
            es.onerror = () => setLive(false);
        } catch {
            setLive(false);
        }
    }

    // ---- bootstrap ---------------------------------------------------------
    async function loadConfig() {
        try {
            const res = await fetch(apiBase + '/config');
            if (!res.ok) return false;
            const cfg = await res.json();
            groupColors =
                cfg && typeof cfg.groupColors === 'object' && cfg.groupColors
                    ? cfg.groupColors
                    : {};
            canPost = !!(cfg && cfg.canPost);
            maxLength = Number(cfg && cfg.maxLength) || 280;
            return true;
        } catch {
            return false;
        }
    }
    async function loadMessages() {
        try {
            const res = await fetch(apiBase + '/messages');
            if (!res.ok) {
                status.textContent = res.status === 403 ? tr.noAccess : tr.couldNotLoad;
                updateEmptyLayout();
                return;
            }
            const data = await res.json();
            const messages = Array.isArray(data && data.messages) ? data.messages : [];
            list.replaceChildren();
            known.clear();
            for (const msg of messages) appendMessage(msg);
            // The zero-messages hint now lives in the composer placeholder
            // (see updateEmptyLayout) instead of this status line.
            status.style.display = 'none';
            updateEmptyLayout();
            scrollToBottom();
        } catch {
            status.textContent = tr.couldNotLoad;
            updateEmptyLayout();
        }
    }

    (async () => {
        const ok = await loadConfig();
        if (destroyed) return;
        if (!ok) {
            status.textContent = tr.unavailable;
            return;
        }
        await loadMessages();
        if (destroyed) return;
        if (canPost) {
            root.appendChild(buildComposer());
        } else {
            const hint = div(user ? 'You can read but not post here.' : 'Sign in to participate.', {
                style: {
                    padding: '10px 14px',
                    color: c.muted,
                    fontSize: '13px',
                    borderTop: '1px solid ' + c.line,
                    flex: '0 0 auto',
                },
            });
            root.appendChild(hint);
        }
        // inputEl (if any) now exists — recompute so the placeholder reflects
        // the current message count.
        updateEmptyLayout();
        openRealtime();
    })();

    // ---- teardown ----------------------------------------------------------
    return () => {
        destroyed = true;
        if (statusTimer) clearTimeout(statusTimer);
        if (es) {
            try {
                es.close();
            } catch {
                /* ignore */
            }
            es = null;
        }
        el.replaceChildren();
    };
}
