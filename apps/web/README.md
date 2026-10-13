# Pulse web workspace

The Stage 3 React/TypeScript application is built by the root `npm run build` and served by the same Fastify listener as the API. Open the configured public origin after `npm start`. React Router owns navigation; one TanStack Query cache and cookie-authenticated SSE invalidate shared-schema API reads. Tailwind and shared semantic controls supply the dark-first responsive UI. D3 shape renders bounded gap-aware charts with an accessible table alternative.

Features live under src/features, shared controls under src/components, freshness under src/app/live.ts and API/session decoding under src/lib/api.ts. Browser code imports @pulse/contracts, never server infrastructure. Tokens are submitted once and never persisted in browser storage.

Run root typecheck/lint/test:e2e commands. Browser tests use actual built assets and isolated local backend/target/receiver processes. Full results and screenshots are linked from [Stage 3 report](../../docs/STAGE-3-REPORT.md). Public package installation is a Stage 4 gate.
