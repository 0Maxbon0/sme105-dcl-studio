#include <Arduino.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <esp_system.h>
#include <bootloader_random.h>
#include <mbedtls/base64.h>
#include <lwip/sockets.h>
#include <cerrno>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <driver/rmt.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <soc/soc.h>
#include <soc/uart_struct.h>
#include <soc/uart_reg.h>
#include <soc/gpio_struct.h>
#include <soc/gpio_sig_map.h>
#include <soc/timer_group_struct.h>
#include <soc/rmt_struct.h>
#include <cstring>
#include <algorithm>

// Ford EEC-IV experimental 97AB SME-105 USB field bridge.
// There is NO arbitrary bus write API and NO automatic vehicle transmission.
// Flxkrmr B=26A4 and doncreat0r B=260E are competing SOURCE CANDIDATES,
// not an ECU-supported or verified DTC command. No erase/actuator modes.
namespace {
constexpr int kRO = 16, kDI = 17, kDE = 18;
constexpr uint8_t kEchoId[] = {0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr uint8_t kGoCart[] = {0, 0, 0, 0, 0, 1, 0x04, 0, 0, 0, 0x05};
constexpr uint32_t kCaptureMs = 10000, kQuietMs = 150, kAckMs = 400;
constexpr uint32_t kArmMs = 15000, kHandshakeWatchdogUs = 75000;
constexpr uint32_t kSlotWatchdogUs = 2250;
constexpr uint32_t kSlotMinLeadUs = 180, kSlotMaxLeadUs = 1250;
constexpr uint32_t kGapToleranceUs = 175;
constexpr size_t kRxRingSize = 2048; // single producer ISR / single USB consumer
constexpr uint16_t kWiFiPort = 8765;
constexpr size_t kWireQueueSize = 16384; // bounded, no allocation/IO in ISR
constexpr uint32_t kAuthDeadlineMs = 5000;
constexpr uint32_t kStaRetryMs = 10000;
static_assert((kRxRingSize & (kRxRingSize - 1)) == 0, "ring power of two");
static_assert((kWireQueueSize & (kWireQueueSize - 1)) == 0, "wire ring power of two");

// All USB commands run in loop(); only register operations run in UART/timer ISRs.
enum Stage : uint8_t { IDLE, QUIET, ECHO_TX, ACK_WAIT, GO_TX,
                       CART_PASSIVE, CART_READ, FINISHING, FAULTED };
enum Fault : uint8_t { NO_FAULT, BAD_IDLE, HSK_TX, HSK_TIMEOUT, HSK_ACK,
                       CART_INIT, CART_ERR, CART_HEADER, CART_PHASE,
                       CART_CADENCE, CART_TIMER, PAD_MISMATCH, PAD_FRAMING,
                       DE_TIMEOUT, RX_OVERFLOW, HOST_STOP, CAPTURE_TIMEOUT,
                       TRANSPORT_BACKPRESSURE };
struct RxEvent { uint32_t at; uint8_t value; };
struct HeaderByte { uint32_t at; uint8_t value; };
struct CmdWord { uint8_t first; uint8_t second; };
constexpr CmdWord IRAM_ATTR word(uint8_t variant, uint8_t slot) {
  return slot == 0 ? CmdWord{0x01,0xB0} :
         slot == 1 ? CmdWord{0xFF,0x5F} :
         slot == 2 ? (variant == 0 ? CmdWord{0x26,0xA4} : CmdWord{0x26,0x0E}) :
         CmdWord{0x00,0xA0};
}
constexpr uint8_t parity(uint8_t first, uint8_t id) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^ id ^ 10) << 4) | id);
}
static_assert(parity(1,0)==0xB0 && parity(0xFF,15)==0x5F &&
              parity(0x26,4)==0xA4 && parity(0x26,14)==0x0E,
              "candidate reference parity");

HardwareSerial referenceBus(2);
hw_timer_t* deTimer = nullptr;
hw_timer_t* slotTimer = nullptr;
intr_handle_t uart1Handle = nullptr;
intr_handle_t uart2Handle = nullptr;
portMUX_TYPE txLock = portMUX_INITIALIZER_UNLOCKED;
volatile Stage stage = IDLE;
volatile Fault failure = NO_FAULT;
volatile bool stopLatched = true, deCutoff = false, slotInFlight = false;
volatile bool slotArmed = false, uart1Live = false;
volatile uint32_t targetUs = 0;
volatile uint8_t variant = 0, pendingSlot = 0;
volatile uint8_t wordsStarted = 0, wordsVerified = 0;
volatile uint8_t padCount = 0;
volatile uint8_t padRx[4][2] = {{0}};
volatile uint32_t txStartUs[4] = {}, txDoneUs[4] = {};
volatile uint32_t uartErr = 0, lostRx = 0, rxTotal = 0;
volatile uint16_t rxWrite = 0, rxRead = 0;
RxEvent rxRing[kRxRingSize] = {};
volatile bool frameLocked = false, captureOnly = false;
volatile uint8_t headerUsed = 0, baselineCount = 0, phase = 255, nextId = 0;
volatile uint32_t lastSyncUs = 0;
HeaderByte header[4] = {};
uint32_t stageStartedMs = 0, captureStartedMs = 0, armExpiresMs = 0;
uint32_t refTxStartedUs = 0, ackLastMs = 0;
uint8_t ack[16] = {}, ackCount = 0;
volatile uint32_t handshakeErrors = 0;
volatile bool transmitConsumed = false;
volatile bool observeConsumed = false; // active Echo-ID/Go-CART, not passive sniff
uint8_t armedVariant = 255;
bool armedFromUSB = true; // ARM/READ must originate on the same authenticated transport
bool nativeReady = false, refReady = false, gateReady = false;
uint8_t gateChannels = 0;
char commandBuffer[176] = {}; // USB-only base64 provisioning up to 44+84 chars
uint8_t commandUsed = 0;
bool discardLine = false;
uint8_t sentPadReports = 0;
uint32_t reportedErrors = 0, reportedLost = 0;
uint8_t lastReportedBaseline = 0;

