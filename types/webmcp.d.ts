interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

interface WebMcpToolExecuteCallbackOptions {
  signal: AbortSignal;
}

interface WebMcpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (input: object, options: WebMcpToolExecuteCallbackOptions) => Promise<unknown>;
}

interface WebMcpModelContext {
  registerTool: (definition: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => Promise<void>;
}

interface Document {
  modelContext?: WebMcpModelContext;
}
