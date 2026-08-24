import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { collectPageErrors, expectNoPageErrors, signIn } from './support.js';

/**
 * The panel's database section: the tables of every module's database, and one page of rows.
 *
 * The section used to be a third-party console; it is this template's own screen now, so what these
 * checks are about is different too. Not "is it the real Adminer" but: does it read the catalogue of a
 * live database, does the key of a row come from the catalogue rather than from a column called `id`,
 * and does the theme of the panel reach a frame that is not React.
 */

/** The screen, inside the frame the panel embeds it in. */
async function openDatabaseSection(page: Page): Promise<FrameLocator> {
  await signIn(page);
  await page.goto('/admin/database');

  const frame = page.frameLocator('iframe');
  await expect(frame.locator('.shell-table').first()).toBeVisible({ timeout: 20_000 });
  return frame;
}

/** Switches the database and waits for its tables, which are a different set. */
async function chooseDatabase(page: Page, frame: FrameLocator, matching: RegExp): Promise<void> {
  await frame.locator('.shell-database').click();
  await frame.locator('.el-select-dropdown__item').filter({ hasText: matching }).first().click();
}

test.describe('the database section', () => {
  test('reads the catalogue of a live database', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await expect(frame.locator('.shell-table-name').filter({ hasText: 'identities' })).toBeVisible();

    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    // The columns are named by the database, with the type the catalogue reports beside each one.
    await expect(frame.locator('.column-head').filter({ hasText: /^email\s/ }).first()).toBeVisible();
    await expect(frame.locator('.column-head').filter({ hasText: 'uuid' }).first()).toBeVisible();

    expectNoPageErrors(problems);
  });

  test('sorts through the column menu and keeps the view in the address', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.column-head').filter({ hasText: /^email\s/ }).first().click();
    await frame
      .locator('.el-dropdown-menu__item:visible')
      .filter({ hasText: 'Сортировать' })
      .first()
      .click();

    await expect(frame.locator('.column-sort').first()).toHaveText('↑');

    /*
     * The view is in the frame's own URL, which is what makes a link to a filtered table sendable.
     * There is nowhere to store named views: this interface creates no table of its own.
     */
    const inner = page.frames().at(-1)?.url() ?? '';
    expect(inner).toContain('#');
  });

  /**
   * A table shows a line of a value, and a hash or a json document is longer than the line. Clicking
   * the cell is how the rest of it is seen — and the check is that what opens is the whole value, not
   * the truncated text the cell was showing.
   */
  test('shows a cut value in full when the cell is clicked', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    const cell = frame.locator('.el-table__row .value-cell').first();
    const shown = ((await cell.textContent()) ?? '').trim();
    await cell.click();

    const full = frame.locator('.value-dialog textarea');
    await expect(full).toBeVisible();
    await expect(full).toHaveValue(shown);
    // The name of the column it came from, so a value out of context is still identifiable.
    await expect(frame.locator('.value-dialog .head-name')).toHaveText('id');
  });

  /**
   * A filter with nothing typed in it must not be asked. Adding a condition is what sends the view to
   * the server, and the new filter starts empty — so an empty value went to a uuid column and PostgreSQL
   * answered `invalid input syntax for type uuid: ""`. An error message for doing nothing but adding a
   * row to a form. The count on the button says how many filters are really being asked, which is how a
   * half-filled one is visibly not one of them.
   */
  test('adds an empty filter without asking anything yet', async ({ page }) => {
    const problems = collectPageErrors(page);
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_auth$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'identities' }).click();
    await expect(frame.locator('.el-table__row').first()).toBeVisible({ timeout: 20_000 });

    await frame.locator('.filters-button').click();
    await frame.locator('.filters-add').click();

    // The filter is in the panel, the rows are still there, and nothing was refused.
    await expect(frame.locator('.filters-row')).toHaveCount(1);
    await expect(frame.locator('.el-table__row').first()).toBeVisible();
    await expect(frame.locator('.el-message--error')).toHaveCount(0);
    await expect(frame.locator('.filters-button')).toHaveText('Фильтры');

    // Filling it in does ask, and the count then says one. The column is switched to a text one first:
    // a filter starts on the first column, which here is a uuid, and `probe` is not a uuid.
    await frame.locator('.filters-column').click();
    await frame.locator('.el-select-dropdown__item:visible').filter({ hasText: 'email' }).first().click();
    await frame.locator('.filters-value input').fill('probe');

    await expect(frame.locator('.filters-button')).toHaveText('Фильтры · 1');
    await expect(frame.locator('.el-message--error')).toHaveCount(0);

    expectNoPageErrors(problems);
  });

  /**
   * A table whose key is two columns is the case a screen gets wrong: addressing a row by `id` would
   * either fail or, worse, match several rows. This one exists in the admin database.
   */
  test('shows a two-column key as the key of that table', async ({ page }) => {
    const frame = await openDatabaseSection(page);

    await chooseDatabase(page, frame, /_admin$/);
    await frame.locator('.shell-table-name').filter({ hasText: 'administrator_grants' }).click();

    // Nothing refuses here: the table opens, and its own key is what a row would be addressed by.
    await expect(frame.locator('.column-head').filter({ hasText: 'administrator_id' })).toBeVisible();
    await expect(frame.locator('.column-head').filter({ hasText: /^service\s/ })).toBeVisible();
  });

  /**
   * The theme is the one contract this screen keeps with the panel, and it is not a React component:
   * the panel sends a message, the screen writes the attribute. Nothing else connects the two.
   */
  test('follows the theme the panel sends it', async ({ page }) => {
    const frame = await openDatabaseSection(page);
    const html = frame.locator('html');

    await page.evaluate(() => {
      const embedded = document.querySelector('iframe');
      embedded?.contentWindow?.postMessage(
        { type: 'template.admin.theme', theme: 'dark' },
        window.location.origin,
      );
    });
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.evaluate(() => {
      const embedded = document.querySelector('iframe');
      embedded?.contentWindow?.postMessage(
        { type: 'template.admin.theme', theme: 'light' },
        window.location.origin,
      );
    });
    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});
