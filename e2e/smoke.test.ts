import { expect, test } from '@playwright/test';

// Smoke tests — requires both dev servers:
//   npm run dev:front  (port 3210)
//   npm run dev:server (port 3211)

test('app loads without JS errors', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto('/t/demo');
  await page.waitForTimeout(3_000);

  expect(jsErrors).toEqual([]);
});

test('app renders title', async ({ page }) => {
  await page.goto('/t/demo');
  await expect(page).toHaveTitle(/Treenity/i, { timeout: 10_000 });
});

test('tree sidebar shows nodes', async ({ page }) => {
  await page.goto('/t/demo');
  // Search input is the sidebar landmark
  await expect(page.getByPlaceholder('Search nodes...')).toBeVisible({ timeout: 10_000 });
  // At least one tree node visible (e.g. "local")
  await expect(page.getByText('local')).toBeVisible({ timeout: 5_000 });
});

test('main panel shows placeholder when no node selected', async ({ page }) => {
  await page.goto('/t/demo');
  await expect(page.getByText('Select a node to inspect')).toBeVisible({ timeout: 10_000 });
});
