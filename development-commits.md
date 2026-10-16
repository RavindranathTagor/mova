# Development commit plan

The project starts from the current MOVA prototype. The entries below are a work queue for the next development phase, not a claim that the work is already done. Each entry is intended to become one focused commit. The three developers can work independently on separate entries, then share their commits or patches with the project owner before integrating them.

Each developer owns eight commits, for 24 planned commits total. Keep the listed order within a workstream where entries depend on earlier work. Coordinate shared files such as `server/index.mjs`, `server/store.mjs`, and `src/App.tsx` before parallel edits.

## Developer 1 — Core and reliability

1. `fix: validate required environment settings at startup` — identify invalid or missing configuration early and print actionable setup guidance.
2. `fix: bound provider requests and handle timeouts consistently` — make cancellation, timeout, and retry behavior predictable across configured model providers.
3. `feat: add structured request logging` — add request IDs and consistent server-side error records without logging credentials or private payloads.
4. `fix: make checkpoint writes crash-safe` — write state atomically and handle interrupted or malformed checkpoint files.
5. `feat: expose backend readiness checks` — report application and FalkorDB readiness separately for local operations.
6. `fix: reject malformed mission input at API boundaries` — validate user-controlled request bodies and return consistent client errors.
7. `feat: add configurable retention for local execution history` — bound local checkpoint growth while preserving active missions.
8. `docs: document local backup and recovery steps` — explain checkpoint backup, restore, and recovery limitations.

## Developer 2 — Interface and accessibility

9. `fix: improve narrow-screen workspace layout` — keep mission controls and status readable on small screens.
10. `feat: add clear loading and empty states to mission views` — explain what is loading and what the user can do next.
11. `fix: make mission status changes accessible` — announce meaningful status updates to assistive technology.
12. `feat: add keyboard navigation for graph inspection` — support selecting and inspecting graph items without a pointer.
13. `fix: preserve workspace context after refresh` — restore the selected mission and view when the page reloads.
14. `feat: add copy actions for evidence and execution details` — make visible mission details easy to copy for review.
15. `fix: clarify connection checks and permission errors` — distinguish unavailable services, denied access, and missing setup.
16. `docs: add interface walkthrough for first-time contributors` — describe the main workspace views and their state flow.

## Developer 3 — Integrations and verification

17. `fix: normalize connector failures into actionable results` — give callers a consistent error shape without hiding provider details.
18. `feat: add connector health summary endpoint` — provide a compact summary for configured integration checks.
19. `fix: handle expired integration credentials cleanly` — surface reauthorization guidance and avoid repeated failing calls.
20. `feat: add integration request audit metadata` — record source, timestamp, and outcome for connector operations.
21. `test: cover mission approval and rejection boundaries` — add focused cases for actions that require user approval.
22. `test: cover connector timeout and partial failure paths` — exercise failure handling using local test doubles.
23. `test: add API contract checks for mission endpoints` — verify request validation and response shapes.
24. `docs: document repeatable integration verification` — record local prerequisites and safe steps for checking each connector.

## Working agreement

- Make one commit per completed entry and keep the commit limited to that change.
- Use the commit subject shown above, or adjust it to match the final implementation.
- Add or update focused tests when changing behavior; run the relevant existing checks before handing off.
- Do not include `.env`, `.data/`, build output, dependency folders, or machine-specific editor files in shared commits or ZIP archives.
- Before integrating parallel work, check for overlapping edits and resolve them with the relevant developer.