// No Wi-Fi operation in CART/UART/timer ISR paths. Firmware emits bounded
// ASCII into a single fan-out queue. USB and authenticated TCP have separate
// cursors: neither is silently allowed to skip a byte.
class BridgeOutput : public Print {
 public:
  size_t write(uint8_t byte) override {
    if (used() >= kWireQueueSize) { ++overflow_; return 0; }
    bytes_[write_++ & (kWireQueueSize - 1)] = byte;
    return 1;
  }
  size_t write(const uint8_t* buffer, size_t count) override {
    size_t wrote = 0;
    while (wrote < count && write(buffer[wrote])) ++wrote;
    if (wrote != count) overflow_ += static_cast<uint32_t>(count - wrote - 1);
    return wrote;
  }
  using Print::write;
  size_t freeBytes() const { return kWireQueueSize - used(); }
  uint32_t queued() const { return write_; }
  uint32_t usbCursor() const { return usbRead_; }
  uint32_t tcpCursor() const { return tcpRead_; }
  uint32_t overflow() const { return overflow_; }
  void dropTcpAtCurrent() { tcpRead_ = write_; tcpEnabled_ = false; tcpSendFailed_ = false; }
  void markTcpAuthenticated() { tcpRead_ = write_; tcpEnabled_ = true; tcpSendFailed_ = false; }
  bool tcpSendFailed() const { return tcpSendFailed_; }
  void drainUSB() {
    if (usbRead_ == write_) return;
    const int capacity = Serial.availableForWrite();
    if (capacity <= 0) return;
    const size_t len = std::min(static_cast<size_t>(capacity),
        std::min(static_cast<size_t>(write_ - usbRead_),
                 std::min(static_cast<size_t>(256), kWireQueueSize - (usbRead_ & (kWireQueueSize - 1)))));
    usbRead_ += Serial.write(bytes_ + (usbRead_ & (kWireQueueSize - 1)), len);
  }
  void drainTCP(WiFiClient& client) {
    if (tcpRead_ == write_) return;
    // Arduino ESP32 WiFiClient::write may block for 10 select(1s) retries;
    // availableForWrite() is the inherited default ZERO. Neither is safe
    // during a 10ms ECU frame cadence. Use lwIP nonblocking send directly.
    const int socket = client.fd();
    if (socket < 0) { tcpSendFailed_ = true; return; }
    const size_t len = std::min(static_cast<size_t>(write_ - tcpRead_),
                        std::min(static_cast<size_t>(128),
                                 kWireQueueSize - (tcpRead_ & (kWireQueueSize - 1))));
    const int sent = ::send(socket, bytes_ + (tcpRead_ & (kWireQueueSize - 1)),
                            len, MSG_DONTWAIT);
    if (sent > 0) tcpRead_ += static_cast<uint32_t>(sent);
    else if (sent == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR))
      tcpSendFailed_ = true;
  }
 private:
  uint32_t used() const {
    // While TCP is unauthenticated/disconnected, tcpRead_=write_ and USB
    // alone constrains the queue. When authenticated, both cursors constrain it.
    return write_ - (tcpEnabled_ ? std::min(usbRead_, tcpRead_) : usbRead_);
  }
  uint8_t bytes_[kWireQueueSize] = {};
  uint32_t write_ = 0, usbRead_ = 0, tcpRead_ = 0, overflow_ = 0;
  bool tcpEnabled_ = false, tcpSendFailed_ = false;
};
BridgeOutput out;
Preferences wifiPrefs;
WiFiServer wifiServer(kWiFiPort);
WiFiClient wifiClient;
bool wifiConfigured = false, tcpAuthenticated = false;
bool tcpHadActiveSession = false;
bool wifiServerStarted = false;
bool prefsReady = false, mdnsStarted = false, commandFromUSB = true;
char wifiToken[33] = {};
char wifiLine[96] = {};
uint8_t wifiLineUsed = 0;
bool wifiLineDiscard = false;
uint32_t wifiAuthStartedMs = 0, wifiLastRetryMs = 0;
uint32_t transportFaults = 0;
void runCommand(const char* command);
void stopEverything(Fault reason);

