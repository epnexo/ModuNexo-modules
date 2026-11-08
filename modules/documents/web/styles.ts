/**
 * The module's own stylesheet. The platform only knows Tailwind utilities and its design tokens, so the class names the
 * pages use (`portlet`, `btn`, `kpis`, ...) are defined here, with the tokens as colors: the light and dark themes
 * follow the platform without any value of its own. It is rendered once per page by `PageBar`.
 */
export const DOCUMENTS_CSS = `
.page-bar { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1rem; padding: 1.5rem 1.5rem 1rem; border-bottom: 1px solid var(--border); }
.page-bar h1 { font-size: 1.5rem; line-height: 2rem; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.page-bar p { margin: 0.25rem 0 0; color: var(--muted-foreground); font-size: 0.9rem; }
.page-bar-text { min-width: 0; }
.page-bar-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
.page-tabs { display: inline-flex; gap: 0.25rem; padding: 0.25rem; border-radius: var(--radius); background: var(--panel); }
.page-tabs a { padding: 0.35rem 0.75rem; border-radius: calc(var(--radius) - 0.25rem); font-size: 0.875rem; color: var(--muted-foreground); text-decoration: none; transition: background var(--duration-fast), color var(--duration-fast); }
.page-tabs a:hover { background: var(--panel-hover); color: var(--foreground); }
.page-tabs a[aria-current="page"] { background: var(--surface); color: var(--foreground); font-weight: 500; box-shadow: var(--shadow-raised); }

.page-body { --portlet-pad: 1rem; display: flex; flex-direction: column; gap: 1.25rem; padding: 1.25rem 1.5rem 2rem; max-width: 72rem; }
code { font-family: var(--font-mono); font-size: 0.85em; }
.muted { color: var(--muted-foreground); }
.num { font-variant-numeric: tabular-nums; }
.right { text-align: right; }
.page-body a { color: var(--accent); text-underline-offset: 2px; }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; margin: 0; }
.kpi { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.9rem 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.kpi dt { font-size: 0.8rem; color: var(--muted-foreground); }
.kpi dd { margin: 0; }
.kpi-value { font-size: 1.75rem; font-weight: 600; line-height: 2rem; }
.kpi-sub { font-size: 0.78rem; color: var(--muted-foreground); }

.portlet { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.portlet-head { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel); }
.portlet-head h2 { margin: 0; font-size: 0.95rem; font-weight: 600; }
.portlet-body { padding: 1rem; }
.portlet-note { margin: 0 0 0.75rem; color: var(--muted-foreground); font-size: 0.875rem; }

.table-wrap { overflow-x: auto; }
.table-wrap table, .variables-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.table-wrap th, .variables-table th { text-align: left; padding: 0.5rem 0.75rem; font-weight: 500; font-size: 0.78rem; color: var(--muted-foreground); border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
.table-wrap td, .variables-table td { padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.table-wrap tbody tr:hover { background: var(--panel); }
.table-wrap th.right, .table-wrap td.right { text-align: right; }

.badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 500; background: var(--panel-hover); color: var(--foreground); }
.badge.ok { background: var(--success-soft); color: var(--success); }
.badge.warn { background: var(--warning-soft); color: var(--warning); }
.badge.error { background: var(--danger-soft); color: var(--danger); }

.notice { padding: 0.75rem 1rem; border: 1px solid var(--warning); border-radius: var(--radius); background: var(--warning-soft); font-size: 0.9rem; }
.notice.error { border-color: var(--danger); background: var(--danger-soft); color: var(--danger-soft-foreground); }
.notice.ok { border-color: var(--success); background: var(--success-soft); }
.notice strong { display: block; margin-bottom: 0.15rem; }

.btn { display: inline-flex; align-items: center; justify-content: center; height: 2.25rem; padding: 0 0.9rem; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--foreground); font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; transition: background var(--duration-fast); }
.btn:hover { background: var(--accent-soft); }
.page-body a.btn, .page-bar a.btn { color: var(--foreground); }
.btn.primary, .page-body a.btn.primary, .page-bar a.btn.primary { border-color: transparent; background: var(--accent); color: var(--accent-foreground); }
.btn.primary:hover { background: var(--accent-hover); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }

.form { display: flex; flex-direction: column; gap: 1rem; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 0.9rem 1rem; }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field.wide { grid-column: 1 / -1; }
.field-label, .field label { font-size: 0.85rem; font-weight: 500; }
.field-help { font-size: 0.78rem; color: var(--muted-foreground); }
.field-error { font-size: 0.8rem; color: var(--danger); }
.required { color: var(--danger); margin-left: 0.15rem; }
.form-section-title { margin: 0.5rem 0 0; font-size: 0.95rem; font-weight: 600; }
.form-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.input, .form select, .form textarea { width: 100%; padding: 0.5rem 0.7rem; border: 1px solid var(--border-strong); border-radius: calc(var(--radius) - 0.125rem); background: var(--surface); color: var(--foreground); font: inherit; font-size: 0.9rem; outline: none; }
.input:focus-visible, .form select:focus-visible, .form textarea:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
.input.code, .code { font-family: var(--font-mono); font-size: 0.82rem; }
textarea.input { min-height: 8rem; resize: vertical; }

.details { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.9rem; background: var(--surface); }
.details summary { cursor: pointer; font-weight: 500; }
.variables { margin: 0.5rem 0 0; }
.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; list-style: none; margin: 0; padding: 0; }
.chip { padding: 0.15rem 0.6rem; border-radius: 999px; background: var(--accent-soft); color: var(--accent-soft-foreground); font-family: var(--font-mono); font-size: 0.78rem; }
`;
