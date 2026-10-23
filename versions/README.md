# Versions

`dist/` holds only the **current** packed version of each module and is not tracked: build it with `npm run pack -- <module-id>`.
Every earlier version is kept here, in `versions/<module-id>/<version>/<module-id>-<version>.tgz` with its `SHA256`, and each module
has a `CHANGELOG.md` in `versions/<module-id>/`.

```
versions/
  inbox/
    CHANGELOG.md
    0.1.0/inbox-0.1.0.tgz   SHA256
  contacts/
    CHANGELOG.md
    0.1.0/contacts-0.1.0.tgz   SHA256
  agenda/
    CHANGELOG.md
```

- **Packing a new version** (raise `version` in both `manifest.ts` and `package.json`, add its entry to the changelog, run
  `npm run pack -- <module-id>`) moves the previous packed version here by itself.
- **A released version is never replaced.** If `npm run pack` would archive different bytes under a version that is already here, it
  stops. Raise the version instead.
- **Installing an old version**: `modules add versions/<id>/<version>/<id>-<version>.tgz --sha256 <the hash in SHA256>` on a platform
  that does not have the module yet. The platform only upgrades to a higher version, so this is not a way to roll an installed
  module back.
