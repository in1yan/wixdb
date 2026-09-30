#!/usr/bin/env python3
"""
cache_demo.py — Demonstrates LRU and LFU eviction behaviours of the custom cache server.

Prerequisites:
  - Python 3.10+
  - JDK 23+ and Maven 3.9+ (to build and run the cache server)

Usage:
  1. Start TWO cache-server instances (one LRU, one LFU) in separate terminals:

       cd cache-server
       java -cp target/classes cache.Main --port 6379 --capacity 5 --eviction LRU
       java -cp target/classes cache.Main --port 6380 --capacity 5 --eviction LFU

  2. Run this script:

       python cache_demo.py

  The script connects to both servers, runs identical access patterns, and prints
  a side-by-side comparison showing how LRU and LFU make different eviction choices.
"""

import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Optional


# ─── RESP Protocol Helpers ──────────────────────────────────────────────────────

def encode_command(*args: str) -> bytes:
    """Encode a Redis command as a RESP array of bulk strings."""
    parts = [f"*{len(args)}\r\n"]
    for arg in args:
        parts.append(f"${len(arg)}\r\n{arg}\r\n")
    return "".join(parts).encode()


def read_line(sock: socket.socket) -> str:
    """Read a CRLF-terminated line from the socket."""
    buf = b""
    while not buf.endswith(b"\r\n"):
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError("Server closed connection")
        buf += chunk
    return buf[:-2].decode()


def read_response(sock: socket.socket):
    """Parse a single RESP response from the socket."""
    line = read_line(sock)
    prefix, data = line[0], line[1:]

    if prefix == "+":                       # Simple String
        return data
    elif prefix == "-":                     # Error
        return f"ERROR: {data}"
    elif prefix == ":":                     # Integer
        return int(data)
    elif prefix == "$":                     # Bulk String
        length = int(data)
        if length == -1:
            return None
        payload = b""
        while len(payload) < length + 2:    # +2 for trailing \r\n
            payload += sock.recv(length + 2 - len(payload))
        return payload[:-2].decode()
    elif prefix == "*":                     # Array
        count = int(data)
        if count == -1:
            return None
        return [read_response(sock) for _ in range(count)]
    else:
        return line


# ─── Client Wrapper ─────────────────────────────────────────────────────────────

class CacheClient:
    """Minimal Redis-protocol client for the custom cache server."""

    def __init__(self, host: str = "localhost", port: int = 6379):
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((self.host, self.port))
        # Consume the COMMAND DOCS response that redis-cli would send;
        # our server doesn't require it, so just ensure we're clean.

    def close(self):
        if self.sock:
            try:
                self._execute("QUIT")
            except Exception:
                pass
            self.sock.close()
            self.sock = None

    def _execute(self, *args: str):
        self.sock.sendall(encode_command(*args))
        return read_response(self.sock)

    # --- Cache commands ---

    def ping(self) -> str:
        return self._execute("PING")

    def set(self, key: str, value: str, ex: int = None, px: int = None) -> str:
        cmd = ["SET", key, value]
        if ex is not None:
            cmd += ["EX", str(ex)]
        elif px is not None:
            cmd += ["PX", str(px)]
        return self._execute(*cmd)

    def get(self, key: str) -> Optional[str]:
        return self._execute("GET", key)

    def delete(self, *keys: str) -> int:
        return self._execute("DEL", *keys)

    def exists(self, *keys: str) -> int:
        return self._execute("EXISTS", *keys)

    def keys(self, pattern: str = "*") -> list:
        return self._execute("KEYS", pattern)

    def dbsize(self) -> int:
        return self._execute("DBSIZE")

    def flushdb(self) -> str:
        return self._execute("FLUSHDB")

    def info(self) -> dict:
        raw = self._execute("INFO")
        result = {}
        for line in raw.split("\r\n"):
            if ":" in line and not line.startswith("#"):
                k, v = line.split(":", 1)
                result[k.strip()] = v.strip()
        return result

    def config_get(self, param: str) -> list:
        return self._execute("CONFIG", "GET", param)


# ─── Pretty Printing ────────────────────────────────────────────────────────────

CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def banner(text: str):
    width = 70
    print()
    print(f"{BOLD}{CYAN}{'═' * width}{RESET}")
    print(f"{BOLD}{CYAN}  {text}{RESET}")
    print(f"{BOLD}{CYAN}{'═' * width}{RESET}")


def section(text: str):
    print(f"\n{BOLD}{YELLOW}── {text} {'─' * (60 - len(text))}{RESET}")


def step(text: str):
    print(f"  {DIM}▸{RESET} {text}")


