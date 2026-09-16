/**
 * Project-relative directories the runner works from.
 *
 * `TEMPLATES_DIR` is both where renderer templates are read from AND the
 * resolver root, so a leading slash in a template means "from my templates"
 * rather than "from wherever the project sits". That is the same rule a server
 * project gets from `jexs run app/index.json app`, where the template directory
 * is passed as the root. The two uses share this constant because the whole
 * point is that they cannot drift apart.
 */
export const TEMPLATES_DIR = "src";

/** The `jexs bundle` output */
export const BROWSER_DIR = "dist/browser";

/**
 * Optional main-process startup, relative to `TEMPLATES_DIR`. Runs before any
 * window exists, for menus, a tray, or opening windows itself. Absent, the
 * runner just opens a window on the default page.
 */
export const MAIN_TEMPLATE = "main.json";
