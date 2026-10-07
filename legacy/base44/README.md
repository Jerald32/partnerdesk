# Archived Base44 client code — not executable app code

These files were outside the `src/main.jsx` → `App.jsx` import graph before
archiving. They are preserved for reference only, outside `src`, and are not
routes, build inputs, or supported entry points. Do not import them into the app.
Their old aliases and SDK dependencies are deliberately not restored.

Archived features include old registration/password recovery/MFA/email screens,
the OAuth consent page, old account/profile upload forms, old settings managers,
audit backup/download, and replaced audit/user-request helpers. The Base44 SDK,
Vite plugin and their injected analytics/navigation agents have been removed.
Vite now provides the native `@` → `src` alias.

Current equivalents live in `src/pages` and use the shared Supabase client,
app-session headers, RLS and validated server RPCs. Registration and recovery
remain unavailable routes; no old Auth flow is silently re-enabled.

The repository's `base44/` server/entity definitions and historical migration
`legacy_base44_id` columns are reference/import artifacts, not active app APIs.
Preserving them does not enable legacy code or migrate historical records/files.
