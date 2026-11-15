# Contributing

## Setup

| Part | Requirement | Install |
|---|---|---|
| `dashboard/` | Node.js 20+ (22 recommended; `nvm use` reads `.nvmrc`) | `cd dashboard && npm install` |
| `pipeline/` | Python 3.9+ | nothing to install; it uses the standard library only |

## Workflow

1. Branch from `main` with a descriptive name: `feat/…`, `fix/…`, `docs/…`,
   `chore/…` or `refactor/…`.
2. Keep each pull request to one concern. Add or update tests with every
   behaviour change.
3. Run the checks locally. CI runs the same ones on every pull request and blocks
   the merge if any fail:

   ```bash
   cd dashboard && npm run check
   ```

   ```bash
   cd pipeline && python3 -W error -m unittest discover -s tests
   ```

4. Update the docs in the same pull request when behaviour, configuration or the
   API changes: `docs/api.md`, the relevant README, and `CHANGELOG.md` under
   **Unreleased**.
5. Fill in the pull request template, including how you tested the change.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional
scope such as `fix(dashboard): …`. Write the subject in the imperative and keep
it under 72 characters.

**TypeScript** (`dashboard/`)

- Prettier formats and ESLint lints. Run `npm run format` and `npm run lint:fix`
  before committing.
- Strict TypeScript, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Don't silence errors with `any` or `@ts-ignore`.
- Use relative imports with the `.js` extension (ES modules).
- Validate everything that comes in over HTTP in `normalise.ts` or `otlp.ts`,
  never in route handlers.
- The web app in `public/` has no dependencies or build step. Keep it that way
  unless there's a strong reason.

**Python** (`pipeline/`)

- Standard library only, compatible with Python 3.9: use `typing.List` /
  `Optional` in runtime annotations.
- Name thresholds as module constants instead of magic numbers.
- Tests use `unittest`.

## Releases

1. Move the **Unreleased** entries in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `dashboard/package.json`, `pipeline/pyproject.toml` and
   `pipeline/llm_obs/__init__.py`.
3. Merge to `main`, then tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`.
