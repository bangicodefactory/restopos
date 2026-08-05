import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup } from '@playwright/test';

import { ADMIN_STATE, adminCredentials, xsrf } from './support/register';

/**
 * Sign into the back office once, and save the session for the whole run (XCT-135).
 *
 * `/login` is rate limited to ten attempts a minute. Every register spec mints its own pairing code,
 * and if each one logged in first, a suite of nine would exhaust the limit partway through — the
 * later specs would then get a 429, fail to mint, and *skip*. A suite that silently shrinks under
 * its own load is worse than one that fails: it goes green while testing less and less.
 *
 * Cookies serialise cleanly, unlike the register's non-extractable device key, so one login here is
 * reused by every spec's `request` fixture.
 */
setup('sign into the back office', async ({ page, context }) => {
    mkdirSync(dirname(ADMIN_STATE), { recursive: true });

    const { email, password } = adminCredentials();

    // Through the API rather than the form: this is provisioning, not a test of the login screen.
    await page.request.get('/login');

    await page.request.post('/login', {
        headers: { 'X-XSRF-TOKEN': await xsrf(page.request), Accept: 'application/json' },
        form: { email, password },
    });

    await context.storageState({ path: ADMIN_STATE });
});
