interface WebMcpToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
}

interface WebMcpModelContext {
  registerTool: (definition: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => Promise<void>;
}

interface Document {
  modelContext?: WebMcpModelContext;
}