bool busSessionActive() {
  return stage != IDLE && stage != FINISHING && stage != FAULTED;
}
void clearSecrets(void* target, size_t size) {
  volatile uint8_t* p = static_cast<volatile uint8_t*>(target);
  while (size--) *p++ = 0;
}
bool validHexToken(const char* value) {
  if (strlen(value) != 32) return false;
  for (size_t i = 0; i < 32; ++i) {
    const char c = value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}
bool generateToken() {
  uint8_t bytes[16];
  // Initial NVS token creation and WIFI_FORGET both run before/after RF.
  // Mix SAR ADC entropy into ESP32 HWRNG instead of trusting an RF-off seed.
  bootloader_random_enable();
  esp_fill_random(bytes, sizeof bytes);
  bootloader_random_disable();
  static constexpr char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof bytes; ++i) {
    wifiToken[2 * i] = alphabet[bytes[i] >> 4];
    wifiToken[2 * i + 1] = alphabet[bytes[i] & 15];
  }
  wifiToken[32] = 0;
  clearSecrets(bytes, sizeof bytes);
  return prefsReady && wifiPrefs.putString("token", wifiToken) == 32;
}
bool validBase64(const char* s, size_t maxEncoded) {
  const size_t n = strlen(s);
  if (n == 0 || n > maxEncoded || (n % 4) != 0) return false;
  bool padding = false;
  for (size_t i = 0; i < n; ++i) {
    const char c = s[i];
    if (c == '=') { if (i < n - 2) return false; padding = true; }
    else if (padding || !((c >= 'A' && c <= 'Z') ||
                         (c >= 'a' && c <= 'z') ||
                         (c >= '0' && c <= '9') || c == '+' || c == '/')) return false;
  }
  return true;
}
bool decodeBase64(const char* input, char* output, size_t cap, size_t& decoded) {
  decoded = 0;
  if (mbedtls_base64_decode(reinterpret_cast<unsigned char*>(output), cap - 1,
                            &decoded, reinterpret_cast<const unsigned char*>(input),
                            strlen(input)) != 0 || decoded >= cap) return false;
  output[decoded] = 0;
  return memchr(output, 0, decoded) == nullptr;
}
void dropTcpClient(bool transportLost) {
  if (armedVariant < 2 && !armedFromUSB) armedVariant = 255;
  if (transportLost && tcpAuthenticated) {
    ++transportFaults;
    if (busSessionActive()) stopEverything(HOST_STOP);
  }
  tcpAuthenticated = false;
  tcpHadActiveSession = false;
  wifiLineUsed = 0;
  wifiLineDiscard = false;
  if (wifiClient) wifiClient.stop();
  out.dropTcpAtCurrent();
}
bool tokenMatches(const char* supplied) {
  if (!validHexToken(wifiToken) || strlen(supplied) != 32) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < 32; ++i) {
    char c = supplied[i];
    if (c >= 'A' && c <= 'F') c = static_cast<char>(c + ('a' - 'A'));
    diff |= static_cast<uint8_t>(c ^ wifiToken[i]);
  }
  return diff == 0;
}
void startSta() {
  if (!wifiConfigured || !prefsReady || busSessionActive()) return;
  const String ssid = wifiPrefs.getString("ssid", "");
  const String pass = wifiPrefs.getString("pass", "");
  if (ssid.length() < 1 || ssid.length() > 32 ||
      pass.length() < 8 || pass.length() > 63) {
    wifiConfigured = false;
    return;
  }
  WiFi.mode(WIFI_STA); // NEVER enable an access point
  WiFi.persistent(false);
  WiFi.setHostname("sme105-bridge");
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str()); // asynchronous; no waiting or retry TX
  wifiLastRetryMs = millis();
}
void initializeWiFi() {
  prefsReady = wifiPrefs.begin("sme105wifi", false);
  if (!prefsReady) { WiFi.mode(WIFI_OFF); return; }
  const String savedToken = wifiPrefs.getString("token", "");
  if (savedToken.length() == 32 && validHexToken(savedToken.c_str())) {
    memcpy(wifiToken, savedToken.c_str(), 33);
  } else if (!generateToken()) {
    clearSecrets(wifiToken, sizeof(wifiToken));
    WiFi.mode(WIFI_OFF);
    return;
  }
  const String ssid = wifiPrefs.getString("ssid", "");
  const String pass = wifiPrefs.getString("pass", "");
  wifiConfigured = ssid.length() >= 1 && ssid.length() <= 32 &&
                   pass.length() >= 8 && pass.length() <= 63;
  if (wifiConfigured) startSta();
  else WiFi.mode(WIFI_OFF);
}
void printWiFiStatus() {
  out.print(F("WIFI_STATUS state="));
  if (!wifiConfigured) out.print(F("DISABLED"));
  else if (WiFi.status() == WL_CONNECTED) out.print(F("CONNECTED"));
  else out.print(F("CONNECTING"));
  out.print(F(" ip="));
  if (wifiConfigured && WiFi.status() == WL_CONNECTED) out.print(WiFi.localIP());
  else out.print(F("0.0.0.0"));
  out.print(F(" port=")); out.print(kWiFiPort);
  out.print(F(" clients=")); out.print(tcpAuthenticated ? 1 : 0);
  // Canonical host label is stable; callers must use IP until CONNECTED.
  // Actual mDNS resolution is opportunistic, never a safety authority.
  out.println(F(" host=sme105-bridge.local"));
}
void processWiFiProvision(const char* command) {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (busSessionActive() || stage == FINISHING) {
    out.println(F("DENIED wifi_busy")); return;
  }
  constexpr size_t prefix = sizeof("WIFI_CONFIG ") - 1;
  const char* left = command + prefix;
  const char* space = strchr(left, ' ');
  if (!space || strchr(space + 1, ' ') || !prefsReady || !validHexToken(wifiToken)) {
    out.println(F("DENIED wifi_config_invalid")); return;
  }
  char encSSID[48] = {};
  char ssid[33] = {}, password[64] = {};
  const size_t firstLen = static_cast<size_t>(space - left);
  size_t sn = 0, pn = 0;
  bool okay = firstLen > 0 && firstLen < sizeof encSSID;
  if (okay) { memcpy(encSSID, left, firstLen); encSSID[firstLen] = 0; }
  okay = okay && validBase64(encSSID, 44) && validBase64(space + 1, 84) &&
         decodeBase64(encSSID, ssid, sizeof ssid, sn) &&
         decodeBase64(space + 1, password, sizeof password, pn) &&
         sn >= 1 && sn <= 32 && pn >= 8 && pn <= 63;
  for (size_t i = 0; okay && i < sn; ++i)
    if (static_cast<uint8_t>(ssid[i]) < 32) okay = false;
  for (size_t i = 0; okay && i < pn; ++i)
    if (static_cast<uint8_t>(password[i]) < 32 ||
        static_cast<uint8_t>(password[i]) > 126) okay = false;
  if (okay) {
    dropTcpClient(false);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    WiFi.disconnect(true, false);
    const bool saved = wifiPrefs.putString("ssid", ssid) == sn &&
                       wifiPrefs.putString("pass", password) == pn;
    if (saved) {
      wifiConfigured = true;
      startSta();
      out.println(F("WIFI_CONFIG OK saved=1 reconnecting=1"));
    } else {
      wifiPrefs.remove("ssid"); wifiPrefs.remove("pass");
      wifiConfigured = false;
      WiFi.mode(WIFI_OFF);
      out.println(F("DENIED wifi_config_invalid"));
    }
  } else out.println(F("DENIED wifi_config_invalid"));
  clearSecrets(password, sizeof(password));
  clearSecrets(ssid, sizeof(ssid));
  clearSecrets(encSSID, sizeof(encSSID));
}

void IRAM_ATTR deOff() {
  GPIO.out_w1tc = 1UL << kDE;
  GPIO.func_out_sel_cfg[kDE].func_sel = SIG_GPIO_OUT_IDX;
}
void IRAM_ATTR disableSlotTimer() { TIMERG0.hw_timer[1].config.alarm_en = 0; }
void IRAM_ATTR disableDeTimer() { TIMERG0.hw_timer[0].config.alarm_en = 0; }
void IRAM_ATTR faultISR(Fault why) {
  deOff();
  disableSlotTimer();
  disableDeTimer();
  UART2.int_ena.tx_done = 0;
  stopLatched = true;
  slotArmed = false;
  slotInFlight = false;
  if (failure == NO_FAULT) failure = why;
  stage = FAULTED;
}
void IRAM_ATTR watchdogISR() {
  deOff();
  disableDeTimer();
  deCutoff = true;
  if (stage == ECHO_TX || stage == GO_TX || slotInFlight)
    faultISR(DE_TIMEOUT);
}
// Direct TIMERG0 alarms avoid calling timer APIs that acquire locks in ISR.
bool IRAM_ATTR armTimer(uint8_t n, uint32_t deltaUs) {
  if (n > 1) return false;
  TIMERG0.hw_timer[n].config.alarm_en = 0;
  TIMERG0.hw_timer[n].update = 1;
  const uint64_t now = (static_cast<uint64_t>(TIMERG0.hw_timer[n].cnt_high) << 32) |
                       TIMERG0.hw_timer[n].cnt_low;
  const uint64_t target = now + deltaUs;
  TIMERG0.hw_timer[n].alarm_high = static_cast<uint32_t>(target >> 32);
  TIMERG0.hw_timer[n].alarm_low = static_cast<uint32_t>(target);
  if (n == 0) TIMERG0.int_clr_timers.t0 = 1;
  else TIMERG0.int_clr_timers.t1 = 1;
  TIMERG0.hw_timer[n].config.alarm_en = 1;
  return true;
}

bool IRAM_ATTR nearUs(uint32_t a, uint32_t b, uint32_t window = kGapToleranceUs) {
  const int32_t diff = static_cast<int32_t>(a - b);
  return diff >= -static_cast<int32_t>(window) &&
         diff <= static_cast<int32_t>(window);
}
bool IRAM_ATTR headerValid(uint8_t id, uint8_t expectedPhase) {
  if (headerUsed != 4 || header[0].value != 0 || header[1].value != 0 ||
      header[3].value != parity(header[2].value, id)) return false;
  if (!nearUs(header[1].at, header[0].at + 1042) ||
      !nearUs(header[3].at, header[2].at + 1042)) return false;
  const bool four = nearUs(header[2].at, header[1].at + 1458);
  const bool zero = nearUs(header[2].at, header[1].at + 1042);
  return expectedPhase == 255 ? (four || zero) :
         (expectedPhase == 4 ? four : zero);
}

