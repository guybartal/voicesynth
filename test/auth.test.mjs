import test from "node:test";
import assert from "node:assert/strict";
import { createCliTokenProvider } from "../lib/speech.mjs";

const resourceId = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test-speech";
const initialTime = 1_800_000_000_000;
const result = (now, accessToken = "fake.access.token") => ({
  stdout: JSON.stringify({ accessToken, expires_on: Math.floor(now / 1000) + 3600 }),
});

test("CLI uses a fixed executable, argument array, correct audience, and resource subscription", async () => {
  const provider = createCliTokenProvider(resourceId, {
    now: () => initialTime,
    execute: async (command, args, options) => {
      assert.equal(command, "az");
      assert.deepEqual(args, [
        "account", "get-access-token", "--resource", "https://cognitiveservices.azure.com",
        "--subscription", "11111111-2222-3333-4444-555555555555",
        "--output", "json", "--only-show-errors",
      ]);
      assert.equal(options.timeout, 20_000);
      assert.equal(options.shell, undefined);
      return result(initialTime);
    },
  });
  assert.equal(await provider.getToken(), "fake.access.token");
});

test("tokens are cached, deduplicated, and refreshed before expiry", async () => {
  let now = initialTime;
  let calls = 0;
  const provider = createCliTokenProvider(resourceId, {
    now: () => now,
    execute: async () => {
      calls++;
      return result(now, `token-${calls}`);
    },
  });
  assert.deepEqual(await Promise.all([provider.getToken(), provider.getToken()]), ["token-1", "token-1"]);
  now += 3_000_000;
  assert.equal(await provider.getToken(), "token-1");
  assert.equal(calls, 1);
  now += 480_000;
  assert.equal(await provider.getToken(), "token-2");
  assert.equal(calls, 2);
  provider.invalidate();
  assert.equal(await provider.getToken(), "token-3");
});

for (const [label, failure, status, message] of [
  ["missing executable", { code: "ENOENT" }, 503, /not installed/],
  ["CLI timeout", { killed: true }, 504, /timed out/],
  ["login failure", { code: 1, stderr: "secret-output", stdout: "secret-token" }, 503, /az login/],
]) {
  test(`${label} is actionable and does not disclose CLI output`, async () => {
    const provider = createCliTokenProvider(resourceId, {
      execute: async () => { throw Object.assign(new Error("secret-error"), failure); },
    });
    await assert.rejects(provider.getToken(), (error) => {
      assert.equal(error.status, status);
      assert.match(error.message, message);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const [label, stdout] of [
  ["invalid JSON", "private-invalid-output"],
  ["missing token", JSON.stringify({ expires_on: initialTime / 1000 + 3600 })],
  ["missing expiry", JSON.stringify({ accessToken: "private-token" })],
  ["invalid expiry", JSON.stringify({ accessToken: "private-token", expires_on: "not-a-time" })],
  ["expired token", JSON.stringify({ accessToken: "private-token", expires_on: initialTime / 1000 })],
  ["nearly expired token", JSON.stringify({ accessToken: "private-token", expires_on: initialTime / 1000 + 119 })],
  ["invalid bearer characters", JSON.stringify({ accessToken: "private-token\r\ninjected", expires_on: initialTime / 1000 + 3600 })],
  ["null response", "null"],
]) {
  test(`${label} is rejected without exposing its contents`, async () => {
    const provider = createCliTokenProvider(resourceId, {
      now: () => initialTime,
      execute: async () => ({ stdout }),
    });
    await assert.rejects(provider.getToken(), (error) => {
      assert.ok([502, 503].includes(error.status));
      assert.ok(!error.message.includes("private"));
      return true;
    });
  });
}

test("failed CLI calls are retried after the user signs in", async () => {
  let calls = 0;
  const provider = createCliTokenProvider(resourceId, {
    now: () => initialTime,
    execute: async () => {
      calls++;
      if (calls === 1) throw new Error("not logged in");
      return result(initialTime);
    },
  });
  await assert.rejects(provider.getToken(), /az login/);
  assert.equal(await provider.getToken(), "fake.access.token");
  assert.equal(calls, 2);
});
