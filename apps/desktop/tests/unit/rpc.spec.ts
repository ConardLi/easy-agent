import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, test } from "@playwright/test";
import { RpcClient, RpcError } from "../../src/main/agent/rpc";

/** A client wired to an in-memory server that sees each request as parsed JSON. */
function pair(onRequest: (message: { id: number; method: string; params: unknown }, reply: (line: object) => void) => void) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const notifications: [string, unknown][] = [];
  const client = new RpcClient(toClient, toServer, (method, params) => notifications.push([method, params]));
  const reply = (line: object) => toClient.write(`${JSON.stringify({ jsonrpc: "2.0", ...line })}\n`);
  createInterface({ input: toServer }).on("line", (line) => onRequest(JSON.parse(line), reply));
  return { client, notifications, reply };
}

test("responses are matched by id, in any order", async () => {
  const held: { id: number; method: string }[] = [];
  const { client } = pair((message, send) => {
    held.push(message);
    if (held.length === 2) {
      send({ id: held[1]!.id, result: held[1]!.method });
      send({ id: held[0]!.id, result: held[0]!.method });
    }
  });
  const [a, b] = await Promise.all([client.request("first"), client.request("second")]);
  expect([a, b]).toEqual(["first", "second"]);
});

test("errors keep their code and data", async () => {
  const { client } = pair((message, send) => send({ id: message.id, error: { code: -32000, message: "busy", data: { code: "busy" } } }));
  const error = await client.request("session/send").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).toInfo()).toEqual({ code: -32000, message: "busy", data: { code: "busy" } });
});

test("notifications arrive in order and junk lines are skipped", async () => {
  const { client, notifications, reply } = pair((message, send) => send({ id: message.id, result: {} }));
  reply({ method: "session/event", params: { seq: 1 } });
  reply({ method: "runtime/log", params: { level: "warn", message: "x" } });
  await client.request("ping");
  expect(notifications).toEqual([
    ["session/event", { seq: 1 }],
    ["runtime/log", { level: "warn", message: "x" }],
  ]);
});

test("closing fails pending and later requests", async () => {
  const { client } = pair(() => {});
  const pending = client.request("slow");
  client.close("process exited");
  await expect(pending).rejects.toThrow("process exited");
  await expect(client.request("later")).rejects.toThrow("process exited");
});
