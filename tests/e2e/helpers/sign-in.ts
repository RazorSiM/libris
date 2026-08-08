import { expect, type Page } from "@playwright/test";

/**
 * Sign in the way a person does: on the login page, in the browser.
 *
 * Nothing here touches cookies directly. Letting the browser receive and store
 * the Set-Cookie is the point — a helper that constructs the cookie itself
 * cannot catch a wrong sameSite, a wrong domain, or a missing Secure flag,
 * which are exactly the settings that break in production and nowhere else.
 */
export async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  // Wait for the setup-vs-sign-in decision before touching the form: the page
  // renders the sign-in fields optimistically and swaps them for the setup
  // fields if the server says the install is empty. Filling across that swap
  // loses the input.
  const settled = page.waitForResponse(
    (res) => res.url().includes("/api/setup") && res.request().method() === "GET",
  );
  await page.goto("/login");
  await expect(page.getByTestId("login-page")).toBeVisible();
  await settled;

  const emailInput = page.getByTestId("login-email-input");
  const passwordInput = page.getByTestId("login-password-input");
  await expect(emailInput).toBeVisible();

  await emailInput.fill(email);
  await passwordInput.fill(password);
  // Assert the values landed in Vue's model, not just the DOM. fill() before
  // hydration finishes sets the element's value without v-model noticing, and
  // the form then submits an empty password — which the server correctly
  // rejects, so the failure reads as "wrong credentials" rather than "too early".
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password);

  await page.getByTestId("login-submit-btn").click();

  // expect().toHaveURL polls; page.waitForURL waits for a load event, and a SPA
  // that navigates with history.replaceState never fires one — so waitForURL
  // times out here even though the app has already rendered.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** Sign out through the UI and land back on the login page. */
export async function signOutThroughUi(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByTestId("logout-btn").click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
}
