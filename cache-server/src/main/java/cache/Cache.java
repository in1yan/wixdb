package cache;

import java.time.Duration;
import java.util.Optional;

/**
 * Generic in-memory cache interface supporting:
 * - Selectable eviction policy (LRU / LFU)
 * - Per-entry TTL (independent of eviction policy)
 * - Thread-safe concurrent operations
 * - Performance metrics (hit rate, miss rate, evictions)
 *
 * @param <K> Key type
 * @param <V> Value type
 */
public interface Cache<K, V> {

    /**
     * Stores a key-value mapping with no expiration (infinite TTL).
     *
     * @param key   non-null cache key
     * @param value non-null cache value
     */
    void put(K key, V value);

    /**
     * Stores a key-value mapping with a specific Time-To-Live (TTL).
     *
     * @param key   non-null cache key
     * @param value non-null cache value
     * @param ttl   duration after which entry expires, or null for no expiry
     */
    void put(K key, V value, Duration ttl);

    /**
     * Retrieves the value associated with the specified key.
     * Updates LRU/LFU tracking and hit/miss statistics.
     * Expired entries are evicted and treated as cache misses.
     *
     * @param key non-null cache key
     * @return Optional containing the value if present and unexpired, otherwise empty
     */
    Optional<V> get(K key);

    /**
     * Removes the mapping for the key if present.
     *
     * @param key cache key
     * @return true if the key was present and removed, false otherwise
     */
    boolean remove(K key);

    /**
     * Checks if a key exists and is not expired without updating LRU/LFU order.
     *
     * @param key cache key
     * @return true if key exists and is unexpired
     */
    boolean containsKey(K key);

    /**
     * Returns the current number of valid entries stored in the cache.
     */
    int size();

    /**
     * Returns the maximum capacity of the cache.
     */
    int getCapacity();

    /**
     * Returns the active eviction policy (LRU or LFU).
     */
    EvictionPolicy getEvictionPolicy();

    /**
     * Returns a snapshot of all non-expired keys currently in the cache.
     */
    java.util.Set<K> keys();

    /**
     * Clears all entries and resets the cache.
     */
    void clear();

    /**
     * Returns a snapshot of the cache performance metrics (hit rate, miss rate, etc.).
     */
    CacheStats getStats();

    /**
     * Explicitly prunes any expired entries.
     * Note: Expired entries are also evicted lazily during standard operations.
     *
     * @return number of expired entries removed
     */
    int cleanExpired();
}
