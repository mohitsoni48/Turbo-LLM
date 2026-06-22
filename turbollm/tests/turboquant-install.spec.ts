import { test, expect } from '@playwright/test'

test.describe('TurboQuant engine installation', () => {
  test.skip(
    process.platform !== 'darwin',
    'macOS Apple Silicon only — tests Gatekeeper quarantine fix',
  )

  test('installs TurboQuant without probe timeout', async ({ page }) => {
    await page.goto('/')

    // Navigate to the Engines section
    await page.getByRole('link', { name: /engine/i }).click()

    // Find TurboQuant in the catalog and click Install
    const turboquantRow = page.getByText('TurboQuant').locator('..')
    await expect(turboquantRow).toBeVisible({ timeout: 10_000 })
    await turboquantRow.getByRole('button', { name: /install/i }).click()

    // Wait for install to complete (up to 2 minutes — includes download time)
    // Assert the probe-timeout error does NOT appear
    await expect(
      page.getByText(/binary did not respond/i),
    ).not.toBeVisible({ timeout: 120_000 })

    // Assert TurboQuant is now shown as installed or active
    await expect(
      page.getByText(/turboquant/i).locator('..').getByText(/installed|active|ready/i),
    ).toBeVisible({ timeout: 120_000 })
  })
})
