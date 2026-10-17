// name: Example.com journey
//
// Kept to what the page actually guarantees. It used to click through a
// "Learn more" link to iana.org; that link, and the <h1>, are gone.
await page.goto('https://example.com');
await expect(page).toHaveTitle(/Example Domain/);
await expect(page.locator('p').first()).toBeVisible();
