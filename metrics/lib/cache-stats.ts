import { Socket } from "node:net";

const HOST = process.env.CACHE_HOST ?? "127.0.0.1";

/**
 * Each cache instance serves exactly one eviction policy, so the console polls
 * one endpoint per policy. LFU_PORT falls back to CACHE_PORT, which makes the
 * two panels read the same server until a second instance is configured.
 */
const LRU_PORT = Number(process.env.CACHE_PORT ?? 6379);
const LFU_PORT = Number(process.env.CACHE_PORT_LFU ?? process.env.CACHE_PORT ?? 6379);

const TIMEOUT_MS = 2000;

export type EvictionPolicy = "LRU" | "LFU";

export type CacheInfo = {
  hits: number;
  misses: number;
  evictions: number;
  totalRequests: number;
  hitRate: number;
  missRate: number;
  evictionPolicy: string;
  maxCapacity: number;
  currentSize: number;
};

/** One cache instance, as seen by one policy panel. */
export type PolicySnapshot = {
  status: "ok" | "unreachable";
  port: number;
  info: CacheInfo | null;
  keys: string[];
  detail: string | null;
};

/** Wire format of GET /api/stats — the single source of truth for both sides. */
export type StatsResponse = {
  fetchedAt: number;
  lru: PolicySnapshot;
  lfu: PolicySnapshot;
  /** True when both panels are pointed at the same instance. */
  shared: boolean;
};

type Reply = string | string[] | number | null;

function encodeCommand(args: string[]): string {
  const parts = args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return `*${args.length}\r\n${parts.join("")}`;
}

/**
 * Reads one RESP reply off the front of `buf`.
 * Returns null when the buffer does not yet hold a complete reply, so the caller
 * can wait for more TCP chunks.
 */
function readReply(buf: string): { value: Reply; rest: string } | null {
  if (buf.length === 0) return null;

  const type = buf[0];
  const headerEnd = buf.indexOf("\r\n");
  if (headerEnd === -1) return null;

  if (type === "$") {
    const length = Number(buf.slice(1, headerEnd));
    if (length === -1) return { value: null, rest: buf.slice(headerEnd + 2) };
    const start = headerEnd + 2;
    if (buf.length < start + length + 2) return null;
    return { value: buf.slice(start, start + length), rest: buf.slice(start + length + 2) };
  }

  if (type === "*") {
    const count = Number(buf.slice(1, headerEnd));
    if (count === -1) return { value: null, rest: buf.slice(headerEnd + 2) };

    let rest = buf.slice(headerEnd + 2);
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = readReply(rest);
      if (!item) return null;
      items.push(item.value === null ? "" : String(item.value));
      rest = item.rest;
    }
    return { value: items, rest };
  }

  if (type === ":") {
    return { value: Number(buf.slice(1, headerEnd)), rest: buf.slice(headerEnd + 2) };
  }

  if (type === "+") {
    return { value: buf.slice(1, headerEnd), rest: buf.slice(headerEnd + 2) };
  }

  if (type === "-") {
    throw new Error(`cache server error: ${buf.slice(1, headerEnd)}`);
  }

  throw new Error(`unsupported RESP reply type "${type}"`);
}

/** Opens one connection, pipelines every command, and returns replies in order. */
function sendCommands(port: number, commands: string[][]): Promise<Reply[]> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    let settled = false;

    const finish = (error: Error | null, values: Reply[] = []) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(values);
    };

    socket.setTimeout(TIMEOUT_MS, () =>
      finish(new Error(`timed out after ${TIMEOUT_MS}ms talking to cache server`)),
    );
    socket.on("error", (error) =>
      finish(
        new Error(
          `cannot reach cache server at ${HOST}:${port} (${(error as NodeJS.ErrnoException).code ?? error.message})`,
        ),
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      try {
        const replies: Reply[] = [];
        let rest = buffer;
        for (let i = 0; i < commands.length; i++) {
          const reply = readReply(rest);
          if (!reply) return;
          replies.push(reply.value);
          rest = reply.rest;
        }
        finish(null, replies);
      } catch (error) {
        finish(error as Error);
      }
    });

    socket.connect(port, HOST, () => socket.write(commands.map(encodeCommand).join("")));
  });
}

function parseInfo(info: string): CacheInfo {
  const fields = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const num = (key: string) => {
    const value = Number(fields.get(key));
    if (!Number.isFinite(value)) {
      throw new Error(`cache server INFO is missing numeric field "${key}"`);
    }
    return value;
  };

  return {
    hits: num("cache_hits"),
    misses: num("cache_misses"),
    evictions: num("cache_evictions"),
    totalRequests: num("total_requests"),
    hitRate: num("cache_hit_rate"),
    missRate: num("cache_miss_rate"),
    evictionPolicy: fields.get("eviction_policy") ?? "UNKNOWN",
    maxCapacity: num("max_capacity"),
    currentSize: num("current_size"),
  };
}

async function fetchSnapshot(port: number): Promise<{ info: CacheInfo; keys: string[] }> {
  const [info, keys] = await sendCommands(port, [
    ["INFO"],
    ["KEYS", "*"],
  ]);
  return {
    info: parseInfo(String(info)),
    keys: Array.isArray(keys) ? keys.map(String) : [],
  };
}

async function fetchPolicy(port: number): Promise<PolicySnapshot> {
  try {
    const { info, keys } = await fetchSnapshot(port);
    return { status: "ok", port, info, keys, detail: null };
  } catch (error) {
    return {
      status: "unreachable",
      port,
      info: null,
      keys: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Polls both policy instances concurrently. A dead instance degrades to its own
 * panel rather than taking the whole console down.
 */
export async function fetchStats(): Promise<StatsResponse> {
  const [lru, lfu] = await Promise.all([fetchPolicy(LRU_PORT), fetchPolicy(LFU_PORT)]);
  return { fetchedAt: Date.now(), lru, lfu, shared: LRU_PORT === LFU_PORT };
}
