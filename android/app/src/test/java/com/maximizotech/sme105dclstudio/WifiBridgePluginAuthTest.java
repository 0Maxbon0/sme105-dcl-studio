package com.maximizotech.sme105dclstudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.fail;

import java.security.GeneralSecurityException;
import org.junit.Test;

public class WifiBridgePluginAuthTest {
    private static final String SSID = "SME105-DIRECT-2BF8";

    @Test
    public void directApUsesFirmwareCompatiblePbkdf2Sha256Vector() throws Exception {
        // Independent vector: UTF-8 "SME105-DCL-AUTH-V1:" + SSID, 10,000 rounds,
        // PBKDF2-HMAC-SHA256, 16 derived bytes rendered as lowercase hex.
        assertEquals("cbb4d68a0c00de650a1a307ef12b091a",
            WifiBridgePlugin.deriveApAuthToken("ExamplePass9", SSID));
        assertEquals(32, WifiBridgePlugin.deriveApAuthToken("Eight888", SSID).length());
        assertNotEquals(WifiBridgePlugin.deriveApAuthToken("ExamplePass9", SSID),
            WifiBridgePlugin.deriveApAuthToken("ExamplePass9", "OTHER-DIRECT-SSID"));
    }

    @Test
    public void directApRejectsInvalidPassphrasesBeforeAuthentication() throws Exception {
        expectInvalid("1234567", SSID);
        expectInvalid("a".repeat(64), SSID);
        expectInvalid("invalid\npass", SSID);
        expectInvalid("非ASCIIpassword", SSID);
        expectInvalid("ExamplePass9", "");
        expectInvalid("ExamplePass9", "SSID\nBAD");
        expectInvalid("ExamplePass9", "éSSID");
        expectInvalid("ExamplePass9", "0123456789abcdef0123456789abcdefX");
    }

    private static void expectInvalid(String password, String ssid) throws Exception {
        try {
            WifiBridgePlugin.deriveApAuthToken(password, ssid);
            fail("Expected invalid direct AP credentials to be rejected");
        } catch (GeneralSecurityException expected) {
            // Authentication is not attempted when the credentials are invalid.
        }
    }
}
