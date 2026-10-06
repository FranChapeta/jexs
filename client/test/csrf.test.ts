import { test } from "node:test";
import assert from "node:assert/strict";
import { addCsrfField } from "../src/csrf.js";

// Just enough page for the handler: a form element class, the cookie, and the
// page's location. FormData is the real one.

class FakeForm {
  constructor(readonly action: string, readonly method: string) {}
}

function withPage(t: { after: (fn: () => void) => void }): void {
  Object.assign(globalThis, {
    HTMLFormElement: FakeForm,
    document: { cookie: "csrf=tok" },
    location: { href: "https://app.test/page", origin: "https://app.test" },
  });
  t.after(() => {
    for (const name of ["HTMLFormElement", "document", "location"]) Reflect.deleteProperty(globalThis, name);
  });
}

/** The fields a submission of `form` would send, after the handler ran. */
function submit(form: FakeForm, formData = new FormData()): FormData {
  const event = new Event("formdata");
  Object.defineProperty(event, "target", { value: form });
  addCsrfField(Object.assign(event, { formData }));
  return formData;
}

test("a POST to the page's own origin gets the token from the cookie", t => {
  withPage(t);
  assert.equal(submit(new FakeForm("https://app.test/save", "post")).get("_csrf"), "tok");
});

test("a form that already carries a token keeps its own", t => {
  withPage(t);
  const fields = new FormData();
  fields.append("_csrf", "rendered");
  assert.deepEqual(submit(new FakeForm("https://app.test/save", "post"), fields).getAll("_csrf"), ["rendered"]);
});

test("GET forms and forms posting to another origin get no token", t => {
  withPage(t);
  assert.equal(submit(new FakeForm("https://app.test/search", "get")).get("_csrf"), null);
  assert.equal(submit(new FakeForm("https://other.test/save", "post")).get("_csrf"), null);
});
