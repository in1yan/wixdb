package cache;

import cache.server.CacheServer;

/**
 * Entry point for the Custom Cache Server.
 *
 * Starts a RESP-compatible TCP server that can be connected to
 * with any standard Redis client (e.g., redis-cli).
 *
 * Usage:
 *   java cache.Main [--port PORT] [--capacity CAPACITY] [--eviction LRU|LFU]
 *
 * Defaults: port=6379, capacity=100, eviction=LRU
 */
public class Main {

    public static void main(String[] args) throws Exception {
        int port = 6379;
        int capacity = 100;
        EvictionPolicy policy = EvictionPolicy.LRU;

        for (int i = 0; i < args.length - 1; i++) {
            switch (args[i]) {
                case "--port"     -> port = Integer.parseInt(args[++i]);
                case "--capacity" -> capacity = Integer.parseInt(args[++i]);
                case "--eviction" -> policy = EvictionPolicy.valueOf(args[++i].toUpperCase());
            }
        }

        Cache<String, String> cache = new InMemoryCache<>(capacity, policy);

        System.out.println("============================================================");
        System.out.println("   CUSTOM CACHE SERVER");
        System.out.println("============================================================");
        System.out.printf("  Port           : %d%n", port);
        System.out.printf("  Capacity       : %d%n", capacity);
        System.out.printf("  Eviction Policy: %s%n", policy);
        System.out.println("============================================================\n");

        new CacheServer(port, cache).start();
    }
}