void IRAM_ATTR slotISR() {
  disableSlotTimer();
  portENTER_CRITICAL_ISR(&txLock);
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  if (stage != CART_READ || stopLatched || !slotArmed || slotInFlight ||
      pendingSlot != wordsStarted || wordsVerified != wordsStarted ||
      wordsStarted >= 4 || !gateReady ||
      !nearUs(now, targetUs) || UART2.status.txfifo_cnt != 0 ||
      !(GPIO.in & (1UL << kRO))) {
    faultISR(CART_TIMER);
    portEXIT_CRITICAL_ISR(&txLock);
    return;
  }
  if (!armTimer(0, kSlotWatchdogUs)) {
    faultISR(DE_TIMEOUT);
    portEXIT_CRITICAL_ISR(&txLock);
    return;
  }
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.rxfifo_rst = 1;
  UART2.conf0.rxfifo_rst = 0;
  UART2.int_ena.tx_done = 1;
  slotArmed = false;
  slotInFlight = true;
  const uint8_t index = wordsStarted++;
  txStartUs[index] = now;
  // RMT autonomous single-shot gate: 2180us HIGH then 80us LOW.
  const uint8_t channel = static_cast<uint8_t>(2 + index);
  GPIO.func_out_sel_cfg[kDE].func_sel = RMT_SIG_OUT2_IDX + index;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 1;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 0;
  RMT.conf_ch[channel].conf1.tx_start = 1;
  const CmdWord selected = word(variant, index);
  // Native UART2 TX AHB FIFO writes, not the APB RX register bitfield.
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.first);
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.second);
  portEXIT_CRITICAL_ISR(&txLock);
}

void IRAM_ATTR uart2ISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & (1UL << 14)) { // TX_DONE shifted final 8N1 stop bit
    deOff();
    disableDeTimer();
    UART2.int_ena.tx_done = 0;
    const uint8_t index = static_cast<uint8_t>(wordsStarted - 1);
    const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
    slotInFlight = false;
    if (stage != CART_READ || stopLatched || index >= 4 ||
        !nearUs(now, txStartUs[index] + 2083, 175)) {
      faultISR(CART_TIMER);
    } else {
      // UART2 RX input matrix is ALSO attached to physical GPIO17.
      // Verify actual pad-decoded pair, not merely requested TX FIFO bytes.
      const uint32_t flags = UART2.int_raw.val;
      const uint32_t count = UART2.status.rxfifo_cnt;
      const uint8_t b0 = count > 0 ? static_cast<uint8_t>(UART2.fifo.rw_byte) : 0;
      const uint8_t b1 = count > 1 ? static_cast<uint8_t>(UART2.fifo.rw_byte) : 0;
      padRx[index][0] = b0;
      padRx[index][1] = b1;
      txDoneUs[index] = now;
      __sync_synchronize();
      padCount = index + 1;
      const CmdWord expected = word(variant, index);
      // RXFIFO_TOUT (bit 8) indicates inactivity, not a UART frame error.
      // Parity, framing and overflow (bits 2..4) invalidate the pad witness.
      if (count != 2 || (flags & ((1UL << 2) | (1UL << 3) | (1UL << 4)))) {
        faultISR(PAD_FRAMING);
      } else if (b0 != expected.first || b1 != expected.second) {
        faultISR(PAD_MISMATCH);
      } else {
        ++wordsVerified;
        if (wordsVerified == 4) captureOnly = true;
      }
    }
  }
  UART2.int_clr.val = pending;
}

void IRAM_ATTR observeHeader(uint8_t octet, uint32_t at) {
  if (stage != CART_READ && stage != CART_PASSIVE) return;
  if (captureOnly) return;
  // Preserve every byte in raw ring. Ignore likely local echo for *header parsing only*.
  if (wordsStarted > 0 && (uint32_t)(at - txStartUs[wordsStarted - 1]) <= 2600) return;
  if (!frameLocked) {
    if (headerUsed < 4) header[headerUsed++] = {at, octet};
    else {
      for (int i = 0; i < 3; ++i) header[i] = header[i + 1];
      header[3] = {at, octet};
    }
    if (headerUsed == 4 && headerValid(0, 255)) {
      frameLocked = true;
      phase = nearUs(header[2].at, header[1].at + 1458) ? 4 : 0;
      baselineCount = 1;
      nextId = 1;
      lastSyncUs = header[1].at;
      headerUsed = 0;
    }
    return;
  }
  // Only original consecutive full headers are accepted for grant of TX authority.
  if (headerUsed < 4) header[headerUsed++] = {at, octet};
  else { faultISR(CART_HEADER); return; }
  if (headerUsed != 4) return;
  const uint8_t id = baselineCount < 16 ? baselineCount : nextId;
  const uint32_t sync = header[1].at;
  const uint32_t dt = sync - lastSyncUs;
  const bool cadence = nearUs(dt, 10000) ||
      (baselineCount == 16 && nearUs(dt, 12500));
  const bool valid = headerValid(id, phase) && cadence;
  headerUsed = 0;
  if (!valid) { faultISR(CART_HEADER); return; }
  lastSyncUs = sync;
  if (baselineCount < 16) {
    ++baselineCount;
    if (baselineCount == 16) {
      nextId = 0;
      // In passive observation, all following RO bytes are evidence, not
      // an obligation to satisfy the four diagnostic-command ID headers.
      if (stage == CART_PASSIVE) captureOnly = true;
    }
    return;
  }
  if (stage == CART_PASSIVE) return;
  if (nextId >= 4 || wordsVerified != nextId || slotInFlight || slotArmed) {
    faultISR(CART_PHASE);
    return;
  }
  const uint32_t target = sync + 2917; // 4-bit sync + 24-bit CART word slot
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  const int32_t lead = static_cast<int32_t>(target - now);
  if (lead < static_cast<int32_t>(kSlotMinLeadUs) ||
      lead > static_cast<int32_t>(kSlotMaxLeadUs) || !armTimer(1, static_cast<uint32_t>(lead))) {
    faultISR(CART_TIMER);
    return;
  }
  targetUs = target;
  pendingSlot = nextId;
  slotArmed = true;
  ++nextId;
}

