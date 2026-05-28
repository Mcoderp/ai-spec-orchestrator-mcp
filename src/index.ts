import { promises as fs } from "node:fs";
import path from "node:path";
import slugify from "slugify";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type JiraIssueSummary = {
  key: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  acceptanceCriteria: string[];
};

const REQUIRED_SPEC_FILES = [
  "feature.yaml",
  "workflows.yaml",
  "api.openapi.yaml",
  "data-models.json",
  "architecture.md",
  "decisions.md",
  "examples/request.json",
  "examples/response.json",
  "examples/failure.json",
];

const FEATURE_KEYS = [
  "feature",
  "business_context",
  "functional_requirements",
  "user_flows",
  "validations",
  "edge_cases",
  "dependencies",
  "analytics",
  "security",
  "non_functional",
];

const BootstrapInput = z.object({
  ticketKey: z.string().min(2),
  repoPath: z.string().min(1),
  featureSlug: z.string().optional(),
  specsRoot: z.string().optional().default("docs/specs"),
  includeOwnershipUpdate: z.boolean().optional().default(true),
  ownershipFilePath: z.string().optional().default("docs/specs/spec_ownership.yaml"),
});

const ValidateInput = z.object({
  specPath: z.string().min(1),
});

const ChecklistInput = z.object({
  specPath: z.string().min(1),
});

const OwnershipInput = z.object({
  repoPath: z.string().min(1),
  featureSlug: z.string().min(2),
  codePaths: z.array(z.string()).min(1),
  ownershipFilePath: z.string().optional().default("docs/specs/spec_ownership.yaml"),
});

