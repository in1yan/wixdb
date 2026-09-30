package cache.server;

import cache.Cache;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * TCP server that speaks the RESP protocol, allowing standard redis-cli connections.
 * Wraps a {@link Cache} instance and serves it over the network.
 */
public class CacheServer {

    private final int port;
    private final Cache<String, String> cache;

    public CacheServer(int port, Cache<String, String> cache) {
        this.port = port;
        this.cache = cache;
    }

    /**
     * Starts listening for connections. Blocks indefinitely.
     * Each client is handled on a virtual thread.
     */
    public void start() throws IOException {
        var threadFactory = Thread.ofVirtual().factory();

        try (ServerSocket serverSocket = new ServerSocket(port)) {
            serverSocket.setReuseAddress(true);

            System.out.println("Cache server listening on port " + port);
            System.out.println("Connect with: redis-cli -p " + port);
            System.out.println("Type INFO in redis-cli to see cache metrics.\n");

            while (true) {
                Socket clientSocket = serverSocket.accept();
                var handler = new ClientHandler(clientSocket, cache);
                threadFactory.newThread(handler).start();
            }
        }
    }
}
