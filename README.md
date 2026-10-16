# MOVA - Personal Outcome Agent

MOVA turns a request or a connected-app mention into a live mission. FalkorDB stores its evidence, provenance, dependencies, decisions, approval proposals, and the graph gate that decides which tool may run next. The application contains no demo mode or fallback graph engine.

## Slate-pad connected-data recording

Use the existing [Slate-pad repository](https://github.com/RavindranathTagor/slate-pad) for the hackathon recording. The complete, copyable preparation, team-chat, GitHub-issue, MOVA-task, FalkorDB architecture, and three-minute video script is in [the Slate-pad live demo runbook](docs/slate-pad-live-demo.md).

## Run

Requires Node.js20.18+ (22 recommended), Docker Compose, and Kiro CLI for the configured model.

```powershell
# Preserve your existing .env.
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
npm install
docker compose up -d
docker compose -f docker-compose.traccar.yml up -d
npm run dev
```

Open http://localhost:5173. Backend: http://localhost:3001. This is a local single-user prototype; it does not expose the MOVA backend publicly.

## Current integrations

MOVA reasoning uses Kiro as the configured primary model (`LLM_PROVIDER=kiro-cli`) with a no-tools CLI profile; MOVA owns tool execution through MCP. If Kiro is unavailable or times out, MOVA uses the configured Groq fallback and records that state in Connections. See [Kiro setup](docs/kiro-setup.md).

MOVA uses a self-hosted SearXNG instance for web research, GitHub for repository and discussion evidence, and Slack and Discord for allowlisted channel context. A recent `@MOVA` mention can open a graph-backed mission; any resulting reply is a proposal until the user approves it. GitHub issue and pull-request discussion replies, Slack messages, and Discord messages use the same approval gate.

TomTom and OpenStreetMap power location requests when the model classifies a task as location work. Traccar supplies phone location only when a recent valid fix exists. The map and tracking surface appears for those requests, not for general connected-data work. See [navigation](docs/navigation.md) and [Traccar setup](docs/traccar-setup.md).

Open **Connections** to check each service. Results show the last check, permission failures and setup guidance, including official console links. A populated key is not treated as a verified connection. Calendar requires configured Google OAuth; Firebase end-to-end push is not implemented.

## Supported requests

- Research public web sources and produce a cited answer or local artifact.
- Compare GitHub commits, repository context, and allowlisted GitHub issue discussion evidence; propose a discussion reply after review.
- Read allowlisted Slack or Discord channel context, investigate a new `@MOVA` mention, then propose a reply in the same channel.
- Read calendar context and current weather when configured.
- Plan and monitor a location request against an arrival deadline, show the map and tracking state, and verify arrival from fresh and accurate location evidence.

Other requested actions are blocked with an explanation. General browser automation, purchases, email sending and native MOVA apps are not implemented. The responsive web interface supports mobile browsers; Traccar Client handles native device tracking separately.

## Understand the work

The **Live execution** component shows the current stage, tool calls, streamed operation summaries, and exact Cypher traversals. The **Mission Bubble** initially focuses on the decision path; select All connections for the full bounded graph. Select nodes or edges to inspect their source, timestamp and evidence class.

FalkorDB is required for live execution. The `READY_QUERY` traversal only releases a pending tool when all dependency steps have completed with suitable evidence. A `Decision` node and `GATES` relationships make this execution policy visible. Mention events, evidence, artifacts, and external-action proposals are linked to the same mission graph. The graph is not a decorative copy of application state.

## Verification

```powershell
$env:FALKORDB_TEST_URL='redis://127.0.0.1:6380'
npm test
npm run build
```

Contract fixtures exist only in tests. They are not available as an application mode. Retired simulated mission records are archived intact in the ignored local checkpoint and hidden from the product.

See [verification results](docs/verification.md), [Track1 walkthrough](docs/track-1-walkthrough.md), [research](docs/research/falkordb-study.md), and [API setup](docs/api-setup.md).

## Storage and limits

`.env` and `.data/` are ignored by Git. Credentials stay on the backend. State is a single-process JSON checkpoint with FalkorDB mission graphs, not a transactional multi-worker workflow store. Cross-store crash recovery, durable event replay, production tenancy and token-rotation automation need additional work before deployment.
