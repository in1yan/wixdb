package cache.server;

import cache.Cache;
import cache.CacheStats;

import java.io.IOException;
import java.net.Socket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Handles a single client connection over the RESP protocol.
 * Dispatches Redis-compatible commands against the shared cache instance.
 */
public class ClientHandler implements Runnable {

    private final Socket socket;
    private final Cache<String, String> cache;

    public ClientHandler(Socket socket, Cache<String, String> cache) {
        this.socket = socket;
        this.cache = cache;
    }

    @Override
    public void run() {
        try (socket) {
            RespParser parser = new RespParser(socket.getInputStream());
            RespWriter writer = new RespWriter(socket.getOutputStream());

            List<String> command;
            while ((command = parser.readCommand()) != null) {
                handleCommand(command, writer);
            }
        } catch (IOException e) {
            // Client disconnected or I/O error — silently close
        }
    }

    private void handleCommand(List<String> args, RespWriter writer) throws IOException {
        if (args.isEmpty()) {
            writer.writeError("ERR empty command");
            return;
        }

        String cmd = args.getFirst().toUpperCase();

        switch (cmd) {
            case "PING"    -> handlePing(args, writer);
            case "ECHO"    -> handleEcho(args, writer);
            case "SET"     -> handleSet(args, writer);
            case "GET"     -> handleGet(args, writer);
            case "DEL"     -> handleDel(args, writer);
            case "EXISTS"  -> handleExists(args, writer);
            case "KEYS"    -> handleKeys(args, writer);
            case "DBSIZE"  -> handleDbSize(writer);
            case "FLUSHDB" -> handleFlushDb(writer);
            case "INFO"    -> handleInfo(args, writer);
            case "CONFIG"  -> handleConfig(args, writer);
            case "COMMAND" -> handleCommandCmd(writer);
            case "CLIENT"  -> writer.writeSimpleString("OK");
            case "QUIT"    -> { writer.writeSimpleString("OK"); socket.close(); }
            default        -> writer.writeError("ERR unknown command '" + args.getFirst() + "'");
        }
    }

    // --- Command Handlers ---

    private void handlePing(List<String> args, RespWriter writer) throws IOException {
        if (args.size() > 1) {
            writer.writeBulkString(args.get(1));
        } else {
            writer.writeSimpleString("PONG");
        }
    }

    private void handleEcho(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 2) {
            writer.writeError("ERR wrong number of arguments for 'echo' command");
            return;
        }
        writer.writeBulkString(args.get(1));
    }

    private void handleSet(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 3) {
            writer.writeError("ERR wrong number of arguments for 'set' command");
            return;
        }

        String key = args.get(1);
        String value = args.get(2);
        Duration ttl = null;

        // Parse optional EX / PX flags
        for (int i = 3; i < args.size() - 1; i++) {
            String flag = args.get(i).toUpperCase();
            String flagValue = args.get(i + 1);
            switch (flag) {
                case "EX" -> { ttl = Duration.ofSeconds(Long.parseLong(flagValue)); i++; }
                case "PX" -> { ttl = Duration.ofMillis(Long.parseLong(flagValue)); i++; }
            }
        }

        if (ttl != null) {
            cache.put(key, value, ttl);
        } else {
            cache.put(key, value);
        }
        writer.writeSimpleString("OK");
    }

    private void handleGet(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 2) {
            writer.writeError("ERR wrong number of arguments for 'get' command");
            return;
        }
        Optional<String> value = cache.get(args.get(1));
        writer.writeBulkString(value.orElse(null));
    }

    private void handleDel(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 2) {
            writer.writeError("ERR wrong number of arguments for 'del' command");
            return;
        }
        int count = 0;
        for (int i = 1; i < args.size(); i++) {
            if (cache.remove(args.get(i))) count++;
        }
        writer.writeInteger(count);
    }

    private void handleExists(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 2) {
            writer.writeError("ERR wrong number of arguments for 'exists' command");
            return;
        }
        int count = 0;
        for (int i = 1; i < args.size(); i++) {
            if (cache.containsKey(args.get(i))) count++;
        }
        writer.writeInteger(count);
    }

    private void handleKeys(List<String> args, RespWriter writer) throws IOException {
        Set<String> keys = cache.keys();
        String pattern = args.size() > 1 ? args.get(1) : "*";

        List<String> matched;
        if ("*".equals(pattern)) {
            matched = new ArrayList<>(keys);
        } else {
            // Simple prefix* matching
            String prefix = pattern.endsWith("*") ? pattern.substring(0, pattern.length() - 1) : pattern;
            matched = keys.stream().filter(k -> k.startsWith(prefix)).toList();
        }
        writer.writeBulkStringArray(matched);
    }

    private void handleDbSize(RespWriter writer) throws IOException {
        writer.writeInteger(cache.size());
    }

    private void handleFlushDb(RespWriter writer) throws IOException {
        cache.clear();
        writer.writeSimpleString("OK");
    }

    private void handleInfo(List<String> args, RespWriter writer) throws IOException {
        CacheStats stats = cache.getStats();

        String info = String.join("\r\n",
            "# Cache",
            "eviction_policy:" + cache.getEvictionPolicy(),
            "max_capacity:" + cache.getCapacity(),
            "current_size:" + cache.size(),
            "",
            "# Stats",
            "cache_hits:" + stats.hits(),
            "cache_misses:" + stats.misses(),
            "cache_evictions:" + stats.evictions(),
            "total_requests:" + stats.totalRequests(),
            "cache_hit_rate:" + String.format("%.4f", stats.hitRate()),
            "cache_miss_rate:" + String.format("%.4f", stats.missRate()),
            "cache_hit_rate_pct:" + String.format("%.2f%%", stats.hitRate() * 100),
            "cache_miss_rate_pct:" + String.format("%.2f%%", stats.missRate() * 100),
            ""
        );

        writer.writeBulkString(info);
    }

    private void handleConfig(List<String> args, RespWriter writer) throws IOException {
        if (args.size() < 3) {
            writer.writeError("ERR wrong number of arguments for 'config' command");
            return;
        }

        String subCmd = args.get(1).toUpperCase();
        String param = args.get(2).toLowerCase();

        if ("GET".equals(subCmd)) {
            switch (param) {
                case "eviction_policy" -> writer.writeConfigPair("eviction_policy", cache.getEvictionPolicy().name());
                case "maxcapacity"     -> writer.writeConfigPair("maxcapacity", String.valueOf(cache.getCapacity()));
                default                -> writer.writeEmptyArray();
            }
        } else {
            writer.writeError("ERR unsupported CONFIG subcommand '" + subCmd + "'");
        }
    }

    /** Handles COMMAND and COMMAND DOCS — returns empty array so redis-cli doesn't error. */
    private void handleCommandCmd(RespWriter writer) throws IOException {
        writer.writeEmptyArray();
    }
}
