import type { StateMachineDefinition } from "../types.js";
import { normalizeTransitions, referenceName } from "../validation.js";
import type { ResourceAnalysisOptions, ResourceAnalysisResult, ResourceIssue } from "./types.js";

interface Configuration { state: string; resources: Set<string>; path: string[] }

export function analyzeResourceClosure(
  definition: StateMachineDefinition,
  options: ResourceAnalysisOptions,
): ResourceAnalysisResult {
  const limit = options.maxConfigurations ?? 10_000;
  const terminalStates = new Set(options.terminalStates ?? Object.entries(definition.states).filter(([, s]) => s.final).map(([name]) => name));
  const initial: Configuration = { state: definition.initial, resources: new Set(options.initialResources), path: [definition.initial] };
  applyActions(initial, definition.states[definition.initial]?.entry?.map(referenceName) ?? [], options, []);
  const queue = [initial];
  const seen = new Set<string>();
  const issues: ResourceIssue[] = [];

  while (queue.length > 0 && seen.size < limit) {
    const current = queue.shift()!;
    const key = configurationKey(current);
    if (seen.has(key)) continue;
    seen.add(key);
    if (terminalStates.has(current.state) && current.resources.size > 0) {
      for (const resource of current.resources) issues.push({ kind: "leak", resource, state: current.state, path: current.path, message: `Resource '${resource}' remains acquired at terminal state '${current.state}'` });
    }

    const state = definition.states[current.state];
    for (const [event, value] of Object.entries(state?.on ?? {})) {
      for (const transition of normalizeTransitions(value)) {
        const next: Configuration = { state: transition.target, resources: new Set(current.resources), path: [...current.path, `${event} -> ${transition.target}`] };
        applyActions(next, state?.exit?.map(referenceName) ?? [], options, issues);
        applyActions(next, transition.actions?.map(referenceName) ?? [], options, issues);
        applyActions(next, definition.states[transition.target]?.entry?.map(referenceName) ?? [], options, issues);
        queue.push(next);
      }
    }
  }
  if (queue.length > 0) issues.push({ kind: "unbounded", state: queue[0]!.state, path: queue[0]!.path, message: `Analysis exceeded ${limit} unique configurations` });
  return { valid: issues.length === 0, issues: deduplicate(issues), configurationsExplored: seen.size };
}

function applyActions(configuration: Configuration, actions: string[], options: ResourceAnalysisOptions, issues: ResourceIssue[]): void {
  for (const action of actions) {
    const effect = options.effects[action];
    if (!effect) continue;
    for (const resource of effect.acquire ?? []) configuration.resources.add(resource);
    for (const resource of effect.release ?? []) {
      if (!configuration.resources.delete(resource)) issues.push({ kind: "invalid-release", resource, state: configuration.state, path: configuration.path, message: `Action '${action}' releases '${resource}' when it is not acquired` });
    }
  }
}

function configurationKey(value: Configuration): string { return `${value.state}|${[...value.resources].sort().join(",")}`; }
function deduplicate(issues: ResourceIssue[]): ResourceIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => { const key = `${issue.kind}|${issue.resource ?? ""}|${issue.state}|${issue.path.join("|")}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
