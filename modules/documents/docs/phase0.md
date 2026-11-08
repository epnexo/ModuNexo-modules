# Phase 0: feasibility spikes

This project lives apart from the platform core and from `modunexo-modules`. Nothing here changes either of them.
Goal: prove the riskiest assumptions of the documents automation before writing the module.

| # | Spike | Status | Result |
|---|---|---|---|
| 1 | The NDA engine renders a PDF in an arm64 container | Done | `spikes/01-render`: Debian bookworm + WeasyPrint 62.3 from pip renders the example NDA (3 pages, Inter font, layout correct) with `--network none`, so rendering needs no external call |
| 2 | DocuSeal accepts the PDF through its API (no manual upload, no tunnel) | Pending | Needs authorization to use the DocuSeal instance |
| 3 | A signing link opens from outside the local network | Pending | Needs the owner to open a link from a device outside the LAN |
| 4 | Microsoft Graph sends the signing-link email from the restricted mailbox | Pending | Needs authorization, the sender mailbox and a test recipient |
| 5 | The platform module calls the engine and the engine calls the platform with a service token | Pending | Local only |

## Findings so far

- The production image of the platform has no Python, and the host Python has no WeasyPrint, so rendering must live in its own container.
- The skill's company data (`config.json`) is mounted read-only at run time and never copied into this folder (`.gitignore` excludes it, `.env` and `out/`).
