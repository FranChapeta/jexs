import { pageCsrfToken } from "@jexs/core";

/**
 * Add the session's CSRF token, read from its cookie, to a form the page posts
 * to its own origin, unless the form already carries one. Listening for
 * `formdata` covers every native submission, `form.submit()` (which `$submit`
 * uses and which fires no `submit` event) included, so the server need not
 * render the token into the page and the HTML stays the same for everyone.
 */
export function addCsrfField(event: FormDataEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.formData.has("_csrf")) return;
  const token = pageCsrfToken(form.action, form.method.toUpperCase());
  if (token) event.formData.append("_csrf", token);
}
