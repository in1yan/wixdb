package cache;

/**
 * Immutable snapshot of cache performance metrics.
 *
 * @param hits          Total number of successful cache lookups
 * @param misses        Total number of cache misses (key absent or expired)
 * @param evictions     Total number of entries evicted due to capacity limits
 * @param totalRequests Total number of lookup requests (hits + misses)
 * @param hitRate       Fraction of requests that resulted in a cache hit (0.0 to 1.0)
 * @param missRate      Fraction of requests that resulted in a cache miss (0.0 to 1.0)
 */
public record CacheStats(
    long hits,
    long misses,
    long evictions,
    long totalRequests,
    double hitRate,
    double missRate
) {
    public static CacheStats of(long hits, long misses, long evictions) {
        long total = hits + misses;
        double hitRate = total == 0 ? 0.0 : (double) hits / total;
        double missRate = total == 0 ? 0.0 : (double) misses / total;
        return new CacheStats(hits, misses, evictions, total, hitRate, missRate);
    }

    @Override
    public String toString() {
        return String.format(
            "CacheStats[Requests=%d, Hits=%d (%.2f%%), Misses=%d (%.2f%%), Evictions=%d]",
            totalRequests,
            hits,
            hitRate * 100,
            misses,
            missRate * 100,
            evictions
        );
    }
}
