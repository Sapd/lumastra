// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together web e2e — scenario 10, in its own file because it needs tracing OFF:
 * Playwright's trace DOM snapshots evaluate in the page and so grant it a user
 * activation (measured: navigator.userActivation.hasBeenActive false -> true after one
 * goto with snapshots on), which would void the test's premise. `test.use({ trace })`
 * forces a new worker, so it can only be set per file. Same harness, same config.
 */

import { chromium, expect, test } from '@playwright/test';
import { webUrl } from './wt-env';
import { identityHeaders, Party, scenario } from './wt-harness';

test.use({ trace: 'off' });

// ---------------------------------------------------------------------------
// 10. Autoplay without the launch flag: a guest follows a remote Play with no gesture
// ---------------------------------------------------------------------------

// Chromium-only: the strict policy and the gesture-free CDP reads are Chromium's.
scenario(
    'guest follows remote play without a user gesture',
    { tag: ['@chromium-only'] },
    async (s) => {
        const { rec } = s;
        // A browser WITHOUT --autoplay-policy=no-user-gesture-required, set to the strict
        // policy a fresh real browser applies to a site it has no engagement with.
        const strict = await chromium.launch({
            args: ['--autoplay-policy=document-user-activation-required'],
        });
        s.onCleanup(() => strict.close());
        const guestCtx = await strict.newContext({
            baseURL: webUrl(),
            extraHTTPHeaders: identityHeaders(s.guestUser),
        });
        s.onCleanup(() => guestCtx.close());

        const m = await s.movie();
        const host = await s.participant(s.hostUser, 'host');
        const joiner = await s.participant(s.guestUser, 'guest-join', { context: guestCtx });
        const party = s.track(
            await Party.create(host, { id: m.id, title: m.title, mediaType: 'movie' }, s.title),
        );
        await party.join(joiner);
        // The join click was a user gesture, and Chromium keeps a page's sticky activation
        // across reload(). A NEW tab opening the watch URL has none: the stored party
        // (localStorage, shared by the context) brings it back into the party — the
        // "reopened the tab mid-party" case.
        const guest = await s.participant(s.guestUser, 'guest', { context: guestCtx });
        await guest.readWithoutGestures();
        await joiner.page.close();
        await guest.page.goto(`${webUrl()}/watch/${m.id}`);
        await guest.waitForVideoReady();
        expect(await guest.hasUserActivation(), 'guest tab has a user activation').toBe(false);
        const cid = await guest.clientId();
        await expect
            .poll(
                async () =>
                    (await party.session()).session?.participants?.some((p) => p.clientId === cid),
                {
                    message: 'the new guest tab did not rejoin from the stored party',
                    timeout: 15_000,
                },
            )
            .toBe(true);

        await host.play();
        const both = [host, guest];
        await rec.waitPlayState(both, true, 'guest follows remote play without a gesture', 25_000);
        const v = (await guest.video())!;
        const prompt = await guest.page
            .locator('.autoplay-muted-overlay')
            .isVisible()
            .catch(() => false);
        rec.log('observed', { label: 'guest autoplay', muted: v.muted, prompt });
        // Unmuted autoplay is impossible under this policy: the player must have taken the
        // muted fallback and told the user so.
        expect(v.muted, 'guest playing unmuted without a gesture (policy not in effect?)').toBe(
            true,
        );
        expect(prompt, 'no "Unmute" prompt for the muted fallback').toBe(true);
        await rec.measureDrift(both, 'muted guest in sync');

        await guest.page.locator('.autoplay-muted-overlay button.unmute-button').click();
        await expect.poll(async () => (await guest.video())?.muted).toBe(false);
        await rec.waitPlayState(both, true, 'still playing after unmute');
        await rec.measureDrift(both, 'after unmute');
    },
);