void IRAM_ATTR uart1ISR(void*) {
  const uint32_t pending = UART1.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++uartErr;
    if (stage == CART_READ) faultISR(CART_ERR);
  }
  const uint32_t count = UART1.status.rxfifo_cnt;
  if (count > 1) {
    ++uartErr;
    if (stage == CART_READ) faultISR(CART_ERR);
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t value = static_cast<uint8_t>(UART1.fifo.rw_byte);
    const uint32_t at = static_cast<uint32_t>(esp_timer_get_time());
    const uint16_t head = rxWrite;
    const uint16_t next = (head + 1) & (kRxRingSize - 1);
    if (next == rxRead) {
      ++lostRx;
      if (stage == CART_READ) faultISR(RX_OVERFLOW);
    } else {
      rxRing[head] = {at, value};
      __sync_synchronize();
      rxWrite = next;
      ++rxTotal;
    }
    if (stage == CART_READ || stage == CART_PASSIVE) observeHeader(value, at);
  }
  UART1.int_clr.val = pending;
}

void onReferenceError(hardwareSerial_error_t) { ++handshakeErrors; }
void outputHex(uint8_t value) {
  if (value < 16) out.print('0');
  out.print(value, HEX);
}
void closeNative() {
  deOff(); disableSlotTimer(); disableDeTimer();
  UART1.int_ena.val = 0; UART2.int_ena.val = 0;
  if (uart1Handle) { esp_intr_free(uart1Handle); uart1Handle = nullptr; }
  if (uart2Handle) { esp_intr_free(uart2Handle); uart2Handle = nullptr; }
  nativeReady = false;
  pinMode(kDI, INPUT);
}
void closeReference() {
  deOff(); disableDeTimer();
  if (refReady) referenceBus.end();
  refReady = false;
  pinMode(kDI, INPUT);
}
void stopEverything(Fault reason) {
  armedVariant = 255; // A stopped/faulted session never preserves pending authority
  portENTER_CRITICAL(&txLock);
  stopLatched = true;
  deOff(); disableSlotTimer(); disableDeTimer();
  UART2.int_ena.tx_done = 0;
  UART2.conf0.txfifo_rst = 1; UART2.conf0.txfifo_rst = 0;
  slotArmed = false;
  slotInFlight = false;
  portEXIT_CRITICAL(&txLock);
  closeNative(); closeReference();
  if (failure == NO_FAULT) failure = reason;
  stage = FINISHING;
}

bool setupGate() {
  rmt_config_t conf = {};
  conf.rmt_mode = RMT_MODE_TX;
  conf.gpio_num = GPIO_NUM_18;
  conf.clk_div = 80;
  conf.mem_block_num = 1;
  conf.tx_config.loop_en = false;
  conf.tx_config.carrier_en = false;
  conf.tx_config.idle_output_en = true;
  conf.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  rmt_item32_t pulse = {};
  pulse.duration0 = 2180; pulse.level0 = 1;
  pulse.duration1 = 80; pulse.level1 = 0;
  for (int i = 0; i < 4; ++i) {
    conf.channel = static_cast<rmt_channel_t>(RMT_CHANNEL_2 + i);
    if (rmt_config(&conf) != ESP_OK ||
        rmt_driver_install(conf.channel, 0, 0) != ESP_OK ||
        rmt_fill_tx_items(conf.channel, &pulse, 1, 0) != ESP_OK) return false;
    ++gateChannels;
  }
  // The 2400/8N2 handshake takes ~50.4ms for eleven octets.
  // RMT6 is an AUTONOMOUS 52ms DE ceiling: CPU/USB lockups cannot
  // leave the MAX487 transmitting indefinitely. A separate 75ms
  // timer ISR also aborts the session if the serial shifter wedges.
  conf.channel = RMT_CHANNEL_6;
  if (rmt_config(&conf) != ESP_OK ||
      rmt_driver_install(conf.channel, 0, 0) != ESP_OK) return false;
  rmt_item32_t handshakeGate[2] = {};
  handshakeGate[0].duration0 = 32000;
  handshakeGate[0].level0 = 1;
  handshakeGate[0].duration1 = 20000;
  handshakeGate[0].level1 = 1;
  handshakeGate[1].duration0 = 80;
  handshakeGate[1].level0 = 0;
  if (rmt_fill_tx_items(RMT_CHANNEL_6, handshakeGate, 2, 0) != ESP_OK) return false;
  deOff();
  gateReady = (gateChannels == 4);
  return gateReady;
}
bool openReference() {
  closeNative();
  referenceBus.setRxBufferSize(256);
  referenceBus.begin(2400, SERIAL_8N2, kRO, kDI);
  referenceBus.onReceiveError(onReferenceError);
  refReady = true;
  return true;
}
bool openNative() {
  closeReference();
  rxRead = rxWrite = 0;
  rxTotal = lostRx = uartErr = 0;
  frameLocked = false; captureOnly = false;
  baselineCount = 0; headerUsed = 0; phase = 255; nextId = 0;
  wordsStarted = wordsVerified = padCount = 0;
  slotInFlight = slotArmed = false;
  const uart_config_t conf = {
    .baud_rate = 9600,
    .data_bits = UART_DATA_8_BITS,
    .parity = UART_PARITY_DISABLE,
    .stop_bits = UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    .rx_flow_ctrl_thresh = 0,
    .source_clk = UART_SCLK_APB,
  };
  if (uart_param_config(UART_NUM_1, &conf) != ESP_OK ||
      uart_param_config(UART_NUM_2, &conf) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kRO,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_set_pin(UART_NUM_2, kDI, kDI,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  gpio_pad_select_gpio(static_cast<gpio_num_t>(kRO));
  gpio_matrix_in(kRO, U1RXD_IN_IDX, false);
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_INPUT_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U2TXD_OUT_IDX, false, false);
  // Input-only mirror of actual TX GPIO17 pad into native UART2 RX.
  gpio_matrix_in(GPIO_NUM_17, U2RXD_IN_IDX, false);
  if (GPIO.func_in_sel_cfg[U1RXD_IN_IDX].func_sel != kRO ||
      GPIO.func_in_sel_cfg[U2RXD_IN_IDX].func_sel != kDI ||
      GPIO.func_in_sel_cfg[U2RXD_IN_IDX].sig_in_sel != 1 ||
      GPIO.func_out_sel_cfg[kDI].func_sel != U2TXD_OUT_IDX) return false;
  UART1.int_ena.val = 0; UART2.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF; UART2.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1; UART1.conf0.rxfifo_rst = 0;
  UART2.conf0.rxfifo_rst = 1; UART2.conf0.rxfifo_rst = 0;
  UART2.conf0.txfifo_rst = 1; UART2.conf0.txfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1;
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uart1ISR, nullptr, &uart1Handle) != ESP_OK) return false;
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uart2ISR, nullptr, &uart2Handle) != ESP_OK) {
    esp_intr_free(uart1Handle); uart1Handle = nullptr; return false;
  }
  nativeReady = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  return true;
}
void beginSession(Stage target, uint8_t kind) {
  if (stage != IDLE || !gateReady || deTimer == nullptr || slotTimer == nullptr) {
    out.println(F("DENIED busy_or_unready")); return;
  }
  // OBSERVE transmits 2400-baud source frames, unlike LISTEN_9600.
  // Never allow repeated active handshakes from a persistent USB client.
  if (target == CART_PASSIVE && kind == 3) {
    if (observeConsumed) {
      out.println(F("DENIED observe_already_used")); return;
    }
    observeConsumed = true; // consume before any possible handshake TX
  }
  if (target == CART_READ &&
      (transmitConsumed || armedVariant != kind || armedFromUSB != commandFromUSB ||
       static_cast<int32_t>(armExpiresMs - millis()) <= 0)) {
    out.println(F("DENIED arm_required_or_consumed")); return;
  }
  if (target == CART_READ) transmitConsumed = true; // before any 2400 TX
  armedVariant = 255;
  stopLatched = true;
  failure = NO_FAULT;
  deCutoff = false;
  reportedErrors = reportedLost = 0;
  lastReportedBaseline = sentPadReports = 0;
  captureOnly = false;
  variant = kind;
  const bool listen = target == CART_PASSIVE && kind == 2;
  if (listen) {
    if (!openNative()) { stopEverything(CART_INIT); out.println(F("FAULT reason=CART_INIT")); return; }
    stopLatched = false;
    stage = CART_PASSIVE; captureStartedMs = millis();
    out.println(F("EVENT session=LISTEN_9600 origin=RO_ONLY no_tx=1"));
    return;
  }
  if (!openReference()) { stopEverything(CART_INIT); return; }
  stopLatched = false;
  stage = QUIET;
  stageStartedMs = millis();
  out.print(F("EVENT session="));
  out.println(target == CART_READ ? F("READ_CANDIDATE") : F("OBSERVE"));
}

