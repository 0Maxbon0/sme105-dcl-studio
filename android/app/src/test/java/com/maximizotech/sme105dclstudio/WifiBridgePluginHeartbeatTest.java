package com.maximizotech.sme105dclstudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.Test;

public class WifiBridgePluginHeartbeatTest {
    @Test
    public void parsesPongNonceAndBridgeSessionMetadata() {
        WifiBridgePlugin.Pong pong = WifiBridgePlugin.parsePong(
            "PONG 17-3 boot=boot-7 session=run-12 seq=905");

        assertEquals("17-3", pong.nonce);
        assertEquals("boot-7", pong.bootId);
        assertEquals("run-12", pong.sessionId);
        assertEquals(905L, pong.seq);
    }

    @Test
    public void rejectsMalformedPongAndNonNumericSequence() {
        assertNull(WifiBridgePlugin.parsePong("PONG wrong-format"));
        assertNull(WifiBridgePlugin.parsePong("PONG n1 boot=b session=s seq=unknown"));
    }

    @Test
    public void heartbeatStaleCheckUsesSixSecondBoundary() {
        long lastPong = 1_000_000_000L;

        assertFalse(WifiBridgePlugin.isHeartbeatStale(lastPong, lastPong + 5_999_000_000L));
        assertTrue(WifiBridgePlugin.isHeartbeatStale(lastPong, lastPong + 6_000_000_000L));
    }

    @Test
    public void watchdogRevokesConnectionIndependentlyOfBlockedWriteLock() throws IOException, InterruptedException {
        ServerSocket server = new ServerSocket(0);
        Socket client = new Socket("127.0.0.1", server.getLocalPort());
        Socket serverSide = server.accept();

        try {
            WifiBridgePlugin.ConnectAttempt attempt = new WifiBridgePlugin.ConnectAttempt(42L, false);
            attempt.socket = client;
            // Set lastValidPongNanos to 10 seconds in the past so watchdog detects it as stale (> 6s)
            attempt.lastValidPongNanos = System.nanoTime() - TimeUnit.SECONDS.toNanos(10);
            WifiBridgePlugin.setTestConnectionState(attempt, client, true);

            CountDownLatch lockAcquired = new CountDownLatch(1);
            CountDownLatch finishSignal = new CountDownLatch(1);
            AtomicBoolean writeLockHeld = new AtomicBoolean(false);

            // Simulate a blocked background writer indefinitely holding attempt.writeLock
            Thread blockedWriter = new Thread(() -> {
                synchronized (attempt.writeLock) {
                    writeLockHeld.set(true);
                    lockAcquired.countDown();
                    try {
                        finishSignal.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException ignored) {}
                }
            });
            blockedWriter.start();

            assertTrue("Writer thread must acquire writeLock", lockAcquired.await(1, TimeUnit.SECONDS));
            assertTrue("writeLock must be held by background writer", writeLockHeld.get());

            // Run heartbeat tick from watchdog thread - must NOT block on attempt.writeLock!
            long tickStart = System.currentTimeMillis();
            WifiBridgePlugin.heartbeatTick(attempt);
            long tickDuration = System.currentTimeMillis() - tickStart;

            // Heartbeat execution must complete immediately (< 500ms) without waiting for writeLock
            assertTrue("Watchdog execution must not block on writeLock; duration: " + tickDuration + "ms", tickDuration < 500);

            // Socket must be closed and connection revoked
            assertTrue("Active socket must be revoked and closed by watchdog", client.isClosed());
            assertFalse("Authentication must be cleared", WifiBridgePlugin.isTestAuthenticated());
            assertNull("Active attempt must be revoked", WifiBridgePlugin.getTestActiveAttempt());

            // Release writer thread
            finishSignal.countDown();
            blockedWriter.join(1000);
        } finally {
            WifiBridgePlugin.resetTestConnectionState();
            client.close();
            serverSide.close();
            server.close();
        }
    }
}
