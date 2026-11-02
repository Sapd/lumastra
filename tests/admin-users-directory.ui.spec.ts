// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectHydrated } from './helpers/hydration';

test.describe('user directory', () => {
    test('preserves filters through reload and browser navigation', async ({ page }) => {
        await gotoHydrated(page, '/admin/users');
        await page.getByRole('button', { name: /^Needs attention/ }).click();
        await expect(page).toHaveURL(/filter=attention/);
        await page.reload();
        await expectHydrated(page);
        await expect(page.getByRole('button', { name: /^Needs attention/ })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await page.getByRole('searchbox').fill('no-match-directory-test');
        await expect(page.getByText('No users to display')).toBeVisible();
        await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
        await expect(page).not.toHaveURL(/filter=|q=/);
        await page.goBack();
        await expect(page.getByRole('searchbox')).toHaveValue('no-match-directory-test');
    });

    test('opens a linkable account and restores the directory on Back', async ({ page }) => {
        await gotoHydrated(page, '/admin/users');
        await page
            .getByRole('button', { name: /^View details for / })
            .first()
            .click();
        await expect(page).toHaveURL(/user=/);
        const dialog = page.getByRole('dialog', { name: /^View details for / });
        await expect(dialog).toBeVisible();
        await page.reload();
        await expectHydrated(page);
        await expect(dialog).toBeVisible();
        await dialog.getByRole('tab', { name: 'Access & sign-in', exact: true }).click();
        await expect(dialog.getByRole('spinbutton')).toBeVisible();
        await expect(dialog.getByLabel('Email (optional)')).toBeVisible();
        await expect(dialog.getByText(/Unrated content is hidden by default/)).toBeVisible();
        await expect(dialog.getByText('Live TV has no age restriction.')).toBeVisible();
        await expect(
            dialog.getByText('New libraries are visible to everyone until access is denied.'),
        ).toBeVisible();
        await page.goBack();
        await expect(dialog).not.toBeVisible();
    });

    test('fits the directory and account panel on a narrow screen', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await gotoHydrated(page, '/admin/users');
        await page
            .getByRole('button', { name: /^View details for / })
            .first()
            .click();
        const dialog = page.getByRole('dialog', { name: /^View details for / });
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await dialog.getByRole('tab', { name: 'Access & sign-in', exact: true }).click();
        await expect(dialog.getByRole('spinbutton')).toBeVisible();
    });
});

test('validates the optional email before creating a user', async ({ page }) => {
    await gotoHydrated(page, '/admin/users');
    await page.getByRole('button', { name: 'Create user', exact: true }).click();
    const email = page.getByLabel('Email (optional)');
    await email.fill('invalid-email');
    await expect(page.getByRole('alert')).toHaveText(
        'Enter a valid email address, or leave the field empty.',
    );
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await email.fill('anna@example.test');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/Use the email verified by your SSO provider/)).toBeVisible();
});