def result_line(label: str, value, color=RESET):
    print(f"    {label}: {color}{value}{RESET}")


def print_keys(client: CacheClient, label: str):
    k = client.keys()
    k = sorted(k) if k else []
    print(f"    {label} keys ({len(k)}): {GREEN}{k}{RESET}")


def print_stats(client: CacheClient, label: str):
    info = client.info()
    print(f"    {BOLD}{label} stats:{RESET}")
    for field_name in ["cache_hits", "cache_misses", "cache_evictions",
                       "total_requests", "cache_hit_rate_pct", "cache_miss_rate_pct"]:
        if field_name in info:
            print(f"      {field_name}: {CYAN}{info[field_name]}{RESET}")


# ─── Demo Scenarios ─────────────────────────────────────────────────────────────

def demo_basic_eviction(lru: CacheClient, lfu: CacheClient):
    """
    Scenario 1: Fill cache to capacity, then insert one more key.
    Shows which key each policy evicts.
    """
    section("Scenario 1 — Basic Eviction on Capacity Overflow")
    print(f"  Cache capacity: 5. Insert keys A–E, then access some, then insert F.")
    print(f"  This forces one eviction — but the victim differs per policy.\n")

    for client in (lru, lfu):
        client.flushdb()

    # Fill both caches with A–E
    for key in ["A", "B", "C", "D", "E"]:
        lru.set(key, f"val-{key}")
        lfu.set(key, f"val-{key}")
    step("Inserted keys A, B, C, D, E into both caches")

    # Access pattern: read A twice, B once, skip C entirely
    # This makes A "most recent + most frequent", C "least recent + least frequent"
    for key in ["A", "A", "B", "D", "E"]:
        lru.get(key)
        lfu.get(key)
    step("Access pattern: A(×2), B(×1), D(×1), E(×1)  —  C never accessed after SET")

    # Now insert F — triggers eviction (capacity = 5)
    lru.set("F", "val-F")
    lfu.set("F", "val-F")
    step("Inserted key F → eviction triggered!\n")

    # Check who was evicted
    lru_keys = sorted(lru.keys())
    lfu_keys = sorted(lfu.keys())

    lru_evicted = sorted(set("ABCDE") - set(lru_keys))
    lfu_evicted = sorted(set("ABCDE") - set(lfu_keys))

    result_line("LRU evicted", lru_evicted, RED)
    result_line("LRU remaining keys", lru_keys, GREEN)
    result_line("LFU evicted", lfu_evicted, RED)
    result_line("LFU remaining keys", lfu_keys, GREEN)

    print(f"\n  {DIM}Explanation:{RESET}")
    print(f"  • LRU evicts the key not accessed for the longest time.")
    print(f"    After the reads [A, A, B, D, E], the recency order (most→least)")
    print(f"    is E → D → B → A → C.  So {RED}C{RESET} is evicted (least recently used).")
    print(f"  • LFU evicts the key with the fewest total accesses.")
    print(f"    Frequencies after SET + GETs:  A=3, B=2, D=2, E=2, C=1.")
    print(f"    {RED}C{RESET} has the lowest frequency, so it's evicted here too.")
    print(f"    (When frequencies tie, LFU falls back to LRU order within that bucket.)")


def demo_frequency_vs_recency(lru: CacheClient, lfu: CacheClient):
    """
    Scenario 2: Demonstrate the core difference — a frequently-used key that
    hasn't been accessed recently. LRU evicts it; LFU keeps it.
    """
    section("Scenario 2 — Frequency vs. Recency Conflict")
    print(f"  Shows the key difference: a heavily-used key that hasn't been")
    print(f"  touched recently survives under LFU but is evicted under LRU.\n")

    for client in (lru, lfu):
        client.flushdb()

    # Insert key "hot" and access it many times to build frequency
    lru.set("hot", "popular-value")
    lfu.set("hot", "popular-value")
    for _ in range(10):
        lru.get("hot")
        lfu.get("hot")
    step('Inserted "hot" and accessed it 10× (total freq = 11 incl. SET)')

    # Now fill the rest of the cache with other keys — pushing "hot" to be the
    # least-recently-used despite being the most-frequently-used
    for key in ["w", "x", "y", "z"]:
        lru.set(key, f"val-{key}")
        lfu.set(key, f"val-{key}")
    step('Filled remaining capacity with keys w, x, y, z')
    step('"hot" is now the LEAST recently used, but MOST frequently used\n')

    # Access each of w, x, y, z once more so they have freq=2
    for key in ["w", "x", "y", "z"]:
        lru.get(key)
        lfu.get(key)
    step("Accessed w, x, y, z once more (freq = 2 each)")

    # Insert a new key to force eviction
    lru.set("new", "triggers-eviction")
    lfu.set("new", "triggers-eviction")
    step('Inserted "new" → eviction triggered!\n')

    lru_has_hot = lru.get("hot") is not None
    lfu_has_hot = lfu.get("hot") is not None

    result_line("LRU kept 'hot'?", lru_has_hot, GREEN if lru_has_hot else RED)
    result_line("LFU kept 'hot'?", lfu_has_hot, GREEN if lfu_has_hot else RED)
    result_line("LRU keys", sorted(lru.keys()), GREEN)
    result_line("LFU keys", sorted(lfu.keys()), GREEN)

    print(f"\n  {DIM}Explanation:{RESET}")
    print(f"  • LRU only cares about recency. 'hot' was accessed long ago")
    print(f"    (before w, x, y, z), so LRU evicts it — {RED}losing a valuable key!{RESET}")
    print(f"  • LFU considers access frequency. 'hot' has freq=11 vs. others")
    print(f"    with freq=2, so LFU {GREEN}keeps it{RESET} and evicts the least-frequent key.")


