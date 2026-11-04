import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual({
      PORT: 8080,
      LOG_LEVEL: "info",
      PUBLISHER: "memory",
      OUTPUT_TOPIC: "orders.transformed",
      DLQ_TOPIC: "orders.failed",
      PUBLISH_MAX_ATTEMPTS: 3,
      PUBLISH_RETRY_BASE_MS: 200,
      PUBLISH_RETRY_MAX_MS: 5000,
      PUBLISH_TIMEOUT_MS: 5000,
      IDEMPOTENCY_TTL_SECONDS: 86400,
      MAX_BODY_BYTES: 1048576,
    });
  });

  it("coerces numbers from strings and reads every variable", () => {
    const config = loadConfig({
      PORT: "9000",
      PUBLISHER: "pubsub",
      GOOGLE_CLOUD_PROJECT: "my-project",
      PUBLISH_MAX_ATTEMPTS: "5",
    });
    expect(config).toMatchObject({
      PORT: 9000,
      PUBLISHER: "pubsub",
      GOOGLE_CLOUD_PROJECT: "my-project",
      PUBLISH_MAX_ATTEMPTS: 5,
    });
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ PORT: "", GOOGLE_CLOUD_PROJECT: "" })).toMatchObject({ PORT: 8080 });
    expect(loadConfig({ GOOGLE_CLOUD_PROJECT: "" }).GOOGLE_CLOUD_PROJECT).toBeUndefined();
  });

  it("ignores unrelated environment variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", HOME: "/root" })).not.toHaveProperty("PATH");
  });

  it("fails fast listing every invalid variable", () => {
    const run = () =>
      loadConfig({ PORT: "abc", PUBLISHER: "kafka", PUBLISH_MAX_ATTEMPTS: "0", LOG_LEVEL: "loud" });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(4);
      expect(issues.map((issue) => issue.split(":")[0]).sort()).toEqual([
        "LOG_LEVEL",
        "PORT",
        "PUBLISHER",
        "PUBLISH_MAX_ATTEMPTS",
      ]);
    }
  });
});
