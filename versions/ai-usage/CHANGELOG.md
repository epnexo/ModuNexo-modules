# ai-usage

## 0.6.8 - 2026-11-24

- A second dashboard chart, "Tokens by tool, last 30 days": one bar per tool, and pressing a bar opens that tool's page (`/ai-usage?tool=<tool>`). It is the first chart to use `{label}` in its link, so the module now asks for platform `^0.1.4` (SDK 0.1.4, core 0.10.0 or later).
- No migration.

## 0.6.7 - 2026-11-24

- Its stylesheet is written inside the platform's `module` layer, so what a company or a person customizes wins over it without `!important`.
- No migration.

