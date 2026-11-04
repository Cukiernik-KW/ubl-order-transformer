import { z } from "zod";

// Output contract (spec "Output Message Example"). Key order follows the spec; Zod's parse
// rebuilds objects in schema order, so the published JSON always has this exact shape.
export const OrderLineSchema = z.object({
  lineId: z.number().int().positive(),
  itemId: z.string().min(1),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().min(1),
  comment: z.string().nullable(),
});

export const TransformedOrderSchema = z.object({
  messageId: z.string().min(1),
  transformedAt: z.iso.datetime(),
  order: z.object({
    orderId: z.string().min(1),
    externalOrganizationId: z.string().min(1),
    reference: z.string().nullable(),
    orderDate: z.iso.date(),
    lines: z.array(OrderLineSchema).min(1),
  }),
});

export type OrderLine = z.infer<typeof OrderLineSchema>;
export type TransformedOrder = z.infer<typeof TransformedOrderSchema>;