bool sendReference(const uint8_t (&bytes)[11]) {
  if (!refReady || handshakeErrors || digitalRead(kRO) != HIGH) return false;
  if (!armTimer(0, kHandshakeWatchdogUs)) return false;
  // Output mux switches only after an independently bounded RMT6 gate
  // has been initialized. Never drive handshake DE from a CPU-only GPIO.
  GPIO.func_out_sel_cfg[kDE].func_sel = RMT_SIG_OUT6_IDX;
  RMT.conf_ch[6].conf1.mem_rd_rst = 1;
  RMT.conf_ch[6].conf1.mem_rd_rst = 0;
  RMT.conf_ch[6].conf1.tx_start = 1;
  delayMicroseconds(20); // fixed hardware settle, never waits on USB
  refTxStartedUs = static_cast<uint32_t>(esp_timer_get_time());
  const size_t sent = referenceBus.write(bytes, 11); // <= FIFO capacity, no flush
  return sent == 11;
}
void pollHandshake() {
  const uint32_t now = millis();
  if (stage == QUIET) {
    if (referenceBus.available() || digitalRead(kRO) != HIGH || handshakeErrors) {
      stopEverything(BAD_IDLE); return;
    }
    if (now - stageStartedMs >= kQuietMs) {
      if (!sendReference(kEchoId)) { stopEverything(HSK_TX); return; }
      stage = ECHO_TX; stageStartedMs = now;
      out.println(F("EVENT h2400_tx=ECHO_ID bytes=11 candidate=1"));
    }
  } else if (stage == ECHO_TX || stage == GO_TX) {
    const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - refTxStartedUs;
    if (elapsed > 90000 || deCutoff || handshakeErrors) {
      stopEverything(HSK_TIMEOUT); return;
    }
    if (elapsed > 40000 && UART2.status.txfifo_cnt == 0 && UART2.status.st_utx_out == 0) {
      deOff(); disableDeTimer();
      if (stage == ECHO_TX) {
        stage = ACK_WAIT;
        stageStartedMs = ackLastMs = now;
        ackCount = 0;
        out.println(F("EVENT h2400_tx_done=ECHO_ID"));
      } else {
        if (!openNative()) { stopEverything(CART_INIT); return; }
        stopLatched = false;
        stage = variant >= 2 ? CART_PASSIVE : CART_READ;
        captureStartedMs = now;
        out.println(F("EVENT cart=9600_8N1 raw_ro=1 ecu_verified=0 dtc_verified=0"));
      }
    }
  } else if (stage == ACK_WAIT) {
    while (referenceBus.available()) {
      const int c = referenceBus.read();
      if (c < 0 || ackCount >= sizeof(ack)) { stopEverything(HSK_ACK); return; }
      ack[ackCount++] = static_cast<uint8_t>(c);
      ackLastMs = now;
      // H2400 logs preserve candidate bytes; host must not infer ECU ownership.
      out.print(F("H2400 t_ms=")); out.print(now);
      out.print(F(" byte=")); outputHex(static_cast<uint8_t>(c)); out.println();
    }
    if (handshakeErrors || ackCount > 12 || now - stageStartedMs >= kAckMs) {
      stopEverything(HSK_ACK); return;
    }
    if (ackCount == 12 && now - ackLastMs >= 20) {
      if (memcmp(ack, kEchoId, 11) || ack[11] != 0x01) {
        stopEverything(HSK_ACK); return;
      }
      out.println(F("EVENT ack=candidate_11_echo_plus_01 source=UNVERIFIED"));
      if (!sendReference(kGoCart)) { stopEverything(HSK_TX); return; }
      stage = GO_TX; stageStartedMs = now;
      out.println(F("EVENT h2400_tx=GO_CART bytes=11 candidate=1"));
    }
  }
}

