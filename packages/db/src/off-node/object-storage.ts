import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

export const ObjectStorageConfigSchema = z.strictObject({
  endpoint: z.url(),
  bucket: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  forcePathStyle: z.boolean().default(false),
});
export type ObjectStorageConfig = z.input<typeof ObjectStorageConfigSchema>;
const encode = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key: Uint8Array | string, value: string) => createHmac("sha256", key).update(value).digest();
const parser = new XMLParser({
  parseTagValue: false,
  isArray: (name) => ["Version", "DeleteMarker", "Upload"].includes(name),
});

export class ObjectStorageError extends Error {
  constructor(readonly status: number) {
    super(`Object storage request failed (${status}).`);
  }
}

export interface ObjectReceipt {
  key: string;
  versionId: string;
  etag: string;
  bytes: number;
  digest: string;
}

export class ObjectStorage {
  private readonly config;
  constructor(config: ObjectStorageConfig) {
    this.config = ObjectStorageConfigSchema.parse(config);
  }

  async request(method: string, key = "", query: Record<string, string> = {}, body?: Uint8Array | string) {
    const { endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken, forcePathStyle } = this.config;
    const url = new URL(endpoint);
    if (!forcePathStyle) url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `/${[...(forcePathStyle ? [bucket] : []), ...key.split("/")].map(encode).join("/")}`;
    const canonicalQuery = Object.entries(query)
      .map(([name, value]) => [encode(name), encode(value)])
      .sort(([a, av], [b, bv]) =>
        a === b ? (av as string).localeCompare(bv as string) : (a as string).localeCompare(b as string),
      )
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    url.search = canonicalQuery;
    const at = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = at.slice(0, 8);
    const payload = hash(body ?? "");
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": at };
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;
    const names = Object.keys(headers).sort();
    const signed = names.join(";");
    const canonical = [
      method,
      url.pathname,
      canonicalQuery,
      `${names.map((name) => `${name}:${headers[name]}\n`).join("")}`,
      signed,
      payload,
    ].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const signing = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
    const signature = hmac(signing, `AWS4-HMAC-SHA256\n${at}\n${scope}\n${hash(canonical)}`).toString("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ObjectStorageError(response.status);
    }
    return response;
  }

  private async xml(response: Response) {
    const value = await response.text();
    if (XMLValidator.validate(value) !== true) throw new Error("Invalid object storage XML response.");
    return parser.parse(value);
  }

  async get(key: string, versionId?: string) {
    return this.request("GET", key, versionId ? { versionId } : {});
  }

  async put(key: string, bytes: Uint8Array) {
    const response = await this.request("PUT", key, {}, bytes);
    return this.receipt(response, key, bytes.length, `sha256:${hash(bytes)}`);
  }

  private receipt(response: Response, key: string, bytes: number, digest: string): ObjectReceipt {
    const versionId = response.headers.get("x-amz-version-id");
    const etag = response.headers.get("etag");
    if (!versionId || versionId === "null" || !etag) throw new Error("Off-node storage requires object versioning.");
    return { key, versionId, etag, bytes, digest };
  }

  async versions(prefix: string) {
    const items: { key: string; versionId: string; deleted: boolean; latest: boolean }[] = [];
    let query: Record<string, string> = { versions: "", prefix, "encoding-type": "url" };
    for (;;) {
      const page = (await this.xml(await this.request("GET", "", query))).ListVersionsResult;
      for (const [name, deleted] of [
        ["Version", false],
        ["DeleteMarker", true],
      ] as const) {
        for (const item of page[name] ?? [])
          items.push({
            key: decodeURIComponent(item.Key),
            versionId: item.VersionId,
            deleted,
            latest: item.IsLatest === "true",
          });
      }
      if (page.IsTruncated !== "true") return items;
      query = {
        ...query,
        "key-marker": decodeURIComponent(page.NextKeyMarker),
        "version-id-marker": page.NextVersionIdMarker,
      };
    }
  }

  async multipart(prefix: string) {
    const items: { key: string; uploadId: string }[] = [];
    let query: Record<string, string> = { uploads: "", prefix, "encoding-type": "url" };
    for (;;) {
      const page = (await this.xml(await this.request("GET", "", query))).ListMultipartUploadsResult;
      for (const item of page.Upload ?? []) items.push({ key: decodeURIComponent(item.Key), uploadId: item.UploadId });
      if (page.IsTruncated !== "true") return items;
      query = {
        ...query,
        "key-marker": decodeURIComponent(page.NextKeyMarker),
        "upload-id-marker": page.NextUploadIdMarker,
      };
    }
  }

  async abort(key: string, uploadId: string) {
    try {
      await this.request("DELETE", key, { uploadId });
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 404) throw error;
    }
  }

  async deleteVersion(key: string, versionId: string) {
    await this.request("DELETE", key, { versionId });
  }

  async beginMultipart(key: string) {
    return (await this.xml(await this.request("POST", key, { uploads: "" }))).InitiateMultipartUploadResult
      .UploadId as string;
  }

  async uploadFile(key: string, path: string) {
    const file = await open(path, "r");
    let uploadId: string | undefined;
    try {
      const { size } = await file.stat();
      uploadId = await this.beginMultipart(key);
      const parts: { PartNumber: number; ETag: string }[] = [];
      const chunk = Buffer.alloc(8 * 1024 ** 2);
      const digest = createHash("sha256");
      for (let offset = 0; offset < size; ) {
        const length = Math.min(chunk.length, size - offset);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await file.read(chunk, done, length - done, offset + done);
          if (!bytesRead) throw new Error("Backup changed during upload.");
          done += bytesRead;
        }
        const bytes = chunk.subarray(0, length);
        digest.update(bytes);
        const partNumber = parts.length + 1;
        const response = await this.request("PUT", key, { uploadId, partNumber: String(partNumber) }, bytes);
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("Multipart response has no digest.");
        parts.push({ PartNumber: partNumber, ETag: etag });
        offset += length;
      }
      const body = new XMLBuilder().build({ CompleteMultipartUpload: { Part: parts } });
      const response = await this.request("POST", key, { uploadId }, body);
      const result = (await this.xml(response)).CompleteMultipartUploadResult;
      if (!result?.ETag) throw new Error("Multipart completion did not confirm the object.");
      response.headers.set("etag", result.ETag);
      return this.receipt(response, key, size, `sha256:${digest.digest("hex")}`);
    } catch (error) {
      if (uploadId) await this.abort(key, uploadId);
      throw error;
    } finally {
      await file.close();
    }
  }

  // A failed operation owns this exact prefix; other accounts and operations are untouched.
  async clean(prefix: string) {
    for (const item of await this.multipart(prefix)) await this.abort(item.key, item.uploadId);
    for (const item of await this.versions(prefix)) await this.deleteVersion(item.key, item.versionId);
    if ((await this.multipart(prefix)).length || (await this.versions(prefix)).length)
      throw new Error("Failed upload cleanup is incomplete.");
  }
}
