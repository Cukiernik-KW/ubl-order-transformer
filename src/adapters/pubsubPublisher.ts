import { PubSub, type Topic } from "@google-cloud/pubsub";
import { serverError } from "../domain/errors.js";
import type { MessageAttributes, Publisher } from "../ports/publisher.js";

export type PubSubClient = Pick<PubSub, "topic" | "close">;

export interface PubSubPublisherOptions {
  projectId?: string;
  /** Per-attempt timeout. The library's own retry is disabled (see below). */
  publishTimeoutMs: number;
  /** Injected in tests; defaults to a real client (ADC auth, honours PUBSUB_EMULATOR_HOST). */
  client?: PubSubClient;
}

/** Real Pub/Sub adapter. Authenticates with Application Default Credentials only (no key files). */
export class PubSubPublisher implements Publisher {
  private readonly client: PubSubClient;
  private readonly publishTimeoutMs: number;
  // Topic objects own the batching state, so they are created once and reused.
  private readonly topics = new Map<string, Topic>();

  constructor(options: PubSubPublisherOptions) {
    this.client = options.client ?? new PubSub({ projectId: options.projectId });
    this.publishTimeoutMs = options.publishTimeoutMs;
  }

  async publish(topic: string, json: unknown, attributes: MessageAttributes = {}): Promise<string> {
    try {
      return await this.topicFor(topic).publishMessage({ json, attributes });
    } catch (error) {
      // Treated as transient, including config errors such as NOT_FOUND or PERMISSION_DENIED:
      // they are our problem, not the message's, so the message must not be dead-lettered as bad input.
      throw serverError(error);
    }
  }

  /** Flushes pending batches and closes connections (called on SIGTERM). */
  async close(): Promise<void> {
    await Promise.all([...this.topics.values()].map((topic) => topic.flush()));
    await this.client.close();
  }

  private topicFor(name: string): Topic {
    let topic = this.topics.get(name);
    if (!topic) {
      topic = this.client.topic(name, {
        // retry: null disables the library's built-in retry (which could run for minutes),
        // so withRetry() is the only retry layer in the process and its total budget stays
        // below the push subscription's ack deadline.
        gaxOpts: { timeout: this.publishTimeoutMs, retry: null },
      });
      this.topics.set(name, topic);
    }
    return topic;
  }
}
