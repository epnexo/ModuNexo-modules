# documents-port
Objective: port modules/documents from the old `@epnexo/core` API to `@modunexo/sdk`, then keep growing it into the documents automation.
Branch: feat/documents (worktree of modunexo-modules). Delivery: ask-on-risk. Test runner: `npm test` (node --test) and `npm run typecheck`.

## Specs
- S1: The module is defined with `defineModule` from `@modunexo/sdk` (id `documents`, schema `documents`), packaged as `@local/documents`, with no dependency on `@epnexo/core` or on `pg`.
- S2: All data access goes through `getDb("documents")`; no `getPool`, no `describeDbError`, no `pg.Pool`. A transaction uses `getDb(...).transaction`.
- S3: Pages are declared in the manifest (`pages`, `permission`, `nav`) and every page file exports `metadata`.
- S4: Files (generated and signed PDFs) are stored with the platform files API (`putFile`/`getFile`), not on the module's own disk folder.
- S5: Configuration (DocuSeal address and token, engine address) comes from module `settings` (the token as `secret`), not from `process.env`.
- S6: The existing behavior and the existing tests keep passing; migrations already applied are never edited, changes go in a new `NNNN_*.sql` with `version` raised in `manifest.ts` and `package.json`.
- S7: The module is removed from the `exclude` list of `tsconfig.json` once it type-checks.
- S9: A write (create or change a template or document, save the profile) needs `documents.write`; sending a document to be signed needs `documents.send`. They are enforced by the platform, as POST routes with `permission`, not by server actions that a read-only user could trigger from a page they can see.
- S8 (assumption): the PDF engine keeps its adapter interface; the Python renderer cannot ship inside the platform image, so a separate engine service replaces the local spawn in a later phase.

## Tasks
- [x] T1 (S1,S3,S7) manifest, package.json, permissions, nav, pages, metadata. Route: inline.
- [x] T2 (S2) data layer: replace getPool/describeDbError/inTransaction. Route: inline.
- [x] T3 (S4,S6) files on the platform files API, new migration. Route: inline.
- [ ] T4 (S5) settings instead of environment variables. Route: inline.
- [x] T5 (S6) test helpers on the new core testing API; run the integration tests against a scratch database. Route: inline.
- [ ] T6 (S7) type-check clean, pack, install on a scratch platform, open the page with real data. Route: inline.
- [x] T8 (S9) replace the server actions in `web/actions.ts` with POST routes carrying `permission`. Risk: item 2 (permissions). Route: inline, own commit.
- [ ] T7 (S2) decide what replaces the `import-nda` CLI that opens its own pg pool. Route: inline.

## Log
- L3 (2026-11-08): T1, T2 and T5 observed: `npm run typecheck` 0 errors with documents included (S7); documents suite 801 pass, 0 fail, 5 skipped against a throwaway Postgres 16. The full repo run has one failure, `tests/assistant/answer.integration.test.ts` ("reads the event it is given and answers that message"), that also fails at the original commit 368c5fb, so it is not caused by the port.
- L4: Found while running with a database: the earlier reorganization had left `tests/dashboard` pointing at the old module folders; fixed here. Without a database those tests are skipped and hide it.
- L5: Behavior changes on purpose: the commit is made by the platform, so the commit-failure tests inject the fault around `transaction`; `describeDbError` is the module's own and keeps the `unreachable` and `The database query failed` wording; the missing-schema hint no longer says `npm run db:migrate`.
- L1 (2026-11-08, user): "sí, empecemos a portar documents"
- L2: Findings. The old API is used in ~20 files; stores already take a small `Queryable`, so they stay. Tests are mostly integration and skip without a database (237 skipped in the repo): T5 needs a scratch Postgres.
- L6 (2026-11-08): T8 observed. The seven server actions are now eight POST routes with `permission` (`documents.write`, and `documents.send` for send and clear-send). Each route checks `Origin` against `Host`, caps the body at 1 MB, and answers a safe 500. Forms post with `fetch` so errors still show without a reload; redirects are followed only for paths on this site. 13 new tests; breaking the origin check on purpose made 2 of them fail. Full run: 1122 pass, 1 fail (the pre-existing assistant one).
- L7 (2026-11-08): T3 observed. The generated PDF is stored with `putFile` in the same transaction as its row (the row keeps `pdf_file_id`; `pdf_path` is now only the display name); the download route reads it with `getFile`; the disk helpers (`documentsDir`, `resolveInside`, `moveIntoPlace`) are gone; migration 0005 adds the nullable column (additive); the manifest declares `files` for PDFs only, with no `permission`. The recovery of a commit whose answer was lost is kept. Rows from before the file store have no PDF (none exist on a new platform). The upload of the PDF to DocuSeal is still manual (`not-uploaded` in `send-signature`): that is Phase 1, not T3. Full run: 1112 pass, 1 fail (the pre-existing assistant one). Risk: item 1 (a migration; additive column only).
