"use client";

import { useEffect, useRef, useState } from "react";
import {
  artifactSchema,
  boundArtifactPath,
  LOAD_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PLAY_TIMEOUT_MS,
  parseFrameMessage,
  type ArtifactPath,
  type ArtifactReference,
} from "../contracts.js";

export type EmbedStatus =
  "loading" | "playing" | "complete" | "error" | "stopped";
export type ExperienceEmbedProps = {
  experience: ArtifactReference;
  /** The same trusted, stable route function used by the server runtime. */
  artifactPath: ArtifactPath;
};

/** Host must enforce frame-src blob: (not Report-Only). Never add allow-same-origin. */
export function ExperienceEmbed({
  experience,
  artifactPath,
}: ExperienceEmbedProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<EmbedStatus>("loading");
  const [seconds, setSeconds] = useState(60);
  const stopRef = useRef<() => void>(() => {});
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    const instance = crypto.randomUUID();
    const controller = new AbortController();
    let alive = true,
      loaded = false,
      ready = false;
    let blobUrl: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const dispose = () => {
      alive = false;
      controller.abort();
      clearTimeout(loadTimeout);
      clearTimeout(sessionTimeout);
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      frame.current?.removeAttribute("src");
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = undefined;
      }
    };
    const finish = (next: EmbedStatus) => {
      if (!alive) return;
      dispose();
      setUrl(null);
      setStatus(next);
    };
    const onMessage = (event: MessageEvent) => {
      if (!alive || event.source !== frame.current?.contentWindow) return;
      const message = parseFrameMessage(event.data, experience.id, instance);
      if (!message) return;
      if (message.type === "ready" && !ready) {
        ready = true;
        clearTimeout(loadTimeout);
        setStatus("playing");
      } else if (message.type === "complete" && ready) finish("complete");
      else if (message.type === "error") finish("error");
    };
    const loadTimeout = setTimeout(() => finish("error"), LOAD_TIMEOUT_MS);
    const sessionTimeout = setTimeout(() => finish("stopped"), PLAY_TIMEOUT_MS);
    stopRef.current = () => finish("stopped");
    loadRef.current = () => {
      if (!alive) return;
      if (loaded) finish("error");
      loaded = true;
    };
    setStatus("loading");
    setSeconds(60);
    setUrl(null);
    window.addEventListener("message", onMessage);
    const started = Date.now();
    timer = setInterval(() => {
      if (alive)
        setSeconds(Math.max(0, 60 - Math.floor((Date.now() - started) / 1000)));
    }, 250);

    void (async () => {
      try {
        const artifact = artifactSchema.parse(experience);
        if (artifact.frameUrl !== boundArtifactPath(artifact.id, artifactPath))
          throw Error("Invalid artifact route");
        const response = await fetch(artifact.frameUrl, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("text/html") ||
          !response.body
        )
          throw Error("Artifact unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_FRAME_BYTES) {
              await reader.cancel();
              throw Error("Artifact too large");
            }
            chunks.push(new Uint8Array(value));
          }
        } finally {
          reader.releaseLock();
        }
        if (!alive) return;
        blobUrl = URL.createObjectURL(new Blob(chunks, { type: "text/html" }));
        setUrl(`${blobUrl}#${instance}`);
      } catch {
        finish("error");
      }
    })();
    return () => {
      dispose();
      stopRef.current = () => {};
      loadRef.current = () => {};
    };
  }, [experience.id, experience.frameUrl, artifactPath, attempt]);

  const active = status === "playing" || status === "loading";
  return (
    <section aria-label={`Experience: ${experience.title}`}>
      <h3>{experience.title}</h3>
      <p role="status" aria-live="polite">
        {status === "loading"
          ? "Loading isolated experience…"
          : status === "playing"
            ? `Playing · ${seconds}s remaining`
            : status === "complete"
              ? "Experience complete!"
              : status === "error"
                ? "This experience could not run safely. Try reset or request another experience."
                : "Experience stopped."}
      </p>
      {url && active ? (
        <iframe
          ref={frame}
          onLoad={() => loadRef.current()}
          src={url}
          title={experience.title}
          sandbox="allow-scripts"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; autoplay 'none'; payment 'none'; usb 'none'; serial 'none'; bluetooth 'none'; clipboard-read 'none'; clipboard-write 'none'"
          referrerPolicy="no-referrer"
          width={640}
          height={400}
          style={{ maxWidth: "100%", border: 0 }}
        />
      ) : null}
      <p>
        Focus the experience for keyboard or pointer interaction. Generated
        content may not be accessible to screen readers.
      </p>
      <button
        type="button"
        onClick={() => stopRef.current()}
        disabled={!active}
      >
        Stop experience
      </button>{" "}
      <button
        type="button"
        onClick={() => {
          stopRef.current();
          setAttempt((value) => value + 1);
        }}
      >
        Reset experience
      </button>
      <p>
        Maximum normal session: 60 seconds. Browser-managed resource limits:
        Stop and timers cannot guarantee interruption of runaway code; closing
        the tab may be necessary. Public networking can expose your IP and
        public interaction data to external services.
      </p>
    </section>
  );
}
