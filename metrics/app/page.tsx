"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CacheInfo, PolicySnapshot, StatsResponse } from "@/lib/cache-stats";

type Policy = "LRU" | "LFU";

type RowId =
  | "total_requests"
  | "cache_hits"
  | "cache_misses"
  | "cache_evictions"
  | "cache_hit_rate"
  | "cache_miss_rate";

type SortMode = "value-desc" | "value-asc" | "label";

type Row = {
  id: RowId;
  label: string;
  value: number;
  display: string;
  share: number;
  depth: 0 | 1;
  note: string;
};

type Sample = {
  total: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
  missRate: number;
};

type Column = { rate: number; missHeavy: boolean };

type History = Record<Policy, Sample[]>;

type Active =
  | { kind: "metric"; policy: Policy; row: Row }
  | { kind: "key"; index: number; name: string };

const POLICIES: Policy[] = ["LRU", "LFU"];

const POLICY_BLURB: Record<Policy, string> = {
  LRU: "least-recently-used entries are dropped first",
  LFU: "least-frequently-used entries are dropped first",
};

const POLICY_TAG: Record<Policy, string> = {
  LRU: "recency",
  LFU: "frequency",
};

const EMPTY: CacheInfo = {
  hits: 0,
  misses: 0,
  evictions: 0,
  totalRequests: 0,
  hitRate: 0,
  missRate: 0,
  evictionPolicy: "—",
  maxCapacity: 0,
  currentSize: 0,
};

const EMPTY_SNAPSHOT: PolicySnapshot = {
  status: "unreachable",
  port: 0,
  info: null,
  keys: [],
  detail: "connecting to cache server…",
};

const POLL_MS = 1000;
const HISTORY = 48;
const TREND_CELLS = 18;
const GRAPH_ROWS = 4;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const SORT_LABELS: Record<SortMode, string> = {
  "value-desc": "value ↓",
  "value-asc": "value ↑",
  label: "label a–z",
};

const count = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

function bar(share: number, cells: number): string {
  if (cells <= 0) return "";
  const exact = Math.max(0, Math.min(1, share)) * cells;
  const full = Math.floor(exact);
  const eighth = Math.min(7, Math.round((exact - full) * 8));
  return "█".repeat(Math.min(full, cells)) + (full < cells ? EIGHTHS[eighth] : "");
}

/** Renders a series as eighth-height block glyphs, oldest on the left. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  return values
    .map((value) => {
      const norm = span === 0 ? 0.5 : (value - min) / span;
      return SPARK[Math.min(7, Math.max(0, Math.round(norm * 7)))];
    })
    .join("");
}

/** Per-poll deltas, so monotonic counters trend as activity rather than a ramp. */
function deltas(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) out.push(Math.max(0, series[i] - series[i - 1]));
  return out;
}

function trendFor(id: RowId, history: Sample[]): number[] {
  if (history.length < 2) return [];

  if (id === "cache_hit_rate") return history.map((s) => s.hitRate);
  if (id === "cache_miss_rate") return history.map((s) => s.missRate);

  const field: Record<Exclude<RowId, "cache_hit_rate" | "cache_miss_rate">, keyof Sample> = {
    total_requests: "total",
    cache_hits: "hits",
    cache_misses: "misses",
    cache_evictions: "evictions",
  };
  return deltas(history.map((s) => s[field[id]]));
}

function buildRows(info: CacheInfo, policy: Policy): Row[] {
  const total = info.totalRequests;
  const share = (n: number) => (total === 0 ? 0 : n / total);

  return [
    {
      id: "total_requests",
      label: "total_requests",
      value: info.totalRequests,
      display: count(info.totalRequests),
      share: total === 0 ? 0 : 1,
      depth: 0,
      note: "every lookup since start — parent of all counters below",
    },
    {
      id: "cache_hits",
      label: "cache_hits",
      value: info.hits,
      display: count(info.hits),
      share: share(info.hits),
      depth: 1,
      note: "lookups served from memory without touching the origin",
    },
    {
      id: "cache_misses",
      label: "cache_misses",
      value: info.misses,
      display: count(info.misses),
      share: share(info.misses),
      depth: 1,
      note: "key absent or TTL expired — the origin had to be consulted",
    },
    {
      id: "cache_evictions",
      label: "cache_evictions",
      value: info.evictions,
      display: count(info.evictions),
      share: share(info.evictions),
      depth: 1,
      note: `entries dropped by the ${policy} policy — ${POLICY_BLURB[policy]}`,
    },
    {
      id: "cache_hit_rate",
      label: "cache_hit_rate",
      value: info.hitRate,
      display: info.hitRate.toFixed(4),
      share: info.hitRate,
      depth: 1,
      note: "hits ÷ total_requests — the headline efficiency number",
    },
    {
      id: "cache_miss_rate",
      label: "cache_miss_rate",
      value: info.missRate,
      display: info.missRate.toFixed(4),
      share: info.missRate,
      depth: 1,
      note: "misses ÷ total_requests — the complement of hit rate",
    },
  ];
}

