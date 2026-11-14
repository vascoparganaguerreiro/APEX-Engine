# APEX Engine: working rules for Claude sessions

Next.js 16 + TypeScript on Vercel, Supabase for auth and Postgres (row-level security). The production database is
shared with an older Streamlit app. The owner has asked for this project to be advanced by unattended Claude sessions
(decision D-001 in `docs/DECISIONS.md`). These rules are what make that safe; follow them exactly.

## Commands (all must pass before any push)
```
npm ci
npm run lint        # 0 errors; warnings are tracked in docs/BACKLOG.md
npm run typecheck
npm test            # Node 22+
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build
```

## Layout
- `app/` pages and API routes, `components/`, `lib/` (pure logic is unit-tested; modules imported by tests use
  relative imports with a `.ts` extension, never `@/`), `tests/` (node --test), `sql/` (migrations, run by hand by the
  owner in the Supabase SQL Editor), `docs/` (backlog, decisions, status).
- Secrets: the service-role key is read only in `lib/serverConnections.ts`; client components never import server modules.

## How work is chosen and recorded
1. `docs/BACKLOG.md` is the single queue. Take the first item under "Ready" whose blockers are met. One item per pull request.
2. Before changing code, state the evidence in the PR description: what is wrong or missing (file and line, failing
   command, or measurement), why this fix, what was verified, what was not.
3. Every non-obvious choice (a trade-off, a default, anything a reasonable owner might have decided differently) gets an
   entry in `docs/DECISIONS.md` in the same PR: context, options considered, choice, evidence, how to reverse it.
4. Update `docs/BACKLOG.md` in the same PR: move the item to "Done" with the PR link; add anything newly found, with evidence.
5. If the evidence is not there (cannot reproduce, cannot verify, depends on production data), do not guess. Move the
   item to "Needs the owner" with the exact question and stop work on it.

## Branches, CI and merging
- `main` is protected: pull request required, squash merge only, required check "Test, typecheck and build", branch
  must be up to date. Never push to `main`, never force-push, never bypass or weaken these rules or the CI workflow.
- Branch names: `auto/<backlog-id>-<slug>`. Commit messages say what and why.
- Merging to `main` deploys to production on Vercel. A session may squash-merge its own PR only when ALL hold:
  - CI is green on the PR head and the branch is up to date with `main`;
  - the change is in the **self-merge class**: docs, tests, lint or tooling, refactors with unchanged behaviour, and
    bug fixes fully covered by tests that fail before and pass after;
  - it needs nothing from the owner to work in production (no new env var, no SQL to run, no Supabase or Vercel setting).
- Everything else is opened as a PR and left for the owner, labelled in the title with `[needs owner]`, with the
  reason and the exact steps the owner must take. In particular, never self-merge changes to: `sql/`, authentication,
  row-level security, encryption or credential handling, the AI usage limits, the CI workflow or branch rules,
  dependencies' major versions, or anything that changes what users see in health or medical wording.
- At most one open `auto/` PR at a time. If one is already open, work on getting it green or answer its reviews; do not start another.

## Never
- Run SQL against any database, or ask for or handle database passwords, API keys or tokens.
- Delete user data, drop tables, columns or indexes, or write a migration that does so without `[needs owner]`.
- Disable, skip or weaken a test, a lint rule or a security check to get green.
- Send project or user details to outside services.
- Add a dependency without recording in `docs/DECISIONS.md` why existing code cannot do it.

## When to stop and report instead of acting
- CI on `main` is red, or production looks broken: do not pile changes on top; report what is failing and the smallest fix.
- Two consecutive runs made no progress on the same item: move it to "Needs the owner".
- The backlog's "Ready" list is empty: do nothing except the weekly review.
