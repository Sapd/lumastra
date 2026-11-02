// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { CANONICAL_FIELD_IDS, type CanonicalFieldId } from '$lib/schemas/radio';
import type { DetectedMapping } from './types';

interface Leaf {
    path: string;
    parentKey: string;
    leafKey: string;
    parentKeyPath: string[]; // ['currentshow'] etc
    value: unknown;
}

const IMAGE_URL_RE = /^https?:\/\/.+\.(jpe?g|png|gif|webp)(\?.*)?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const MAX_DEPTH = 20;

function walk(node: unknown, path: string, parentPath: string[], depth = 0): Leaf[] {
    if (depth > MAX_DEPTH) return [];
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) {
        return node.flatMap((v, i) => walk(v, `${path}[${i}]`, parentPath, depth + 1));
    }
    if (typeof node === 'object') {
        const out: Leaf[] = [];
        for (const [k, v] of Object.entries(node)) {
            const childPath = `${path}.${k}`;
            if (v === null || v === undefined) continue;
            if (typeof v === 'object') {
                out.push(...walk(v, childPath, [...parentPath, k], depth + 1));
            } else {
                out.push({
                    path: childPath,
                    parentKey: parentPath[parentPath.length - 1] ?? '',
                    leafKey: k,
                    parentKeyPath: parentPath,
                    value: v,
                });
            }
        }
        return out;
    }
    return [];
}

interface Rule {
    /** Score 0..1 per leaf. 0 means "doesn't match at all". */
    score(leaf: Leaf): number;
}

function keywordScore(leafKey: string, keywords: string[], bonus = 0.1): number {
    const k = leafKey.toLowerCase();
    // Earlier keywords in the list are more specific/preferred — give them
    // a tiny priority edge so ties are broken deterministically.
    for (let i = 0; i < keywords.length; i++) {
        const kw = keywords[i];
        const priority = (keywords.length - i) * 0.001;
        if (k === kw) return 1.0 + priority;
        if (k.includes(kw)) return 0.8 + bonus + priority;
    }
    return 0;
}

function parentHas(leaf: Leaf, keywords: string[]): boolean {
    const joined = leaf.parentKeyPath.join(' ').toLowerCase();
    return keywords.some((kw) => joined.includes(kw));
}

function prefersString(leaf: Leaf): number {
    return typeof leaf.value === 'string' ? 0 : -0.3;
}

function prefersNumber(leaf: Leaf): number {
    const n = typeof leaf.value === 'number' ? leaf.value : Number(String(leaf.value));
    return Number.isFinite(n) && n >= 0 ? 0 : -0.5;
}