function sortRows(
  rows: Row[],
  mode: SortMode,
  pinKey: (id: RowId) => string,
  pinned: Set<string>,
): Row[] {
  const byPin = (a: Row, b: Row) => Number(pinned.has(pinKey(b.id))) - Number(pinned.has(pinKey(a.id)));
  const byName = (a: Row, b: Row) => a.label.localeCompare(b.label);
  const desc = (a: Row, b: Row) => b.share - a.share || byName(a, b);
  const asc = (a: Row, b: Row) => a.share - b.share || byName(a, b);

  if (mode === "label") return [...rows].sort((a, b) => byPin(a, b) || byName(a, b));
  return [...rows].sort((a, b) => byPin(a, b) || (mode === "value-asc" ? asc(a, b) : desc(a, b)));
}

function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function ago(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

/**
 * Both policy blocks share one column geometry, so measuring a single bar cell
 * gives the exact glyph count for every bar on screen.
 */
function useCells(target: React.RefObject<HTMLElement | null>, glyph: React.RefObject<HTMLElement | null>) {
  const [cells, setCells] = useState(0);

  useEffect(() => {
    const node = target.current;
    const probe = glyph.current;
    if (!node || !probe) return;

    const measure = () => {
      const charWidth = probe.getBoundingClientRect().width;
      if (charWidth > 0) setCells(Math.floor(node.clientWidth / charWidth));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [target, glyph]);

  return cells;
}

export default function Home() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [sortMode, setSortMode] = useState<SortMode>("value-desc");
  const [showHelp, setShowHelp] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [history, setHistory] = useState<History>({ LRU: [], LFU: [] });
  const [frame, setFrame] = useState(0);

  const barRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cells = useCells(barRef, probeRef);

  const lru = stats?.lru ?? EMPTY_SNAPSHOT;
  const lfu = stats?.lfu ?? EMPTY_SNAPSHOT;
  const fetchedAt = stats?.fetchedAt ?? 0;
  const shared = stats?.shared ?? true;

  const snapOf = useCallback(
    (policy: Policy): PolicySnapshot => (policy === "LRU" ? lru : lfu),
    [lru, lfu],
  );

  const pinKey = useCallback((policy: Policy, id: RowId) => `${policy}:${id}`, []);

  const rowsFor = useCallback(
    (policy: Policy) => {
      const snap = snapOf(policy);
      return sortRows(
        buildRows(snap.info ?? EMPTY, policy),
        sortMode,
        (id) => pinKey(policy, id),
        pinned,
      );
    },
    [snapOf, sortMode, pinKey, pinned],
  );

  const lruRows = useMemo(() => rowsFor("LRU"), [rowsFor]);
  const lfuRows = useMemo(() => rowsFor("LFU"), [rowsFor]);

  const reportsLive = (policy: Policy) =>
    snapOf(policy).status === "ok" && snapOf(policy).info?.evictionPolicy.toUpperCase() === policy;

  /** Keys come from whichever instance is actually serving its own policy. */
  const keyPolicy: Policy = !reportsLive("LRU") && reportsLive("LFU") ? "LFU" : "LRU";
  const keys = snapOf(keyPolicy).keys;
  const keySnap = snapOf(keyPolicy);

  const lruCount = lruRows.length;
  const lfuCount = lfuRows.length;
  const rowTotal = lruCount + lfuCount + keys.length;
  const cursor = Math.max(0, Math.min(selected, Math.max(0, rowTotal - 1)));

  const active: Active | null = useMemo(() => {
    if (cursor < lruCount) {
      const row = lruRows[cursor] ?? buildRows(EMPTY, "LRU")[0];
      return row ? { kind: "metric", policy: "LRU", row } : null;
    }
    if (cursor < lruCount + lfuCount) {
      const row = lfuRows[cursor - lruCount] ?? buildRows(EMPTY, "LFU")[0];
      return row ? { kind: "metric", policy: "LFU", row } : null;
    }
    const name = keys[cursor - lruCount - lfuCount];
    return name === undefined ? null : { kind: "key", index: cursor - lruCount - lfuCount, name };
  }, [cursor, keys, lfuCount, lfuRows, lruCount, lruRows]);

  const online = lru.status === "ok" || lfu.status === "ok";
  const bothOffline = lru.status !== "ok" && lfu.status !== "ok";

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/stats", { cache: "no-store" });
      const body = (await response.json()) as StatsResponse;
      setStats(body);

      setHistory((prev) => {
        const next: History = { LRU: [...prev.LRU], LFU: [...prev.LFU] };
        let changed = false;

        for (const policy of POLICIES) {
          const snap = policy === "LRU" ? body.lru : body.lfu;
          if (snap.status !== "ok" || !snap.info) continue;
          const { hits, misses, evictions, totalRequests, hitRate, missRate } = snap.info;
          const list = [
            ...next[policy],
            { total: totalRequests, hits, misses, evictions, hitRate, missRate },
          ];
          next[policy] = list.length > HISTORY ? list.slice(list.length - HISTORY) : list;
          changed = true;
        }

        return changed ? next : prev;
      });

      if (body.lru.status === "ok" || body.lfu.status === "ok") {
        setStartedAt((prev) => prev ?? Date.now());
      }
    } catch {
      setStats({
        fetchedAt: Date.now(),
        lru: { ...EMPTY_SNAPSHOT, detail: "metrics bridge did not respond" },
        lfu: { ...EMPTY_SNAPSHOT, detail: "metrics bridge did not respond" },
        shared: true,
      });
    }
  }, []);

  const tick = useCallback(() => {
    setNow(Date.now());
    void load();
  }, [load]);

  useEffect(() => {
    const anim = setInterval(() => setFrame((f) => (f + 1) % 100000), 110);
    return () => clearInterval(anim);
  }, []);

  useEffect(() => {
    const kick = setTimeout(tick, 0);
    const poll = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(poll);
    };
  }, [tick]);

  useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, lruRows, lfuRows, keys]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;

      if (key === "?" || key === "h") {
        event.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (key === "Escape") {
        setShowHelp(false);
        return;
      }
      if (showHelp) return;

      const move = (delta: number) => {
        event.preventDefault();
        setSelected((prev) => Math.max(0, Math.min(rowTotal - 1, prev + delta)));
      };

      switch (key) {
        case "ArrowDown":
        case "j":
          return move(1);
        case "ArrowUp":
        case "k":
          return move(-1);
        case "PageDown":
          return move(8);
        case "PageUp":
          return move(-8);
        case "Home":
        case "g":
          event.preventDefault();
          return setSelected(0);
        case "End":
        case "G":
          event.preventDefault();
          return setSelected(Math.max(0, rowTotal - 1));
        case " ":
        case "Enter": {
          event.preventDefault();
          if (active?.kind !== "metric") return;
          const target = pinKey(active.policy, active.row.id);
          setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(target)) next.delete(target);
            else next.add(target);
            return next;
          });
          return;
        }
        case "a":
          event.preventDefault();
          return setPinned(
            new Set([
              ...lruRows.map((r) => pinKey("LRU", r.id)),
              ...lfuRows.map((r) => pinKey("LFU", r.id)),
            ]),
          );
        case "n":
          event.preventDefault();
          return setPinned(new Set());
        case "s":
          event.preventDefault();
          return setSortMode((prev) =>
            prev === "value-desc" ? "value-asc" : prev === "value-asc" ? "label" : "value-desc",
          );
        case "r":
          event.preventDefault();
          return void load();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, load, lfuRows, lruRows, pinKey, rowTotal, showHelp]);

  const lastSync = now && fetchedAt ? now - fetchedAt : 0;
  const uptime = startedAt && now ? now - startedAt : 0;

  const columnsFor = useCallback(
    (policy: Policy): Column[] => {
      const rates = deltas(history[policy].map((s) => s.total));
      const missRates = deltas(history[policy].map((s) => s.misses));
      return rates.map((rate, i) => {
        const missDelta = missRates[i] ?? 0;
        return { rate, missHeavy: rate > 0 && missDelta / rate > 0.5 };
      });
    },
    [history],
  );

  const columns = { LRU: columnsFor("LRU"), LFU: columnsFor("LFU") } as Record<Policy, Column[]>;
  const peaks = {
    LRU: columns.LRU.reduce((max, c) => Math.max(max, c.rate), 0),
    LFU: columns.LFU.reduce((max, c) => Math.max(max, c.rate), 0),
  } as Record<Policy, number>;

  const marquee = online
    ? POLICIES.map((policy) => {
        const snap = snapOf(policy);
        const info = snap.info;
        if (!info) return `${policy} panel offline — ${snap.detail ?? "no data"}`;
        return `${policy} ${POLICY_BLURB[policy]}  ${count(info.currentSize)}/${count(info.maxCapacity)} entries  ${count(info.totalRequests)} requests  ${pct(info.hitRate)} hit rate  ${count(info.evictions)} evictions`;
      }).join("   ·   ")
    : " OFFLINE  no link to cache server ";

  return (
    <div className="flex h-screen flex-col overflow-hidden text-[13px] leading-[1.5] select-none">
      {/* ── title bar ────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-1.5">
        <span className="flex items-baseline gap-2">
          <span className="text-[var(--term-bright)]">VINX CACHE MONITOR</span>
          <span className="text-[var(--term-faint)]">v0.1.0</span>
        </span>
        <span className="hidden items-center gap-4 text-[var(--term-dim)] lg:flex">
          <Hint keys="↑↓" label="move" />
          <Hint keys="space" label="pin" />
          <Hint keys="s" label="sort" />
          <Hint keys="r" label="refresh" />
          <Hint keys="?" label="help" />
        </span>
      </header>

      <Marquee text={marquee} frame={frame} online={online} />

      {/* ── main ─────────────────────────────────────────────────── */}
      <main className="relative flex min-h-0 flex-1 flex-col">
        {bothOffline && (
          <div className="flex shrink-0 items-center gap-3 border-b border-[var(--term-line)] px-4 py-1.5">
            <span className="text-[var(--term-bright)]">● OFFLINE</span>
            <span className="truncate text-[var(--term-dim)]">
              {POLICIES.map((p) => `${p}: ${snapOf(p).detail ?? "unreachable"}`).join("   ·   ")}
            </span>
            <span className="ml-auto hidden shrink-0 text-[var(--term-faint)] sm:block">
              java -jar cache-server --port 6379
            </span>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-3">
          {POLICIES.map((policy) => {
            const snap = snapOf(policy);
            const rows = policy === "LRU" ? lruRows : lfuRows;
            const offset = policy === "LRU" ? 0 : lruCount;
            const live = reportsLive(policy);

            return (
              <section key={policy}>
                <PolicyHeader policy={policy} snapshot={snap} live={live} shared={shared} />

                {snap.status !== "ok" ? (
                  <div className="px-4 py-px text-[var(--term-faint)]">
                    no data — {snap.detail ?? "instance unreachable"}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-4 px-4 py-px text-[var(--term-faint)]">
                      <span className="w-[20ch] shrink-0">METRIC</span>
                      <span className="w-[13ch] shrink-0 text-right">VALUE</span>
                      <span className="w-[10ch] shrink-0 text-right">SHARE</span>
                      <span className="w-[18ch] shrink-0">TREND</span>
                      <span className="min-w-[12ch] flex-1">DISTRIBUTION</span>
                    </div>

                    {rows.map((row, index) => {
                      const position = offset + index;
                      const isCursor = position === cursor;
                      const isPinned = pinned.has(pinKey(policy, row.id));
                      const trend = trendFor(row.id, history[policy]).slice(-TREND_CELLS);

                      return (
                        <div
                          key={`${policy}-${row.id}`}
                          data-cursor={isCursor}
                          onClick={() => setSelected(position)}
                          className={`flex cursor-default items-center gap-4 px-4 py-px ${
                            isCursor
                              ? "bg-[var(--term-sel)] text-[var(--term-bright)]"
                              : "text-[var(--term-fg)]"
                          }`}
                        >
                          <span className="w-[20ch] shrink-0 truncate">
                            <span className={isCursor ? "text-[var(--term-bright)]" : "text-[var(--term-faint)]"}>
                              {isCursor ? "▸" : row.depth === 0 ? " " : "├"}
                            </span>
                            {isPinned && <span className="text-[var(--term-bar)]">●</span>}
                            {row.label}
                          </span>

                          <span className="w-[13ch] shrink-0 text-right tabular-nums">{row.display}</span>

                          <span className="w-[10ch] shrink-0 text-right tabular-nums text-[var(--term-dim)]">
                            {pct(row.share)}
                          </span>

                          <span className="w-[18ch] shrink-0 overflow-hidden whitespace-pre text-[var(--term-dim)]">
                            {sparkline(trend)}
                          </span>

                          <span
                            ref={index === 0 && policy === "LRU" ? barRef : undefined}
                            className="min-w-[12ch] flex-1 overflow-hidden whitespace-pre text-[var(--term-bar)]"
                          >
                            {bar(row.share, cells)}
                            <span ref={probeRef} className="invisible absolute">
                              0
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </>
                )}
              </section>
            );
          })}

          <section>
            <div className="flex items-center gap-4 border-y border-[var(--term-line)] px-4 py-1">
              <span className="text-[var(--term-bright)]">KEYS</span>
              <span className="text-[var(--term-faint)]">{keyPolicy} · 127.0.0.1:{keySnap.port || "—"}</span>
              <span className="ml-auto text-[var(--term-faint)]">
                {keys.length} listed · {count(keySnap.info?.currentSize ?? 0)}/
                {count(keySnap.info?.maxCapacity ?? 0)} resident
              </span>
            </div>

            <div className="flex items-center gap-4 px-4 py-px text-[var(--term-faint)]">
              <span className="w-[20ch] shrink-0">KEY NAME</span>
              <span className="w-[13ch] shrink-0 text-right">#</span>
              <span className="min-w-[12ch] flex-1">TTL / FREQUENCY</span>
            </div>

            {keys.length === 0 ? (
              <div className="px-4 py-px text-[var(--term-faint)]">
                {online ? "no keys in cache" : "— keys unavailable while offline —"}
              </div>
            ) : (
              keys.map((key, index) => {
                const position = lruCount + lfuCount + index;
                const isCursor = position === cursor;
                return (
                  <div
                    key={`${key}-${index}`}
                    data-cursor={isCursor}
                    onClick={() => setSelected(position)}
                    className={`flex cursor-default items-center gap-4 px-4 py-px ${
                      isCursor ? "bg-[var(--term-sel)] text-[var(--term-bright)]" : "text-[var(--term-fg)]"
                    }`}
                  >
                    <span className="w-[20ch] shrink-0 truncate">
                      <span className={isCursor ? "text-[var(--term-bright)]" : "text-[var(--term-faint)]"}>
                        {isCursor ? "▸" : " "}
                      </span>
                      {key || "∅"}
                    </span>
                    <span className="w-[13ch] shrink-0 text-right tabular-nums text-[var(--term-faint)]">
                      {String(index + 1).padStart(3, "0")}
                    </span>
                    <span className="min-w-[12ch] flex-1 text-[var(--term-faint)]">— not exposed —</span>
                  </div>
                );
              })
            )}
          </section>
        </div>

        <Scrollbar viewport={scrollRef} />

        {/* ── live traffic, one graph per policy ──────────────────── */}
        <div className="flex shrink-0 items-stretch gap-4 border-t border-[var(--term-line)] px-4 py-1.5">
          {POLICIES.map((policy) => (
            <div key={policy} className="flex min-w-0 flex-1 items-end gap-2">
              <span className="shrink-0 text-[var(--term-faint)]">{policy}</span>
              <LiveGraph columns={columns[policy]} rows={GRAPH_ROWS} />
              <span className="shrink-0 text-[var(--term-faint)] tabular-nums">peak {peaks[policy]}/s</span>
            </div>
          ))}
          <span className="hidden shrink-0 items-center text-[var(--term-faint)] md:flex">
            <span className="text-[var(--term-bar)]">█</span> hit-led
            <span className="ml-3 text-[var(--term-bar)] opacity-45">█</span> miss-led
          </span>
        </div>

        {showHelp && <Help onClose={() => setShowHelp(false)} />}
      </main>

      {/* ── status bar ───────────────────────────────────────────── */}
      <footer className="shrink-0 border-t">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-[var(--term-dim)]">
          <Hint keys="↑↓" label="move" />
          <Hint keys="space" label="pin" />
          <Hint keys="a" label="all" />
          <Hint keys="n" label="none" />
          <Hint keys="s" label="sort" />
          <Hint keys="r" label="refresh" />
          <Hint keys="?" label="help" />

          <span className="ml-auto flex flex-wrap items-center gap-x-4 text-[var(--term-fg)]">
            <span>sort {SORT_LABELS[sortMode]}</span>
            <span>{keys.length} keys</span>
            <span>up {hms(uptime)}</span>
            <span className={online ? "text-[var(--term-dim)]" : "text-[var(--term-bright)]"}>
              {online ? `${ago(lastSync)} ago` : "no link"}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--term-line)] px-4 py-1 text-[var(--term-faint)]">
          <span className="truncate text-[var(--term-dim)]">
            {active === null
              ? "no row selected"
              : active.kind === "key"
                ? `key ${active.index + 1}/${keys.length} — ${active.name || "∅"} — no per-key ttl or frequency in the protocol`
                : `${active.row.label} · ${active.policy} — ${active.row.note}`}
          </span>
          <span className="ml-auto shrink-0">
            {POLICIES.filter(reportsLive).length === 0 ? "no live policy" : null}
            {POLICIES.map((policy) => {
              const snap = snapOf(policy);
              const info = snap.info;
              return (
                <span key={policy} className="ml-3">
                  <span className={reportsLive(policy) ? "text-[var(--term-bar)]" : "text-[var(--term-faint)]"}>
                    {reportsLive(policy) ? "●" : "·"}
                  </span>{" "}
                  {policy} {info ? `${pct(info.currentSize / (info.maxCapacity || 1))} full` : "offline"}
                </span>
              );
            })}
            {"  ·  "}
            {pinned.size} pinned
          </span>
        </div>
      </footer>
    </div>
  );
}

function PolicyHeader({
  policy,
  snapshot,
  live,
  shared,
}: {
  policy: Policy;
  snapshot: PolicySnapshot;
  live: boolean;
  shared: boolean;
}) {
  const info = snapshot.info;
  const reported = info?.evictionPolicy.toUpperCase();

  return (
    <div
      className={`flex items-center gap-4 border-y px-4 py-1 ${
        live ? "border-[var(--term-line)]" : "border-dashed border-[var(--term-line)]"
      }`}
    >
      <span className={live ? "text-[var(--term-bright)]" : "text-[var(--term-dim)]"}>
        {live ? "■" : "□"} {policy}
      </span>
      <span className="text-[var(--term-faint)]">{POLICY_TAG[policy]}</span>
      <span className="text-[var(--term-dim)]">{POLICY_BLURB[policy]}</span>

      <span className="ml-auto flex shrink-0 items-center gap-3 text-[var(--term-faint)]">
        {!live && reported && reported !== policy && (
          <span className="text-[var(--term-bright)]">instance reports {reported}</span>
        )}
        {!live && shared && !reported && (
          <span className="text-[var(--term-bright)]">set CACHE_PORT_LFU for a second instance</span>
        )}
        {live && (
          <>
            <span>127.0.0.1:{snapshot.port}</span>
            <span>
              {count(info?.currentSize ?? 0)}/{count(info?.maxCapacity ?? 0)} entries
            </span>
            <span className="text-[var(--term-dim)]">{pct(info?.hitRate ?? 0)} hit</span>
            <span>{count(info?.evictions ?? 0)} evictions</span>
          </>
        )}
        <span className={live ? "text-[var(--term-bar)]" : "text-[var(--term-faint)]"}>
          {live ? "● live" : "◦"}
        </span>
      </span>
    </div>
  );
}

function Marquee({ text, frame, online }: { text: string; frame: number; online: boolean }) {
  const cell = `${text} `;
  const period = cell.length;
  const offset = frame % period;

  return (
    <div className="shrink-0 overflow-hidden border-b border-[var(--term-line)] bg-[var(--term-panel)] py-px leading-[1.4]">
      <div className="w-[64ch] overflow-hidden whitespace-pre">
        <span
          className={online ? "text-[var(--term-dim)]" : "text-[var(--term-bright)]"}
          style={{ display: "inline-block", transform: `translateX(${-offset}ch)` }}
        >
          {cell.repeat(Math.ceil(80 / period) + 2)}
        </span>
      </div>
    </div>
  );
}

function LiveGraph({ columns, rows }: { columns: Column[]; rows: number }) {
  const max = Math.max(1, ...columns.map((c) => c.rate));
  const recent = columns.slice(-40);

  return (
    <div
      className="flex min-w-0 flex-1 items-end gap-px overflow-hidden"
      style={{ height: `${rows}lh` }}
    >
      {recent.map((column, i) => {
        // sqrt keeps mid-range traffic visible when a single spike sets the scale
        const height =
          column.rate === 0 ? 0 : Math.max(1, Math.round(Math.sqrt(column.rate / max) * rows));
        return (
          <span
            key={i}
            className={`flex flex-col-reverse justify-start ${
              column.missHeavy ? "text-[var(--term-bar)] opacity-45" : "text-[var(--term-bar)]"
            }`}
          >
            {Array.from({ length: height }, (_, k) => (
              <span key={k} className="leading-[1.5]">
                █
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded-[2px] border border-[var(--term-line)] bg-[var(--term-panel)] px-1 text-[var(--term-fg)]">
        {keys}
      </kbd>
      {label}
    </span>
  );
}

function Scrollbar({ viewport }: { viewport: React.RefObject<HTMLDivElement | null> }) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const node = track.current;
    const scroll = viewport.current;
    if (!node || !scroll) return;

    const measure = () => {
      const outer = node.clientHeight;
      const overflow = scroll.scrollHeight - scroll.clientHeight;
      if (overflow <= 0) {
        setThumb({ top: 0, height: outer });
        return;
      }
      const height = Math.max(16, (scroll.clientHeight / scroll.scrollHeight) * outer);
      const top = (scroll.scrollTop / overflow) * (outer - height);
      setThumb({ top, height });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(scroll);
    scroll.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", measure);
    };
  }, [viewport]);

  return (
    <div ref={track} aria-hidden className="pointer-events-none absolute top-0 right-0 h-full w-[2px]">
      <div
        className="absolute w-full bg-[var(--term-dim)]"
        style={{ top: thumb.top, height: thumb.height }}
      />
    </div>
  );
}

const HELP: [string, string][] = [
  ["↑ ↓ / j k", "move selection"],
  ["pgup / pgdn", "jump eight rows"],
  ["g / G", "first / last row"],
  ["space, enter", "pin or unpin metric"],
  ["a", "pin everything"],
  ["n", "clear all pins"],
  ["s", "cycle sort order"],
  ["r", "refresh immediately"],
  ["?", "toggle this panel"],
  ["esc", "dismiss"],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--term-bg)]/90 p-8">
      <div className="w-full max-w-lg border border-[var(--term-line)] bg-[var(--term-panel)]">
        <div className="flex items-center justify-between border-b border-[var(--term-line)] px-4 py-1.5">
          <span className="text-[var(--term-bright)]">KEYBOARD REFERENCE</span>
          <button
            onClick={onClose}
            className="text-[var(--term-faint)] hover:text-[var(--term-bright)]"
          >
            esc ✕
          </button>
        </div>
        <dl className="px-4 py-2">
          {HELP.map(([keys, description]) => (
            <div key={keys} className="flex items-baseline gap-4 py-px">
              <dt className="w-[14ch] shrink-0 text-[var(--term-fg)]">{keys}</dt>
              <dd className="text-[var(--term-dim)]">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
