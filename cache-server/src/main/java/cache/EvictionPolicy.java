package cache;

/**
 * Supported cache eviction policies.
 */
public enum EvictionPolicy {
    /**
     * Least Recently Used: Discards the items that have not been accessed for the longest time.
     */
    LRU,

    /**
     * Least Frequently Used: Discards the items with the lowest access count.
     */
    LFU
}