const server = new Server(
  {
    name: "ai-spec-orchestrator-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bootstrap_spec_from_jira",
      description:
        "Create or update an AI-native spec package from Jira ticket context.",
      inputSchema: {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira issue key (e.g., PROJ-123)" },
          repoPath: { type: "string", description: "Repository absolute path" },
          featureSlug: {
            type: "string",
            description: "Optional feature slug; derived from Jira summary if omitted",
          },
          specsRoot: {
            type: "string",
            description: "Specs root relative to repoPath (default: docs/specs)",
          },
          includeOwnershipUpdate: {
            type: "boolean",
            description: "Append/update ownership mapping entry",
            default: true,
          },
          ownershipFilePath: {
            type: "string",
            description: "Ownership file relative to repoPath",
            default: "docs/specs/spec_ownership.yaml",
          },
        },
        required: ["ticketKey", "repoPath"],
        additionalProperties: false,
      },
    },
    {
      name: "validate_spec_package",
      description: "Validate required files and minimum structure for a spec package.",
      inputSchema: {
        type: "object",
        properties: {
          specPath: {
            type: "string",
            description: "Absolute or relative path to spec package directory",
          },
        },
        required: ["specPath"],
        additionalProperties: false,
      },
    },
    {
      name: "generate_review_checklist",
      description:
        "Generate a pull-request review checklist from an existing spec package.",
      inputSchema: {
        type: "object",
        properties: {
          specPath: {
            type: "string",
            description: "Absolute or relative path to spec package directory",
          },
        },
        required: ["specPath"],
        additionalProperties: false,
      },
    },
    {
      name: "update_spec_ownership",
      description:
        "Append/update docs/specs/spec_ownership.yaml mapping for feature code paths.",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository absolute path" },
          featureSlug: { type: "string", description: "Feature slug directory under docs/specs" },
          codePaths: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns for code ownership mapping",
          },
          ownershipFilePath: {
            type: "string",
            description: "Ownership file relative to repoPath",
            default: "docs/specs/spec_ownership.yaml",
          },
        },
        required: ["repoPath", "featureSlug", "codePaths"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: rawArguments } = request.params;
    switch (name) {
      case "bootstrap_spec_from_jira": {
        const args = BootstrapInput.parse(rawArguments ?? {});
        const result = await bootstrapSpecFromJira(args);
        return textResult(result);
      }
      case "validate_spec_package": {
        const args = ValidateInput.parse(rawArguments ?? {});
        const result = await validateSpecPackage(args.specPath);
        return textResult(result);
      }
      case "generate_review_checklist": {
        const args = ChecklistInput.parse(rawArguments ?? {});
        const result = await generateReviewChecklist(args.specPath);
        return textResult(result);
      }
      case "update_spec_ownership": {
        const args = OwnershipInput.parse(rawArguments ?? {});
        const result = await updateSpecOwnership(args);
        return textResult(result);
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Tool execution failed: ${message}`, true);
  }
});

async function bootstrapSpecFromJira(args: z.infer<typeof BootstrapInput>): Promise<string> {
  const repoPath = path.resolve(args.repoPath);
  const jiraIssue = await fetchJiraIssue(args.ticketKey);
  const inferredSlug = slugify(jiraIssue.summary || args.ticketKey, {
    lower: true,
    strict: true,
    trim: true,
  });
  const featureSlug = args.featureSlug || inferredSlug || args.ticketKey.toLowerCase();
  const specDir = path.join(repoPath, args.specsRoot, featureSlug);
  await fs.mkdir(path.join(specDir, "examples"), { recursive: true });

  const fileMap: Record<string, string> = {
    "feature.yaml": renderFeatureYaml(jiraIssue, featureSlug),
    "workflows.yaml": renderWorkflowsYaml(featureSlug),
    "api.openapi.yaml": renderOpenApiYaml(featureSlug),
    "data-models.json": renderDataModelsJson(featureSlug),
    "architecture.md": renderArchitectureMd(jiraIssue, featureSlug),
    "decisions.md": renderDecisionsMd(jiraIssue),
    "examples/request.json": JSON.stringify({ example: "request payload", ticket: args.ticketKey }, null, 2),
    "examples/response.json": JSON.stringify({ example: "success response", status: "OK" }, null, 2),
    "examples/failure.json": JSON.stringify(
      { example: "failure response", errorCode: "VALIDATION_FAILED", ticket: args.ticketKey },
      null,
      2,
    ),
  };

  for (const [relativeFile, content] of Object.entries(fileMap)) {
    const target = path.join(specDir, relativeFile);
    await writeIfMissing(target, content);
  }

  let ownershipMessage = "Ownership update skipped.";
  if (args.includeOwnershipUpdate) {
    ownershipMessage = await updateSpecOwnership({
      repoPath,
      featureSlug,
      codePaths: [`lib/**/${featureSlug}*`, `test/**/${featureSlug}*`],
      ownershipFilePath: args.ownershipFilePath,
    });
  }

  return [
    `Spec package ready: ${specDir}`,
    `Ticket: ${jiraIssue.key}`,
    `Summary: ${jiraIssue.summary || "(not found; used fallback context)"}`,
    ownershipMessage,
  ].join("\n");
}

async function validateSpecPackage(specPathInput: string): Promise<string> {
  const specPath = path.resolve(specPathInput);
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const rel of REQUIRED_SPEC_FILES) {
    const target = path.join(specPath, rel);
    if (!(await exists(target))) {
      missing.push(rel);
    }
  }

  const featureYamlPath = path.join(specPath, "feature.yaml");
  if (await exists(featureYamlPath)) {
    const content = await fs.readFile(featureYamlPath, "utf8");
    for (const key of FEATURE_KEYS) {
      if (!new RegExp(`^${key}\\s*:`, "m").test(content)) {
        warnings.push(`feature.yaml missing key: ${key}`);
      }
    }
  }

  const workflowsPath = path.join(specPath, "workflows.yaml");
  if (await exists(workflowsPath)) {
    const content = (await fs.readFile(workflowsPath, "utf8")).toLowerCase();
    if (!content.includes("states:")) warnings.push("workflows.yaml missing states section");
    if (!content.includes("transitions:")) warnings.push("workflows.yaml missing transitions section");
  }

  const lines: string[] = [];
  if (missing.length === 0 && warnings.length === 0) {
    lines.push(`Validation passed for: ${specPath}`);
  } else {
    lines.push(`Validation result for: ${specPath}`);
    if (missing.length > 0) {
      lines.push("Missing files:");
      lines.push(...missing.map((item) => `- ${item}`));
    }
    if (warnings.length > 0) {
      lines.push("Warnings:");
      lines.push(...warnings.map((item) => `- ${item}`));
    }
  }
  return lines.join("\n");
}

async function generateReviewChecklist(specPathInput: string): Promise<string> {
  const specPath = path.resolve(specPathInput);
  const validation = await validateSpecPackage(specPath);
  const checklist = [
    `## Spec Review Checklist`,
    ``,
    `Spec path: \`${specPath}\``,
    ``,
    `### Intent and Scope`,
    `- [ ] \`feature.yaml\` has clear problem, outcome, and measurable success metrics`,
    `- [ ] Functional requirements and user flows match Jira acceptance criteria`,
    `- [ ] Edge cases and non-functional constraints are explicit`,
    ``,
    `### Behavior and Contracts`,
    `- [ ] \`workflows.yaml\` contains states and transitions for every flow`,
    `- [ ] \`api.openapi.yaml\` matches current/expected service contract`,
    `- [ ] \`data-models.json\` aligns with API schemas and validation rules`,
    ``,
    `### Governance`,
    `- [ ] \`decisions.md\` includes recent dated decision update`,
    `- [ ] \`examples/\` includes request, success response, and failure response`,
    `- [ ] Ownership mapping in \`docs/specs/spec_ownership.yaml\` reflects touched code paths`,
    ``,
    `### Validator Output`,
    "```",
    validation,
    "```",
  ];
  return checklist.join("\n");
}

