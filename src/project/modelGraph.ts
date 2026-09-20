import { commandError } from "../plan/errors.js";
import type { Model } from "./types.js";

export type ModelNode = Model;

export function topoSortModels(models: ModelNode[]): string[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  if (byId.size !== models.length) {
    const seen = new Set<string>();
    for (const m of models) {
      if (seen.has(m.id)) {
        throw commandError("validation", `duplicate model id: ${m.id}`, {
          resource_id: m.id,
          pointer: "/models",
        });
      }
      seen.add(m.id);
    }
  }
  for (const model of models) {
    for (const dep of model.depends_on) {
      if (!byId.has(dep)) {
        throw commandError(
          "validation",
          `model ${model.id} depends on unknown model: ${dep}`,
          { resource_id: model.id, pointer: `/models/${model.id}/depends_on` },
        );
      }
    }
  }

  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      throw commandError(
        "validation",
        `cycle in model dependencies: ${[...path, id].join(" -> ")}`,
        { resource_id: id, pointer: "/models" },
      );
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.depends_on) {
      visit(dep, [...path, id]);
    }
    state.set(id, "done");
    order.push(id);
  };
  for (const model of models) visit(model.id, []);
  return order;
}
