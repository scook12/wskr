import { z } from "zod"

export * from "./protocol"
export * from "./runtime"
export * from "./backend-contract"

export const MessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  body: z.string().min(1),
})

export type Message = z.infer<typeof MessageSchema>