const RULES: Record<CanonicalFieldId, Rule> = {
    title: {
        score: (l) => {
            if (parentHas(l, ['next', 'upcoming'])) return 0;
            return Math.max(
                0,
                keywordScore(l.leafKey, ['songtitle', 'title', 'track', 'song', 'nowplaying']) +
                    prefersString(l),
            );
        },
    },
    artist: {
        score: (l) => {
            if (parentHas(l, ['next', 'upcoming'])) return 0;
            return Math.max(
                0,
                keywordScore(l.leafKey, ['artist', 'performer', 'band']) + prefersString(l),
            );
        },
    },
    trackDurationSeconds: {
        score: (l) =>
            Math.max(0, keywordScore(l.leafKey, ['duration', 'length']) + prefersNumber(l)),
    },
    trackElapsedSeconds: {
        score: (l) =>
            Math.max(
                0,
                keywordScore(l.leafKey, ['elapsed', 'played', 'position']) + prefersNumber(l),
            ),
    },
    djName: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            // Strong leaf signal — unambiguous DJ/host name fields.
            // E.g. Technobase exposes `liveBroadcast.nickName` with no DJ-ish parent.
            if (/^(djname|dj_name|nickname|hostname|presentername|djnick)$/.test(k)) {
                return Math.max(0, 1.0 + prefersString(l));
            }
            if (!parentHas(l, ['dj', 'deejay', 'host', 'presenter'])) return 0;
            return Math.max(
                0,
                keywordScore(l.leafKey, ['name', 'nickname', 'nick']) + prefersString(l),
            );
        },
    },
    djImageUrl: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            const valOk = typeof l.value === 'string' && IMAGE_URL_RE.test(l.value);
            // Strong leaf signal — leaf already names the DJ image
            if (
                valOk &&
                /^(djimage|djavatar|djphoto|hostimage|hostavatar|presenterimage)$/.test(k)
            ) {
                return 1.0;
            }
            if (!parentHas(l, ['dj', 'deejay', 'host', 'presenter'])) return 0;
            const kw = keywordScore(l.leafKey, ['image', 'avatar', 'photo', 'logo']);
            if (kw === 0) return 0;
            return valOk ? kw : 0;
        },
    },
    showName: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            // Strong leaf signal — leaf already names the show
            if (
                /^(showname|show_name|showtitle|programname|programtitle|programmname|sendungname)$/.test(
                    k,
                )
            ) {
                return Math.max(0, 1.0 + prefersString(l));
            }
            if (!parentHas(l, ['show', 'program', 'programm', 'sendung'])) return 0;
            return Math.max(0, keywordScore(l.leafKey, ['name']) + prefersString(l));
        },
    },
    showDescription: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            if (/^(showdescription|showdesc|showabout|programdescription|programdesc)$/.test(k)) {
                return Math.max(0, 1.0 + prefersString(l));
            }
            if (!parentHas(l, ['show', 'program'])) return 0;
            return Math.max(
                0,
                keywordScore(l.leafKey, ['description', 'desc', 'about']) + prefersString(l),
            );
        },
    },
    showImageUrl: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            const valOk = typeof l.value === 'string' && IMAGE_URL_RE.test(l.value);
            if (valOk && /^(showimage|showcover|showartwork|programimage|programcover)$/.test(k)) {
                return 1.0;
            }
            if (!parentHas(l, ['show', 'program'])) return 0;
            const kw = keywordScore(l.leafKey, ['image', 'cover', 'artwork', 'logo']);
            if (kw === 0) return 0;
            return valOk ? kw : 0;
        },
    },
    showStartsAt: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            const ok = typeof l.value === 'string' && ISO_DATE_RE.test(l.value);
            if (ok && /^(showstart|showstarts|showstartsat|showbegin|programstart)$/.test(k)) {
                return 1.0;
            }
            if (!parentHas(l, ['show', 'program'])) return 0;
            const kw = keywordScore(l.leafKey, ['start', 'begin']);
            if (kw === 0) return 0;
            return ok ? kw : 0;
        },
    },
    showEndsAt: {
        score: (l) => {
            const k = l.leafKey.toLowerCase();
            const ok = typeof l.value === 'string' && ISO_DATE_RE.test(l.value);
            if (ok && /^(showend|showends|showendsat|showstop|programend)$/.test(k)) {
                return 1.0;
            }
            if (!parentHas(l, ['show', 'program'])) return 0;
            const kw = keywordScore(l.leafKey, ['end', 'stop']);
            if (kw === 0) return 0;
            return ok ? kw : 0;
        },
    },
    upNextTitle: {
        score: (l) => {
            const ok = parentHas(l, ['next', 'upcoming']) || /next/i.test(l.path);
            if (!ok) {
                // fallback: second array entry under playhistory/history
                if (/\[1\]/.test(l.path) && /history|playhistory/.test(l.path)) {
                    return Math.max(0, keywordScore(l.leafKey, ['songtitle', 'title']));
                }
                return 0;
            }
            return keywordScore(l.leafKey, ['songtitle', 'title', 'song']);
        },
    },
    upNextArtist: {
        score: (l) => {
            const ok = parentHas(l, ['next', 'upcoming']) || /next/i.test(l.path);
            if (!ok) {
                if (/\[1\]/.test(l.path) && /history|playhistory/.test(l.path)) {
                    return Math.max(0, keywordScore(l.leafKey, ['artist']));
                }
                return 0;
            }
            return keywordScore(l.leafKey, ['artist']);
        },
    },
    upNextImageUrl: {
        score: (l) => {
            const ok = parentHas(l, ['next', 'upcoming']);
            if (!ok) return 0;
            const kw = keywordScore(l.leafKey, ['image', 'cover', 'artwork']);
            if (kw === 0) return 0;
            const valOk = typeof l.value === 'string' && IMAGE_URL_RE.test(l.value);
            return valOk ? kw : 0;
        },
    },
};

export function detectFields(root: unknown): DetectedMapping {
    const leaves = walk(root, '$', []);
    const jsonPaths: DetectedMapping['jsonPaths'] = {};
    const confidence: DetectedMapping['confidence'] = {};

    for (const field of CANONICAL_FIELD_IDS) {
        const rule = RULES[field];
        let best: { score: number; path: string } | null = null;
        for (const leaf of leaves) {
            const s = rule.score(leaf);
            if (s > 0 && (best === null || s > best.score)) {
                best = { score: s, path: leaf.path };
            }
        }
        if (best && best.score > 0.5) {
            jsonPaths[field] = best.path;
            confidence[field] = Math.min(1, best.score);
        } else if (best) {
            // low-confidence candidate still surfaced for admin review
            jsonPaths[field] = best.path;
            confidence[field] = best.score;
        }
    }

    return {
        jsonPaths,
        confidence,
        allLeafPaths: leaves.map((l) => l.path),
    };
}
