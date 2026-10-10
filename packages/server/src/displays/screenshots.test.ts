import { expect, test } from "bun:test";
import { screenshotFixture, testPng } from "./screenshot-fixture";

test("a one-use supervisor upload publishes a private binary output and charges quota", async () => {
  const f = await screenshotFixture();
  try {
    const capture = await f.nextCapture();
    expect((await capture.upload()).status).toBe(204);
    const resource = await capture.capture;
    expect(resource).toMatchObject({ kind: "screenshot", bytes: testPng.length, content_type: "image/png" });
    expect(JSON.stringify(resource)).not.toContain("base64");
    expect((await capture.upload()).status).toBe(401);
    const content = await f.client.outputs.download(f.id, resource.id);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(testPng);
    expect((await fetch(`${f.baseUrl}/v1/workspaces/${f.id}/outputs/${resource.id}/content`)).status).toBe(401);
    expect(
      (
        await fetch(`${f.baseUrl}/v1/workspaces/${f.id}/outputs/${resource.id}/content`, {
          headers: { authorization: `Bearer ${f.server.limitedToken}` },
        })
      ).status,
    ).toBe(403);
    expect((await f.client.outputs.list(f.id)).items[0]?.value).toMatchObject({ id: resource.id });
    await expect(f.client.displays.capture(f.id)).rejects.toThrow("capacity");
  } finally {
    await f.close();
  }
});

test("revoking capture authority prevents a late upload and releases the reservation", async () => {
  const f = await screenshotFixture();
  try {
    const capture = await f.nextCapture();
    await f.server.store.revokeMachineKey(f.server.keyId, new Date());
    expect((await capture.upload()).status).toBe(401);
    await expect(capture.capture).rejects.toThrow();
    expect((await f.server.store.binaryOutputs.get(capture.payload.output_id))?.state).toBe("deleted");
    expect((await f.server.store.listOutputs(f.id)).length).toBe(0);
  } finally {
    await f.close();
  }
});

test("an oversized supervisor upload is rejected without publishing or retaining bytes", async () => {
  const f = await screenshotFixture();
  try {
    const capture = await f.nextCapture();
    expect((await capture.upload(Buffer.alloc(4 * 1024 ** 2 + 1))).status).toBe(413);
    await expect(capture.capture).rejects.toThrow();
    expect((await f.server.store.binaryOutputs.get(capture.payload.output_id))?.state).toBe("deleted");
  } finally {
    await f.close();
  }
});
