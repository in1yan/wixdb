# WIX

A custom in-memory database with pluggable eviction policies, built from scratch in Java. The monorepo also includes a companion metrics dashboard.

## Projects

| Project | Stack | Description |
|---|---|---|
| [`cache-server/`](cache-server/) | Java 23, Maven | **WIX** — custom in-memory database with LRU/LFU eviction, per-entry TTL, and performance metrics |
| [`metrics/`](metrics/) | Next.js 16, React 19, TypeScript, Tailwind CSS 4 | Metrics dashboard web app (bootstrapped starter) |

---

## WIX (cache-server)

WIX is a lightweight, thread-safe, in-memory key-value database built from scratch in Java. It speaks the [RESP (REdis Serialization Protocol)](https://redis.io/docs/reference/protocol-spec/) wire format, so any RESP-compatible client (e.g. `redis-cli`) can connect to it out of the box — but WIX is its own database with its own cache engine, eviction logic, and stats tracking.

### Features

- **Pluggable eviction** — LRU (Least Recently Used) and LFU (Least Frequently Used)
- **Per-entry TTL** — independent expiration via duration or `EX`/`PX` flags
- **Proactive + lazy expiration** — expired keys pruned on access and swept before eviction
- **Thread-safe** — guarded by `ReentrantLock` for fine-grained concurrency
- **Real-time stats** — hits, misses, evictions, hit/miss rates
- **Virtual Threads** — Java 23 virtual threads for lightweight per-connection concurrency
- **Zero runtime dependencies** — pure Java standard library

### Supported Commands

| Command | Syntax | Description |
|---|---|---|
| `PING` | `PING [msg]` | Health check |
| `ECHO` | `ECHO <msg>` | Echo message back |
| `SET` | `SET <key> <val> [EX sec \| PX ms]` | Store key-value with optional TTL |
| `GET` | `GET <key>` | Retrieve value |
| `DEL` | `DEL <key> [key ...]` | Delete one or more keys |
| `EXISTS` | `EXISTS <key> [key ...]` | Check key existence |
| `KEYS` | `KEYS [pattern]` | List keys (supports `*` glob) |
| `DBSIZE` | `DBSIZE` | Count entries |
| `FLUSHDB` | `FLUSHDB` | Clear all entries |
| `INFO` | `INFO` | Cache config and performance stats |
| `CONFIG` | `CONFIG GET <param>` | Query `eviction_policy` or `maxcapacity` |
| `QUIT` | `QUIT` | Close connection |

### Prerequisites

- JDK 23+
- Maven 3.9+

### Build & Run

```bash
cd cache-server

# Compile
mvn compile

# Run tests
mvn test

# Package standalone JAR
mvn package

# Start WIX with defaults (port 6379, capacity 100, LRU)
java -cp target/classes cache.Main

# Start WIX with custom configuration
java -cp target/classes cache.Main --port 6380 --capacity 500 --eviction LFU
```

### Example Session

Connect with any RESP-compatible client (e.g. `redis-cli`):

```bash
# Connect to WIX
redis-cli -p 6379

127.0.0.1:6379> SET user:1 Alice EX 60
OK
127.0.0.1:6379> GET user:1
"Alice"
127.0.0.1:6379> INFO
# Cache
eviction_policy:LRU
max_capacity:100
current_size:1

# Stats
cache_hits:1
cache_misses:0
cache_evictions:0
total_requests:1
cache_hit_rate_pct:100.00%
cache_miss_rate_pct:0.00%
```

### WIX Architecture

```
cache/                                 # WIX core engine
├── Cache.java            # Cache<K,V> interface
├── EvictionPolicy.java   # LRU / LFU enum
├── CacheStats.java       # Immutable stats record
├── InMemoryCache.java    # Core implementation (HashMap + doubly-linked list)
├── Main.java             # CLI entry point
└── server/                            # WIX network layer
    ├── CacheServer.java  # TCP server (virtual threads)
    ├── ClientHandler.java # Per-connection command dispatch
    ├── RespParser.java   # RESP protocol parser
    └── RespWriter.java   # RESP protocol encoder
```

### CI

Runs on push to `master` and on PRs — executes `mvn -B test` on Ubuntu with JDK 23 (Temurin).

---

## metrics

A Next.js 16 web application bootstrapped with `create-next-app`. Currently contains the default starter template — intended to become a metrics/analytics dashboard for WIX.

### Tech Stack

- **Next.js 16** (App Router)
- **React 19** / **TypeScript 5**
- **Tailwind CSS 4** / **PostCSS**
- **Geist** font family

### Prerequisites

- Node.js 20+
- npm (or pnpm / yarn / bun)

### Setup & Run

```bash
cd metrics

# Install dependencies
npm install

# Development server (http://localhost:3000)
npm run dev

# Production build
npm run build

# Serve production build
npm run start

# Lint
npm run lint
```
