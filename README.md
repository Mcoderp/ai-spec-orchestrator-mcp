# AI Spec Orchestrator MCP

MCP server for AI-native feature spec orchestration.  
It helps teams bootstrap and maintain structured spec packages from Jira context.

## Features

- `bootstrap_spec_from_jira`  
  Creates `docs/specs/<feature-slug>/` with:
  - `feature.yaml`
  - `workflows.yaml`
  - `api.openapi.yaml`
  - `data-models.json`
  - `architecture.md`
  - `decisions.md`
  - `examples/request.json`, `response.json`, `failure.json`
- `validate_spec_package`  
  Checks required files and minimum schema sections.
- `generate_review_checklist`  
  Produces a markdown review checklist from spec package state.
- `update_spec_ownership`  
  Appends mapping to `docs/specs/spec_ownership.yaml`.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Build and run

```bash
npm run build
npm start
```

For local development:

```bash
npm run dev
```

## Jira integration (optional)

If you set these env vars, the bootstrap tool fetches real Jira issue context:

- `JIRA_BASE_URL` (example: `https://your-domain.atlassian.net`)
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Without these, tool still scaffolds specs with fallback placeholders.

## MCP configuration example

```json
{
  "mcpServers": {
    "ai-spec-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/ai-spec-orchestrator-mcp/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://your-domain.atlassian.net",
        "JIRA_EMAIL": "you@company.com",
        "JIRA_API_TOKEN": "your-token"
      }
    }
  }
}
```

You can also copy the ready sample file:

- `mcp.sample.json` (project root)

## Example tool call ideas

- Bootstrap from Jira:
  - `ticketKey`: `PROJ-123`
  - `repoPath`: `/path/to/repo`
- Validate package:
  - `specPath`: `/path/to/repo/docs/specs/feature-slug`
- Generate checklist:
  - `specPath`: `/path/to/repo/docs/specs/feature-slug`
- Update ownership:
  - `repoPath`: `/path/to/repo`
  - `featureSlug`: `feature-slug`
  - `codePaths`: `["lib/**/feature*","test/**/feature*"]`

