package cache;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Thread-safe in-memory cache implementation with selectable eviction strategy (LRU / LFU),
 * independent per-entry TTL, and performance metrics tracking.
 *
 * @param <K> Key type
 * @param <V> Value type
 */
public class InMemoryCache<K, V> implements Cache<K, V> {

    private final int capacity;
    private final EvictionPolicy evictionPolicy;
    private final Map<K, Node<K, V>> map = new HashMap<>();
    private final ReentrantLock lock = new ReentrantLock();

    // Metrics counters
    private long hits = 0;
    private long misses = 0;
    private long evictions = 0;

    // LRU Structure
    private final DoublyLinkedList<K, V> lruList = new DoublyLinkedList<>();

    // LFU Structures
    private final Map<Long, DoublyLinkedList<K, V>> freqMap = new HashMap<>();
    private long minFrequency = 1;

    public InMemoryCache(int capacity, EvictionPolicy evictionPolicy) {
        if (capacity <= 0) {
            throw new IllegalArgumentException("Cache capacity must be strictly greater than 0");
        }
        this.capacity = capacity;
        this.evictionPolicy = Objects.requireNonNull(evictionPolicy, "Eviction policy must not be null");
    }

    @Override
    public void put(K key, V value) {
        put(key, value, null);
    }

    @Override
    public void put(K key, V value, Duration ttl) {
        Objects.requireNonNull(key, "Key must not be null");
        Objects.requireNonNull(value, "Value must not be null");

        lock.lock();
        try {
            long now = System.currentTimeMillis();
            long expireAtMs = (ttl == null) ? Long.MAX_VALUE : (now + ttl.toMillis());

            Node<K, V> existing = map.get(key);
            if (existing != null) {
                // Update existing node
                existing.value = value;
                existing.expireAtMs = expireAtMs;
                recordAccess(existing);
                return;
            }

            // If at capacity, check if any expired entries can be cleaned first
            if (map.size() >= capacity) {
                cleanExpiredInternal(now);
            }

            // If still at capacity, evict an entry according to the policy
            if (map.size() >= capacity) {
                evictOne();
            }

            // Insert new node
            Node<K, V> newNode = new Node<>(key, value, expireAtMs);
            map.put(key, newNode);
            insertNodeIntoPolicy(newNode);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public Optional<V> get(K key) {
        Objects.requireNonNull(key, "Key must not be null");

        lock.lock();
        try {
            Node<K, V> node = map.get(key);
            if (node == null) {
                misses++;
                return Optional.empty();
            }

            long now = System.currentTimeMillis();
            if (node.isExpired(now)) {
                // TTL expired independent of eviction strategy
                removeNodeFromPolicy(node);
                map.remove(key);
                misses++;
                return Optional.empty();
            }

            hits++;
            recordAccess(node);
            return Optional.of(node.value);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public boolean remove(K key) {
        Objects.requireNonNull(key, "Key must not be null");

        lock.lock();
        try {
            Node<K, V> node = map.remove(key);
            if (node == null) {
                return false;
            }
            removeNodeFromPolicy(node);
            return true;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public boolean containsKey(K key) {
        Objects.requireNonNull(key, "Key must not be null");

        lock.lock();
        try {
            Node<K, V> node = map.get(key);
            if (node == null) {
                return false;
            }
            if (node.isExpired(System.currentTimeMillis())) {
                removeNodeFromPolicy(node);
                map.remove(key);
                return false;
            }
            return true;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public int size() {
        lock.lock();
        try {
            cleanExpiredInternal(System.currentTimeMillis());
            return map.size();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public int getCapacity() {
        return capacity;
    }

    @Override
    public EvictionPolicy getEvictionPolicy() {
        return evictionPolicy;
    }

    @Override
    public Set<K> keys() {
        lock.lock();
        try {
            cleanExpiredInternal(System.currentTimeMillis());
            return new HashSet<>(map.keySet());
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void clear() {
        lock.lock();
        try {
            map.clear();
            lruList.clear();
            freqMap.clear();
            minFrequency = 1;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public CacheStats getStats() {
        lock.lock();
        try {
            return CacheStats.of(hits, misses, evictions);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public int cleanExpired() {
        lock.lock();
        try {
            return cleanExpiredInternal(System.currentTimeMillis());
        } finally {
            lock.unlock();
        }
    }

    // --- Internal Helpers (Assumes caller holds lock) ---

    private int cleanExpiredInternal(long now) {
        List<K> expiredKeys = new ArrayList<>();
        for (Node<K, V> node : map.values()) {
            if (node.isExpired(now)) {
                expiredKeys.add(node.key);
            }
        }
        for (K key : expiredKeys) {
            Node<K, V> node = map.remove(key);
            if (node != null) {
                removeNodeFromPolicy(node);
            }
        }
        return expiredKeys.size();
    }

    private void insertNodeIntoPolicy(Node<K, V> node) {
        if (evictionPolicy == EvictionPolicy.LRU) {
            lruList.addFirst(node);
        } else {
            node.frequency = 1;
            minFrequency = 1;
            freqMap.computeIfAbsent(1L, _ -> new DoublyLinkedList<>()).addFirst(node);
        }
    }

    private void recordAccess(Node<K, V> node) {
        if (evictionPolicy == EvictionPolicy.LRU) {
            lruList.moveToFirst(node);
        } else {
            long oldFreq = node.frequency;
            DoublyLinkedList<K, V> list = freqMap.get(oldFreq);
            if (list != null) {
                list.remove(node);
                if (list.isEmpty()) {
                    freqMap.remove(oldFreq);
                    if (minFrequency == oldFreq) {
                        minFrequency++;
                    }
                }
            }
            node.frequency++;
            freqMap.computeIfAbsent(node.frequency, _ -> new DoublyLinkedList<>()).addFirst(node);
        }
    }

    private void removeNodeFromPolicy(Node<K, V> node) {
        if (evictionPolicy == EvictionPolicy.LRU) {
            lruList.remove(node);
        } else {
            DoublyLinkedList<K, V> list = freqMap.get(node.frequency);
            if (list != null) {
                list.remove(node);
                if (list.isEmpty()) {
                    freqMap.remove(node.frequency);
                }
            }
        }
    }

    private void evictOne() {
        Node<K, V> evictedNode;
        if (evictionPolicy == EvictionPolicy.LRU) {
            evictedNode = lruList.removeLast();
        } else {
            DoublyLinkedList<K, V> minList = freqMap.get(minFrequency);
            if (minList != null) {
                evictedNode = minList.removeLast();
                if (minList.isEmpty()) {
                    freqMap.remove(minFrequency);
                }
            } else {
                evictedNode = null;
            }
        }

        if (evictedNode != null) {
            map.remove(evictedNode.key);
            evictions++;
        }
    }

    // --- Linked Node and List Data Structures ---

    static class Node<K, V> {
        final K key;
        V value;
        long expireAtMs;
        long frequency;
        Node<K, V> prev;
        Node<K, V> next;

        Node(K key, V value, long expireAtMs) {
            this.key = key;
            this.value = value;
            this.expireAtMs = expireAtMs;
            this.frequency = 1;
        }

        boolean isExpired(long now) {
            return expireAtMs != Long.MAX_VALUE && now > expireAtMs;
        }
    }

    static class DoublyLinkedList<K, V> {
        final Node<K, V> head;
        final Node<K, V> tail;
        int size;

        DoublyLinkedList() {
            head = new Node<>(null, null, Long.MAX_VALUE);
            tail = new Node<>(null, null, Long.MAX_VALUE);
            head.next = tail;
            tail.prev = head;
            size = 0;
        }

        void addFirst(Node<K, V> node) {
            node.next = head.next;
            node.prev = head;
            head.next.prev = node;
            head.next = node;
            size++;
        }

        void remove(Node<K, V> node) {
            if (node.prev != null && node.next != null) {
                node.prev.next = node.next;
                node.next.prev = node.prev;
                node.prev = null;
                node.next = null;
                size--;
            }
        }

        void moveToFirst(Node<K, V> node) {
            remove(node);
            addFirst(node);
        }

        Node<K, V> removeLast() {
            if (size == 0) {
                return null;
            }
            Node<K, V> last = tail.prev;
            remove(last);
            return last;
        }

        boolean isEmpty() {
            return size == 0;
        }

        void clear() {
            head.next = tail;
            tail.prev = head;
            size = 0;
        }
    }
}
