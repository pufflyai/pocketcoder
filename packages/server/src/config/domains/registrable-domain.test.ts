import { expect, test } from "bun:test";
import { getDomain } from "tldts";
import { registrableDomain } from "./registrable-domain";

test("compressed suffix data matches tldts for private domains, wildcards, exceptions and Unicode", () => {
  const hosts = [
    "api.example.com",
    "views.example.co.uk",
    "co.uk",
    "foo.github.io",
    "github.io",
    "foo.appspot.com",
    "a.b.ck",
    "www.ck",
    "a.city.kawasaki.jp",
    "a.kawasaki.jp",
    "foo.s3.amazonaws.com",
    "bar.compute.amazonaws.com",
    "xn--85x722f.com.cn",
    "例子.中国",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "invalid..example.com",
  ];
  for (const host of hosts)
    expect(registrableDomain(host)).toBe(getDomain(host, { extractHostname: false, allowPrivateDomains: true }));
});
