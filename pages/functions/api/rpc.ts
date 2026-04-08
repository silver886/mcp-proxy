import { MAX_PAYLOAD_SIZE, json } from "../lib.js";

interface Env {
  MCP_CONFIG: KVNamespace;
}

interface KvEntry {
  authHash: string;
  payload: string; // encrypted ciphertext
  createdAt: number;
}

interface RpcRequest {
  codeId: string;   // SHA-256(code), base64url — used as KV key
  authHash: string;  // HMAC-SHA-256(key, code), base64url — proves key+code knowledge
  action: "read" | "write" | "delete";
  payload?: string;  // encrypted ciphertext (write only)
}

const TTL = 900; // 15 minutes
const RATE_LIMIT_CAPACITY = 5; // max tokens (burst size)
const RATE_LIMIT_REFILL_RATE = 1 / 15; // tokens per second (1 request per 15 seconds)
const RATE_LIMIT_TTL = 600; // seconds to keep bucket in KV

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison to prevent timing attacks on authHash
// Uses crypto.subtle.timingSafeEqual with Cloudflare's recommended length-mismatch pattern
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) {
    // Compare a against itself to avoid leaking length via timing
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

// Token bucket rate limiting (per client, stored in KV)
interface TokenBucket {
  tokens: number;
  lastRefill: number; // epoch ms
}

async function checkRateLimit(kv: KVNamespace, clientId: string): Promise<boolean> {
  const key = `rate:${clientId}`;
  const now = Date.now();

  let bucket = await kv.get<TokenBucket>(key, "json");
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsed * RATE_LIMIT_REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    await kv.put(key, JSON.stringify(bucket), { expirationTtl: RATE_LIMIT_TTL });
    return false;
  }

  bucket.tokens -= 1;
  await kv.put(key, JSON.stringify(bucket), { expirationTtl: RATE_LIMIT_TTL });
  return true;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // Reject oversized requests early
  const contentLength = parseInt(context.request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return json({ error: "Request too large" }, 413);
  }

  let req: RpcRequest;
  try {
    req = await context.request.json<RpcRequest>();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!req.codeId || !req.authHash || !req.action) {
    return json({ error: "codeId, authHash, and action are required" }, 400);
  }

  const kvKey = `pair:${req.codeId}`;

  switch (req.action) {
    case "write": {
      if (!req.payload) {
        return json({ error: "payload is required for write" }, 400);
      }
      if (req.payload.length > MAX_PAYLOAD_SIZE) {
        return json({ error: `payload exceeds ${MAX_PAYLOAD_SIZE} bytes` }, 413);
      }

      // Rate limit writes per IP (hashed to avoid storing real IPs)
      const rawIp = context.request.headers.get("cf-connecting-ip") ?? "unknown";
      const ipHash = bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawIp)));
      if (!await checkRateLimit(context.env.MCP_CONFIG, ipHash)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }

      // Check if entry exists — if so, validate authHash matches
      const existing = await context.env.MCP_CONFIG.get<KvEntry>(kvKey, "json");
      if (existing && !timingSafeEqual(existing.authHash, req.authHash)) {
        return json({ error: "Unauthorized" }, 403);
      }

      const entry: KvEntry = {
        authHash: req.authHash,
        payload: req.payload,
        createdAt: Date.now(),
      };

      await context.env.MCP_CONFIG.put(kvKey, JSON.stringify(entry), {
        expirationTtl: TTL,
      });

      return json({ ok: true });
    }

    case "read": {
      const entry = await context.env.MCP_CONFIG.get<KvEntry>(kvKey, "json");

      if (!entry) {
        return json({ status: "pending" }, 404);
      }

      if (!timingSafeEqual(entry.authHash, req.authHash)) {
        return json({ error: "Unauthorized" }, 403);
      }

      return json({ payload: entry.payload });
    }

    case "delete": {
      const entry = await context.env.MCP_CONFIG.get<KvEntry>(kvKey, "json");

      if (entry && !timingSafeEqual(entry.authHash, req.authHash)) {
        return json({ error: "Unauthorized" }, 403);
      }

      await context.env.MCP_CONFIG.delete(kvKey);
      return json({ ok: true });
    }

    default:
      return json({ error: `Unknown action: ${req.action}` }, 400);
  }
};
