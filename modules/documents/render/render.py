#!/usr/bin/env python3
"""
Render one HTML document to PDF with WeasyPrint and report where the signature boxes landed.

Ported from the render.py of the /nda skill. The differences are on purpose:
  - the HTML comes from stdin and the PDF goes to --pdf (through a temporary file in the same folder, renamed into
    place when complete), so no layout file is written;
  - stdout carries one JSON document: {"pages": N, "fields": [{"id", "page", "x", "y", "w", "h"}]};
  - nothing is fetched over the network, and files are read only from the --assets folder (see SafeFetcher).

Usage:  render.py --pdf OUT.pdf [--assets DIR] < document.html

Fields are the elements marked data-campo="ID". page is 0-based; x, y, w, h are fractions of the page width and
height, the format DocuSeal takes (same meaning as the skill's -campos.json). Fonts: if DIR/fonts holds
Inter-Regular.ttf, Inter-SemiBold.ttf or Inter-Bold.ttf they are offered as the family "NDA Sans", as the skill
does; without them WeasyPrint falls back to the system fonts the template lists.

Exit codes: 0 done, 2 bad usage, 3 WeasyPrint is not installed for this interpreter, 1 any other failure
(the reason is on stderr).
"""
import argparse
import json
import logging
import os
import sys
import tempfile
import warnings
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname, urlopen

FONT_FACES = [("Inter-Regular.ttf", 400), ("Inter-SemiBold.ttf", 600), ("Inter-Bold.ttf", 700)]
MAX_HTML_BYTES = 8 * 1024 * 1024


class SafeFetcher:
    """
    The only way WeasyPrint reaches a resource. Allowed: data: URIs, and file: URLs that resolve (symlinks
    included) to a file inside the assets folder. Everything else, http(s), ftp, other files and relative
    references without a base, raises. A template body is stored content: it must not make the server read
    arbitrary files or call out.
    """

    _fail_on_errors = False  # a refused resource is a warning in WeasyPrint, not a failed render

    def __init__(self, assets_dir):
        self.root = os.path.realpath(assets_dir) if assets_dir else None

    def __call__(self, url, *args, **kwargs):
        return self.fetch(url)

    def fetch(self, url, headers=None):
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme == "data":
            return self._response(url, urlopen(url))  # the data: handler decodes in memory and never opens a socket
        if scheme == "file" and self.root and parts.netloc in ("", "localhost"):
            path = os.path.realpath(url2pathname(parts.path))  # url2pathname already decodes %XX; decoding twice would turn a literal % into another file
            if os.path.commonpath([path, self.root]) == self.root and os.path.isfile(path):
                with open(path, "rb") as handle:
                    return self._response(url, handle.read())
        raise ValueError("resource not allowed")

    @staticmethod
    def _response(url, body):
        headers = None
        if hasattr(body, "read"):
            headers = {"Content-Type": body.headers.get("Content-Type", "application/octet-stream")}
            body = body.read()
        try:
            from weasyprint.urls import URLFetcherResponse
        except ImportError:  # WeasyPrint before 67 takes a plain dict
            return {"string": body, "redirected_url": url}
        return URLFetcherResponse(url, body, headers)


def file_url(path):
    """A file: URL for an absolute path, with #, ?, %, quotes and spaces escaped, so the path survives being parsed as a URL."""
    return Path(path).as_uri()


def directory_url(path):
    """The same for a folder, with the trailing slash that makes it a base for relative references."""
    return file_url(path).rstrip("/") + "/"


def font_css(assets_dir):
    """@font-face rules with absolute file URLs, for the Inter files that exist in DIR/fonts."""
    if not assets_dir:
        return ""
    fonts = os.path.join(os.path.realpath(assets_dir), "fonts")
    rules = []
    for name, weight in FONT_FACES:
        path = os.path.join(fonts, name)
        if os.path.isfile(path):
            url = file_url(path)
            rules.append('@font-face { font-family: "NDA Sans"; src: url("%s"); font-weight: %d; font-style: normal; }' % (url, weight))
    return "\n".join(rules)


def descendants(box):
    yield box
    for child in getattr(box, "children", None) or []:
        yield from descendants(child)


def signature_fields(document):
    fields, seen = [], set()
    for number, page in enumerate(document.pages):
        width, height = page.width, page.height
        for box in descendants(page._page_box):
            element = getattr(box, "element", None)
            field_id = element.get("data-campo") if element is not None else None
            if not field_id or field_id in seen:
                continue
            seen.add(field_id)  # the first box is the outer one; the anonymous boxes inside share its element
            fields.append({
                "id": field_id, "page": number,
                "x": round(box.border_box_x() / width, 4), "y": round(box.border_box_y() / height, 4),
                "w": round(box.border_width() / width, 4), "h": round(box.border_height() / height, 4),
            })
    return fields


def write_atomically(document, pdf_path):
    """Write to a temporary file in the destination folder and replace the target only once the PDF is complete."""
    folder = os.path.dirname(os.path.abspath(pdf_path))
    handle, temporary = tempfile.mkstemp(prefix=".render-", suffix=".pdf", dir=folder)
    os.close(handle)
    try:
        document.write_pdf(temporary)
        os.replace(temporary, pdf_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv):
    parser = argparse.ArgumentParser(description="Render HTML from stdin to PDF.")
    parser.add_argument("--pdf", required=True, help="where to write the PDF")
    parser.add_argument("--assets", help="the only folder files may be read from (fonts go in DIR/fonts)")
    args = parser.parse_args(argv)

    # WeasyPrint reports refused resources and bad CSS through logging and warnings, with the URL or the value in the text.
    # Stderr is read by the server log, so only this script's own fixed messages may reach it.
    logging.disable(logging.CRITICAL)
    warnings.simplefilter("ignore")

    try:
        from weasyprint import CSS, HTML
        from weasyprint.text.fonts import FontConfiguration
    except ImportError:
        sys.stderr.write("WeasyPrint is not installed for this Python interpreter.\n")
        return 3

    html = sys.stdin.buffer.read(MAX_HTML_BYTES + 1)
    if len(html) > MAX_HTML_BYTES:
        sys.stderr.write("The HTML is larger than %d bytes.\n" % MAX_HTML_BYTES)
        return 1

    fetcher = SafeFetcher(args.assets)
    base_url = directory_url(fetcher.root) if fetcher.root else None
    fonts = FontConfiguration()
    css = font_css(args.assets)
    extra = [CSS(string=css, font_config=fonts, url_fetcher=fetcher)] if css else []
    document = HTML(string=html.decode("utf-8"), base_url=base_url, url_fetcher=fetcher).render(stylesheets=extra, font_config=fonts)

    fields = signature_fields(document)
    write_atomically(document, args.pdf)
    sys.stdout.write(json.dumps({"pages": len(document.pages), "fields": fields}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:  # the type is enough for the log; the message could echo document text
        sys.stderr.write("render failed: %s\n" % type(error).__name__)
        sys.exit(1)