def demo_scan_resistance(lru: CacheClient, lfu: CacheClient):
    """
    Scenario 3: A 'cache scan' — a burst of one-time keys pushes out the
    working set under LRU but not LFU.
    """
    section("Scenario 3 — Scan Resistance (One-Shot Burst)")
    print(f"  Simulates a batch job scanning through keys once. LRU is vulnerable")
    print(f"  to this 'pollution'; LFU resists it.\n")

    for client in (lru, lfu):
        client.flushdb()

    # Establish a "working set" of 3 keys, accessed repeatedly
    working_set = ["ws1", "ws2", "ws3"]
    for key in working_set:
        lru.set(key, f"working-{key}")
        lfu.set(key, f"working-{key}")

    for _ in range(5):
        for key in working_set:
            lru.get(key)
            lfu.get(key)
    step(f"Established working set {working_set}, each accessed 5× after SET (freq=6)")

    # Now add 2 filler keys to reach capacity
    for key in ["fill1", "fill2"]:
        lru.set(key, f"filler-{key}")
        lfu.set(key, f"filler-{key}")
    step("Filled cache to capacity with fill1, fill2 (freq=1 each)")

    print_keys(lru, "LRU before scan")
    print_keys(lfu, "LFU before scan")
    print()

    # Simulate a scan: rapidly SET 5 one-shot keys (forces 5 evictions)
    scan_keys = [f"scan{i}" for i in range(1, 6)]
    for key in scan_keys:
        lru.set(key, f"one-shot-{key}")
        lfu.set(key, f"one-shot-{key}")
    step(f"Scan burst: inserted {scan_keys} (each used once)\n")

    lru_remaining = sorted(lru.keys())
    lfu_remaining = sorted(lfu.keys())

    lru_ws_survived = [k for k in working_set if k in lru_remaining]
    lfu_ws_survived = [k for k in working_set if k in lfu_remaining]

    result_line("LRU keys after scan", lru_remaining, GREEN)
    result_line("LRU working-set survivors", lru_ws_survived, RED if len(lru_ws_survived) < 3 else GREEN)
    result_line("LFU keys after scan", lfu_remaining, GREEN)
    result_line("LFU working-set survivors", lfu_ws_survived, RED if len(lfu_ws_survived) < 3 else GREEN)

    print(f"\n  {DIM}Explanation:{RESET}")
    print(f"  • LRU evicts the oldest-accessed key on each insertion. The scan")
    print(f"    pushes out the entire working set since they weren't accessed")
    print(f"    during the burst — {RED}all working-set keys are lost!{RESET}")
    print(f"  • LFU evicts based on frequency. The working set (freq=6) easily")
    print(f"    outranks the scan keys (freq=1) and the fillers (freq=1),")
    print(f"    so {GREEN}all working-set keys survive{RESET}. The scan keys evict only")
    print(f"    low-frequency entries.")


