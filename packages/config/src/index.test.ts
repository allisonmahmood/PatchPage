import { describe, expect, it } from "vitest";
import { getServerConfig } from "./index.js";

describe("getServerConfig", () => {
  it("defaults to json db when DATABASE_URL is absent", () => {
    const config = getServerConfig({});

    expect(config.dbDriver).toBe("json");
    expect(config.storageDriver).toBe("filesystem");
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
  });

  it("defaults to postgres db when DATABASE_URL is present", () => {
    const config = getServerConfig({ DATABASE_URL: "postgres://example" });

    expect(config.dbDriver).toBe("postgres");
  });
});
