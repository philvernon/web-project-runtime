"use client";

// Owner-directed extraction of Dolebot-derived message/Markdown presentation.
// Trusted inline host content stays caller-owned; model HTML is never mounted.
import { memo, type ReactNode, type ComponentProps } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";

export type ChatMessageProps = {
  role: "user" | "assistant";
  text?: string;
  author?: string;
  children?: ReactNode;
};

export const ChatMessage = memo(function ChatMessage({
  role,
  text,
  children,
  author = "Assistant",
}: ChatMessageProps) {
  return (
    <div className="message" data-wpr-ui="" data-role={role}>
      <h2>{role === "user" ? "You" : author}</h2>
      <div>
        {role === "assistant" && text ? (
          <AssistantMarkdown text={text} />
        ) : text ? (
          <div className="message-text">{text}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
});

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown" data-wpr-ui="">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url: string) => {
          // Keep destinations local or HTTPS; reject protocol-relative and backslash URLs.
          if (url.startsWith("//") || url.includes("\\")) return "";
          const safe = defaultUrlTransform(url);
          return /^(?:https:\/\/|\/(?!\/)|#)/i.test(safe) ? safe : "";
        }}
        components={{
          h1: "h3",
          h2: "h3",
          h3: "h3",
          h4: "h3",
          h5: "h3",
          h6: "h3",
          pre({ children }: ComponentProps<"pre">) {
            return (
              <pre tabIndex={0} role="region" aria-label="Code block">
                {children}
              </pre>
            );
          },
          a({ children, href }: ComponentProps<"a">) {
            if (!href) return <>{children}</>;
            const external = /^https:\/\//i.test(href);
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {children}
                {external && (
                  <span className="wpr-sr-only"> (opens in a new tab)</span>
                )}
              </a>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
