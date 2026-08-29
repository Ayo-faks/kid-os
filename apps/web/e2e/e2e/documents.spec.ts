import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const objectKey =
  'tenants/11111111-1111-4111-8111-111111111111/homes/22222222-2222-4222-8222-222222222222/documents/75757575-7575-4575-8575-757575757575/Care-plan.pdf';
const fileBody = Buffer.from('care plan');

async function mockObjectUpload(page: Page): Promise<void> {
  await page.route('**/api/documents/presign', async (route) => {
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({
      mime_type: 'application/pdf',
      original_filename: 'Care plan.pdf',
      size_bytes: fileBody.length,
    });
    await route.fulfill({
      body: JSON.stringify({ objectKey, uploadUrl: `/minio/careos-documents/${objectKey}` }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.route('**/minio/**', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['content-type']).toBe('application/pdf');
    expect(route.request().postDataBuffer()).toEqual(fileBody);
    await route.fulfill({ status: 200 });
  });
}

test.describe('documents', () => {
  test('uploads through the verified object boundary and refreshes the list', async ({ page }) => {
    await mockObjectUpload(page);
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        expect(route.request().headers()['idempotency-key']).toBeTruthy();
        expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
        expect(route.request().postDataJSON()).toEqual({
          mime_type: 'application/pdf',
          object_key: objectKey,
          original_filename: 'Care plan.pdf',
          size_bytes: fileBody.length,
        });
        await route.fulfill({
          body: JSON.stringify({
            id: '75757575-7575-4575-8575-757575757575',
            status: 'processing',
            workflowId: 'doc-ingest-75757575-7575-4575-8575-757575757575',
          }),
          contentType: 'application/json',
          status: 202,
        });
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          documents: [
            {
              createdAt: '2026-07-16T11:00:00.000Z',
              failureReason: null,
              id: '75757575-7575-4575-8575-757575757575',
              mimeType: 'application/pdf',
              objectKey,
              originalFilename: 'Care plan.pdf',
              sizeBytes: fileBody.length,
              status: 'uploaded',
              updatedAt: '2026-07-16T11:00:00.000Z',
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
    });

    await page.goto('/documents');
    await expect(page.getByRole('heading', { exact: true, name: 'Documents' })).toBeVisible();
    await expect(page.getByText('Legacy care plan.pdf')).toBeVisible();
    await expect(page.getByText('Document extraction is unavailable.')).toBeVisible();

    await page.getByLabel('Document file').setInputFiles({
      buffer: fileBody,
      mimeType: 'application/pdf',
      name: 'Care plan.pdf',
    });
    await page.getByRole('button', { name: 'Upload document' }).click();

    await expect(page.getByRole('status')).toContainText('Document accepted for extraction');
    await expect(page.getByTestId('documents-list')).toContainText('Care plan.pdf');
    await expect(page.getByTestId('document-status')).toHaveText('Queued');
  });

  test('surfaces registration refusal without claiming acceptance', async ({ page }) => {
    await mockObjectUpload(page);
    await page.route('**/api/documents', async (route) => {
      await route.fulfill({
        body: JSON.stringify({ message: 'Uploaded document metadata does not match.' }),
        contentType: 'application/json',
        status: 400,
      });
    });

    await page.goto('/documents');
    await page.getByLabel('Document file').setInputFiles({
      buffer: fileBody,
      mimeType: 'application/pdf',
      name: 'Care plan.pdf',
    });
    await page.getByRole('button', { name: 'Upload document' }).click();

    await expect(
      page.getByText('Kid-OS could not verify the uploaded document (HTTP 400).', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('has no axe violations', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
