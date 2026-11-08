"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createWebBuilderController,
  type BuilderTransport,
  type WebBuilderController,
} from "../headless.js";
import type {
  ArtifactPath,
  BuilderPhase,
  BuilderSnapshot,
} from "../contracts.js";
import { ExperienceEmbed } from "./experience-embed.js";
import {
  Conversation,
  type ConversationExchange,
  type ConversationProps,
} from "./conversation.js";

export type UseWebBuilderOptions = Parameters<
  typeof createWebBuilderController
>[0];
export type WebBuilderState = {
  snapshot: BuilderSnapshot;
  submit: WebBuilderController["submit"];
  stop: WebBuilderController["stop"];
  reset: WebBuilderController["reset"];
};

/** Keep options.transport (and optional requestId) stable across renders.
 * The controller alone owns requests/history. Effect cleanup aborts it on unmount
 * or replacement; a microtask lease allows React StrictMode's effect replay.
 */
export function useWebBuilder({
  transport,
  requestId,
  timeoutMs,
}: UseWebBuilderOptions): WebBuilderState {
  const resource = useMemo(
    () => ({
      controller: createWebBuilderController({
        transport,
        requestId,
        timeoutMs,
      }),
      owners: 0,
    }),
    [transport, requestId, timeoutMs],
  );
  const { controller } = resource;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    resource.owners++;
    return () => {
      resource.owners--;
      queueMicrotask(() => {
        if (!resource.owners) void controller.dispose();
      });
    };
  }, [resource, controller]);
  return useMemo(
    () => ({
      snapshot,
      submit: controller.submit,
      stop: controller.stop,
      reset: controller.reset,
    }),
    [snapshot, controller],
  );
}

export type WebBuilderProps = Pick<
  ConversationProps,
  | "heading"
  | "introduction"
  | "assistantLabel"
  | "starters"
  | "label"
  | "labels"
  | "welcomeArtwork"
  | "children"
> & {
  transport: BuilderTransport;
  /** Trusted, stable function shared with the server runtime. */
  artifactPath: ArtifactPath;
  className?: string;
  resetLabel?: string;
};
const phases: Record<BuilderPhase, string> = {
  thinking: "Thinking…",
  generating: "Generating project…",
  repairing: "Repairing project…",
  compiling: "Compiling project…",
};

/** Ready-to-mount builder: streamed conversation and matching isolated artifacts. */
export function WebBuilder({
  transport,
  artifactPath,
  className,
  resetLabel = "Reset",
  ...presentation
}: WebBuilderProps) {
  const { snapshot, submit, stop, reset } = useWebBuilder({ transport });
  const exchanges: ConversationExchange[] = useMemo(
    () =>
      snapshot.exchanges.map((exchange) => ({
        id: exchange.requestId,
        message: exchange.message,
        text: exchange.text,
        status:
          exchange.status === "waiting"
            ? "pending"
            : exchange.status === "completed"
              ? "received"
              : exchange.status === "stopped"
                ? "stopped_waiting"
                : "rejected",
        progress: exchange.phase ? phases[exchange.phase] : undefined,
        completion:
          exchange.status === "error"
            ? (exchange.error?.message ??
              "The request failed. Existing results are retained.")
            : exchange.status === "stopped"
              ? "Stopped. Partial results are retained."
              : undefined,
      })),
    [snapshot.exchanges],
  );
  const status =
    snapshot.status === "resetting"
      ? "Resetting conversation…"
      : snapshot.status === "error" && !snapshot.exchanges.length
        ? "Reset failed. Please try Reset again."
        : !snapshot.canSubmit && snapshot.status === "idle"
          ? "Finishing request…"
          : undefined;
  return (
    <section
      className={`web-builder${className ? ` ${className}` : ""}`}
      data-wpr-ui=""
      aria-label="Web builder"
    >
      <div className="builder-controls">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={
            snapshot.status === "resetting" ||
            (!snapshot.exchanges.length && snapshot.status !== "error")
          }
        >
          {resetLabel}
        </button>
      </div>
      <Conversation
        {...presentation}
        heading={presentation.heading ?? "Web builder"}
        exchanges={exchanges}
        submitMessage={submit}
        stopWaiting={() => {
          void stop();
        }}
        waiting={snapshot.status === "waiting"}
        canSubmit={snapshot.canSubmit}
        status={status}
        renderResult={(id) =>
          snapshot.exchanges
            .find((exchange) => exchange.requestId === id)
            ?.artifacts.map((artifact) => (
              <div className="builder-artifact" key={artifact.id}>
                <ExperienceEmbed
                  experience={artifact}
                  artifactPath={artifactPath}
                />
              </div>
            ))
        }
      />
    </section>
  );
}
