// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Response Envelope Serializers
// Wraps payloads in the Subsonic/OpenSubsonic JSON and XML response envelope.

import { SUBSONIC_API_VERSION, SUBSONIC_TYPE, SUBSONIC_SERVER_VERSION } from '../constants.js';
import type { SubsonicFormat } from '../types.js';
import { escapeXml } from '$lib/server/utils/xml-escape.js';

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

// Shared with the Top Shelf SVG renderer — see utils/xml-escape.ts for why
// this is not defined locally. The previous local copy escaped the entities but
// left XML-1.0-illegal control characters intact, so a track title carrying
// `\x0B` (or a request param echoed into an error message) produced XML that a
// strict client is entitled to reject outright.

/**
 * Derive the singular element name for repeated array items.
 * e.g. "artist" → "artist", "index" → "index", "entry" → "entry"
 * For keys ending in "s" we strip it; otherwise keep as-is.
 */
function singularOf(key: string): string {
    // Explicit known plurals used in Subsonic responses
    const MAP: Record<string, string> = {
        artist: 'artist',
        album: 'album',
        song: 'song',
        entry: 'entry',
        index: 'index',
        genre: 'genre',
        folder: 'folder',
    };
    if (MAP[key]) return MAP[key];
    if (key.endsWith('s')) return key.slice(0, -1);
    return key;
}

/**
 * Recursive XML serialiser. Handles up to 3-4 levels (sufficient for
 * Subsonic response depth).
 *
 * Rules:
 *  - Primitive values on an object → XML attributes
 *  - Array values → repeated child elements (singular key name)
 *  - Nested objects → child element
 *  - Special `_text` field → element text content
 */
export function toXml(tag: string, obj: unknown, indent = ''): string {
    if (obj === null || obj === undefined) return '';

    if (typeof obj !== 'object') {
        // Scalar — render as element with text content
        return `${indent}<${tag}>${escapeXml(String(obj))}</${tag}>\n`;
    }

    if (Array.isArray(obj)) {
        return obj.map((item) => toXml(tag, item, indent)).join('');
    }

    const record = obj as Record<string, unknown>;

    // Separate attrs from children
    const attrs: string[] = [];
    const children: string[] = [];
    let textContent: string | undefined;

    for (const [key, val] of Object.entries(record)) {
        if (val === undefined || val === null) continue;

        if (key === '_text' || (key === 'value' && typeof val === 'string')) {
            textContent = escapeXml(String(val));
            continue;
        }

        if (Array.isArray(val)) {
            const childTag = singularOf(key);
            for (const item of val) {
                children.push(toXml(childTag, item, indent + '  '));
            }
            continue;
        }

        if (typeof val === 'object') {
            children.push(toXml(key, val, indent + '  '));
            continue;
        }

        // Primitive → attribute
        attrs.push(` ${key}="${escapeXml(String(val))}"`);
    }

    const attrStr = attrs.join('');

    if (children.length === 0 && textContent === undefined) {
        return `${indent}<${tag}${attrStr}/>\n`;
    }

    const childStr = children.join('');

    if (textContent !== undefined && children.length === 0) {
        return `${indent}<${tag}${attrStr}>${textContent}</${tag}>\n`;
    }

    return `${indent}<${tag}${attrStr}>\n${childStr}${indent}</${tag}>\n`;
}

// ---------------------------------------------------------------------------
// Envelope constants
// ---------------------------------------------------------------------------

const BASE_ENVELOPE = {
    status: 'ok' as const,
    version: SUBSONIC_API_VERSION,
    type: SUBSONIC_TYPE,
    serverVersion: SUBSONIC_SERVER_VERSION,
    openSubsonic: true,
};

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * Build a successful Subsonic response with the given payload merged into
 * the response envelope. Handles both JSON and XML formats.
 */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

export function subsonicOk(payload: Record<string, unknown>, format: SubsonicFormat): Response {
    if (format === 'xml') {
        const envelope = {
            ...BASE_ENVELOPE,
            ...payload,
        };
        const xml = buildXmlEnvelope(envelope);
        return new Response(xml, {
            headers: {
                'Content-Type': 'text/xml; charset=UTF-8',
                ...CORS_HEADERS,
            },
        });
    }

    return new Response(
        JSON.stringify({
            'subsonic-response': { ...BASE_ENVELOPE, ...payload },
        }),
        {
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                ...CORS_HEADERS,
            },
        },
    );
}

/**
 * Build a failed Subsonic response with an error code and message.
 * helpUrl is an OpenSubsonic extension field (apiKeyAuthentication spec) pointing
 * users to documentation when an auth mechanism is unsupported or invalid.
 */
export function subsonicError(
    code: number,
    message: string,
    format: SubsonicFormat,
    helpUrl?: string,
): Response {
    const error: Record<string, unknown> = { code, message };
    if (helpUrl) error.helpUrl = helpUrl;
    const errorEnvelope = {
        ...BASE_ENVELOPE,
        status: 'failed' as const,
        error,
    };

    if (format === 'xml') {
        const xml = buildXmlEnvelope(errorEnvelope);
        return new Response(xml, {
            headers: {
                'Content-Type': 'text/xml; charset=UTF-8',
                ...CORS_HEADERS,
            },
        });
    }

    return new Response(JSON.stringify({ 'subsonic-response': errorEnvelope }), {
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            ...CORS_HEADERS,
        },
    });
}

/**
 * Build a ping/empty OK response — no payload beyond the envelope.
 */
export function subsonicPing(format: SubsonicFormat): Response {
    return subsonicOk({}, format);
}

// ---------------------------------------------------------------------------
// XML envelope builder
// ---------------------------------------------------------------------------

/**
 * Build the full XML document string for a Subsonic response envelope.
 * Primitives in the envelope become attributes; nested objects/arrays become
 * child elements.
 */
function buildXmlEnvelope(envelope: Record<string, unknown>): string {
    const attrs: string[] = [`xmlns="http://subsonic.org/restapi"`];
    const children: string[] = [];

    for (const [key, val] of Object.entries(envelope)) {
        if (val === undefined || val === null) continue;

        if (typeof val === 'object' && !Array.isArray(val)) {
            children.push(toXml(key, val, '  '));
            continue;
        }

        if (Array.isArray(val)) {
            const childTag = singularOf(key);
            for (const item of val) {
                children.push(toXml(childTag, item, '  '));
            }
            continue;
        }

        attrs.push(`${key}="${escapeXml(String(val))}"`);
    }

    const attrStr = attrs.join(' ');
    const childStr = children.join('');

    const header = '<?xml version="1.0" encoding="UTF-8"?>\n';

    if (childStr.length === 0) {
        return `${header}<subsonic-response ${attrStr}/>\n`;
    }

    return `${header}<subsonic-response ${attrStr}>\n${childStr}</subsonic-response>\n`;
}
