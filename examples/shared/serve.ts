import { experiences } from "../experiences/config.js";
import { charts } from "../charts/config.js";
import { createExampleHost } from "./host.js";
import { configuredGateway } from "./model.js";

async function main() {
  const name = process.argv[2];
  if (name !== "experiences" && name !== "charts")
    throw Error("Usage: npm start -- experiences|charts");
  const port =
    process.env.WEB_BUILDER_PORT === undefined
      ? 0
      : Number(process.env.WEB_BUILDER_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw Error(
      "WEB_BUILDER_PORT must be an integer between 0 and 65535 (0 chooses an unused port).",
    );
  const host = await createExampleHost({
    example: name === "experiences" ? experiences : charts,
    gateway: configuredGateway(process.env),
    port,
  });
  console.log(`${name}: ${host.origin}`);
  console.log(
    "Loopback development only. Explicitly configured model calls may incur provider charges. Ctrl-C stops sessions and the host.",
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void host.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Example startup failed.",
  );
  process.exitCode = 1;
});
