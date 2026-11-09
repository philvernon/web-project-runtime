/** Server-only Pi orchestration and host-scoped builder service. Never import into a browser bundle. */
export { runConversationTurn, ConversationError } from "./pi/runner.js";
export type {
  OriginalToolCall,
  ConversationLimits,
  StreamHooks,
  ConversationTurnOptions,
} from "./pi/runner.js";
export { createPiGateway, gatewayModelCall } from "./pi/gateway.js";
export type {
  PiGatewayOptions,
  PiGateway,
  GatewayRequest,
  ModelStage,
} from "./pi/gateway.js";
export { createBuilderService } from "./pi/service.js";
export type {
  BuilderServiceOptions,
  BuilderService,
  BuilderSession,
} from "./pi/service.js";
export { handleBuilderRequest } from "./pi/http.js";

export { createGenerationTool } from "./pi/tools.js";
export type {
  BuilderToolContext,
  BuilderToolSet,
  GenerationToolOptions,
} from "./pi/tools.js";
export type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
