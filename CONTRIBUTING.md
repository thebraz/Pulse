# Contributing

Use Node 24.19.0 and npm 11.6.4. Install with `npm ci`. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, and `npm run test:package` before proposing a change. Install Chromium once with `npx playwright install chromium`.

Keep changes focused and preserve the shared API contracts, egress policy, transactional incident/outbox processing and queue limits. Add a regression test for a confirmed defect. Tests use temporary SQLite databases and controlled network fixtures, never an operator database or real credentials.

Public engineering contracts are in `docs/specifications/`. Document changed behavior and limitations. Do not include secrets, local databases, logs or machine-specific paths in contributions. Security reports follow `SECURITY.md`.
