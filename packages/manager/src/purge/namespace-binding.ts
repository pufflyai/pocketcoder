import { createRequestDigest } from "./intent";

export const createBindingLabel = "pocketcoder.dev/create-request";
export const createDigestLabel = (digest: string) => `h${Buffer.from(digest, "hex").toString("base64url")}h`;
export const createNamespaceLabel = (requestId: string) => createDigestLabel(createRequestDigest(requestId));
export const namespaceForAccount = (id: string) => `pc-account-${id.replaceAll("-", "")}`;
