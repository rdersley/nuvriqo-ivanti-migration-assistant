import { test, expect } from '@playwright/test';

const requestTypeId = process.env.QA_REQUEST_TYPE_ID || '60';
const projectKey = process.env.QA_PROJECT_KEY || 'DEMO';

test('migrated New Employee Setup form is usable and helper fields are hidden', async ({ page }) => {
  await page.goto(`/jira/servicedesk/projects/${projectKey}/settings/request-types/request-type/${requestTypeId}/request-form`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Jira|Service/i);

  const body = page.locator('body');
  await expect(body).toContainText(/New Employee Setup/i);
  await expect(body).not.toContainText('dept manager display name');
  await expect(body).not.toContainText('Facility Detail');
  await expect(body).not.toContainText('New Employee Information');
  await expect(body).not.toContainText('Equipment Details');
  await expect(body).not.toContainText('imageField');
});

test('request type remains attached to migrated form', async ({ page }) => {
  await page.goto(`/jira/servicedesk/projects/${projectKey}/settings/request-types/request-type/${requestTypeId}/request-form`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('New Employee Setup - Ivanti Migration Form');
});
