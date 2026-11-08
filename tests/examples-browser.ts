import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createExampleHost } from "../examples/shared/host.js";
import { experiences } from "../examples/experiences/config.js";
import { charts } from "../examples/charts/config.js";
import { exampleModelFixture } from "./examples-fixture.js";

// Explicit synthetic model HTTP fixtures. These tests exercise actual Pi Agent, gateway,
// tool dispatch, generation, validation, compilation, transport and sandboxed artifacts.
// They do not perform live inference/login or establish provider acceptance.
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  for (const example of [experiences, charts]) {
    for (const size of ["desktop", "mobile"] as const) {
      await test(`synthetic ${example.id}: generate and refine on ${size}`, async () => {
        const model = await exampleModelFixture(example.id);
        const host = await createExampleHost({
          example,
          gateway: model.gateway,
        });
        const context = await browser!.newContext({
          viewport:
            size === "desktop"
              ? { width: 1280, height: 900 }
              : { width: 390, height: 844 },
          isMobile: size === "mobile",
          hasTouch: size === "mobile",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const artifactUrls: string[] = [];
        page.on("request", (request) => {
          if (request.url().startsWith(host.origin + "/artifacts/"))
            artifactUrls.push(request.url());
        });
        const unexpected: string[] = [];
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          if (/^https?:/.test(url) && !url.startsWith(host.origin + "/")) {
            unexpected.push(url);
            await route.abort();
          } else await route.continue();
        });
        try {
          const response = await page.goto(host.origin);
          assert(
            response
              ?.headers()
              ["content-security-policy"]?.includes("frame-src blob:"),
          );
          await expect(
            page.getByRole("heading", { name: example.presentation.heading }),
          ).toBeVisible();
          await expect(
            page.getByRole("textbox", { name: "Message", exact: true }),
          ).toBeVisible();
          await assertAccessible(page);
          await noOverflow(page);

          // A starter submits through WebBuilder, not a parallel example flow.
          await page
            .getByRole("button", {
              name: example.presentation.starters[0]!.text,
              exact: true,
            })
            .click();
          await expect.poll(() => model.projectPending()).toBe(true);
          const first = page.getByRole("article", {
            name: "Exchange 1",
            exact: true,
          });
          await expect(first).toContainText("Preparing the synthetic example.");
          await expect(first).toContainText("Generating project…");
          await expect(
            page.getByRole("button", { name: "Stop", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Send message", exact: true }),
          ).toBeDisabled();
          assert.equal(
            await page.locator("iframe").count(),
            0,
            "No prebuilt preview while generating",
          );
          model.release();
          await expect(first.locator("iframe")).toHaveCount(1);
          await expect(first).toContainText("Playing");
          if (example.id === "experiences" && size === "desktop") {
            const outsider = await browser!.newContext();
            try {
              await outsider.request.get(host.origin); // a different host-selected session
              assert.equal(
                (await outsider.request.get(artifactUrls[0]!)).status(),
                404,
              );
            } finally {
              await outsider.close();
            }
          }
          assert.equal(
            await first.locator("iframe").getAttribute("sandbox"),
            "allow-scripts",
          );
          const initial = page
            .frames()
            .find((frame) => frame.url().startsWith("blob:"))!;
          assert(
            initial,
            "Compiled artifact is running in an opaque blob frame",
          );
          if (example.id === "experiences") {
            const target = initial.getByRole("button", { name: "Tap target" });
            await target.focus();
            await page.keyboard.press("Enter");
            await expect(initial.getByRole("status")).toHaveText("Score: 1");
            await initial.getByRole("button", { name: "Restart game" }).click();
            await expect(initial.getByRole("status")).toHaveText("Score: 0");
          } else {
            await expect(
              initial.getByRole("img", { name: /vertical bars/ }),
            ).toBeVisible();
            await expect(initial.getByRole("table")).toContainText(
              "Synthetic completed deliveries",
            );
          }
          await noOverflow(page);

          const change =
            example.id === "experiences"
              ? "Make the target blue; keep the score and restart controls."
              : "Make the bars horizontal and preserve the delivery counts.";
          const composer = page.getByRole("textbox", {
            name: "Message",
            exact: true,
          });
          await composer.fill(change);
          await composer.press("Enter");
          await expect.poll(() => model.projectPending()).toBe(true);
          const second = page.getByRole("article", {
            name: "Exchange 2",
            exact: true,
          });
          await expect(second).toContainText("Updating the synthetic example.");
          model.release();
          await expect(second).toContainText("Playing");
          await expect(page.locator("iframe")).toHaveCount(2);
          const frames = page
            .frames()
            .filter((frame) => frame.url().startsWith("blob:"));
          const refined = frames.at(-1)!;
          if (example.id === "experiences") {
            const target = refined.getByRole("button", { name: "Tap target" });
            await expect(target).toHaveCSS(
              "background-color",
              "rgb(20, 87, 172)",
            );
            if (size === "mobile") await target.tap();
            else await target.click();
            await expect(refined.getByRole("status")).toHaveText("Score: 1");
          } else {
            await expect(
              refined.getByRole("img", { name: /horizontal bars/ }),
            ).toBeVisible();
            await expect(refined.getByRole("table")).toContainText("70");
          }
          assert.deepEqual(model.stages, [
            "conversation",
            "project",
            "conversation",
            "project",
          ]);
          for (const request of model.requests) {
            assert.equal(request.headers.authorization, undefined);
            assert.equal(request.headers["openai-project"], undefined);
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(unexpected, []);
          await noOverflow(page);
          await assertAccessible(page);
          // Package reset owns artifact disposal as well as transcript state.
          await page
            .getByRole("button", { name: "Reset", exact: true })
            .click();
          await expect(page.locator("iframe")).toHaveCount(0);
          await expect(page.getByRole("article")).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: example.presentation.starters[0]!.text,
              exact: true,
            }),
          ).toBeVisible();
        } finally {
          await context.close();
          await model.close();
          await host.close();
        }
      });
    }
  }
  await test("synthetic example: Stop cancels the backend turn and retains partial text", async () => {
    const model = await exampleModelFixture("experiences");
    const host = await createExampleHost({
      example: experiences,
      gateway: model.gateway,
    });
    const page = await browser!.newPage();
    try {
      await page.goto(host.origin);
      await page
        .getByRole("button", {
          name: experiences.presentation.starters[0]!.text,
          exact: true,
        })
        .click();
      await expect.poll(() => model.projectPending()).toBe(true);
      await expect(page.getByRole("article")).toContainText(
        "Preparing the synthetic example.",
      );
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByRole("article")).toContainText(
        "Stopped. Partial results are retained.",
      );
      await expect(page.getByRole("article")).toContainText(
        "Preparing the synthetic example.",
      );
      await expect.poll(() => model.projectAborted()).toBe(true);
      model.release();
      await expect(page.locator("iframe")).toHaveCount(0);
      assert.deepEqual(model.stages, ["conversation", "project"]);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page.getByRole("article")).toHaveCount(0);
    } finally {
      await page.close();
      await model.close();
      await host.close();
    }
  });
} finally {
  await browser?.close();
}

async function noOverflow(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Host has no horizontal overflow",
  );
  for (const frame of page
    .frames()
    .filter((frame) => frame.url().startsWith("blob:"))) {
    assert.equal(
      await frame.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "Artifact has no horizontal overflow",
    );
  }
}
async function assertAccessible(page: Page) {
  // axe cannot inspect an opaque sandbox's DOM; artifact controls are checked above with Playwright.
  const result = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
    [],
  );
}