def demo_ttl_expiration(client: CacheClient, label: str):
    """
    Scenario 4: Per-entry TTL — shows keys expiring independently.
    """
    section(f"Scenario 4 — TTL Expiration ({label})")
    print(f"  Demonstrates per-entry TTL. Keys expire independently of eviction.\n")

    client.flushdb()

    client.set("short-lived", "gone-soon", ex=2)
    client.set("long-lived", "stays-around", ex=30)
    client.set("permanent", "never-expires")
    step('SET "short-lived" EX 2  (expires in 2s)')
    step('SET "long-lived"  EX 30 (expires in 30s)')
    step('SET "permanent"         (no TTL)')

    result_line("Immediately — short-lived", client.get("short-lived"), GREEN)
    result_line("Immediately — long-lived", client.get("long-lived"), GREEN)
    result_line("Immediately — permanent", client.get("permanent"), GREEN)

    step("Waiting 3 seconds for short-lived to expire...")
    time.sleep(3)

    val = client.get("short-lived")
    result_line("After 3s — short-lived", val if val else "(nil) — expired!", RED if not val else GREEN)
    result_line("After 3s — long-lived", client.get("long-lived"), GREEN)
    result_line("After 3s — permanent", client.get("permanent"), GREEN)

    print_keys(client, label)


def print_final_summary(lru: CacheClient, lfu: CacheClient):
    """Print cumulative stats from both servers."""
    banner("Final Summary — Cumulative Stats")

    print(f"\n  {'Metric':<24} {'LRU':>12} {'LFU':>12}")
    print(f"  {'─' * 24} {'─' * 12} {'─' * 12}")

    lru_info = lru.info()
    lfu_info = lfu.info()

    for field_name, display in [
        ("cache_hits", "Hits"),
        ("cache_misses", "Misses"),
        ("cache_evictions", "Evictions"),
        ("total_requests", "Total Requests"),
        ("cache_hit_rate_pct", "Hit Rate"),
        ("cache_miss_rate_pct", "Miss Rate"),
    ]:
        lru_val = lru_info.get(field_name, "?")
        lfu_val = lfu_info.get(field_name, "?")
        print(f"  {display:<24} {CYAN}{lru_val:>12}{RESET} {MAGENTA}{lfu_val:>12}{RESET}")

    print(f"\n  {BOLD}Key Takeaways:{RESET}")
    print(f"  • {CYAN}LRU{RESET} is simple and effective when recent access predicts future access.")
    print(f"    However, it's vulnerable to scans and one-shot bursts that pollute the cache.")
    print(f"  • {MAGENTA}LFU{RESET} tracks long-term popularity and resists scan pollution,")
    print(f"    but can be slow to adapt when access patterns shift (old hot keys linger).")
    print(f"  • Choose based on your workload: recency-dominated → LRU, popularity-dominated → LFU.")
    print()


# ─── Main ────────────────────────────────────────────────────────────────────────

def main():
    lru_port = 6379
    lfu_port = 6380

    banner("Cache Server Demo — LRU vs. LFU Eviction Behaviour")
    print(f"\n  Connecting to LRU server on port {lru_port}...")
    print(f"  Connecting to LFU server on port {lfu_port}...")

    lru = CacheClient(port=lru_port)
    lfu = CacheClient(port=lfu_port)

    try:
        lru.connect()
        lfu.connect()
    except ConnectionRefusedError:
        print(f"\n  {RED}ERROR: Could not connect to cache servers.{RESET}")
        print(f"  Make sure both servers are running:\n")
        print(f"    Terminal 1:  java -cp target/classes cache.Main --port {lru_port} --capacity 5 --eviction LRU")
        print(f"    Terminal 2:  java -cp target/classes cache.Main --port {lfu_port} --capacity 5 --eviction LFU")
        sys.exit(1)

    # Verify connections
    assert lru.ping() == "PONG", "LRU server ping failed"
    assert lfu.ping() == "PONG", "LFU server ping failed"
    print(f"  {GREEN}✓ Both servers connected and responding.{RESET}")

    # Verify policies
    lru_policy = lru.config_get("eviction_policy")
    lfu_policy = lfu.config_get("eviction_policy")
    print(f"  LRU server policy: {CYAN}{lru_policy[1] if lru_policy else '?'}{RESET}")
    print(f"  LFU server policy: {MAGENTA}{lfu_policy[1] if lfu_policy else '?'}{RESET}")

    if lru_policy and lru_policy[1] != "LRU":
        print(f"  {RED}WARNING: Port {lru_port} is not running LRU! Results may be misleading.{RESET}")
    if lfu_policy and lfu_policy[1] != "LFU":
        print(f"  {RED}WARNING: Port {lfu_port} is not running LFU! Results may be misleading.{RESET}")

    try:
        # Run scenarios
        demo_basic_eviction(lru, lfu)
        demo_frequency_vs_recency(lru, lfu)
        demo_scan_resistance(lru, lfu)
        demo_ttl_expiration(lru, "LRU")  # TTL works the same under both; demo one
        print_final_summary(lru, lfu)
    finally:
        lru.close()
        lfu.close()


if __name__ == "__main__":
    main()
