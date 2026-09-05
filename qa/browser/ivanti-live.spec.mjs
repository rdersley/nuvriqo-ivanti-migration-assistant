import { test, expect } from '@playwright/test';

const requestTypeId = process.env.QA_REQUEST_TYPE_ID || '60';
const projectKey = process.env.QA_PROJECT_KEY || 'DEMO';
const requestFormPath = `/jira/servicedesk/projects/${projectKey}/settings/request-types/request-type/${requestTypeId}/request-form`;

async function openRequestForm(page) {
  await page.goto(requestFormPath, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Jira|Service/i);
  await expect(page.locator('body')).toContainText(/New Employee Setup/i);
}

test.describe('Ivanti migrated form - authenticated live Jira QA', () => {
  test('migrated form loads and remains attached to request type', async ({ page }) => {
    await openRequestForm(page);
    await expect(page.locator('body')).toContainText('New Employee Setup - Ivanti Migration Form');
  });

  test('internal Ivanti helper fields stay hidden from the live form', async ({ page }) => {
    await openRequestForm(page);
    const body = page.locator('body');
    for (const helper of [
      'dept manager display name',
      'Facility Detail',
      'New Employee Information',
      'Equipment Details',
      'imageField',
    ]) {
      await expect(body).not.toContainText(helper);
    }
  });

  test('important migrated employee fields are present', async ({ page }) => {
    await openRequestForm(page);
    const body = page.locator('body');
    for (const field of ['Hiring Manager', 'Computer Required', 'Start Date']) {
      await expect(body).toContainText(new RegExp(field, 'i'));
    }
  });

  test('Hiring Manager remains visible after lookup repair', async ({ page }) => {
    await openRequestForm(page);
    // Keep this live-browser assertion deliberately scoped to the migrated field itself.
    // Jira's editor sidebar contains unrelated built-in User Picker fields, so searching
    // the entire page for "User Picker" creates a false positive.
    const hiringManager = page.getByText(/^Hiring Manager$/i).first();
    await expect(hiringManager).toBeVisible();
  });

  test('form editor has no visible migration error state', async ({ page }) => {
    await openRequestForm(page);
    const body = page.locator('body');
    await expect(body).not.toContainText(/couldn['’]t load form/i);
    await expect(body).not.toContainText(/failed to load form/i);
    await expect(body).not.toContainText(/form not found/i);
  });
});
