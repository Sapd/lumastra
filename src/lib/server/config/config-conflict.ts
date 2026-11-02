// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown by `saveConfig` when its `expect` precondition fails: the value
 * settings.json holds for a key is no longer the one the caller built its
 * change from (another replica, tab or admin saved in between). Its own
 * module so callers can catch it without importing the whole config service.
 */
export class ConfigConflictError extends Error {
    constructor(public readonly key: string) {
        super(`${key} was changed by another save; reload and try again`);
        this.name = 'ConfigConflictError';
    }
}
