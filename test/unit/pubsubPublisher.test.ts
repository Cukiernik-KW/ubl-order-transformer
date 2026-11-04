import { describe, expect, it, vi } from "vitest";
import { PubSubPublisher, type PubSubClient } from "../../src/adapters/pubsubPublisher.js";
import { AppError } from "../../src/domain/errors.js";

function fakeClient(publishMessage = vi.fn(() => Promise.resolve("server-id-1"))) {
  const flush = vi.fn(() => Promise.resolve());
  const topic = vi.fn(() => ({ publishMessage, flush }));
  const close = vi.fn(() => Promise.resolve());
  const client = { topic, close } as unknown as PubSubClient;
  return { client, topic, publishMessage, flush, close };
}

describe("PubSubPublisher (with a fake client, no network)", () => {
  it("publishes JSON with attributes and returns the server message id", async () => {
    const fake = fakeClient();
    const publisher = new PubSubPublisher({ client: fake.client, publishTimeoutMs: 5000 });

    await expect(
      publisher.publish("orders.transformed", { a: 1 }, { messageId: "m1" }),
    ).resolves.toBe("server-id-1");
    expect(fake.publishMessage).toHaveBeenCalledWith({
      json: { a: 1 },
      attributes: { messageId: "m1" },
    });
  });

  it("creates each topic once, with library retry disabled and a per-attempt timeout", async () => {
    const fake = fakeClient();
    const publisher = new PubSubPublisher({ client: fake.client, publishTimeoutMs: 5000 });

    await publisher.publish("orders.transformed", {});
    await publisher.publish("orders.transformed", {});
    await publisher.publish("orders.failed", {});

    expect(fake.topic).toHaveBeenCalledTimes(2);
    expect(fake.topic).toHaveBeenCalledWith("orders.transformed", {
      gaxOpts: { timeout: 5000, retry: null },
    });
  });

  it("wraps library errors as transient AppErrors, keeping the cause", async () => {
    const cause = Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
    const fake = fakeClient(vi.fn(() => Promise.reject(cause)));
    const publisher = new PubSubPublisher({ client: fake.client, publishTimeoutMs: 5000 });

    const failure = publisher.publish("orders.transformed", {});
    await expect(failure).rejects.toBeInstanceOf(AppError);
    await expect(failure).rejects.toMatchObject({ code: "ServerError", permanent: false, cause });
  });

  it("flushes every topic and closes the client", async () => {
    const fake = fakeClient();
    const publisher = new PubSubPublisher({ client: fake.client, publishTimeoutMs: 5000 });
    await publisher.publish("a", {});
    await publisher.publish("b", {});

    await publisher.close();
    expect(fake.flush).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
