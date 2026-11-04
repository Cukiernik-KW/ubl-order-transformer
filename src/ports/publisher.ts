export type MessageAttributes = Record<string, string>;

export interface Publisher {
  /**
   * Publishes a JSON payload and resolves with the broker's message id.
   * Rejects with a transient AppError when the broker is unavailable.
   */
  publish(topic: string, json: unknown, attributes?: MessageAttributes): Promise<string>;
}
