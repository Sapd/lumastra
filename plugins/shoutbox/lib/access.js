// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A configured group list as an array. The host now stores `array` settings as
 * arrays, but a value saved before that is the comma-separated text — and
 * `String.prototype.includes` on it is a SUBSTRING test ("admins" contains
 * "admin"), which would admit the wrong group.
 */
const asList = (v) =>
    Array.isArray(v)
        ? v.map(String)
        : typeof v === 'string'
          ? v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
          : [];

const intersects = (a, b) => Array.isArray(a) && a.some((g) => asList(b).includes(g));

/** @param {{groups:string[],isAdmin:boolean}} user @param {{readGroups:string[]}} cfg */
export function canRead(user, cfg) {
    if (user.isAdmin) return true;
    if (asList(cfg.readGroups).length === 0) return true;
    return intersects(user.groups, cfg.readGroups);
}

/** @param {{groups:string[],isAdmin:boolean}} user @param {{readGroups:string[],postGroups:string[]}} cfg */
export function canPost(user, cfg) {
    if (user.isAdmin) return true;
    if (!canRead(user, cfg)) return false;
    if (asList(cfg.postGroups).length === 0) return true;
    return intersects(user.groups, cfg.postGroups);
}

/** @param {{groups:string[],isAdmin:boolean}} user @param {{adminGroups:string[]}} cfg */
export function canModerate(user, cfg) {
    if (user.isAdmin) return true;
    if (asList(cfg.adminGroups).length === 0) return false;
    return intersects(user.groups, cfg.adminGroups);
}
