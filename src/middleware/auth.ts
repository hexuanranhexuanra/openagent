import type { MiddlewareHandler } from "hono";
import { createLogger } from "../logger";

const log = createLogger("middleware:auth");

/**
 * Feishu/Lark event signature verification middleware.
 *
 * Verifies the X-Lark-Signature header using HMAC-SHA256:
 *   signature = sha256(timestamp + nonce + encrypt_key + body)
 */
export function verifyLarkSignature(encryptKey?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!encryptKey) {
      await next();
      return;
    }

    const timestamp = c.req.header("X-Lark-Request-Timestamp") ?? "";
    const nonce = c.req.header("X-Lark-Request-Nonce") ?? "";
    const signature = c.req.header("X-Lark-Signature") ?? "";

    if (!signature) {
      log.warn("Missing Lark signature header");
      return c.json({ error: "Missing signature" }, 401);
    }

    const body = await c.req.text();
    const content = timestamp + nonce + encryptKey + body;

    const encoder = new TextEncoder();
    const key = encoder.encode(content);
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");

    if (hash !== signature) {
      log.warn("Invalid Lark signature", { expected: hash.slice(0, 8), got: signature.slice(0, 8) });
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Re-inject the parsed body so downstream handlers can read it
    c.set("rawBody", body);
    await next();
  };
}

/**
 * Bearer token auth middleware for API routes.
 */
export function bearerAuth(token?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    const provided = authHeader?.replace("Bearer ", "");

    if (provided !== token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
  };
}
