import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    forkable_sessions: defineTable({
        email: v.string(),
        cookie: v.string(),
        expiresAt: v.number(), // Unix timestamp
        createdAt: v.number(), // Unix timestamp
    }).index("by_email", ["email"]),
}); 