void flushPadReports() {
  // Diagnostic headers are only 10ms apart. Avoid task-level USB printing
  // during any uncompleted four-word critical timing sequence. ISR evidence
  // stays in bounded SRAM until the fourth word or a latched fault/STOP.
  if (stage == CART_READ && !captureOnly && failure == NO_FAULT) return;
  while (sentPadReports < padCount) {
    const uint8_t i = sentPadReports++;
    const CmdWord selected = word(variant, i);
    out.print(F("TX_PAD slot=")); out.print(i);
    out.print(F(" expected=")); outputHex(selected.first); outputHex(selected.second);
    out.print(F(" observed=")); outputHex(padRx[i][0]); outputHex(padRx[i][1]);
    out.print(F(" tx_us=")); out.print(txStartUs[i]);
    out.print(F(" done_us=")); out.print(txDoneUs[i]);
    out.print(F(" match=")); out.println(i < wordsVerified ? 1 : 0);
  }
}
void flushRaw() {
  char line[45];
  while (rxRead != rxWrite) {
    const RxEvent value = rxRing[rxRead];
    const int len = snprintf(line, sizeof(line), "RX t_us=%lu byte=%02X\n",
                             static_cast<unsigned long>(value.at), value.value);
    if (len <= 0 || len >= static_cast<int>(sizeof(line))) break;
    if (out.freeBytes() < static_cast<size_t>(len)) break; // bounded, never block either transport
    out.write(reinterpret_cast<const uint8_t*>(line), static_cast<size_t>(len));
    rxRead = (rxRead + 1) & (kRxRingSize - 1);
  }
}
void pollActive() {
  if (stage == CART_READ || stage == CART_PASSIVE) {
    if (reportedErrors != uartErr) { reportedErrors = uartErr; out.print(F("EVENT uart_errors=")); out.println(uartErr); }
    if (reportedLost != lostRx) { reportedLost = lostRx; out.print(F("EVENT rx_lost=")); out.println(lostRx); }
    if (baselineCount != lastReportedBaseline && baselineCount == 16) {
      lastReportedBaseline = baselineCount;
      out.println(F("EVENT baseline=16 synced=1 authority=unverified"));
    }
    if (millis() - captureStartedMs >= kCaptureMs) stopEverything(CAPTURE_TIMEOUT);
  }
}
void reportEnd() {
  // Raw events MUST be drained before END. Retain bounded capture on USB host.
  flushPadReports();
  flushRaw();
  if (rxRead != rxWrite) return;
  out.print(F("END reason=")); out.print(static_cast<unsigned>(failure));
  out.print(F(" ro_bytes=")); out.print(rxTotal);
  out.print(F(" ro_lost=")); out.print(lostRx);
  out.print(F(" uart_errors=")); out.print(uartErr);
  out.print(F(" pad_verified=")); out.print(wordsVerified);
  out.print(F(" words_started=")); out.print(wordsStarted);
  out.println(F(" ecu_verified=0 dtc_verified=0 DE=LOW"));
  stage = IDLE;
}
void printStatus() {
  out.print(F("STATUS SME105_USB_BRIDGE_V1 stage=")); out.print(static_cast<unsigned>(stage));
  const bool transmitting = (stage == ECHO_TX || stage == GO_TX || slotInFlight);
  out.print(transmitting ? F(" DE=ACTIVE_GUARDED") : F(" DE=LOW"));
  out.print(F(" auto_tx=0 gate4=")); out.print(gateReady ? 1 : 0);
  out.print(F(" pad_rx=")); out.print(nativeReady ? 1 : 0);
  out.print(F(" read_used=")); out.print(transmitConsumed ? 1 : 0);
  out.print(F(" observe_used=")); out.print(observeConsumed ? 1 : 0);
  out.print(F(" transport_lost=")); out.print(transportFaults);
  out.print(F(" out_overflow=")); out.print(out.overflow());
  out.print(F(" armed="));
  if (armedVariant < 2 && !transmitConsumed &&
      static_cast<int32_t>(armExpiresMs - millis()) > 0)
    out.print(armedVariant == 0 ? F("A4") : F("0E"));
  else out.print(F("NONE"));
  out.print(F(" fault=")); out.println(static_cast<unsigned>(failure));
}
void printPins() {
  out.println(F("PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1"));
}
void processTcpLine(char* line) {
  if (!tcpAuthenticated) {
    if (stage != IDLE || strncmp(line, "AUTH ", 5) || !tokenMatches(line + 5)) {
      // Never return session output or device data to an unauthenticated peer.
      const char deny[] = "DENIED auth\n";
      if (wifiClient.fd() >= 0)
        (void)::send(wifiClient.fd(), deny, sizeof(deny) - 1, MSG_DONTWAIT);
      dropTcpClient(false);
      return;
    }
    tcpAuthenticated = true;
    out.markTcpAuthenticated();
    // Host's security handshake requires EXACT LF, not Arduino Print CRLF.
    out.print(F("AUTH OK\n"));
    return;
  }
  commandFromUSB = false;
  runCommand(line);
  commandFromUSB = true;
}
void pollWiFi() {
  if (!wifiConfigured || !prefsReady) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiClient.connected() || tcpAuthenticated) dropTcpClient(true);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    if (!busSessionActive() &&
        static_cast<uint32_t>(millis() - wifiLastRetryMs) >= kStaRetryMs) {
      wifiLastRetryMs = millis();
      WiFi.reconnect(); // STA-only retry; NEVER a vehicle command
    }
    return;
  }
  if (!wifiServerStarted) {
    // mDNS and socket initialization are task-level potentially costly;
    // never start them during the phase-critical live CART sequence.
    if (busSessionActive()) return;
    wifiServer.begin();
    wifiServerStarted = true;
    if (!mdnsStarted && MDNS.begin("sme105-bridge")) {
      mdnsStarted = true;
      MDNS.addService("sme105", "tcp", kWiFiPort);
    }
  }
  // An authenticated controller can disappear just as a new connection
  // arrives. Revoke its ongoing vehicle session BEFORE considering anyone
  // new. A new TCP peer must never inherit command authority mid-session.
  if (tcpAuthenticated && !wifiClient.connected()) dropTcpClient(true);
  WiFiClient incoming = wifiServer.accept();
  if (incoming) {
    if (wifiClient.connected() || busSessionActive() || stage == FINISHING)
      incoming.stop(); // at most one; no connection takeover of live UART
    else {
      dropTcpClient(false);
      wifiClient = incoming;
      wifiClient.setNoDelay(true);
      wifiAuthStartedMs = millis();
      wifiLineUsed = 0;
      wifiLineDiscard = false;
    }
  }
  if (!wifiClient.connected()) {
    if (tcpAuthenticated) dropTcpClient(true);
    return;
  }
  if (!tcpAuthenticated &&
      static_cast<uint32_t>(millis() - wifiAuthStartedMs) > kAuthDeadlineMs) {
    dropTcpClient(false);
    return;
  }
  // Bounded input per loop: a noisy WiFi peer must never monopolize CART ISR.
  for (int budget = 0; budget < 96 && wifiClient.connected() && wifiClient.available(); ++budget) {
    const int octet = wifiClient.read();
    if (octet < 0) break;
    const char ch = static_cast<char>(octet);
    if (ch == '\n' || ch == '\r') {
      if (wifiLineDiscard) { dropTcpClient(tcpAuthenticated); return; }
      if (wifiLineUsed) {
        wifiLine[wifiLineUsed] = 0;
        processTcpLine(wifiLine);
        clearSecrets(wifiLine, sizeof wifiLine);
        wifiLineUsed = 0;
        if (!wifiClient.connected()) return;
      }
    } else if (ch < 32 || ch > 126 || wifiLineUsed >= sizeof(wifiLine) - 1) {
      // Do not permit an unlimited line or fragmented parser state.
      wifiLineDiscard = true;
    } else if (!wifiLineDiscard) {
      wifiLine[wifiLineUsed++] = ch;
    }
  }
  if (tcpAuthenticated && busSessionActive()) tcpHadActiveSession = true;
  if (out.tcpSendFailed()) { dropTcpClient(true); return; }
  if (tcpAuthenticated) out.drainTCP(wifiClient);
  if (out.tcpSendFailed()) dropTcpClient(true);
}
void runCommand(const char* cmd) {
  if (!strncmp(cmd, "WIFI_CONFIG ", sizeof("WIFI_CONFIG ") - 1)) {
    processWiFiProvision(cmd); return;
  }
  if (!strcmp(cmd, "WIFI_STATUS")) { printWiFiStatus(); return; }
  if (!strcmp(cmd, "WIFI_TOKEN")) {
    if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
    if (busSessionActive() || !prefsReady || !validHexToken(wifiToken)) {
      out.println(F("DENIED wifi_unready")); return;
    }
    // Deliberately BYPASS fanout. Never leak token into TCP or raw output.
    Serial.print(F("WIFI_TOKEN ")); Serial.println(wifiToken);
    return;
  }
  if (!strcmp(cmd, "WIFI_FORGET")) {
    if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
    if (busSessionActive() || stage == FINISHING || !prefsReady) {
      out.println(F("DENIED wifi_busy")); return;
    }
    dropTcpClient(false);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    wifiConfigured = false;
    wifiPrefs.remove("ssid");
    wifiPrefs.remove("pass");
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    if (!generateToken()) out.println(F("DENIED wifi_unready"));
    else out.println(F("WIFI_FORGET OK"));
    return;
  }
  if (!strcmp(cmd, "STOP")) {
    armedVariant = 255; // STOP from either transport revokes every pending ARM
    if (stage != IDLE && stage != FINISHING) { stopEverything(HOST_STOP); out.println(F("EVENT stop=accepted DE=LOW")); }
    else { deOff(); out.println(F("EVENT stop=idle DE=LOW")); }
    return;
  }
  if (!strcmp(cmd, "HELLO")) { out.println(F("HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1")); return; }
  if (!strcmp(cmd, "HELP")) {
    out.println(F("COMMANDS HELLO HELP STATUS PINS LISTEN_9600 OBSERVE ARM_A4 READ_A4 ARM_0E READ_0E STOP RESET_IDLE"));
    out.println(F("READ_* only after matching ARM_* within 15s; one diagnostic attempt per boot; no clear/actuate/raw write"));
    out.println(F("WIFI USB_ONLY: WIFI_CONFIG <SSID_BASE64> <PASSWORD_BASE64> | WIFI_TOKEN | WIFI_FORGET; WIFI_STATUS read-only"));
    return;
  }
  if (!strcmp(cmd, "STATUS")) { printStatus(); return; }
  if (!strcmp(cmd, "PINS")) { printPins(); return; }
  if (!strcmp(cmd, "RESET_IDLE")) {
    if (stage != IDLE || slotInFlight || !stopLatched) out.println(F("DENIED busy"));
    else { failure = NO_FAULT; armedVariant = 255; out.println(F("EVENT idle_reset no_read_rearm=1")); }
    return;
  }
  if (!strcmp(cmd, "ARM_A4") || !strcmp(cmd, "ARM_0E")) {
    if (stage != IDLE || transmitConsumed) { out.println(F("DENIED read_used_or_busy")); return; }
    armedVariant = strcmp(cmd, "ARM_A4") == 0 ? 0 : 1;
    armedFromUSB = commandFromUSB;
    armExpiresMs = millis() + kArmMs;
    out.print(F("EVENT read_armed variant=")); out.print(armedVariant == 0 ? F("A4") : F("0E"));
    out.println(F(" valid_ms=15000 no_tx_yet=1"));
    return;
  }
  if (!strcmp(cmd, "READ_A4")) { beginSession(CART_READ, 0); return; }
  if (!strcmp(cmd, "READ_0E")) { beginSession(CART_READ, 1); return; }
  if (!strcmp(cmd, "OBSERVE")) { beginSession(CART_PASSIVE, 3); return; }
  if (!strcmp(cmd, "LISTEN_9600")) { beginSession(CART_PASSIVE, 2); return; }
  out.println(F("DENIED unknown_or_unsafe_command"));
}
void pollUsb() {
  // Maximum input budget protects the phase-critical CART service loop.
  for (int budget = 0; budget < 192 && Serial.available(); ++budget) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (discardLine) { discardLine = false; commandUsed = 0; continue; }
      if (commandUsed) {
        commandBuffer[commandUsed] = 0;
        commandFromUSB = true;
        runCommand(commandBuffer);
        clearSecrets(commandBuffer, sizeof commandBuffer);
        commandUsed = 0;
      }
    } else if (ch < 32 || ch > 126 || commandUsed >= sizeof(commandBuffer) - 1) {
      discardLine = true;
      commandUsed = 0;
    } else if (!discardLine) {
      commandBuffer[commandUsed++] = ch;
    }
  }
}
} // namespace

