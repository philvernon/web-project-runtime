import assert from "node:assert/strict";
import { test } from "node:test";
import { get } from "node:http";
import { BUILDER_LIMITS } from "@philvernon/web-project-runtime/contracts";
import { createExampleHost } from "../examples/shared/host.js";
import { charts } from "../examples/charts/config.js";
import { exampleModelFixture } from "./examples-fixture.js";

await test("example dev host: exact origin, private sessions, request and registry bounds", async () => {
  const model = await exampleModelFixture("charts");
  const host = await createExampleHost({
    example: charts,
    gateway: model.gateway,
  });
  try {
    const unauthenticated = await fetch(`${host.origin}/example-config`);
    assert.equal(unauthenticated.status, 401);
    const root = await fetch(host.origin);
    const cookie = root.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.match(root.headers.getSetCookie()[0]!, /HttpOnly; SameSite=Strict/);
    const html = await root.text();
    assert.match(html, /\/ui\.css/);
    assert.match(
      root.headers.get("content-security-policy")!,
      /frame-src blob:/,
    );
    const config = await fetch(`${host.origin}/example-config`, {
      headers: { cookie },
    });
    const publicConfig = await config.text();
    assert.deepEqual(JSON.parse(publicConfig), charts.presentation);
    for (const hidden of [
      charts.instructions,
      charts.publicContext,
      model.gateway.model().baseUrl,
    ]) {
      assert(!html.includes(hidden));
      assert(!publicConfig.includes(hidden));
    }
    const bundle = await (
      await fetch(`${host.origin}/ui.js`, { headers: { cookie } })
    ).text();
    for (const hidden of [
      "createPiGateway",
      "createBuilderService",
      "CredentialStore",
      "generate_project",
      "createGenerationTool",
      "build_chart",
      "get_delivery_data",
      "Public synthetic delivery counts",
      model.gateway.model().baseUrl,
    ])
      assert(!bundle.includes(hidden), `Browser bundle leaked ${hidden}`);
    assert.equal(
      (await fetch(`${host.origin}/ui.css`, { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/builder`, {
          method: "POST",
          headers: {
            cookie,
            origin: "https://other.invalid",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "submit",
            requestId: "example-request",
            message: "Must not call model",
          }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/builder`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    // Undici normalizes Host; use node:http to send an actual rebinding-style header.
    const hostileHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(host.origin, { headers: { host: "other.invalid" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).once("error", reject);
      },
    );
    assert.equal(hostileHostStatus, 403);
    assert.equal(
      (
        await fetch(`${host.origin}/builder?endpoint=http://127.0.0.1:1`, {
          method: "POST",
          headers: {
            cookie,
            origin: host.origin,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/builder`, {
          method: "POST",
          headers: {
            cookie,
            origin: host.origin,
            "content-type": "application/json",
          },
          body: "x".repeat(BUILDER_LIMITS.commandBytes + 1),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/builder`, {
          method: "POST",
          headers: {
            cookie,
            origin: host.origin,
            "content-type": "application/json",
          },
          body: "not json",
        })
      ).status,
      400,
    );
    const missing = "/artifacts/" + "0".repeat(64);
    assert.equal(
      (await fetch(host.origin + missing, { headers: { cookie } })).status,
      404,
    );
    assert.equal((await fetch(host.origin + missing)).status, 401);
    // A page with an existing token doesn't allocate another session. New admissions are capped.
    for (let index = 1; index < 8; index++)
      assert.equal((await fetch(host.origin)).status, 200);
    assert.equal((await fetch(host.origin)).status, 503);
    assert.equal(
      (await fetch(host.origin, { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      model.requests.length,
      0,
      "Rejected requests must not dispatch to a model",
    );
  } finally {
    await model.close();
    await host.close();
  }
});
