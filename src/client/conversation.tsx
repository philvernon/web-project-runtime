"use client";

// Owner-directed extraction of Dolebot-derived conversation/transcript behavior.
// No transport, domain policy or authority is owned by this controlled view.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChatComposer, type ComposerLabels } from "./chat-composer.js";
import { ChatMessage, AssistantMarkdown } from "./chat-message.js";

export type ConversationExchange = {
  id: string;
  message: string;
  text?: string;
  status:
    | "pending"
    | "received"
    | "stopped_waiting"
    | "transport_unconfirmed"
    | "rejected";
  completion?: string;
  /** Observed work, not estimated percentages. */
  progress?: string;
};
export type ConversationProps = {
  exchanges: readonly ConversationExchange[];
  submitMessage: (message: string) => void | Promise<unknown>;
  stopWaiting: () => void;
  waiting: boolean;
  canSubmit: boolean;
  label?: string;
  heading?: ReactNode;
  assistantLabel?: string;
  introduction?: string;
  starters?: { category: string; text: string }[];
  children?: ReactNode;
  /** Compiled, trusted presentation artwork; never model-authored markup. */
  welcomeArtwork?: ReactNode;
  /** Trusted host UI attached to the matching observed exchange. */
  renderResult?: (exchangeId: string) => ReactNode;
  labels?: ComposerLabels;
  /** Optional observed status supplied by the host (for example, reset failure). */
  status?: string;
};

export function Conversation({
  exchanges,
  submitMessage,
  stopWaiting,
  waiting: pending,
  canSubmit,
  label = "Conversation",
  heading,
  assistantLabel = "Assistant",
  introduction = "Describe a web experience to build, or ask a question before getting started.",
  starters = [],
  children,
  welcomeArtwork,
  renderResult,
  labels,
  status: observedStatus,
}: ConversationProps) {
  const id = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const thread = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState("");
  const status =
    observedStatus ??
    (pending
      ? (exchanges.at(-1)?.progress ??
        "Sending message. Waiting for a response.")
      : (exchanges.at(-1)?.completion ?? "Ready."));

  // Original transcript scrolling, scoped to this conversation only.
  useEffect(() => {
    if (exchanges.length > 0 && thread.current)
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [exchanges]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await sendText(draft);
  }
  async function sendText(text: string) {
    if (!canSubmit || pending || composing.current) return;
    const message = text.trim();
    if (!message || message.length > 2000) {
      setInputError("Enter a message of 1–2,000 characters.");
      composer.current?.focus();
      return;
    }
    setInputError("");
    setDraft("");
    composer.current?.focus();
    try {
      await submitMessage(message);
    } catch {
      // Never surface a transport/provider exception through the browser UI.
      setInputError("The message could not be sent. Please try again.");
    }
  }
  function cancel() {
    stopWaiting();
    composer.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return;
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section
      className="conversation"
      data-wpr-ui=""
      aria-label={label}
      data-has-exchanges={exchanges.length > 0}
    >
      <section
        className="thread"
        ref={thread}
        tabIndex={0}
        aria-label="Conversation transcript"
      >
        <div className="conversation-content">
          <div className="conversation-introduction">
            {exchanges.length === 0 && welcomeArtwork}
            <h1 id={`${id}-heading`}>{heading ?? label}</h1>
            {exchanges.length === 0 && <p>{introduction}</p>}
          </div>
          {exchanges.length === 0 && starters.length > 0 && (
            <section
              className="conversation-starters"
              aria-label="Getting started"
            >
              <h2 className="wpr-sr-only">Start with a question</h2>
              <ul>
                {starters.map((starter) => (
                  <li key={starter.text}>
                    <button
                      type="button"
                      disabled={!canSubmit || pending}
                      onClick={() => void sendText(starter.text)}
                    >
                      <span className="starter-category" aria-hidden="true">
                        {starter.category}
                      </span>
                      <span>{starter.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
            aria-relevant="additions"
            aria-busy={pending}
            className="conversation-messages"
          >
            {exchanges.map((exchange, index) => (
              <article
                key={exchange.id}
                aria-label={`Exchange ${index + 1}`}
                data-exchange-id={exchange.id}
              >
                <ChatMessage role="user" text={exchange.message} />
                <ChatMessage role="assistant" author={assistantLabel}>
                  {exchange.status === "pending" && (
                    <p className="conversation-progress">
                      {exchange.progress ?? "Waiting for response…"}
                    </p>
                  )}
                  {exchange.status !== "pending" && exchange.completion && (
                    <p
                      className="notice"
                      role={
                        exchange.status === "rejected" ? "alert" : undefined
                      }
                    >
                      {exchange.completion}
                    </p>
                  )}
                  {exchange.text !== undefined && (
                    <AssistantMarkdown text={exchange.text} />
                  )}
                  {renderResult?.(exchange.id)}
                </ChatMessage>
              </article>
            ))}
          </section>
          {children}
        </div>
      </section>
      <ChatComposer
        id={id}
        draft={draft}
        setDraft={setDraft}
        busy={pending}
        canSubmit={canSubmit}
        chatInput={composer}
        composing={composing}
        submit={submit}
        keyDown={keyDown}
        cancel={cancel}
        status={status}
        inputError={inputError}
        labels={labels}
      />
    </section>
  );
}
