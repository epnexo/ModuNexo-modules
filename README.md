# modunexo-modules

Modules for the [Modunexo](https://github.com/epnexo/ModuNexo) platform. The platform ships no business module; each
module here is packed into an archive and installed on a running platform.

| Module | What it does |
| --- | --- |
| `inbox` | Receives signed messages from a channel at `/hooks/inbox/messages`, lists conversations, lets an operator reply, and updates live. |

## Install a module

```bash
npm run pack:inbox                                   # writes dist/inbox-<version>.tgz and prints its SHA-256
# on the platform:
npm run modunexo -- modules add inbox-0.1.0.tgz --sha256 <hex>
npm run modunexo -- modules apply <hex>              # place, build, restart without downtime
```

`pack:inbox` needs the platform checkout beside this folder (`../CRM Module`).

## Develop

The platform is linked as a local dependency (`file:../CRM Module/packages/...`), so run `npm install` here after
cloning both repositories side by side.

```bash
export TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test
npm test                                             # each module's tests, in tests/<module>/
```

A module is a folder (`inbox/`) with its manifest, migrations and sources; its tests live outside it, in
`tests/<module>/`, so the archive carries no tests.
