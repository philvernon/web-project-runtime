/** Browser-safe artifact and lifecycle contract. No server or React imports. */
export {
  BUILDER_LIMITS,
  builderRequestIdSchema,
  builderMessageSchema,
  builderCommandSchema,
  builderPhaseSchema,
  builderErrorSchema,
  builderEventSchema,
  boundBuilderHistory,
} from "./shared/builder.js";
export type {
  BuilderCommand,
  BuilderSubmit,
  BuilderPhase,
  BuilderError,
  BuilderEvent,
  BuilderEventData,
  BuilderExchange,
  BuilderSnapshot,
} from "./shared/builder.js";
export { artifactSchema } from "./shared/schemas.js";
export type { ArtifactReference } from "./shared/schemas.js";
export {
  WebProjectError,
  MAX_REQUEST_BYTES,
  MAX_SOURCE_BYTES,
  MAX_FRAME_BYTES,
  LOAD_TIMEOUT_MS,
  PLAY_TIMEOUT_MS,
  parseFrameMessage,
  hasNavigationBoundary,
} from "./shared/protocol.js";
export type {
  RuntimeFailureCode,
  RuntimeFailure,
  FrameMessage,
} from "./shared/protocol.js";

export type ArtifactPath = (id: string) => string;
/** Trusted consumer routing, never a URL chosen by generated source or model output. */
export function boundArtifactPath(id: string, route: ArtifactPath): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid artifact identity");
  const value = route(id);
  // A canonical origin-relative path only: no origin, credentials, query or fragment.
  // Comparing the exact reference again in the client binds the path to this ID.
  if (!/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(value) || !value.endsWith(`/${id}`))
    throw Error(
      "Artifact routing must bind a canonical same-origin path to its identity",
    );
  return value;
}
