import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { handleAttachmentCommand, mediaTypeOf, uploadAttachments } from "./attachments";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcd-cli-attach-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function descriptorFor(path: string) {
  const id = path.split("/").at(-2) as string;
  return {
    id,
    name: basename(path),
    path: `/home/pocketcoder/.pcd/attachments/${id}/x`,
    media_type: "text/plain",
    size_bytes: 5,
    sha256: "a".repeat(64),
  };
}

describe("mediaTypeOf", () => {
  test("maps common extensions and defaults to octet-stream", () => {
    expect(mediaTypeOf("report.pdf")).toBe("application/pdf");
    expect(mediaTypeOf("photo.JPG")).toBe("image/jpeg");
    expect(mediaTypeOf("data.csv")).toBe("text/csv");
    expect(mediaTypeOf("binary.xyz")).toBe("application/octet-stream");
  });
});

describe("uploadAttachments", () => {
  test("PUTs each file with headers and returns the attachment ids", async () => {
    const dir = tempDir();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello");
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return Response.json(descriptorFor(path), { status: 201 });
    };
    const logs: string[] = [];

    const ids = await uploadAttachments(api, "ws-1", [file], (line) => logs.push(line));

    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    const call = calls[0] as { path: string; init: RequestInit };
    expect(call.path).toBe(`/v1/workspaces/ws-1/attachments/${ids[0]}`);
    expect(call.init.method).toBe("PUT");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["content-disposition"]).toBe('attachment; filename="notes.txt"');
    expect(headers["content-length"]).toBe("5");
    expect(logs[0]).toContain("notes.txt");
  });

  test("throws with the server explanation when an upload fails", async () => {
    const dir = tempDir();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello");
    const api = async () =>
      Response.json({ error: { code: "attachment.conflict", message: "boom", request_id: "r" } }, { status: 409 });
    expect(uploadAttachments(api, "ws-1", [file], () => {})).rejects.toThrow(/notes.txt.*409/);
  });

  test("throws before any request for an unreadable file", async () => {
    let called = false;
    const api = async () => {
      called = true;
      return Response.json({});
    };
    expect(uploadAttachments(api, "ws-1", ["/does/not/exist.txt"], () => {})).rejects.toThrow(/could not read/);
    expect(called).toBe(false);
  });
});

describe("handleAttachmentCommand", () => {
  test("queues existing files and rejects missing ones", () => {
    const dir = tempDir();
    const file = join(dir, "report.pdf");
    writeFileSync(file, "x");
    const queue: string[] = [];
    const output: string[] = [];
    const print = (line: string) => output.push(line);

    expect(handleAttachmentCommand(`/attach ${file}`, queue, print)).toBe(true);
    expect(queue).toEqual([file]);
    expect(output[0]).toContain("report.pdf");

    expect(handleAttachmentCommand("/attach /missing/nope.txt", queue, print)).toBe(true);
    expect(queue).toEqual([file]);
    expect(output[1]).toContain("no such file");
  });

  test("lists and detaches queued files", () => {
    const dir = tempDir();
    const first = join(dir, "a.txt");
    const second = join(dir, "b.txt");
    writeFileSync(first, "a");
    writeFileSync(second, "b");
    const queue = [first, second];
    const output: string[] = [];
    const print = (line: string) => output.push(line);

    expect(handleAttachmentCommand("/attachments", queue, print)).toBe(true);
    expect(output.join("\n")).toContain("a.txt");
    expect(output.join("\n")).toContain("b.txt");

    expect(handleAttachmentCommand("/detach 1", queue, print)).toBe(true);
    expect(queue).toEqual([second]);

    expect(handleAttachmentCommand("/detach all", queue, print)).toBe(true);
    expect(queue).toEqual([]);

    expect(handleAttachmentCommand("hello agent", queue, print)).toBe(false);
  });
});
