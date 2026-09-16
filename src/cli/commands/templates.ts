import { okResult, type CommandResult } from "../envelope.js";

export interface TemplateInfo {
  id: string;
  required_inputs: string[];
  limitations: string;
}

const TEMPLATES: TemplateInfo[] = [
  {
    id: "fixture-transfers",
    required_inputs: [],
    limitations: "dataset-only fixture; no RPC; no ingest",
  },
  {
    id: "ingest-transfers",
    required_inputs: ["RPC_URL (archive-capable Ethereum JSON-RPC)", "Docker for compose"],
    limitations:
      "one chain, explicit addresses, pinned end block; rindexer image is linux/amd64",
  },
];

export function listTemplates(): TemplateInfo[] {
  return TEMPLATES.map((t) => ({ ...t, required_inputs: [...t.required_inputs] }));
}

export function templatesList(): CommandResult<{ templates: TemplateInfo[] }> {
  return okResult("templates list", { templates: listTemplates() });
}
