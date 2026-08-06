// name: Example.com journey
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
await page.getByRole('link', { name: 'Learn more' }).click();
await expect(page).toHaveURL(/iana\.org/);