async function updateSpecOwnership(args: z.infer<typeof OwnershipInput>): Promise<string> {
  const repoPath = path.resolve(args.repoPath);
  const ownershipPath = path.join(repoPath, args.ownershipFilePath);
  const specTarget = `docs/specs/${args.featureSlug}`;
  const ruleName = `feature-${args.featureSlug}`;

  let content = "";
  if (await exists(ownershipPath)) {
    content = await fs.readFile(ownershipPath, "utf8");
  } else {
    await fs.mkdir(path.dirname(ownershipPath), { recursive: true });
    content = ["bypass:", "code_paths:", "  - \"lib/**\"", "rules:"].join("\n");
  }

  if (content.includes(`- name: ${ruleName}`) || content.includes(`- "${specTarget}"`)) {
    return `Ownership already contains mapping for ${args.featureSlug}.`;
  }

  const block = [
    "",
    `  - name: ${ruleName}`,
    "    paths:",
    ...args.codePaths.map((pattern) => `      - \"${pattern}\"`),
    "    specs:",
    `      - \"${specTarget}\"`,
    "",
  ].join("\n");

  const next = content.endsWith("\n") ? `${content}${block}` : `${content}\n${block}`;
  await fs.writeFile(ownershipPath, next, "utf8");
  return `Added ownership mapping in ${ownershipPath} for ${args.featureSlug}.`;
}

async function fetchJiraIssue(ticketKey: string): Promise<JiraIssueSummary> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !token) {
    return {
      key: ticketKey,
      summary: ticketKey,
      description:
        "Jira credentials were not configured. Fill this spec manually from ticket context.",
      status: "unknown",
      issueType: "unknown",
      acceptanceCriteria: [],
    };
  }

  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(
    ticketKey,
  )}?fields=summary,description,status,issuetype`;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Jira issue lookup failed (${response.status} ${response.statusText})`);
  }

  const payload = (await response.json()) as any;
  const fields = payload.fields ?? {};
  return {
    key: payload.key ?? ticketKey,
    summary: String(fields.summary ?? ticketKey),
    description: extractDescription(fields.description),
    status: String(fields.status?.name ?? "unknown"),
    issueType: String(fields.issuetype?.name ?? "unknown"),
    acceptanceCriteria: [],
  };
}

