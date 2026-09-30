package cache.server;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Writes RESP-encoded responses to an output stream.
 */
public class RespWriter {

    private static final byte[] CRLF = "\r\n".getBytes(StandardCharsets.UTF_8);

    private final OutputStream out;

    public RespWriter(OutputStream out) {
        this.out = new BufferedOutputStream(out, 8192);
    }

    /** +OK\r\n */
    public void writeSimpleString(String msg) throws IOException {
        out.write('+');
        out.write(msg.getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        out.flush();
    }

    /** -ERR message\r\n */
    public void writeError(String msg) throws IOException {
        out.write('-');
        out.write(msg.getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        out.flush();
    }

    /** :N\r\n */
    public void writeInteger(long value) throws IOException {
        out.write(':');
        out.write(Long.toString(value).getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        out.flush();
    }

    /** $N\r\ndata\r\n or $-1\r\n for null */
    public void writeBulkString(String value) throws IOException {
        if (value == null) {
            out.write("$-1".getBytes(StandardCharsets.UTF_8));
            out.write(CRLF);
        } else {
            byte[] data = value.getBytes(StandardCharsets.UTF_8);
            out.write('$');
            out.write(Integer.toString(data.length).getBytes(StandardCharsets.UTF_8));
            out.write(CRLF);
            out.write(data);
            out.write(CRLF);
        }
        out.flush();
    }

    /** *N\r\n followed by bulk strings */
    public void writeBulkStringArray(List<String> values) throws IOException {
        out.write('*');
        out.write(Integer.toString(values.size()).getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        for (String v : values) {
            writeBulkStringNoFlush(v);
        }
        out.flush();
    }

    /** *0\r\n */
    public void writeEmptyArray() throws IOException {
        out.write("*0".getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        out.flush();
    }

    /** *-1\r\n */
    public void writeNullArray() throws IOException {
        out.write("*-1".getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        out.flush();
    }

    /** Writes a 2-element array [field, value] pair (for CONFIG GET responses) */
    public void writeConfigPair(String field, String value) throws IOException {
        out.write("*2".getBytes(StandardCharsets.UTF_8));
        out.write(CRLF);
        writeBulkStringNoFlush(field);
        writeBulkStringNoFlush(value);
        out.flush();
    }

    private void writeBulkStringNoFlush(String value) throws IOException {
        if (value == null) {
            out.write("$-1".getBytes(StandardCharsets.UTF_8));
            out.write(CRLF);
        } else {
            byte[] data = value.getBytes(StandardCharsets.UTF_8);
            out.write('$');
            out.write(Integer.toString(data.length).getBytes(StandardCharsets.UTF_8));
            out.write(CRLF);
            out.write(data);
            out.write(CRLF);
        }
    }
}
