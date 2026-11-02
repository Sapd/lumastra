// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() }) },
}));

import { pluginsDirIsPersistent, warnIfPluginsDirEphemeral } from './loader.js';

describe('pluginsDirIsPersistent', () => {
    it('reports NOT persistent for an ordinary directory sharing its parent device', () => {
        // The /app/plugins case: a plain directory in the image layer.
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-'));
        const dir = path.join(base, 'plugins');
        fs.mkdirSync(dir);
        try {
            expect(pluginsDirIsPersistent(dir)).toBe(false);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('returns null — not false — when the directory does not exist', () => {
        // Must not warn about a path that simply is not there yet. A false alarm
        // on every boot trains operators to ignore the message that matters.
        expect(
            pluginsDirIsPersistent(path.join(os.tmpdir(), 'definitely-absent-' + Date.now())),
        ).toBeNull();
    });

    it('returns null at the filesystem root rather than claiming anything', () => {
        expect(pluginsDirIsPersistent('/')).toBeNull();
    });

    it('detects a real mount boundary', () => {
        // /proc is a distinct filesystem on Linux, and on macOS /dev is. Skip
        // where neither holds rather than assert something untrue.
        const candidates = ['/proc', '/dev'];
        const mount = candidates.find(
            (c) => fs.existsSync(c) && fs.statSync(c).dev !== fs.statSync(path.dirname(c)).dev,
        );
        if (!mount) return;
        expect(pluginsDirIsPersistent(mount)).toBe(true);
    });
});

describe('warnIfPluginsDirEphemeral', () => {
    // Testing the PREDICATE is not testing the GATE. pluginsDirIsPersistent
    // could be perfect while the warning never fires — an inverted early
    // return, a wrong default, or simply never being called. A warning that
    // cannot be shown to fire is indistinguishable from no warning, and this
    // one exists precisely to be the only signal an operator gets before their
    // first install silently becomes unpersisted.
    let base = '';
    beforeEach(() => {
        warn.mockClear();
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-'));
        delete process.env.PLUGINS_EXTERNAL_DIR;
    });
    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
        delete process.env.PLUGINS_EXTERNAL_DIR;
    });

    it('WARNS, naming the directory, when it is not a mount point', () => {
        const dir = path.join(base, 'plugins');
        fs.mkdirSync(dir);
        warnIfPluginsDirEphemeral(dir);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(dir);
        expect(warn.mock.calls[0][0]).toMatch(/DELETED|image update/i);
    });

    it('warns even when the path came from PLUGINS_EXTERNAL_DIR', () => {
        // Setting the variable chooses WHERE, not that it is persistent.
        // Skipping this case silenced the one most likely to be a mistake.
        const dir = path.join(base, 'plugins');
        fs.mkdirSync(dir);
        process.env.PLUGINS_EXTERNAL_DIR = dir;
        warnIfPluginsDirEphemeral();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('stays silent when the directory does not exist', () => {
        // The common case on a fresh install: no volume, no directory yet.
        // A warning here would fire on every boot of every deployment and train
        // operators to ignore the one that matters.
        warnIfPluginsDirEphemeral(path.join(base, 'absent'));
        expect(warn).not.toHaveBeenCalled();
    });
});
