package com.maximizotech.sme105dclstudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class WifiBridgePluginWriteRaceTest {
    private static final long WAIT_SECONDS = 3;

    @Test
    public void queuedAttemptAWriteCannotReachReplacementAttemptB() throws Exception {
        TestPlugin plugin = new TestPlugin();
        FakeSocket socketA = new FakeSocket();
        ControlledOutputStream outputA = new ControlledOutputStream(socketA, true);
        installAuthenticatedSession(plugin, 1, socketA, outputA);

        TestCall inFlightA = new TestCall("IN-FLIGHT A");
        plugin.write(inFlightA);
        assertTrue("Attempt A write did not enter its output stream", outputA.entered.await(WAIT_SECONDS, TimeUnit.SECONDS));

        TestCall queuedA = new TestCall("QUEUED A MUST NOT MIGRATE");
        plugin.write(queuedA);
        TestCall disconnect = new TestCall(null);
        plugin.disconnect(disconnect);

        assertTrue("Disconnect did not close attempt A's socket", socketA.isClosed());
        assertFalse("Disconnect completed before the admitted write drained", disconnect.await(150, TimeUnit.MILLISECONDS));

        outputA.allowWriteToReturn.countDown();
        assertTrue(inFlightA.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertTrue(queuedA.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertTrue(disconnect.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertNotNull(inFlightA.rejection);
        assertTrue(inFlightA.rejection.contains("delivery could not be confirmed"));
        assertNotNull(queuedA.rejection);
        assertTrue(queuedA.rejection.contains("session for this queued write is no longer active"));
        assertEquals("Only the already admitted A write may enter A's output", 1, outputA.writeCalls);

        FakeSocket socketB = new FakeSocket();
        ControlledOutputStream outputB = new ControlledOutputStream(socketB, false);
        installAuthenticatedSession(plugin, 2, socketB, outputB);
        TestCall writeB = new TestCall("B ONLY");
        plugin.write(writeB);

        assertTrue(writeB.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertTrue("Attempt B write should resolve", writeB.rejection == null);
        assertEquals("B ONLY", outputB.writtenText());
        assertEquals("No attempt A bytes may be routed to attempt B", "", outputA.writtenText());
        shutdown(plugin);
    }

    @Test
    public void disconnectWaitsForConcurrentWriteToFinishAfterClosingSocket() throws Exception {
        TestPlugin plugin = new TestPlugin();
        FakeSocket socket = new FakeSocket();
        ControlledOutputStream output = new ControlledOutputStream(socket, true);
        installAuthenticatedSession(plugin, 10, socket, output);

        TestCall write = new TestCall("COMMAND DURING DISCONNECT");
        plugin.write(write);
        assertTrue("Write did not enter its output stream", output.entered.await(WAIT_SECONDS, TimeUnit.SECONDS));

        TestCall disconnect = new TestCall(null);
        plugin.disconnect(disconnect);
        assertTrue("Disconnect must close the socket while output is blocked", socket.isClosed());
        assertFalse("Disconnect must wait for the write queue barrier", disconnect.await(150, TimeUnit.MILLISECONDS));

        output.allowWriteToReturn.countDown();
        assertTrue(write.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertTrue(disconnect.await(WAIT_SECONDS, TimeUnit.SECONDS));
        assertNotNull(write.rejection);
        assertTrue(write.rejection.contains("delivery could not be confirmed"));
        assertTrue("The write must complete before disconnect reports completion", write.completedAt < disconnect.completedAt);
        assertEquals("No flush may start after the socket was revoked", 0, output.flushCalls);
        shutdown(plugin);
    }

    private static void installAuthenticatedSession(TestPlugin plugin, long generation,
                                                    FakeSocket socket, OutputStream output) throws Exception {
        Class<?> attemptClass = Class.forName(WifiBridgePlugin.class.getName() + "$ConnectAttempt");
        Constructor<?> constructor = attemptClass.getDeclaredConstructor(long.class);
        constructor.setAccessible(true);
        Object attempt = constructor.newInstance(generation);
        setField(attempt, "authenticated", true);

        setField(plugin, "activeAttempt", attempt);
        setField(plugin, "socket", socket);
        setField(plugin, "output", output);
        setField(plugin, "authenticated", true);
        setField(plugin, "connecting", false);
        setField(plugin, "disconnecting", false);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Class<?> field = target.getClass();
        while (field != null) {
            try {
                Field declared = field.getDeclaredField(name);
                declared.setAccessible(true);
                declared.set(target, value);
                return;
            } catch (NoSuchFieldException ignored) {
                field = field.getSuperclass();
            }
        }
        throw new NoSuchFieldException(name);
    }

    private static void shutdown(TestPlugin plugin) throws Exception {
        ((java.util.concurrent.ExecutorService) getField(plugin, "writeExecutor")).shutdownNow();
        ((java.util.concurrent.ExecutorService) getField(plugin, "ioExecutor")).shutdownNow();
    }

    private static Object getField(Object target, String name) throws Exception {
        Class<?> type = target.getClass();
        while (type != null) {
            try {
                Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (NoSuchFieldException ignored) {
                type = type.getSuperclass();
            }
        }
        throw new NoSuchFieldException(name);
    }

    private static final class TestPlugin extends WifiBridgePlugin {
        @Override
        protected void stopConnectionService() {}

        @Override
        protected void notifyListeners(String eventName, JSObject data) {}
    }

    private static final class TestCall extends PluginCall {
        private static final AtomicInteger COMPLETION_SEQUENCE = new AtomicInteger();
        private final String data;
        private final CountDownLatch completed = new CountDownLatch(1);
        private final AtomicBoolean completedOnce = new AtomicBoolean();
        volatile String rejection;
        volatile int completedAt;

        TestCall(String data) {
            super(null, "WifiBridge", "race-test", "write", null);
            this.data = data;
        }

        @Override
        public String getString(String name) {
            return "data".equals(name) ? data : null;
        }

        @Override
        public void resolve() {
            complete(null);
        }

        @Override
        public void resolve(JSObject value) {
            complete(null);
        }

        @Override
        public void reject(String message) {
            complete(message);
        }

        boolean await(long timeout, TimeUnit unit) throws InterruptedException {
            return completed.await(timeout, unit);
        }

        private void complete(String message) {
            if (!completedOnce.compareAndSet(false, true)) {
                throw new AssertionError("PluginCall completed more than once");
            }
            rejection = message;
            completedAt = COMPLETION_SEQUENCE.incrementAndGet();
            completed.countDown();
        }
    }

    private static final class FakeSocket extends Socket {
        private volatile boolean closed;

        @Override
        public boolean isConnected() {
            return true;
        }

        @Override
        public boolean isClosed() {
            return closed;
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static final class ControlledOutputStream extends OutputStream {
        private final FakeSocket socket;
        private final CountDownLatch allowWriteToReturn;
        final CountDownLatch entered = new CountDownLatch(1);
        private final ByteArrayOutputStream written = new ByteArrayOutputStream();
        volatile int writeCalls;
        volatile int flushCalls;

        ControlledOutputStream(FakeSocket socket, boolean block) {
            this.socket = socket;
            this.allowWriteToReturn = new CountDownLatch(block ? 1 : 0);
        }

        @Override
        public void write(int value) throws IOException {
            write(new byte[] { (byte) value }, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            writeCalls++;
            entered.countDown();
            try {
                allowWriteToReturn.await();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", error);
            }
            if (socket.isClosed()) throw new IOException("socket closed during write");
            written.write(bytes, offset, length);
        }

        @Override
        public void flush() throws IOException {
            flushCalls++;
            if (socket.isClosed()) throw new IOException("socket closed before flush");
        }

        String writtenText() {
            return new String(written.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }
}
