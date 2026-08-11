import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { captureTurnAttachmentBatch } from "./attachments";
import { ControlPlaneClient } from "./control-plane";
import { RemoteRequestError } from "./remote-request-error";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "turn-batch-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(text: string): Context {
  return { messages: [{ role: "user", content: text, timestamp: 0 }] } as unknown as Context;
}

function descriptor(request: Request) {
  const parts = new URL(request.url).pathname.split("/");
  const id = parts.at(-1) as string;
  return {
    id,
    name: "file.txt",
    path: `/home/pocketcoder/.pcd/attachments/${id}/file.txt`,
    media_type: "text/plain",
    size_bytes: Number(request.headers.get("content-length")),
    sha256: "a".repeat(64),
  };
}

function fixtureClient(
  route: (request: Request) => Response | Promise<Response>,
  requests: Request[] = [],
) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return await route(request);
  }) as typeof fetch;
  return new ControlPlaneClient(
    { baseUrl: "http://pocketcoder.test", key: "pkt_example" },
    fetchImpl,
  );
}

describe("TurnAttachmentBatch", () => {
  test("reads files once and reuses stable ids on another workspace", async () => {
    const dir = tempDir();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "original bytes");
    const queue = [file];
    const requests: Request[] = [];
    const controlPlane = fixtureClient(
      async (request) => Response.json(descriptor(request), { status: 201 }),
      requests,
    );
    const batch = captureTurnAttachmentBatch(context("summarize"), queue);
    writeFileSync(file, "changed after capture");

    const first = await batch.upload(controlPlane, WS_A);
    const second = await batch.upload(controlPlane, WS_B);

    expect(second).toEqual(first);
    expect(first[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL((requests[0] as Request).url).pathname).toContain(WS_A);
    expect(new URL((requests[1] as Request).url).pathname).toContain(WS_B);
    expect(await (requests[0] as Request).text()).toBe("original bytes");
    expect(await (requests[1] as Request).text()).toBe("original bytes");
  });

  test("repeats the full immutable batch after a partial terminal upload", async () => {
    const dir = tempDir();
    const firstFile = join(dir, "first.txt");
    const secondFile = join(dir, "second.txt");
    writeFileSync(firstFile, "first");
    writeFileSync(secondFile, "second");
    const queue = [firstFile, secondFile];
    const requests: Request[] = [];
    let failSecond = true;
    const controlPlane = fixtureClient(async (request) => {
      const workspaceId = new URL(request.url).pathname.split("/")[3];
      const workspaceRequests = requests.filter((item) =>
        new URL(item.url).pathname.includes(`/${workspaceId}/`),
      );
      if (failSecond && workspaceRequests.length === 2) {
        failSecond = false;
        return Response.json(
          {
            error: {
              code: "workspace.terminal",
              message: "terminal detail",
              request_id: "secret-request",
            },
          },
          { status: 410 },
        );
      }
      return Response.json(descriptor(request), { status: 201 });
    }, requests);
    const batch = captureTurnAttachmentBatch(context("use both"), queue);

    await batch.upload(controlPlane, WS_A).then(
      () => {
        throw new Error("expected upload to fail");
      },
      (error) => {
        expect(error).toBeInstanceOf(RemoteRequestError);
        expect(error).toMatchObject({
          phase: "attachment",
          promptAccepted: false,
          status: 410,
          code: "workspace.terminal",
        });
        expect((error as Error).message).not.toContain("terminal detail");
      },
    );
    expect(queue).toEqual([firstFile, secondFile]);

    const ids = await batch.upload(controlPlane, WS_B);
    const attemptedIds = requests.map((request) => new URL(request.url).pathname.split("/").at(-1));
    expect(attemptedIds).toEqual([ids[0], ids[1], ids[0], ids[1]]);
  });

  test("uses the same ids for a repeated upload to one workspace", async () => {
    const dir = tempDir();
    const file = join(dir, "file.txt");
    writeFileSync(file, "same");
    const requests: Request[] = [];
    const controlPlane = fixtureClient(
      async (request) => Response.json(descriptor(request), { status: 201 }),
      requests,
    );
    const batch = captureTurnAttachmentBatch(context("send"), [file]);

    expect(await batch.upload(controlPlane, WS_A)).toEqual(await batch.upload(controlPlane, WS_A));
    expect(requests[0]?.url).toBe(requests[1]?.url);
  });

  test("commits only captured queue entries and only when asked", () => {
    const dir = tempDir();
    const captured = join(dir, "captured.txt");
    const added = join(dir, "added.txt");
    writeFileSync(captured, "captured");
    writeFileSync(added, "added");
    const queue = [captured];
    const batch = captureTurnAttachmentBatch(context("send"), queue);
    queue.push(added);

    expect(queue).toEqual([captured, added]);
    batch.commit();
    expect(queue).toEqual([added]);
    batch.commit();
    expect(queue).toEqual([added]);
  });
});
