"use client";

// Owner-directed extraction of Dolebot-derived draft, focus and IME behavior.
import type { FormEvent, KeyboardEvent, RefObject } from "react";

export type ComposerLabels = {
  message?: string;
  placeholder?: string;
  send?: string;
  stop?: string;
};
export type ChatComposerProps = {
  id: string;
  draft: string;
  setDraft: (draft: string) => void;
  busy: boolean;
  canSubmit: boolean;
  chatInput: RefObject<HTMLTextAreaElement | null>;
  composing: RefObject<boolean>;
  submit: (event: FormEvent) => void | Promise<void>;
  keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  cancel: () => void;
  status: string;
  inputError: string;
  labels?: ComposerLabels;
};

export function ChatComposer({
  id,
  draft,
  setDraft,
  busy,
  canSubmit,
  chatInput,
  composing,
  submit,
  keyDown,
  cancel,
  status,
  inputError,
  labels = {},
}: ChatComposerProps) {
  return (
    <div className="chat-composer" data-wpr-ui="">
      <section className="request-status" aria-label="Request status">
        <p role="status" aria-atomic="true">
          {status}
        </p>
        {busy && (
          <button type="button" onClick={cancel}>
            {labels.stop ?? "Stop"}
          </button>
        )}
      </section>
      <form
        aria-labelledby={`${id}-label`}
        onSubmit={(event) => void submit(event)}
      >
        <label
          className="wpr-sr-only"
          id={`${id}-label`}
          htmlFor={`${id}-message`}
        >
          {labels.message ?? "Message"}
        </label>
        <p className="wpr-sr-only" id={`${id}-help`}>
          Enter to send. Shift+Enter for a new line. Maximum 2,000 characters.
        </p>
        <div className="composer-input">
          <textarea
            ref={chatInput}
            id={`${id}-message`}
            aria-describedby={`${id}-help${inputError ? ` ${id}-error` : ""}`}
            aria-invalid={inputError ? true : undefined}
            rows={2}
            maxLength={2000}
            readOnly={busy}
            placeholder={
              labels.placeholder ?? "Describe what you want to build…"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
          <button
            className="composer-send"
            type="submit"
            aria-label={labels.send ?? "Send message"}
            disabled={!draft.trim() || busy || !canSubmit}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          </button>
        </div>
        {inputError && (
          <p id={`${id}-error`} role="alert" className="input-error">
            {inputError}
          </p>
        )}
      </form>
    </div>
  );
}