void setup() {
  pinMode(kDI, INPUT);
  gpio_set_direction(GPIO_NUM_18, GPIO_MODE_OUTPUT);
  deOff();
  Serial.begin(115200);
  deTimer = timerBegin(0, 80, true);
  if (deTimer) {
    timerAttachInterruptFlag(deTimer, &watchdogISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmWrite(deTimer, kHandshakeWatchdogUs, false);
    timerAlarmDisable(deTimer);
  }
  slotTimer = timerBegin(2, 80, true);
  if (slotTimer) {
    timerAttachInterruptFlag(slotTimer, &slotISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmDisable(slotTimer);
  }
  gateReady = setupGate();
  deOff();
  stopLatched = true;
  out.println(F("BOOT SME105_USB_BRIDGE_V1 no_auto_tx=1 DE=LOW source_commands_unverified=1"));
  if (!gateReady || !deTimer || !slotTimer) out.println(F("FAULT reason=HARDWARE_INIT no_transmit=1"));
  initializeWiFi(); // STA credentials + token from NVS; NEVER starts ECU TX
}
void loop() {
  pollUsb();
  pollWiFi();
  if (stage == QUIET || stage == ECHO_TX || stage == ACK_WAIT || stage == GO_TX) pollHandshake();
  pollActive();
  flushRaw();
  // A slow/hostile transport cannot silently force unbounded buffering or
  // authorize further ECU slots. Disconnect TCP on backpressure: its host
  // sees no END and must mark the session incomplete. USB retains evidence.
  if (out.freeBytes() < 128 || out.overflow()) {
    if (busSessionActive()) stopEverything(TRANSPORT_BACKPRESSURE);
    if (tcpAuthenticated) dropTcpClient(false);
  }
  if (stage == FAULTED) {
    const Fault reason = failure;
    stopEverything(reason);
    out.print(F("FAULT reason=")); out.println(static_cast<unsigned>(reason));
  }
  flushPadReports();
  if (stage == FINISHING) reportEnd();
  out.drainUSB();
  if (tcpAuthenticated) {
    out.drainTCP(wifiClient);
    if (out.tcpSendFailed()) dropTcpClient(true);
  }
  delay(0);
}
