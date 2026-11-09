/**
 * Importing a template from an HTML file: the file's text becomes the body, and its name suggests the template's name and
 * slug. Pure, so the page's script and the tests share it. The form still validates everything when it is saved.
 */

/** The largest file the form loads: the same limit as a form body, so a file that loads can also be saved. */
export const MAX_IMPORT_BYTES = 1_000_000;

const HTML_FILE = /\.(html?|xhtml)$/i;

/** Whether a file looks like an HTML document by its name (browsers report an HTML file's type inconsistently). */
export const looksLikeHtml = (fileName: string): boolean => HTML_FILE.test(fileName);

/** A name and a slug from a file name: `Mutual NDA v2.html` gives "Mutual NDA v2" and `mutual-nda-v2`. */
export function suggestFromFileName(fileName: string): { name: string; slug: string } {
  const base = fileName.replace(/^.*[\\/]/, "").replace(HTML_FILE, "").trim();
  const name = base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return { name, slug };
}
