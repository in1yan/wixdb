import { NextResponse } from "next/server";
import { LRU_PORT, LFU_PORT, sendCommands } from "@/lib/cache-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cmd = searchParams.get("cmd");
  const port = Number(searchParams.get("port") ?? LRU_PORT);
  const key = searchParams.get("key");

  if (cmd === "get" && key) {
    try {
      const [val] = await sendCommands(port, [["GET", key]]);
      return NextResponse.json({ ok: true, key, value: val });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: "Invalid query" }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, scenarioId } = body;

    const ports = [LRU_PORT, LFU_PORT];

    if (action === "reset") {
      await Promise.all(
        ports.map((port) =>
          sendCommands(port, [["FLUSHDB"]]).catch(() => null)
        )
      );
      return NextResponse.json({ ok: true, message: "Caches reset (FLUSHDB)" });
    }

    if (action === "scenario") {
      if (scenarioId === 1) {
        // Scenario 1: Basic eviction overflow
        for (const port of ports) {
          await sendCommands(port, [
            ["FLUSHDB"],
            ["SET", "A", "val-A"],
            ["SET", "B", "val-B"],
            ["SET", "C", "val-C"],
            ["SET", "D", "val-D"],
            ["SET", "E", "val-E"],
            ["GET", "A"],
            ["GET", "A"],
            ["GET", "B"],
            ["GET", "D"],
            ["GET", "E"],
            ["SET", "F", "val-F"],
          ]).catch(() => null);
        }
        return NextResponse.json({ ok: true, message: "Scenario 1 (Basic Eviction) executed" });
      }

      if (scenarioId === 2) {
        // Scenario 2: Frequency vs Recency
        for (const port of ports) {
          const cmds: string[][] = [["FLUSHDB"], ["SET", "hot", "popular-value"]];
          for (let i = 0; i < 10; i++) cmds.push(["GET", "hot"]);
          for (const k of ["w", "x", "y", "z"]) cmds.push(["SET", k, `val-${k}`]);
          for (const k of ["w", "x", "y", "z"]) cmds.push(["GET", k]);
          cmds.push(["SET", "new", "triggers-eviction"]);
          await sendCommands(port, cmds).catch(() => null);
        }
        return NextResponse.json({ ok: true, message: "Scenario 2 (Frequency vs Recency) executed" });
      }

      if (scenarioId === 3) {
        // Scenario 3: Scan Resistance
        for (const port of ports) {
          const cmds: string[][] = [["FLUSHDB"]];
          for (const k of ["ws1", "ws2", "ws3"]) cmds.push(["SET", k, `working-${k}`]);
          for (let i = 0; i < 5; i++) {
            for (const k of ["ws1", "ws2", "ws3"]) cmds.push(["GET", k]);
          }
          cmds.push(["SET", "fill1", "filler-1"]);
          cmds.push(["SET", "fill2", "filler-2"]);
          for (let i = 1; i <= 5; i++) cmds.push(["SET", `scan${i}`, `one-shot-${i}`]);
          await sendCommands(port, cmds).catch(() => null);
        }
        return NextResponse.json({ ok: true, message: "Scenario 3 (Scan Resistance) executed" });
      }

      if (scenarioId === 4) {
        // Scenario 4: TTL Expiration
        for (const port of ports) {
          await sendCommands(port, [
            ["FLUSHDB"],
            ["SET", "short-lived", "gone-soon", "EX", "5"],
            ["SET", "long-lived", "stays-around", "EX", "60"],
            ["SET", "permanent", "never-expires"],
          ]).catch(() => null);
        }
        return NextResponse.json({ ok: true, message: "Scenario 4 (TTL Expiration) executed" });
      }

      if (scenarioId === "all") {
        // Run full benchmark sequence
        for (const port of ports) {
          const cmds: string[][] = [
            ["FLUSHDB"],
            // Initial warm-up
            ["SET", "A", "val-A"],
            ["SET", "B", "val-B"],
            ["SET", "C", "val-C"],
            ["GET", "A"],
            ["GET", "A"],
            ["GET", "B"],
            ["SET", "hot", "popular"],
          ];
          for (let i = 0; i < 8; i++) cmds.push(["GET", "hot"]);
          for (const k of ["k1", "k2", "k3", "k4"]) {
            cmds.push(["SET", k, `val-${k}`]);
            cmds.push(["GET", k]);
          }
          cmds.push(["SET", "short-lived", "gone-soon", "EX", "10"]);
          cmds.push(["SET", "permanent", "stays-forever"]);
          await sendCommands(port, cmds).catch(() => null);
        }
        return NextResponse.json({ ok: true, message: "Full comparison scenario executed" });
      }
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
