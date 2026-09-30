package cache.server;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Parses the Redis Serialization Protocol (RESP) from a raw input stream.
 * Supports arrays of bulk strings, which is the format redis-cli uses.
 */
public class RespParser {

    private final InputStream in;

    public RespParser(InputStream in) {
        this.in = new BufferedInputStream(in, 8192);
    }

    /**
     * Reads one RESP command (array of bulk strings) from the stream.
     *
     * @return list of string arguments, or null if the connection is closed
     * @throws IOException on I/O error
     */
    public List<String> readCommand() throws IOException {
        int b = in.read();
        if (b == -1) return null;

        char type = (char) b;

        if (type == '*') {
            // RESP Array
            int count = readIntLine();
            if (count < 0) return null;

            List<String> args = new ArrayList<>(count);
            for (int i = 0; i < count; i++) {
                int prefix = in.read();
                if (prefix == -1) return null;
                if ((char) prefix != '$') {
                    throw new IOException("Expected '$' in bulk string, got: " + (char) prefix);
                }
                int len = readIntLine();
                if (len < 0) return null;

                byte[] data = in.readNBytes(len);
                if (data.length != len) return null;

                // consume trailing \r\n
                in.read();
                in.read();

                args.add(new String(data));
            }
            return args;
        } else {
            // Inline command: read rest of line and split by spaces
            StringBuilder sb = new StringBuilder();
            sb.append(type);
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\r') {
                    in.read(); // consume \n
                    break;
                }
                if (c == '\n') break;
                sb.append((char) c);
            }
            String line = sb.toString().trim();
            if (line.isEmpty()) return null;
            return List.of(line.split("\\s+"));
        }
    }

    private int readIntLine() throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\r') {
                in.read(); // consume \n
                break;
            }
            if (c == '\n') break;
            sb.append((char) c);
        }
        if (sb.isEmpty()) return -1;
        return Integer.parseInt(sb.toString());
    }
}
