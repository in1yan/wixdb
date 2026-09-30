package cache;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InMemoryCacheTest {

    @Test
    @DisplayName("Throws exception if capacity is not positive")
    void testInvalidCapacity() {
        assertThatThrownBy(() -> new InMemoryCache<>(0, EvictionPolicy.LRU))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("Basic put, get, and hit/miss metrics")
    void testBasicPutAndGet() {
        Cache<String, String> cache = new InMemoryCache<>(2, EvictionPolicy.LRU);

        cache.put("k1", "v1");
        assertThat(cache.get("k1")).isEqualTo(Optional.of("v1"));
        assertThat(cache.get("nonExistent")).isEmpty();

        CacheStats stats = cache.getStats();
        assertThat(stats.totalRequests()).isEqualTo(2);
        assertThat(stats.hits()).isEqualTo(1);
        assertThat(stats.misses()).isEqualTo(1);
        assertThat(stats.hitRate()).isEqualTo(0.5);
        assertThat(stats.missRate()).isEqualTo(0.5);
    }

    @Test
    @DisplayName("LRU eviction strategy: evicts least recently accessed entry")
    void testLRUEviction() {
        Cache<String, String> cache = new InMemoryCache<>(2, EvictionPolicy.LRU);

        cache.put("A", "1");
        cache.put("B", "2");

        // Access A, making B the LRU candidate
        assertThat(cache.get("A")).isPresent();

        // Adding C should evict B
        cache.put("C", "3");

        assertThat(cache.get("B")).isEmpty();
        assertThat(cache.get("A")).isPresent();
        assertThat(cache.get("C")).isPresent();
        assertThat(cache.getStats().evictions()).isEqualTo(1);
    }

    @Test
    @DisplayName("LFU eviction strategy: evicts least frequently accessed entry")
    void testLFUEviction() {
        Cache<String, String> cache = new InMemoryCache<>(3, EvictionPolicy.LFU);

        cache.put("A", "1");
        cache.put("B", "2");
        cache.put("C", "3");

        // A accessed 3 times, B accessed 1 time, C accessed 0 times
        cache.get("A");
        cache.get("A");
        cache.get("A");
        cache.get("B");

        // Adding D should evict C because frequency of C is 1 (insertion) vs B=2 vs A=4
        cache.put("D", "4");

        assertThat(cache.get("C")).isEmpty();
        assertThat(cache.get("A")).isPresent();
        assertThat(cache.get("B")).isPresent();
        assertThat(cache.get("D")).isPresent();
        assertThat(cache.getStats().evictions()).isEqualTo(1);
    }

    @Test
    @DisplayName("Per-entry TTL: entries expire independently of eviction policy")
    void testPerEntryTTL() throws InterruptedException {
        Cache<String, String> cache = new InMemoryCache<>(2, EvictionPolicy.LRU);

        cache.put("temp", "val", Duration.ofMillis(100));
        cache.put("perm", "permanent");

        assertThat(cache.get("temp")).isPresent();
        assertThat(cache.get("perm")).isPresent();

        Thread.sleep(150);

        // temp should have expired and returned empty, triggering a miss
        assertThat(cache.get("temp")).isEmpty();
        assertThat(cache.get("perm")).isPresent();

        CacheStats stats = cache.getStats();
        // 3 hits + 1 miss on expired
        assertThat(stats.hits()).isEqualTo(3);
        assertThat(stats.misses()).isEqualTo(1);
    }

    @Test
    @DisplayName("Expired entries free up capacity prior to evicting valid entries")
    void testExpiredPruningBeforeEviction() throws InterruptedException {
        Cache<String, String> cache = new InMemoryCache<>(2, EvictionPolicy.LRU);

        cache.put("k1", "v1", Duration.ofMillis(100));
        cache.put("k2", "v2");

        Thread.sleep(150); // k1 expires

        // Adding k3 when at capacity should prune expired k1 rather than evicting valid k2
        cache.put("k3", "v3");

        assertThat(cache.get("k2")).isPresent();
        assertThat(cache.get("k3")).isPresent();
        assertThat(cache.get("k1")).isEmpty();
        // Since k1 expired naturally, capacity was freed without counting as an LRU eviction
        assertThat(cache.getStats().evictions()).isEqualTo(0);
    }

    @Test
    @DisplayName("Remove and clear operations")
    void testRemoveAndClear() {
        Cache<String, String> cache = new InMemoryCache<>(5, EvictionPolicy.LRU);

        cache.put("a", "1");
        cache.put("b", "2");

        assertThat(cache.remove("a")).isTrue();
        assertThat(cache.remove("a")).isFalse();
        assertThat(cache.size()).isEqualTo(1);

        cache.clear();
        assertThat(cache.size()).isEqualTo(0);
        assertThat(cache.get("b")).isEmpty();
    }

    @Test
    @DisplayName("Thread-safe concurrent PUT and GET operations")
    void testConcurrency() throws InterruptedException {
        int capacity = 20;
        int numThreads = 8;
        int ops = 200;

        Cache<Integer, Integer> cache = new InMemoryCache<>(capacity, EvictionPolicy.LRU);
        ExecutorService executor = Executors.newFixedThreadPool(numThreads);
        CountDownLatch latch = new CountDownLatch(numThreads);

        for (int i = 0; i < numThreads; i++) {
            final int threadNum = i;
            executor.submit(() -> {
                try {
                    for (int j = 0; j < ops; j++) {
                        int key = (threadNum * 10) + (j % 15);
                        cache.put(key, j);
                        cache.get(key);
                    }
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await();
        executor.shutdown();

        assertThat(cache.size()).isLessThanOrEqualTo(capacity);
        CacheStats stats = cache.getStats();
        assertThat(stats.totalRequests()).isEqualTo(numThreads * ops);
        assertThat(stats.hits() + stats.misses()).isEqualTo(stats.totalRequests());
    }
}
