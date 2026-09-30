# WIX Cache Server

A custom, high-performance in-memory key-value database built from scratch in Java 23 with zero runtime dependencies.

For complete architectural and algorithmic documentation across the entire monorepo, see [**`../DOCUMENTATION.md`**](../DOCUMENTATION.md).

## Highlights

- **Pluggable Eviction**: LRU (Least Recently Used) and LFU (Least Frequently Used) with $O(1)$ operations.
- **Per-Entry TTL**: Absolute millisecond timestamps with a hybrid expiration engine (lazy checking on reads + proactive sweeping on capacity limits).
- **Concurrency**: Guarded with `ReentrantLock` and paired with Java 23 Virtual Threads (`Thread.ofVirtual()`) for scalable socket handling.
- **Wire Protocol**: Fully compatible with the Redis Serialization Protocol (RESP), allowing access via `redis-cli`, Telnet, or any language client.
- **Telemetry**: Real-time hit, miss, and eviction counters with hit/miss rate calculation via `INFO`.

## Quick Start

### Build

```bash
# Compile
mvn compile

# Run tests
mvn test

# Package standalone JAR
mvn package
```

### Run

```bash
# Default (port 6379, capacity 100, LRU)
java -cp target/classes cache.Main

# Custom configuration
java -cp target/classes cache.Main --port 6380 --capacity 500 --eviction LFU
```

### Connect

```bash
redis-cli -p 6379

127.0.0.1:6379> SET app:user "alice" EX 60
OK
127.0.0.1:6379> GET app:user
"alice"
127.0.0.1:6379> INFO
```
