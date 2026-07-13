import { describe, expect, it } from "vitest";
import { getServerConfig } from "./index.js";

describe("getServerConfig", () => {
  it("defaults to json db when DATABASE_URL is absent", () => {
    const config = getServerConfig({});

    expect(config.dbDriver).toBe("json");
    expect(config.storageDriver).toBe("filesystem");
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.trustProxy).toBe(false);
  });

  it("defaults to postgres db when DATABASE_URL is present", () => {
    const config = getServerConfig({ DATABASE_URL: "postgres://example" });

    expect(config.dbDriver).toBe("postgres");
  });

  it("parses a positive trusted-proxy hop count as a number", () => {
    const config = getServerConfig({ PATCHPAGE_TRUST_PROXY: "2" });

    expect(config.trustProxy).toBe(2);
  });

  it("parses trusted proxy addresses and CIDR networks as a list", () => {
    const config = getServerConfig({
      PATCHPAGE_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8, 2001:db8::/32"
    });

    expect(config.trustProxy).toEqual(["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]);
  });

  it("bounds trusted-proxy hop counts", () => {
    expect(getServerConfig({ PATCHPAGE_TRUST_PROXY: "32" }).trustProxy).toBe(32);
    expect(() => getServerConfig({ PATCHPAGE_TRUST_PROXY: "33" })).toThrow(
      /Invalid PATCHPAGE_TRUST_PROXY/
    );
  });

  it.each([
    "",
    "   ",
    "0",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e2",
    "true",
    "false",
    "all",
    "*",
    ",127.0.0.1",
    "127.0.0.1,",
    "127.0.0.1,,10.0.0.0/8",
    "not-an-ip",
    "fe80::1%eth0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "0.0.0.0/0",
    "::/0"
  ])("rejects an unsafe or malformed trusted-proxy value %j", (value) => {
    expect(() => getServerConfig({ PATCHPAGE_TRUST_PROXY: value })).toThrow(
      /Invalid PATCHPAGE_TRUST_PROXY/
    );
  });
});
