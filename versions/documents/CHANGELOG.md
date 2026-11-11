# documents

## 0.5.3 - 2026-11-09

- Import a template bundle (the HTML, a `config.json` and the script) that is not only an NDA: the import form on the templates page is generic.
- Uses the platform's own cards, figures, tables, badges, notices and forms; the module keeps only its page bar, layout and a few small parts in `documents.css`, every class prefixed `dc-`. File fields look like the platform's secondary button.
- No migration.

## 0.5.2 - 2026-11-09

- New template: load the body from any HTML file, next to the bundle import.
- No migration.

## 0.5.1 - 2026-11-08

- Import the NDA from the files uploaded on the templates page (the template, `config.json` and the script); nothing from the author's machine is bundled.
- No migration.

## 0.5.0 - 2026-11-08

- The PDF engine can run as a separate service (`engine.url`, with `engine.token` as a secret), for a platform that cannot carry WeasyPrint's system libraries. The local interpreter (`engine.python`) is used when no address is set.
- The service ships as a container image built from `engine/Dockerfile`.
- No migration.

## 0.4.2 - 2026-11-08

- The module ships its own stylesheet; the old shell classes it used are not defined by the platform.
- No migration.

## 0.4.1 - 2026-11-08

- Reports to the dashboard: document figures and an alert for signatures that went stale. Needs a platform with SDK 0.1.1 or later.
- No migration.

## 0.4.0 - 2026-11-08

- DocuSeal and PDF engine configuration come from the module's settings (`docuseal.url`, `docuseal.token`, `engine.python`, `engine.assets_dir`, `engine.timeout_ms`), not from environment variables.
- The `import-nda` command line tool is gone.
- No migration.

## 0.3.0 - 2026-11-08

- Generated PDFs are kept in the platform's file store.

## 0.2.0 - 2026-11-08

- Ported to the `@modunexo/sdk` data layer; every write is guarded by a permission enforced by the platform (`documents.read`, `documents.write`, `documents.send`).
