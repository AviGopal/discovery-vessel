# discovery-vessel git hooks

Versioned git hooks for the discovery-vessel (vessel capability registry for the metabob system). Installed by running:

```bash
scripts/git-hooks/install.sh
```

This sets `core.hooksPath` to `scripts/git-hooks/` so updates land via `git pull`. Same pattern as the `metabob-devbob` super-repo and the deployment repo.

## Philosophy

discovery-vessel is a small TS/Bun service: HTTP server that vessels register against, advertising shapes and resolver contracts. Source lives in `src/`, tests in `test/`, ops tooling in `scripts/`, stateless reference docs in `docs/`. The vessel root holds project metadata plus `index.ts` (the HTTP server entry point).

Anything else accumulates as cruft. The pre-commit hook rejects new cruft at commit time. Existing files are grandfathered.

## Where things go

| You have | Put it in |
|---|---|
| Stateless reference doc | `docs/<topic>.md` |
| One-off operational script | `scripts/<verb>-<noun>.sh` |
| Source code | `src/...` |
| Tests | `test/...` |
| Status snapshot, fix-complete narrative, registry-investigation note | nowhere — write a commit message instead |

## What the hook blocks

A commit is rejected when it adds (or renames into) a file that violates any of these rules:

1. **Files at the vessel root** are limited to a small allowlist (`CLAUDE.md`, `README.md`, `CHANGELOG.md`, `index.ts`, `package.json`, `tsconfig.json`, `bun.lock`, `Dockerfile`, `.dockerignore`, dotfile configs).
2. **No new top-level markdown** outside `docs/`.
3. **No new TypeScript files at root** other than `index.ts`. Source goes in `src/`.
4. **No new test files at root**. Tests live in `test/` or `tests/`.
5. **No new ad-hoc scripts at root** (`*.sh`, `*.js`, `*.py`). Operational scripts go in `scripts/`.
6. **No new image / video / archive files** outside `docs/assets/`.
7. **New top-level directories** outside the allowed set (`src`, `test`, `tests`, `docs`, `scripts`, `packages`, `cli`, `bin`, `.github`, `.minibob`) are rejected.

## Bypass

```bash
git commit --no-verify
```

Use sparingly.

## Related

- The super-repo (`metabob-devbob`) has a parallel hook at `scripts/git-hooks/pre-commit`.
- The deployment repo has the same pattern under its own `scripts/git-hooks/`.
