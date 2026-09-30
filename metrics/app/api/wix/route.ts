import { NextResponse } from "next/server";
import net from "net";

interface WixServerStatus {
  port: number;
  online: boolean;
  evictionPolicy?: string;
  maxCapacity?: number;
  currentSize?: number;
  hits?: number;
  misses?: number;
  evictions?: number;
  totalRequests?: number;
  hitRatePct?: string;
  missRatePct?: string;
  keys?: string[];
  error?: string;
}

function queryWixServer(port: number, timeoutMs = 1200): Promise<WixServerStatus> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let rawData = "";
    let isResolved = false;

    const finish = (result: WixServerStatus) => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);

    socket.connect(port, "127.0.0.1", () => {
      // Send INFO and KEYS * commands
      socket.write("*1\r\n$4\r\nINFO\r\n*2\r\n$4\r\nKEYS\r\n$1\r\n*\r\n");
    });

    socket.on("data", (chunk) => {
      rawData += chunk.toString("utf-8");
      // Check if we received full response
      if (rawData.includes("# Stats") && (rawData.includes("*") || rawData.includes("$"))) {
        parseResponse(rawData, port, finish);
      }
    });

    socket.on("timeout", () => {
      if (rawData.length > 0) {
        parseResponse(rawData, port, finish);
      } else {
        finish({ port, online: false, error: "Connection timed out" });
      }
    });

    socket.on("error", (err) => {
      finish({ port, online: false, error: err.message });
    });
  });
}

function parseResponse(raw: string, port: number, finish: (res: WixServerStatus) => void) {
  const result: WixServerStatus = {
    port,
    online: true,
    keys: [],
  };

  const lines = raw.split("\r\n");
  for (const line of lines) {
    if (line.includes(":") && !line.startsWith("#")) {
      const [key, val] = line.split(":", 2);
      const k = key.trim();
      const v = val.trim();

      if (k === "eviction_policy") result.evictionPolicy = v;
      if (k === "max_capacity") result.maxCapacity = parseInt(v, 10);
      if (k === "current_size") result.currentSize = parseInt(v, 10);
      if (k === "cache_hits") result.hits = parseInt(v, 10);
      if (k === "cache_misses") result.misses = parseInt(v, 10);
      if (k === "cache_evictions") result.evictions = parseInt(v, 10);
      if (k === "total_requests") result.totalRequests = parseInt(v, 10);
      if (k === "cache_hit_rate_pct") result.hitRatePct = v;
      if (k === "cache_miss_rate_pct") result.missRatePct = v;
    }
  }

  finish(result);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const portParam = searchParams.get("port");

  if (portParam) {
    const port = parseInt(portParam, 10);
    const status = await queryWixServer(port);
    return NextResponse.json(status);
  }

  // Check both default ports (6379 for LRU, 6380 for LFU)
  const [lruServer, lfuServer] = await Promise.all([
    queryWixServer(6379),
    queryWixServer(6380),
  ]);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    servers: {
      lru: lruServer,
      lfu: lfuServer,
    },
  });
}