function extractDescription(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const textChunks: string[] = [];

  const walk = (node: any): void => {
    if (!node) return;
    if (typeof node.text === "string") textChunks.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(value);
  return textChunks.join(" ").replace(/\s+/g, " ").trim();
}

function renderFeatureYaml(issue: JiraIssueSummary, featureSlug: string): string {
  return `feature:
  id: ${featureSlug}
  name: "${issue.summary.replace(/"/g, "'")}"
  status: draft
  jira_ticket: ${issue.key}

business_context:
  problem: >
    ${issue.description || "Describe the business problem from Jira context."}
  desired_outcome: >
    Define measurable outcome for this feature.
  success_metrics:
    - metric_1

personas:
  - primary_user

functional_requirements:
  - requirement_1

user_flows:
  - primary_flow

validations:
  - validation_rule_1

edge_cases:
  - edge_case_1

dependencies:
  - dependency_1

analytics:
  events:
    - event_started
    - event_completed

security:
  auth_required: true
  pii:
    - pii_field_or_none

non_functional:
  latency: "<target>"
  availability: "<target>"
`;
}

function renderWorkflowsYaml(featureSlug: string): string {
  return `workflow:
  ${featureSlug}_flow:
    description: Primary workflow for ${featureSlug}
    states:
      - CREATED
      - IN_PROGRESS
      - COMPLETED
      - FAILED
    transitions:
      - CREATED -> IN_PROGRESS
      - IN_PROGRESS -> COMPLETED
      - IN_PROGRESS -> FAILED
`;
}

function renderOpenApiYaml(featureSlug: string): string {
  return `openapi: 3.0.3
info:
  title: "${featureSlug} API"
  version: 1.0.0
paths:
  /${featureSlug}:
    post:
      summary: Execute ${featureSlug}
      operationId: run${toPascalCase(featureSlug)}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RequestModel'
      responses:
        "200":
          description: Success
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ResponseModel'
components:
  schemas:
    RequestModel:
      type: object
      properties:
        id:
          type: string
      required:
        - id
    ResponseModel:
      type: object
      properties:
        status:
          type: string
      required:
        - status
`;
}

function renderDataModelsJson(featureSlug: string): string {
  return JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: `${featureSlug} data models`,
      type: "object",
      definitions: {
        RequestModel: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        ResponseModel: {
          type: "object",
          properties: {
            status: { type: "string" },
            message: { type: "string" },
          },
          required: ["status"],
        },
      },
    },
    null,
    2,
  );
}

function renderArchitectureMd(issue: JiraIssueSummary, featureSlug: string): string {
  return `# Architecture

## Context

- Jira ticket: ${issue.key}
- Issue type: ${issue.issueType}
- Current status: ${issue.status}

## Domain overview

Describe how ${featureSlug} fits into the product domain.

## Service boundaries

- Service A owns:
- Service B owns:

## Constraints

- Security:
- Latency:
- Scale:
`;
}

function renderDecisionsMd(issue: JiraIssueSummary): string {
  const today = new Date().toISOString().slice(0, 10);
  return `# Decisions (ADR-style)

## ${today} ADR-001: Initial spec scaffold from Jira ${issue.key}

### Context
Create baseline spec package from Jira ticket context.

### Decision
Adopt structured-first spec package for implementation.

### Rationale
Improves traceability, deterministic contracts, and AI-assisted delivery quality.

### Alternatives considered
- Keep prose-only markdown spec
- Delay spec until after implementation

### Impact
- Better review clarity
- Easier onboarding
- Fewer requirement mismatches
`;
}

async function writeIfMissing(targetPath: string, content: string): Promise<void> {
  if (await exists(targetPath)) return;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start ai-spec-orchestrator-mcp:", error);
  process.exit(1);
});
