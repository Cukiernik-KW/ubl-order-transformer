import { serverError } from "../domain/errors.js";
import { systemClock, type Clock } from "../ports/clock.js";
import type { MessageAttributes, Publisher } from "../ports/publisher.js";

export interface BrokerMessage {
  id: string;
  topic: string;
  json: unknown;
  attributes: MessageAttributes;
  publishedAt: Date;
}

export type DeliveryResult = "ack" | "nack";
export type PushHandler = (
  message: BrokerMessage,
  deliveryAttempt: number,
) => Promise<DeliveryResult>;

export interface SubscriptionOptions {
  /** Like Pub/Sub's dead_letter_policy.max_delivery_attempts. */
  maxDeliveryAttempts: number;
  deadLetterTopic: string;
}

interface Subscription extends SubscriptionOptions {
  name: string;
  handler: PushHandler;
}

/**
 * In-process stand-in for Pub/Sub (spec: "in-memory publisher/subscriber").
 * - Publisher: stores messages per topic, inspectable in tests.
 * - Push subscription: delivers each message to a handler; a nack or a throw is redelivered,
 *   and after maxDeliveryAttempts the message is forwarded to the dead-letter topic.
 * Differences from real Pub/Sub: redelivery is immediate (no backoff), delivery is in order,
 * and nothing survives a restart.
 */
export class InMemoryBroker implements Publisher {
  private readonly topics = new Map<string, BrokerMessage[]>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly failuresToInject = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly deliveryErrors: unknown[] = [];
  private sequence = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  publish(topic: string, json: unknown, attributes: MessageAttributes = {}): Promise<string> {
    const failures = this.failuresToInject.get(topic) ?? 0;
    if (failures > 0) {
      this.failuresToInject.set(topic, failures - 1);
      return Promise.reject(serverError(new Error(`Simulated publish failure on ${topic}`)));
    }

    const message: BrokerMessage = {
      id: String(++this.sequence),
      topic,
      // Copy, so later mutation by the caller can't change what was "sent".
      json: structuredClone(json),
      attributes: { ...attributes },
      publishedAt: this.clock.now(),
    };
    this.messagesOf(topic).push(message);

    const subscription = this.subscriptions.get(topic);
    if (subscription) this.track(this.deliver(message, subscription));
    return Promise.resolve(message.id);
  }

  /** One push subscription per topic is enough for this service. */
  subscribe(topic: string, handler: PushHandler, options: SubscriptionOptions): void {
    this.subscriptions.set(topic, { name: `${topic}.sub`, handler, ...options });
  }

  /** Makes the next `count` publishes to `topic` fail with a transient error. */
  failPublishes(topic: string, count: number): void {
    this.failuresToInject.set(topic, count);
  }

  messages(topic: string): readonly BrokerMessage[] {
    return [...this.messagesOf(topic)];
  }

  /** Resolves when every delivery, including redeliveries and dead-lettering, has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }
    if (this.deliveryErrors.length > 0) {
      throw new AggregateError(this.deliveryErrors.splice(0), "In-memory delivery failed");
    }
  }

  private messagesOf(topic: string): BrokerMessage[] {
    let list = this.topics.get(topic);
    if (!list) {
      list = [];
      this.topics.set(topic, list);
    }
    return list;
  }

  private track(delivery: Promise<void>): void {
    const tracked = delivery
      .catch((error: unknown) => {
        this.deliveryErrors.push(error);
      })
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private async deliver(message: BrokerMessage, subscription: Subscription): Promise<void> {
    // Deliver asynchronously, like a real broker: never inside the publisher's call stack.
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (let attempt = 1; attempt <= subscription.maxDeliveryAttempts; attempt++) {
      let result: DeliveryResult;
      try {
        result = await subscription.handler(message, attempt);
      } catch {
        result = "nack";
      }
      if (result === "ack") return;
    }

    // Same as the platform's dead-letter policy: the ORIGINAL payload, plus source attributes.
    await this.publish(subscription.deadLetterTopic, message.json, {
      ...message.attributes,
      CloudPubSubDeadLetterSourceSubscription: subscription.name,
      CloudPubSubDeadLetterSourceDeliveryCount: String(subscription.maxDeliveryAttempts),
    });
  }
}
