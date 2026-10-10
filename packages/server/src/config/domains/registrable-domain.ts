import { getEmptyResult, parseImpl } from "tldts-core";
import suffixLookup from "./suffix-lookup";

export function registrableDomain(hostname: string) {
  return parseImpl(
    hostname,
    // The pinned library's FLAG.DOMAIN is 3; its const enum has no runtime export.
    3,
    suffixLookup,
    { extractHostname: false, allowPrivateDomains: true },
    getEmptyResult(),
  ).domain;
}
