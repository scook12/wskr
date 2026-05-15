import { z } from "zod"

export * from "./protocol"
export * from "./runtime"

// lots of types to parse out and get validation for. If we were using Zod from the beginning,
// I think the opencode tool index.ts file would look quite different.

export const MessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  body: z.string().min(1),
})

export type Message = z.infer<typeof MessageSchema>
