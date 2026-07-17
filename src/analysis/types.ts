export interface ResourceEffect {
  acquire?: string[];
  release?: string[];
}

export interface ResourceAnalysisOptions {
  effects: Record<string, ResourceEffect>;
  initialResources?: string[];
  terminalStates?: string[];
  maxConfigurations?: number;
}

export interface ResourceIssue {
  kind: "leak" | "invalid-release" | "unbounded";
  resource?: string;
  state: string;
  path: string[];
  message: string;
}

export interface ResourceAnalysisResult {
  valid: boolean;
  issues: ResourceIssue[];
  configurationsExplored: number;
}
