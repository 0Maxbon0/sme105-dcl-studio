#include <Arduino.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <esp_system.h>
#include <esp_attr.h>
#include <bootloader_random.h>
#include <mbedtls/base64.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_flash_partitions.h>
#include <sdkconfig.h>
#include <lwip/sockets.h>
#include <cerrno>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <driver/rmt.h>
#include <driver/periph_ctrl.h>
#ifdef SME105_BLE
#include "ble_transport.h"
#endif
#include <freertos/ringbuf.h>
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
#include "live_all_map.h"

// Arduino ESP32 normally marks a freshly OTA-booted image VALID inside
// initArduino(), BEFORE setup() can check our pins or Wi-Fi state. Deferring
// validation is essential: IDF's OTA bootloader must be able to roll back
// if the new image crashes or fails health checks on its first boot.
#if !defined(CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE)
#error "Signed OTA requires the ESP32 bootloader rollback-enabled SDK"
#endif
extern "C" bool verifyRollbackLater(void) { return true; }

// Ford EEC-IV experimental 97AB SME-105 USB field bridge.
// There is NO arbitrary bus write API and NO automatic vehicle transmission.
// Flxkrmr B=26A4 and doncreat0r B=260E are competing SOURCE CANDIDATES,
// not an ECU-supported or verified DTC command. No erase/actuator modes.
namespace {
constexpr int kRO = 16, kDI = 17, kDE = 18;
constexpr uint8_t kEchoId[] = {0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr uint8_t kGoCart[] = {0, 0, 0, 0, 0, 1, 0x04, 0, 0, 0, 0x05};
constexpr uint32_t kCaptureMs = 10000, kQuietMs = 150, kAckMs = 400;
constexpr uint32_t kKoeoCaptureMs = 60000, kKoerCaptureMs = 240000, kOfflineCaptureMs = 8000;
constexpr uint32_t kClearCaptureMs = 4000, kMemCaptureMs = 10000;
// Live data runs until STOP, link loss/fault, or this three-hour limit.
constexpr uint32_t kLiveCaptureMs = 3UL * 60UL * 60UL * 1000UL;
// Join an already-running CART stream: frame period = 7.5ms + 2.5ms per
// frame-length unit, i.e. 10ms (length 1) .. 42.5ms (length E).
constexpr uint32_t kJoinMinPeriodUs = 9500, kJoinMaxPeriodUs = 46000;
constexpr uint32_t kJoinGateUs = 400;
constexpr uint32_t kArmMs = 15000, kHandshakeWatchdogUs = 75000;
constexpr uint32_t kSlotWatchdogUs = 2250;
constexpr uint32_t kSlotMinLeadUs = 180, kSlotMaxLeadUs = 1250;
constexpr uint32_t kGapToleranceUs = 175;
constexpr size_t kRxRingSize = 2048; // single producer ISR / single USB consumer
constexpr uint16_t kWiFiPort = 8765;
constexpr size_t kWireQueueSize = 16384; // bounded, no allocation/IO in ISR
constexpr uint32_t kAuthDeadlineMs = 5000;
constexpr uint32_t kStaRetryMs = 10000;
constexpr uint32_t kStaReinitMs = 60000; // escaped/failed reconnect: reapply NVS STA config
constexpr uint32_t kListenerRetryMs = 3000;
constexpr uint32_t kMdnsRetryMs = 10000;
constexpr uint32_t kApRetryMs = 10000;
// Dedicated USB Wi-Fi adapter uses 10.77.13.2/24 with no gateway or DNS.
// Do not use a 192.168.x subnet: the host has multiple Docker bridges.
const IPAddress kDirectApIp(10, 77, 13, 1);
const IPAddress kDirectApMask(255, 255, 255, 0);
constexpr size_t kOtaChunkSize = 512;
// OTA v2 application-layer flow control: no more than 8 KiB accepted
// before the authenticated uploader observes a monotonic progress ACK.
constexpr uint32_t kOtaWindowSize = 8192;
constexpr uint32_t kOtaIdleTimeoutMs = 15000;
constexpr uint32_t kOtaTotalTimeoutMs = 300000;
constexpr uint32_t kOtaFirstBootCheckMs = 8000;
// ::send(MSG_DONTWAIT) only copies bytes into lwIP; it does not prove that
// the uploader has received OTA_OK. Keep the socket alive briefly afterwards.
constexpr uint32_t kOtaOkDrainGraceMs = 1500;
constexpr uint32_t kOtaRebootMaxDelayMs = 4500;
constexpr uint32_t kOtaCurrentVersion = 1;
// Physical USB application-only maintenance baseline for this build. This is
// NOT used as the pre-verification OTA minimum: signed OTA installs must
// still be able to boot PENDING_VERIFY from an older accepted version and
// prove their manifest before promoting ota_ver. On a VALID app with NO pending
// ledger, a supervised physical USB flash may adopt this build baseline.
constexpr uint32_t kUsbInstalledBuildVersion = 21;
constexpr size_t kOtaAppSlotMax = 0x140000; // default 4MB ESP32 OTA partition table
constexpr char kOtaPublisherPublicPEM[] =
  "-----BEGIN PUBLIC KEY-----\n"
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwvvqJc/ITbuRup3AyoBDWBMsfgZh\n"
  "9E86r45Rtj1drURltBc9zoqYxKpZUQqyH8nZxqsAAuuD8Xsh0VognZiBYw==\n"
  "-----END PUBLIC KEY-----\n";
static_assert((kRxRingSize & (kRxRingSize - 1)) == 0, "ring power of two");
static_assert((kWireQueueSize & (kWireQueueSize - 1)) == 0, "wire ring power of two");

// All USB commands run in loop(); only register operations run in UART/timer ISRs.
enum Stage : uint8_t { IDLE, QUIET, ECHO_TX, ACK_WAIT, GO_TX,
                       CART_PASSIVE, CART_READ, FINISHING, FAULTED };
enum Fault : uint8_t { NO_FAULT, BAD_IDLE, HSK_TX, HSK_TIMEOUT, HSK_ACK,
                       CART_INIT, CART_ERR, CART_HEADER, CART_PHASE,
                       CART_CADENCE, CART_TIMER, PAD_MISMATCH, PAD_FRAMING,
                       DE_TIMEOUT, RX_OVERFLOW, HOST_STOP, CAPTURE_TIMEOUT,
                       TRANSPORT_BACKPRESSURE, DE_MISSING, RX_SILENCE };
struct RxEvent { uint32_t at; uint8_t value; };
struct HeaderByte { uint32_t at; uint8_t value; };
struct CmdWord { uint8_t first; uint8_t second; };
// Session kinds: 0/1 = DIAGMODE 26H (frame length 4/E), 2 = LISTEN,
// 3 = OBSERVE, 4 = DIAGMODE 25H on-demand self test (LHBH1 13-22, length E),
// 5 = DIAGMODE 80H go offline (LHBH1 13-26, qualifier 07FH = ~80H),
// 6 = live data: DIAGMODE 41H (load PID map) then 21H (transmit PID values),
//     frame length 6 as used by the flxkrmr and doncreat0r readers.
constexpr uint8_t kVariantKoeo = 4, kVariantOffline = 5, kVariantLive = 6, kVariantLive2 = 7;
constexpr uint8_t kVariantKoer = 8, kVariantClear = 9, kVariantMem = 10, kVariantLive3 = 11;
constexpr uint8_t kVariantAllLive = 12;
constexpr bool isLiveVariant(uint8_t v) {
  return v == kVariantLive || v == kVariantLive2 || v == kVariantLive3 || v == kVariantAllLive;
}
constexpr bool isSelfTest(uint8_t v) { return v == kVariantKoeo || v == kVariantKoer; }
constexpr bool isRepeating(uint8_t v) {
  return isSelfTest(v) || isLiveVariant(v) || v == kVariantClear || v == kVariantMem;
}
constexpr bool isRequestVariant(uint8_t v) {
  return v <= 1 || isRepeating(v) || v == kVariantOffline;
}
// CART_READ kinds that may attach to a stream already running at 9600.
// OBSERVE (3) and go-offline (5) are excluded: OBSERVE keeps BAD_IDLE,
// and OFF joins from beginSession without a quiet window.
constexpr bool joinsRunningCart(uint8_t v) {
  return v <= 1 || isRepeating(v);
}
// Outcomes that never proved a bad TX path. Pad, DE, phase and overflow
// faults stay latched until reboot. Handshake failures are included because
// they happen before any 9600 DPS word is armed.
constexpr bool faultAllowsRearm(Fault reason) {
  return reason == CAPTURE_TIMEOUT || reason == HOST_STOP || reason == BAD_IDLE ||
         reason == HSK_TIMEOUT || reason == HSK_ACK || reason == HSK_TX ||
         reason == CART_INIT;
}
constexpr CmdWord IRAM_ATTR word(uint8_t variant, uint8_t slot) {
  return slot == 0 ? CmdWord{0x01,0xB0} :
         slot == 1 ? CmdWord{0xFF,0x5F} :
         slot == 2 ? (variant == 0 ? CmdWord{0x26,0xA4} :
                      variant == 1 ? CmdWord{0x26,0x0E} :
                      isSelfTest(variant) ? CmdWord{0x25,0x3E} :
                      variant == kVariantClear ? CmdWord{0x02,0x91} :
                      variant == kVariantOffline ? CmdWord{0x80,0xCE} :
                      isLiveVariant(variant) ? CmdWord{0x21,0xF6} :
                      CmdWord{0x26,0xA4}) :
         variant == kVariantOffline ? CmdWord{0x7F,0x20} : CmdWord{0x00,0xA0};
}
constexpr uint8_t parity(uint8_t first, uint8_t id) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^ id ^ 10) << 4) | id);
}
static_assert(parity(1,0)==0xB0 && parity(0xFF,15)==0x5F &&
              parity(0x26,4)==0xA4 && parity(0x26,14)==0x0E &&
              parity(0x25,14)==0x3E && parity(0x80,14)==0xCE &&
              parity(0x7F,0)==0x20 && parity(0x41,6)==0x96 &&
              parity(0x21,6)==0xF6,
              "DPS word vertical parity");
// PID index request word: data = 0x800 | pid (flxkrmr PID_CHECKSUM,
// doncreat0r PIDMap). One PID per frame in IW2; frame 0 left idle because
// the new frame period is only confirmed at frame 1.
constexpr CmdWord pidWord(uint8_t pid) {
  return CmdWord{pid, static_cast<uint8_t>((((pid & 15) ^ (pid >> 4) ^ 8 ^ 10) << 4) | 8)};
}
static_assert(pidWord(0x01).second == 0x38 && pidWord(0x11).second == 0x28 &&
              pidWord(0x0F).second == 0xD8 && pidWord(0x26).second == 0x68,
              "PID word parity matches doncreat0r PIDMap");
// LHBH1 13-29. Set 0 (LIVE): N, ACT, ECT, IACT, IECT, ITP, VBAT, BP, SAFTOT,
// FUELPW1, LAMBSE1, IEGO1, VS, LOAD, KAMRF1. Set 1 (LIVE2): N, FMEM_FLAGS,
// FMEM_FLAG2, RATCH, ITP, DSDRPM, ISCDTY, BITMAP_0, BITMAP_1, INDS, IOCC,
// IVCAL, APT, ATMR1, VBAT.
DRAM_ATTR const uint8_t kLivePids[3][16] = {
  {0x00, 0x01, 0x0F, 0x10, 0x05, 0x06, 0x09, 0x11,
   0x03, 0x04, 0x0C, 0x0D, 0x08, 0x18, 0x27, 0x28},
  {0x00, 0x01, 0x24, 0x25, 0x2B, 0x09, 0x2A, 0x15,
   0x1A, 0x1B, 0x2F, 0x2E, 0x0B, 0x0E, 0x2D, 0x11},
  {0x00, 0x01, 0x02, 0x07, 0x12, 0x13, 0x17, 0x26,
   0x30, 0x32, 0x35, 0x36, 0x37, 0x38, 0x11, 0x04}};
constexpr uint32_t kLiveFramePeriodUs = 22500; // 7.5ms + 2.5ms * length 6
const __FlashStringHelper* variantName(uint8_t v) {
  return v == 0 ? F("A4") : v == 1 ? F("0E") :
         v == kVariantKoeo ? F("KOEO") : v == kVariantKoer ? F("KOER") :
         v == kVariantLive ? F("LIVE") : v == kVariantLive2 ? F("LIVE2") :
         v == kVariantLive3 ? F("LIVE3") : v == kVariantClear ? F("CLR") :
         v == kVariantAllLive ? F("ALL") :
         v == kVariantMem ? F("MEM") : F("OFF");
}

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
volatile uint32_t uartErr = 0, lostRx = 0, rxTotal = 0, lastRxAtUs = 0;
volatile uint16_t rxWrite = 0, rxRead = 0;
RxEvent rxRing[kRxRingSize] = {};
volatile bool frameLocked = false, captureOnly = false;
volatile bool joinMode = false, repeatDps = false, stopAtBlock = false;
volatile uint32_t dpsBlocks = 0;
// Live PID map words ride in IW2, 2.5ms after the DPS slot.
volatile bool extraArmed = false, extraInFlight = false;
volatile uint32_t extraTargetUs = 0, extraStartUs = 0;
volatile uint8_t extraGate = 0, extraFrame = 0;
volatile uint8_t extraColumn = 0;
volatile uint8_t pidWordsStarted = 0, pidWordsVerified = 0;
CmdWord extraWord = {0, 0};
volatile uint8_t headerUsed = 0, baselineCount = 0, phase = 255, nextId = 0;
volatile uint32_t lastSyncUs = 0, framePeriodUs = 10000;
HeaderByte header[4] = {};
uint32_t stageStartedMs = 0, captureStartedMs = 0, armExpiresMs = 0;
uint32_t refTxStartedUs = 0, ackLastMs = 0;
uint8_t ack[16] = {}, ackCount = 0;
volatile uint32_t handshakeErrors = 0;
volatile bool transmitConsumed = false;
volatile bool offlineConsumed = false; // separate one-shot: may follow a READ
volatile bool observeConsumed = false; // active Echo-ID/Go-CART, not passive sniff
uint8_t armedVariant = 255;
bool armedFromUSB = true; // ARM/READ must originate on the same authenticated transport
bool nativeReady = false, refReady = false, gateReady = false;
bool tx2BenchUsed = false; // One explicit operator-commanded pad test per boot.
bool tx2BenchPassed = false; // Volatile: reset on boot; never inferred from FIFO writes.
uint8_t gateChannels = 0;
char commandBuffer[176] = {}; // USB-only base64 provisioning up to 44+84 chars
uint8_t commandUsed = 0;
bool discardLine = false;
uint8_t sentPadReports = 0;
uint32_t reportedErrors = 0, reportedLost = 0;
uint8_t lastReportedBaseline = 0;

// No Wi-Fi operation in CART/UART/timer ISR paths. Firmware emits bounded
// ASCII into a single fan-out queue. USB and authenticated TCP have separate
// cursors. An authenticated TCP controller is the primary evidence recipient;
// USB remains best-effort and skipped bytes are explicitly counted. When no
// TCP controller is authenticated, USB alone constrains the bounded queue.
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
  // During signed OTA, the authenticated TCP updater is the mandatory
  // recipient; serial is optional observation. A closed USB monitor must
  // not prevent the OTA reply from reaching the authenticated uploader.
  void setOtaTcpPrimary(bool enabled) {
    if (!enabled && otaTcpPrimary_ &&
        write_ - usbRead_ >= kWireQueueSize - 512) {
      // Skip only when the optional USB cursor could block new output.
      // Preserve ordinary OTA_FAIL/progress lines for an open USB monitor.
      usbSkipped_ += write_ - usbRead_;
      usbRead_ = write_;
    }
    otaTcpPrimary_ = enabled;
  }
  uint32_t usbSkipped() const { return usbSkipped_; }
  void dropTcpAtCurrent() {
    // A Wi-Fi-only capture can leave an optional, unplugged USB consumer far
    // behind. Never make its stale cursor wedge a new USB-only operation.
    if (tcpEnabled_ && write_ - usbRead_ >= kWireQueueSize - 512) {
      usbSkipped_ += write_ - usbRead_;
      usbRead_ = write_;
    }
    tcpRead_ = write_;
    tcpEnabled_ = false;
    tcpSendFailed_ = false;
  }
  void markTcpAuthenticated() { tcpRead_ = write_; tcpEnabled_ = true; tcpSendFailed_ = false; }
  bool tcpSendFailed() const { return tcpSendFailed_; }
  void drainUSB() {
    if (usbRead_ == write_) return;
    if (tcpEnabled_ && write_ - usbRead_ >= kWireQueueSize) {
      usbSkipped_ += write_ - usbRead_;
      usbRead_ = write_;
      return;
    }
    const int capacity = Serial.availableForWrite();
    if (capacity <= 0) return;
    const size_t len = std::min(static_cast<size_t>(capacity),
        std::min(static_cast<size_t>(write_ - usbRead_),
                 std::min(static_cast<size_t>(256), kWireQueueSize - (usbRead_ & (kWireQueueSize - 1)))));
    usbRead_ += Serial.write(bytes_ + (usbRead_ & (kWireQueueSize - 1)), len);
  }
#ifdef SME105_BLE
  void drainBLE() {
    if (tcpRead_ == write_) return;
    const size_t room = ble_transport::writable();
    if (!room) return;
    const size_t len = std::min(room, std::min(static_cast<size_t>(write_ - tcpRead_),
        std::min(static_cast<size_t>(256), kWireQueueSize - (tcpRead_ & (kWireQueueSize - 1)))));
    tcpRead_ += static_cast<uint32_t>(
        ble_transport::write(bytes_ + (tcpRead_ & (kWireQueueSize - 1)), len));
  }
#endif
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
    // Authenticated TCP sessions (including live CART capture and OTA) must
    // not be terminated by an unopened USB terminal. TCP still fails closed
    // on its own send/backpressure failure. USB-only sessions remain bounded.
    return tcpEnabled_ ? write_ - tcpRead_ : write_ - usbRead_;
  }
  uint8_t bytes_[kWireQueueSize] = {};
  uint32_t write_ = 0, usbRead_ = 0, tcpRead_ = 0, overflow_ = 0;
  bool tcpEnabled_ = false, tcpSendFailed_ = false, otaTcpPrimary_ = false;
  uint32_t usbSkipped_ = 0;
};
BridgeOutput out;
Preferences wifiPrefs;
WiFiServer wifiServer(kWiFiPort);
WiFiClient wifiClient;
bool wifiConfigured = false, tcpAuthenticated = false;
bool wifiApMode = false, wifiApReady = false;
bool tcpHadActiveSession = false;
// The single authenticated remote controller (tcpAuthenticated) is BLE.
bool remoteIsBle = false;
char bleLine[176] = {};
uint8_t bleLineUsed = 0;
bool bleLineDiscard = false;
uint32_t blePin = 0;
bool wifiServerStarted = false;
bool prefsReady = false, mdnsStarted = false, commandFromUSB = true;
char wifiToken[33] = {};
char wifiLine[240] = {}; // OTA_BEGIN signed manifest fits; never unbounded
uint8_t wifiLineUsed = 0;
bool wifiLineDiscard = false;
uint32_t wifiAuthStartedMs = 0, wifiLastRetryMs = 0;
uint32_t transportFaults = 0;
// Wi-Fi event callbacks execute on Arduino's event task. They only record
// fixed-width diagnostics, never touch UART/DE, NVS, sockets or Wi-Fi APIs.
volatile uint32_t wifiDisconnectEvents = 0, wifiGotIpEvents = 0;
volatile uint32_t wifiApStopEvents = 0;
volatile uint8_t wifiLastDisconnectReason = 0;
uint32_t wifiLastHandledIpEvent = 0, wifiOfflineSinceMs = 0;
uint32_t wifiLastHandledApStopEvent = 0, wifiLastApAttemptMs = 0;
uint32_t wifiLastStaReinitMs = 0;
uint32_t wifiLastServerAttemptMs = 0, wifiLastMdnsAttemptMs = 0;
uint32_t wifiRetryAttempts = 0, wifiStaReinitializations = 0;
uint32_t wifiListenerFailures = 0, wifiListenerRestarts = 0;
bool wifiWasOffline = false;

enum class OtaPhase : uint8_t { Idle, Receiving, RebootPending };
struct SignedOtaState {
  OtaPhase phase = OtaPhase::Idle;
  esp_ota_handle_t handle = 0;
  const esp_partition_t* target = nullptr;
  uint32_t size = 0, received = 0, version = 0;
  uint32_t beganMs = 0, lastDataMs = 0, restartDeadlineMs = 0;
  uint32_t nextWindowEnd = 0, progressQueuedAt = 0;
  uint32_t otaOkQueuedAt = 0, otaOkDrainedAtMs = 0;
  bool waitingProgressDrain = false, otaOkDrained = false;
  uint8_t expectedHash[32] = {};
  char hexHash[65] = {};
  mbedtls_sha256_context digest = {};
  bool shaInitialized = false, handleOpen = false;
};
SignedOtaState signedOta;
// USB-only observability for supervised uploads. These values never enter
// the authenticated TCP response stream and never contain keys or tokens.
// Retain the final byte offset across abortSignedOta() so a postmortem
// cannot confuse 0 received with an almost-complete body.
struct OtaDiagnostic {
  uint32_t lastReceived = 0;
  uint32_t writes = 0;
  uint32_t longestWriteUs = 0;
  uint32_t lastWriteUs = 0;
  uint32_t lastProgressMs = 0;
  const char* lastFailure = "NONE"; // only immutable source literals
  const char* operation = "IDLE";
};
OtaDiagnostic otaDiagnostic;
// RTC no-init RAM survives many CPU/software watchdog resets, unlike normal
// .bss. It is diagnostic ONLY, never an OTA admission or version authority.
// A power loss may erase it; magic/check detect uninitialized/torn records.
struct OtaRtcTrace {
  uint32_t magic;
  uint32_t imageBytes;
  uint32_t acceptedBytes;
  uint32_t imageVersion;
  uint32_t phase;  // 1=BEGIN, 2=BODY, 3=ABORT, 4=FULL, 5=BOOT_PENDING
  uint32_t check;
};
RTC_NOINIT_ATTR OtaRtcTrace otaRtcTrace;
constexpr uint32_t kOtaRtcMagic = 0x53A1057Au;
void storeOtaRtcTrace(uint32_t phase) {
  otaRtcTrace.magic = 0; // two-phase validity, never accept partially written
  otaRtcTrace.imageBytes = signedOta.size;
  otaRtcTrace.acceptedBytes = signedOta.received;
  otaRtcTrace.imageVersion = signedOta.version;
  otaRtcTrace.phase = phase;
  otaRtcTrace.check = kOtaRtcMagic ^ otaRtcTrace.imageBytes ^
                      otaRtcTrace.acceptedBytes ^ otaRtcTrace.imageVersion ^
                      otaRtcTrace.phase;
  otaRtcTrace.magic = kOtaRtcMagic;
}
bool otaRtcTraceValid() {
  return otaRtcTrace.magic == kOtaRtcMagic &&
         otaRtcTrace.imageBytes >= 65536 &&
         otaRtcTrace.imageBytes <= kOtaAppSlotMax &&
         otaRtcTrace.acceptedBytes <= otaRtcTrace.imageBytes &&
         otaRtcTrace.phase >= 1 && otaRtcTrace.phase <= 5 &&
         otaRtcTrace.check == (kOtaRtcMagic ^ otaRtcTrace.imageBytes ^
                              otaRtcTrace.acceptedBytes ^
                              otaRtcTrace.imageVersion ^ otaRtcTrace.phase);
}
bool otaFirstBootPending = false, otaBootHealthFailed = false;
bool otaPendingNetworkConfirmed = false;
bool otaRollbackAttempted = false;
uint32_t otaAcceptedVersion = kOtaCurrentVersion;
// NVS putBytes commits one pending manifest atomically. The existing v2
// ota_pending/ota_p_sha keys remain for OTA_CONFIRM and older accepted-version
// continuity, but are never sufficient to advance ota_ver after a crash.
constexpr uint32_t kOtaLedgerMagic = 0x534F5441u;
struct OtaPendingLedger {
  uint32_t magic = kOtaLedgerMagic;
  uint32_t version = 0, imageSize = 0;
  uint32_t targetAddress = 0, targetSize = 0;
  uint8_t targetSubtype = 0;
  char targetLabel[17] = {};
  uint8_t sha256[32] = {};
};
// Explicit prototypes keep Arduino's auto-prototype pass from emitting
// signatures for OtaPendingLedger before the type has been declared.
bool loadPendingOtaLedger(OtaPendingLedger& ledger);
bool ledgerTargetsRunningApp(const OtaPendingLedger& ledger,
                             const esp_partition_t* running);
bool runningAppMatchesSignedHash(const OtaPendingLedger& ledger,
                                 const esp_partition_t* running);
OtaPendingLedger otaTrustedLedger;
bool otaLedgerTrusted = false;
bool otaLedgerAlreadyValid = false; // bootloader rollback no longer possible
uint32_t otaLedgerRetryAfterMs = 0;

void clearPendingOtaLedger() {
  if (!prefsReady) return;
  // A power cut while cleaning these keys is harmless: ota_ver was already
  // committed, or the running app is a different (rolled-back) partition.
  wifiPrefs.remove("ota_ledger");
  wifiPrefs.remove("ota_pending");
  wifiPrefs.remove("ota_p_sha");
}
bool loadPendingOtaLedger(OtaPendingLedger& ledger) {
  if (!prefsReady ||
      wifiPrefs.getBytesLength("ota_ledger") != sizeof(ledger) ||
      wifiPrefs.getBytes("ota_ledger", &ledger, sizeof(ledger)) != sizeof(ledger))
    return false;
  return ledger.magic == kOtaLedgerMagic &&
      ledger.version > kOtaCurrentVersion &&
      ledger.imageSize >= 65536 && ledger.imageSize <= kOtaAppSlotMax &&
      ledger.targetSize == kOtaAppSlotMax &&
      (ledger.targetSubtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ||
       ledger.targetSubtype == ESP_PARTITION_SUBTYPE_APP_OTA_1) &&
      ledger.targetLabel[0] != '\0' && ledger.targetLabel[16] == '\0';
}
bool ledgerTargetsRunningApp(const OtaPendingLedger& ledger,
                             const esp_partition_t* running) {
  return running && running->type == ESP_PARTITION_TYPE_APP &&
      running->subtype == ledger.targetSubtype &&
      running->address == ledger.targetAddress &&
      running->size == ledger.targetSize &&
      strncmp(running->label, ledger.targetLabel, sizeof(running->label)) == 0;
}
bool runningAppMatchesSignedHash(const OtaPendingLedger& ledger,
                                 const esp_partition_t* running) {
  if (!ledgerTargetsRunningApp(ledger, running) ||
      ledger.imageSize > running->size) return false;
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  bool ok = mbedtls_sha256_starts_ret(&hash, 0) == 0;
  uint8_t block[1024] = {}, calculated[32] = {};
  for (uint32_t offset = 0; ok && offset < ledger.imageSize;) {
    const size_t count = std::min(static_cast<size_t>(ledger.imageSize - offset),
                                  sizeof(block));
    ok = esp_partition_read(running, offset, block, count) == ESP_OK &&
         mbedtls_sha256_update_ret(&hash, block, count) == 0;
    offset += static_cast<uint32_t>(count);
    if ((offset & 0x3FFFu) == 0) delay(0); // keep scheduler/watchdog serviced
  }
  if (ok) ok = mbedtls_sha256_finish_ret(&hash, calculated) == 0 &&
               constantTimeEqual(calculated, ledger.sha256, sizeof(calculated));
  mbedtls_sha256_free(&hash);
  return ok;
}
bool acceptValidPendingOta() {
  // This is called only AFTER IDF reports VALID and the signed flash image
  // and partition identity have been checked. Failure keeps all active
  // commands blocked; the next boot can retry from the durable NVS ledger.
  if (!otaLedgerTrusted || !otaLedgerAlreadyValid || !prefsReady) return false;
  otaLedgerRetryAfterMs = millis() + 2000; // bounded NVS endurance on failure
  if (otaTrustedLedger.version > otaAcceptedVersion &&
      (wifiPrefs.putUInt("ota_ver", otaTrustedLedger.version) != sizeof(uint32_t) ||
       wifiPrefs.getUInt("ota_ver", 0) != otaTrustedLedger.version)) return false;
  otaAcceptedVersion = std::max(otaAcceptedVersion, otaTrustedLedger.version);
  clearPendingOtaLedger();
  otaFirstBootPending = false;
  otaLedgerAlreadyValid = false;
  out.print(F("OTA_BOOT state=VALID version="));
  out.println(otaAcceptedVersion);
  return true;
}

void runCommand(const char* command);
void stopEverything(Fault reason);
void abortSignedOta(const char* reason);
void pollSignedOtaBody();
void serviceOtaHealthAndRestart();

bool busSessionActive() {
  return stage != IDLE && stage != FINISHING && stage != FAULTED;
}
bool otaUpdating() { return signedOta.phase != OtaPhase::Idle; }
bool validBase64(const char* s, size_t maxEncoded);
void clearSecrets(void* target, size_t size);

bool parseUnsignedDecimal(const char* text, uint32_t& number) {
  number = 0;
  if (!text || !*text || (text[0] == '0' && text[1])) return false;
  for (const char* c = text; *c; ++c) {
    if (*c < '0' || *c > '9') return false;
    const uint32_t digit = static_cast<uint32_t>(*c - '0');
    if (number > (UINT32_MAX - digit) / 10) return false;
    number = number * 10 + digit;
  }
  return true;
}
bool decodeLowercaseHash(const char* text, uint8_t output[32]) {
  if (!text || strlen(text) != 64) return false;
  for (size_t i = 0; i < 32; ++i) {
    uint8_t decoded = 0;
    for (size_t j = 0; j < 2; ++j) {
      const char c = text[2 * i + j];
      const int digit = c >= '0' && c <= '9' ? c - '0' :
                        c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
      if (digit < 0) return false;
      decoded = static_cast<uint8_t>((decoded << 4) | digit);
    }
    output[i] = decoded;
  }
  return true;
}
bool constantTimeEqual(const uint8_t* a, const uint8_t* b, size_t n) {
  uint8_t diff = 0;
  for (size_t i = 0; i < n; ++i) diff |= a[i] ^ b[i];
  return diff == 0;
}

bool verifyOtaManifestSignature(uint32_t bytes, const char* sha256hex,
                                uint32_t version, const char* signatureBase64) {
  // Strict domain/model separation: a valid signature from another project
  // or for another image length/version cannot authorize this ESP32 image.
  if (!signatureBase64 || strlen(signatureBase64) > 112 ||
      !validBase64(signatureBase64, 112)) return false;
  uint8_t signature[88] = {};
  size_t signatureLen = 0;
  const int decoded = mbedtls_base64_decode(signature, sizeof(signature),
                          &signatureLen,
                          reinterpret_cast<const unsigned char*>(signatureBase64),
                          strlen(signatureBase64));
  if (decoded || signatureLen < 64 || signatureLen > 80) return false;
  char canonical[144] = {};
  const int count = snprintf(canonical, sizeof(canonical),
      "SME105-OTA-V1\nesp32dev\n%lu\n%s\n%lu\n",
      static_cast<unsigned long>(bytes), sha256hex,
      static_cast<unsigned long>(version));
  if (count <= 0 || count >= static_cast<int>(sizeof(canonical))) return false;
  uint8_t manifestDigest[32] = {};
  if (mbedtls_sha256_ret(reinterpret_cast<const unsigned char*>(canonical),
                         static_cast<size_t>(count), manifestDigest, 0) != 0)
    return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  const int parsed = mbedtls_pk_parse_public_key(&key,
       reinterpret_cast<const unsigned char*>(kOtaPublisherPublicPEM),
       sizeof(kOtaPublisherPublicPEM));
  const bool verified = parsed == 0 && mbedtls_pk_can_do(&key, MBEDTLS_PK_ECDSA) &&
      mbedtls_pk_verify(&key, MBEDTLS_MD_SHA256,
                        manifestDigest, sizeof(manifestDigest),
                        signature, signatureLen) == 0;
  mbedtls_pk_free(&key);
  clearSecrets(signature, sizeof(signature));
  clearSecrets(manifestDigest, sizeof(manifestDigest));
  return verified;
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

void otaFailure(const char* reason) {
  out.print(F("OTA_FAIL reason="));
  out.println(reason);
}
void abortSignedOta(const char* reason) {
  if (signedOta.phase != OtaPhase::Receiving) return;
  otaDiagnostic.lastReceived = signedOta.received;
  otaDiagnostic.lastFailure = reason;
  otaDiagnostic.operation = "ABORTING";
  storeOtaRtcTrace(3);
  if (signedOta.handleOpen) {
    (void)esp_ota_abort(signedOta.handle);
    signedOta.handleOpen = false;
  }
  if (signedOta.shaInitialized) {
    mbedtls_sha256_free(&signedOta.digest);
    signedOta.shaInitialized = false;
  }
  signedOta.phase = OtaPhase::Idle;
  signedOta.target = nullptr;
  signedOta.received = 0;
  otaDiagnostic.operation = "ABORTED";
  otaFailure(reason);
  out.setOtaTcpPrimary(false);
}

void beginSignedOta(const char* command) {
  // OTA is network-only, behind the existing 128-bit AUTH; no ECU session,
  // no queued ARM, and no physical DE/RMT gate left active at admission.
  if (commandFromUSB || !tcpAuthenticated) {
    otaFailure("tcp_only"); return;
  }
  if (otaUpdating() || otaFirstBootPending || stage != IDLE || !stopLatched ||
      slotInFlight || slotArmed || armedVariant < 2 ||
      !gateReady || !prefsReady || !validHexToken(wifiToken) ||
      (GPIO.out & (1UL << kDE)) ||
      GPIO.func_out_sel_cfg[kDE].func_sel != SIG_GPIO_OUT_IDX ||
      out.freeBytes() < 256) {
    otaFailure("busy_or_unready"); return;
  }
  // OTA_BEGIN2 SP size_decimal lowerhex_sha256 version_decimal DER_signature_b64
  // Legacy OTA_BEGIN is intentionally rejected. Its unbounded sendall()
  // could buffer an entire image before the ESP32 flash reader caught up.
  // Every space and every length is bounded; no partial/implicit arguments.
  const char* const prefix = "OTA_BEGIN2 ";
  if (strncmp(command, prefix, strlen(prefix))) {
    otaFailure("protocol_upgrade_required"); return;
  }
  const char* args = command + strlen(prefix);
  if (strlen(args) >= sizeof(wifiLine)) {
    otaFailure("invalid_manifest"); return;
  }
  char fields[sizeof(wifiLine)] = {};
  memcpy(fields, args, strlen(args) + 1);
  char* parts[4] = {};
  char* cursor = fields;
  bool formValid = true;
  for (size_t i = 0; i < 4; ++i) {
    if (!*cursor || *cursor == ' ') { formValid = false; break; }
    parts[i] = cursor;
    char* separator = strchr(cursor, ' ');
    if (i < 3) {
      if (!separator || separator[1] == ' ') { formValid = false; break; }
      *separator = 0;
      cursor = separator + 1;
    } else if (separator) { formValid = false; break; }
  }
  uint32_t imageBytes = 0, newVersion = 0;
  uint8_t expectedSha[32] = {};
  formValid = formValid && parseUnsignedDecimal(parts[0], imageBytes) &&
      decodeLowercaseHash(parts[1], expectedSha) &&
      parseUnsignedDecimal(parts[2], newVersion) &&
      newVersion > otaAcceptedVersion && newVersion > kOtaCurrentVersion &&
      imageBytes >= 65536 && imageBytes <= kOtaAppSlotMax;
  if (!formValid) { otaFailure("invalid_manifest"); return; }

  // ECDSA P-256/SHA-256 verification BEFORE erasing/writing even one flash
  // sector. No private signing material is present on the ESP32.
  if (!verifyOtaManifestSignature(imageBytes, parts[1], newVersion, parts[3])) {
    otaFailure("bad_signature"); return;
  }
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
  if (!running || !target || running == target ||
      running->type != ESP_PARTITION_TYPE_APP ||
      target->type != ESP_PARTITION_TYPE_APP ||
      target->size != kOtaAppSlotMax || imageBytes > target->size ||
      !(target->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ||
        target->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_1)) {
    otaFailure("partition_unavailable"); return;
  }
  esp_ota_img_states_t currentState = ESP_OTA_IMG_UNDEFINED;
  if (esp_ota_get_state_partition(running, &currentState) == ESP_OK &&
      currentState == ESP_OTA_IMG_PENDING_VERIFY) {
    otaFailure("unconfirmed_running_image"); return;
  }

  esp_ota_handle_t handle = 0;
  if (esp_ota_begin(target, imageBytes, &handle) != ESP_OK) {
    otaFailure("flash_begin_failed"); return;
  }
  signedOta.handle = handle;
  signedOta.handleOpen = true;
  signedOta.target = target;
  signedOta.size = imageBytes;
  signedOta.received = 0;
  signedOta.version = newVersion;
  signedOta.nextWindowEnd = std::min(imageBytes, kOtaWindowSize);
  signedOta.waitingProgressDrain = false;
  signedOta.progressQueuedAt = 0;
  signedOta.otaOkQueuedAt = 0;
  signedOta.otaOkDrainedAtMs = 0;
  signedOta.otaOkDrained = false;
  memcpy(signedOta.expectedHash, expectedSha, sizeof(expectedSha));
  memcpy(signedOta.hexHash, parts[1], sizeof(signedOta.hexHash));
  mbedtls_sha256_init(&signedOta.digest);
  signedOta.shaInitialized = true;
  if (mbedtls_sha256_starts_ret(&signedOta.digest, 0) != 0) {
    abortSignedOta("hash_init_failed"); return;
  }
  signedOta.beganMs = signedOta.lastDataMs = millis();
  otaDiagnostic = OtaDiagnostic{};
  otaDiagnostic.operation = "RECEIVING";
  signedOta.phase = OtaPhase::Receiving;
  storeOtaRtcTrace(1);
  out.setOtaTcpPrimary(true);
  out.print(F("OTA_READY size=")); out.print(imageBytes);
  out.println(F(" chunk=8192"));
}

void finishSignedOta() {
  if (signedOta.phase != OtaPhase::Receiving ||
      signedOta.received != signedOta.size) return;
  storeOtaRtcTrace(4);
  otaDiagnostic.operation = "FINAL_HASH";
  uint8_t actualSha[32] = {};
  const int finalized = mbedtls_sha256_finish_ret(&signedOta.digest, actualSha);
  mbedtls_sha256_free(&signedOta.digest);
  signedOta.shaInitialized = false;
  if (finalized != 0 ||
      !constantTimeEqual(actualSha, signedOta.expectedHash, sizeof(actualSha))) {
    abortSignedOta("sha256_mismatch"); return;
  }
  otaDiagnostic.operation = "IMAGE_VERIFY";
  const esp_err_t verified = esp_ota_end(signedOta.handle);
  signedOta.handleOpen = false; // esp_ota_end owns/frees handle even on error
  if (verified != ESP_OK) {
    abortSignedOta("image_invalid"); return;
  }
  otaDiagnostic.operation = "NVS_METADATA";
  // Commit anti-replay version only after the NEW image successfully boots
  // and runs its health checks. If first boot fails, bootloader rolls back.
  OtaPendingLedger ledger;
  ledger.version = signedOta.version;
  ledger.imageSize = signedOta.size;
  ledger.targetAddress = signedOta.target->address;
  ledger.targetSize = signedOta.target->size;
  ledger.targetSubtype = signedOta.target->subtype;
  strncpy(ledger.targetLabel, signedOta.target->label,
          sizeof(ledger.targetLabel) - 1);
  memcpy(ledger.sha256, signedOta.expectedHash, sizeof(ledger.sha256));
  if (!prefsReady ||
      wifiPrefs.putString("ota_p_sha", signedOta.hexHash) != 64 ||
      wifiPrefs.putUInt("ota_pending", signedOta.version) != sizeof(uint32_t) ||
      wifiPrefs.putBytes("ota_ledger", &ledger, sizeof(ledger)) != sizeof(ledger)) {
    clearPendingOtaLedger();
    abortSignedOta("pending_metadata_failed"); return;
  }
  otaDiagnostic.operation = "BOOT_SWITCH";
  if (esp_ota_set_boot_partition(signedOta.target) != ESP_OK) {
    clearPendingOtaLedger();
    abortSignedOta("set_boot_failed"); return;
  }
  signedOta.phase = OtaPhase::RebootPending;
  otaDiagnostic.operation = "REBOOT_PENDING";
  storeOtaRtcTrace(5);
  signedOta.restartDeadlineMs = millis() + kOtaRebootMaxDelayMs;
  out.print(F("OTA_OK version=")); out.print(signedOta.version);
  out.print(F(" sha256=")); out.print(signedOta.hexHash);
  out.println(F(" rebooting=1"));
  signedOta.otaOkQueuedAt = out.queued();
}

void pollSignedOtaBody() {
  if (signedOta.phase != OtaPhase::Receiving) return;
  if (!tcpAuthenticated || !wifiClient.connected()) {
    abortSignedOta("disconnect"); return;
  }
  const uint32_t now = millis();
  if (static_cast<uint32_t>(now - signedOta.lastDataMs) > kOtaIdleTimeoutMs ||
      static_cast<uint32_t>(now - signedOta.beganMs) > kOtaTotalTimeoutMs) {
    abortSignedOta("timeout"); return;
  }
  if (signedOta.waitingProgressDrain) {
    // No next-window data is permitted until the previous ACK has been
    // enqueued on the TCP socket. The sender must independently wait for
    // the exact monotonic acknowledgement before releasing more bytes.
    if (out.tcpCursor() >= signedOta.progressQueuedAt) {
      // The host may receive an ACK and transmit the next window BEFORE
      // the ESP32 gets another loop turn. Such already-buffered bytes are
      // valid and must not be mistaken for a pre-ACK flood.
      signedOta.waitingProgressDrain = false;
      signedOta.nextWindowEnd =
         std::min(signedOta.size, signedOta.received + kOtaWindowSize);
    } else {
      // Only data received while the prior ACK is still unsent violates
      // stop-and-wait framing.
      if (wifiClient.available() > 0) {
        abortSignedOta("window_overrun"); return;
      }
      return;
    }
  }
  const int waiting = wifiClient.available();
  if (waiting <= 0) return;
  const size_t remaining = signedOta.nextWindowEnd - signedOta.received;
  const size_t chunkSize = std::min(remaining,
      std::min(static_cast<size_t>(waiting), kOtaChunkSize));
  uint8_t chunk[kOtaChunkSize];
  const int received = wifiClient.read(chunk, chunkSize);
  if (received <= 0) { abortSignedOta("transport_read_failed"); return; }
  if (signedOta.received == 0 && chunk[0] != 0xE9) {
    abortSignedOta("not_esp32_image"); return;
  }
  otaDiagnostic.operation = "HASH_UPDATE";
  if (mbedtls_sha256_update_ret(&signedOta.digest, chunk, received) != 0) {
    abortSignedOta("hash_update_failed"); return;
  }
  otaDiagnostic.operation = "FLASH_WRITE";
  const uint32_t flashStartUs = static_cast<uint32_t>(esp_timer_get_time());
  const esp_err_t flashResult = esp_ota_write(signedOta.handle, chunk, received);
  const uint32_t writeUs = static_cast<uint32_t>(esp_timer_get_time()) - flashStartUs;
  otaDiagnostic.lastWriteUs = writeUs;
  if (writeUs > otaDiagnostic.longestWriteUs)
    otaDiagnostic.longestWriteUs = writeUs;
  ++otaDiagnostic.writes;
  if (flashResult != ESP_OK) { abortSignedOta("write_failed"); return; }
  signedOta.received += static_cast<uint32_t>(received);
  otaDiagnostic.lastReceived = signedOta.received;
  otaDiagnostic.operation = "RECEIVING";
  otaDiagnostic.lastProgressMs = millis();
  signedOta.lastDataMs = millis();
  if (signedOta.received == signedOta.size) {
    finishSignedOta();
  } else if (signedOta.received == signedOta.nextWindowEnd) {
    // An ACK is only emitted AFTER every byte in this window was safely
    // accepted by esp_ota_write and included in the incremental SHA.
    signedOta.waitingProgressDrain = true;
    storeOtaRtcTrace(2);
    out.print(F("OTA_PROGRESS received="));
    out.println(signedOta.received);
    signedOta.progressQueuedAt = out.queued();
  }
}

void serviceSignedOtaTimeout() {
  if (signedOta.phase != OtaPhase::Receiving) return;
  const uint32_t now = millis();
  if (!tcpAuthenticated || !wifiClient.connected()) {
    abortSignedOta("disconnect"); return;
  }
  if (static_cast<uint32_t>(now - signedOta.lastDataMs) > kOtaIdleTimeoutMs ||
      static_cast<uint32_t>(now - signedOta.beganMs) > kOtaTotalTimeoutMs)
    abortSignedOta("timeout");
}

void confirmOtaBootFromNetwork(const char* cmd) {
  // A mere Wi-Fi STA link says nothing about whether the authenticated OTA
  // service works. The host must RECONNECT after reboot and prove it knows
  // the exact signed manifest of the new image via authenticated TCP.
  if (commandFromUSB || !tcpAuthenticated || !otaFirstBootPending ||
      !prefsReady || otaUpdating() || stage != IDLE) {
    out.println(F("OTA_CONFIRM DENIED")); return;
  }
  const char* expectedPrefix = "OTA_CONFIRM ";
  if (strncmp(cmd, expectedPrefix, strlen(expectedPrefix))) {
    out.println(F("OTA_CONFIRM DENIED")); return;
  }
  const char* args = cmd + strlen(expectedPrefix);
  const char* separator = strchr(args, ' ');
  uint32_t version = 0;
  char number[12] = {};
  const size_t numberLen = separator ? static_cast<size_t>(separator - args) : 0;
  const bool sizeValid = numberLen >= 1 && numberLen < sizeof(number);
  if (sizeValid) memcpy(number, args, numberLen);
  uint8_t candidateHash[32] = {}, savedHash[32] = {};
  const String trustedSha = wifiPrefs.getString("ota_p_sha", "");
  const uint32_t trustedVersion = wifiPrefs.getUInt("ota_pending", 0);
  const bool matched = sizeValid && separator && separator[1] &&
      !strchr(separator + 1, ' ') &&
      parseUnsignedDecimal(number, version) &&
      version == trustedVersion && version > otaAcceptedVersion &&
      decodeLowercaseHash(separator + 1, candidateHash) &&
      decodeLowercaseHash(trustedSha.c_str(), savedHash) &&
      constantTimeEqual(candidateHash, savedHash, sizeof(savedHash));
  if (!matched) { out.println(F("OTA_CONFIRM DENIED")); return; }
  otaPendingNetworkConfirmed = true;
  out.print(F("OTA_CONFIRM OK version=")); out.println(version);
}
void dropTcpClient(bool transportLost) {
  // The inactive partition remains unbootable after an interrupted upload;
  // abort the write handle rather than ever resuming an untrusted byte stream.
  if (signedOta.phase == OtaPhase::Receiving)
    abortSignedOta("disconnect");
  if (transportLost && otaFirstBootPending)
    otaPendingNetworkConfirmed = false; // reconnect must confirm again
  if (isRequestVariant(armedVariant) && !armedFromUSB) armedVariant = 255;
  if (transportLost && tcpAuthenticated) {
    ++transportFaults;
    if (busSessionActive()) stopEverything(HOST_STOP);
  }
  tcpAuthenticated = false;
  tcpHadActiveSession = false;
  wifiLineUsed = 0;
  wifiLineDiscard = false;
  bleLineUsed = 0;
  bleLineDiscard = false;
#ifdef SME105_BLE
  if (remoteIsBle && !transportLost) ble_transport::disconnect();
#endif
  remoteIsBle = false;
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
void onStaDisconnect(WiFiEvent_t, WiFiEventInfo_t info) {
  wifiLastDisconnectReason = info.wifi_sta_disconnected.reason;
  ++wifiDisconnectEvents;
}
void onStaGotIp(WiFiEvent_t, WiFiEventInfo_t) {
  ++wifiGotIpEvents;
}
void onApStop(WiFiEvent_t, WiFiEventInfo_t) {
  // Event task: counters only. Never touch sockets, NVS, ISR or vehicle bus.
  ++wifiApStopEvents;
}
// Integral action result avoids Arduino's generated forward declarations
// depending on a locally declared enum before it is defined.
constexpr int kWiFiRecoveryNone = 0, kWiFiRecoveryReconnect = 1;
constexpr int kWiFiRecoveryReinitialize = 2;
int chooseWiFiRecovery(uint32_t now, uint32_t offlineSince,
                                     uint32_t lastRetry, uint32_t lastReinit,
                                     bool vehicleActive) {
  if (vehicleActive) return kWiFiRecoveryNone;
  if (static_cast<uint32_t>(now - offlineSince) >= kStaReinitMs &&
      static_cast<uint32_t>(now - lastReinit) >= kStaReinitMs)
    return kWiFiRecoveryReinitialize;
  if (static_cast<uint32_t>(now - lastRetry) >= kStaRetryMs)
    return kWiFiRecoveryReconnect;
  return kWiFiRecoveryNone;
}
bool listenerRetryDue(uint32_t now, uint32_t lastAttempt) {
  return lastAttempt == 0 ||
      static_cast<uint32_t>(now - lastAttempt) >= kListenerRetryMs;
}
bool directApRetryDue(uint32_t now, uint32_t lastAttempt, bool vehicleActive) {
  return !vehicleActive && (lastAttempt == 0 ||
      static_cast<uint32_t>(now - lastAttempt) >= kApRetryMs);
}
void startSta() {
#ifdef SME105_BLE
  WiFi.mode(WIFI_OFF);
#else
  if (wifiApMode || !wifiConfigured || !prefsReady || busSessionActive()) return;
  const String ssid = wifiPrefs.getString("ssid", "");
  const String pass = wifiPrefs.getString("pass", "");
  if (ssid.length() < 1 || ssid.length() > 32 ||
      pass.length() < 8 || pass.length() > 63) {
    wifiConfigured = false;
    return;
  }
  WiFi.mode(WIFI_STA); // A station is enabled only when USB chose STA mode
  WiFi.persistent(false);
  WiFi.setHostname("sme105-bridge");
#ifdef SME105_BLE
  // ESP-IDF aborts in coex_enable() when Bluetooth starts while Wi-Fi
  // modem sleep is disabled; BLE is the primary transport in this build.
  WiFi.setSleep(true);
#else
  // Disable modem sleep for a low-latency always-on STA bridge. This uses
  // more power; insufficient vehicle supply/antenna coverage cannot be
  // cured by firmware and remains a separate physical diagnostic.
  WiFi.setSleep(false);
#endif
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str()); // asynchronous; no waiting or retry TX
  wifiLastRetryMs = millis();
#endif
}
void startDirectAp() {
#ifdef SME105_BLE
  WiFi.mode(WIFI_OFF);
#else
  if (!wifiApMode || !wifiConfigured || !prefsReady || busSessionActive()) return;
  const String ssid = wifiPrefs.getString("ap_ssid", "");
  const String pass = wifiPrefs.getString("ap_pass", "");
  if (ssid.length() < 1 || ssid.length() > 32 ||
      pass.length() < 16 || pass.length() > 63) {
    wifiApReady = false;
    return;
  }
  wifiLastApAttemptMs = millis();
  // AP-only avoids association/reinitialization with the distant home router
  // interrupting field collection. Strong WPA2 PSK is USB provisioned in NVS.
  WiFi.mode(WIFI_AP);
  WiFi.persistent(false);
  const bool configured = WiFi.softAPConfig(kDirectApIp, kDirectApIp, kDirectApMask);
  const bool started = configured && WiFi.softAP(ssid.c_str(), pass.c_str(), 6, 0, 1);
  wifiApReady = started && WiFi.softAPIP() == kDirectApIp;
  if (!wifiApReady) WiFi.softAPdisconnect(true);
#endif
}
bool networkOnline() {
  return wifiApMode ? wifiApReady && WiFi.getMode() == WIFI_AP &&
                        WiFi.softAPIP() == kDirectApIp :
                      WiFi.status() == WL_CONNECTED;
}
void initializeWiFi() {
#ifdef SME105_BLE
  // BLE PIN lives in NVS namespace sme105wifi key ble_pin. Open read-write
  // and do not erase keys. This build never starts STA or AP.
  prefsReady = wifiPrefs.begin("sme105wifi", false);
  WiFi.mode(WIFI_OFF);
#else
  WiFi.onEvent(onStaDisconnect, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onStaGotIp, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(onApStop, ARDUINO_EVENT_WIFI_AP_STOP);
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
  wifiApMode = wifiPrefs.getBool("ap_mode", false);
  if (wifiApMode) {
    const String apSsid = wifiPrefs.getString("ap_ssid", "");
    const String apPass = wifiPrefs.getString("ap_pass", "");
    wifiConfigured = apSsid.length() >= 1 && apSsid.length() <= 32 &&
                     apPass.length() >= 16 && apPass.length() <= 63;
  } else {
    wifiConfigured = ssid.length() >= 1 && ssid.length() <= 32 &&
                     pass.length() >= 8 && pass.length() <= 63;
  }
  if (wifiConfigured && wifiApMode) startDirectAp();
  else if (wifiConfigured) startSta();
  else WiFi.mode(WIFI_OFF);
#endif
}

void initializeOtaBootHealth() {
  otaAcceptedVersion = std::max(kOtaCurrentVersion,
      prefsReady ? wifiPrefs.getUInt("ota_ver", kOtaCurrentVersion) :
                   kOtaCurrentVersion);
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t imageState = ESP_OTA_IMG_UNDEFINED;
  const bool stateKnown = running &&
      esp_ota_get_state_partition(running, &imageState) == ESP_OK;
  const bool pendingVerify = stateKnown && imageState == ESP_OTA_IMG_PENDING_VERIFY;
  const bool ledgerPresent = loadPendingOtaLedger(otaTrustedLedger);
  const bool pendingKeysExist = prefsReady &&
      (wifiPrefs.isKey("ota_ledger") || wifiPrefs.isKey("ota_pending") ||
       wifiPrefs.isKey("ota_p_sha"));
  const bool sameTarget = ledgerPresent &&
      ledgerTargetsRunningApp(otaTrustedLedger, running);

  if (pendingVerify) {
    // A first boot from a different app, incomplete NVS record, tampered
    // manifest, or corrupted flash must always roll back. Legacy v2 keys
    // alone have no partition/length provenance and confer no authority.
    otaFirstBootPending = true;
    const String pendingSha = prefsReady ? wifiPrefs.getString("ota_p_sha", "") : "";
    uint8_t savedHash[32] = {};
    otaLedgerTrusted = sameTarget &&
        otaTrustedLedger.version > otaAcceptedVersion &&
        wifiPrefs.getUInt("ota_pending", 0) == otaTrustedLedger.version &&
        decodeLowercaseHash(pendingSha.c_str(), savedHash) &&
        constantTimeEqual(savedHash, otaTrustedLedger.sha256, sizeof(savedHash)) &&
        runningAppMatchesSignedHash(otaTrustedLedger, running);
    otaBootHealthFailed = !otaLedgerTrusted;
    out.println(F("OTA_BOOT state=PENDING_VERIFY authority=NONE DE=LOW"));
    return;
  }

  if (!pendingKeysExist) {
    if (stateKnown && imageState == ESP_OTA_IMG_VALID &&
        kUsbInstalledBuildVersion > otaAcceptedVersion) {
      // Trusted physical USB flash preserves otadata and NVS. Never make a
      // lower signed version acceptable merely because this version was
      // installed directly into the already-VALID running app partition.
      // PENDING_VERIFY images can reach this branch only AFTER their signed
      // ledger was accepted and cleared through the normal OTA pathway.
      if (prefsReady && wifiPrefs.putUInt("ota_ver", kUsbInstalledBuildVersion) == sizeof(uint32_t))
        otaAcceptedVersion = kUsbInstalledBuildVersion;
      else {
        otaFirstBootPending = true;
        otaBootHealthFailed = true;
        otaLedgerAlreadyValid = true; // fail inert until durable authority exists
      }
    }
    return;
  }
  if (sameTarget && stateKnown && imageState == ESP_OTA_IMG_VALID &&
      otaTrustedLedger.version > otaAcceptedVersion) {
    // Crash window: IDF made the image VALID, but power failed before
    // ota_ver was written. Full on-flash SHA + partition identity are
    // required before recovering that accepted version.
    otaFirstBootPending = true;
    otaLedgerAlreadyValid = true;
    otaLedgerTrusted = runningAppMatchesSignedHash(otaTrustedLedger, running);
    otaBootHealthFailed = !otaLedgerTrusted;
    if (otaLedgerTrusted) (void)acceptValidPendingOta();
    return;
  }
  if (sameTarget && otaTrustedLedger.version > otaAcceptedVersion &&
      (!stateKnown || imageState != ESP_OTA_IMG_VALID)) {
    // Unknown state on the *target* is never a license to accept/operate.
    otaFirstBootPending = true;
    otaBootHealthFailed = true;
    otaLedgerAlreadyValid = true; // prevent impossible rollback attempts
    return;
  }
  // Running the previous partition after rollback (or already accepted the
  // current VALID image): stale pending keys cannot advance ota_ver.
  clearPendingOtaLedger();
}

void serviceOtaHealthAndRestart() {
  if (signedOta.phase == OtaPhase::RebootPending) {
    // drainTCP() advances the cursor when lwIP accepts a write, BEFORE the
    // remote uploader necessarily receives OTA_OK. Keep the socket alive for
    // a bounded grace interval after the *entire* OTA_OK frame was queued to
    // TCP. Even a disconnected/unresponsive peer cannot hold reboot forever.
    const uint32_t now = millis();
    if (!signedOta.otaOkDrained && tcpAuthenticated && wifiClient.connected() &&
        out.tcpCursor() >= signedOta.otaOkQueuedAt) {
      signedOta.otaOkDrained = true;
      signedOta.otaOkDrainedAtMs = now;
    }
    const bool graceElapsed = signedOta.otaOkDrained &&
        static_cast<uint32_t>(now - signedOta.otaOkDrainedAtMs) >= kOtaOkDrainGraceMs;
    const bool deadlineElapsed =
        static_cast<int32_t>(now - signedOta.restartDeadlineMs) >= 0;
    if (graceElapsed || deadlineElapsed) {
      deOff();
      esp_restart();
    }
    return;
  }
  if (!otaFirstBootPending || otaRollbackAttempted) return;
  if (otaLedgerAlreadyValid) {
    // Once VALID, IDF rollback is impossible. Keep vehicle/OTA commands
    // blocked until the accepted-version NVS write succeeds; retry in loop
    // and again at next boot from the durable pending ledger.
    if (otaLedgerTrusted && !otaBootHealthFailed &&
        static_cast<int32_t>(millis() - otaLedgerRetryAfterMs) >= 0)
      (void)acceptValidPendingOta();
    return;
  }

  // All reboot validation is intentionally in loop(), AFTER Arduino init.
  // Pending-verification firmware cannot access ECU, ARM or begin new OTA.
  const bool hardwareSafe = gateReady && deTimer && slotTimer &&
       stage == IDLE && stopLatched && !slotInFlight && !slotArmed &&
       !(GPIO.out & (1UL << kDE)) &&
       GPIO.func_out_sel_cfg[kDE].func_sel == SIG_GPIO_OUT_IDX;
  const bool essentialState = prefsReady && wifiConfigured &&
       validHexToken(wifiToken) && hardwareSafe && !otaBootHealthFailed;
  // A connected STA alone is not enough for a device that must remain
  // remotely maintainable. Its authenticated TCP listener must also be up.
  const bool networkReady = networkOnline() &&
                            wifiServerStarted && static_cast<bool>(wifiServer);
  // Do not mark an OTA image VALID before its authenticated OTA_CONFIRM OK
  // reply has actually drained onto the authenticated TCP socket.
  const bool confirmationDelivered = otaPendingNetworkConfirmed &&
      tcpAuthenticated && wifiClient.connected() &&
      out.tcpCursor() == out.queued();
  if (essentialState && networkReady && confirmationDelivered &&
      millis() >= kOtaFirstBootCheckMs) {
    // The irreversible bootloader transition occurs FIRST. Pending NVS
    // metadata remains durable until ota_ver succeeds, so a power loss
    // after marking VALID can be reconciled on the next boot.
    if (!otaLedgerTrusted ||
        esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
      otaBootHealthFailed = true;
    } else {
      otaLedgerAlreadyValid = true;
      (void)acceptValidPendingOta();
      return;
    }
  }
  // A dead radio, bad settings, missing DE safety, or failed health check
  // must not approve the new image. The rollback-enabled bootloader will
  // select the prior app after we mark this first boot invalid.
  if (otaBootHealthFailed ||
      static_cast<uint32_t>(millis()) >= 45000) {
    otaRollbackAttempted = true;
    deOff();
    gateReady = false;
    out.println(F("OTA_BOOT state=FAILED action=ROLLBACK"));
    if (esp_ota_mark_app_invalid_rollback_and_reboot() != ESP_OK) {
      otaBootHealthFailed = true;
      // Fail inert if the previous app is unavailable. Do NOT mark valid.
    }
  }
}
void printWiFiStatus() {
  out.print(F("WIFI_STATUS state="));
  if (!wifiConfigured) out.print(F("DISABLED"));
  else if (networkOnline()) out.print(F("CONNECTED"));
  else out.print(F("CONNECTING"));
  out.print(F(" ip="));
  if (networkOnline()) out.print(wifiApMode ? WiFi.softAPIP() : WiFi.localIP());
  else out.print(F("0.0.0.0"));
  out.print(F(" port=")); out.print(kWiFiPort);
  out.print(F(" clients=")); out.print(tcpAuthenticated ? 1 : 0);
  // Canonical host label is stable; callers must use IP until CONNECTED.
  // Actual mDNS resolution is opportunistic, never a safety authority.
  out.println(F(" host=sme105-bridge.local"));
}
void printWiFiDiag() {
  // Diagnostic fields are intentionally numeric and secret-free. Reason is
  // the native ESP-IDF Wi-Fi disconnect code, NOT a proven physical cause.
  out.print(F("WIFI_DIAG disconnects=")); out.print(wifiDisconnectEvents);
  out.print(F(" last_reason=")); out.print(wifiLastDisconnectReason);
  out.print(F(" got_ip=")); out.print(wifiGotIpEvents);
  out.print(F(" reconnects=")); out.print(wifiRetryAttempts);
  out.print(F(" reinitializations=")); out.print(wifiStaReinitializations);
  out.print(F(" listener_failures=")); out.print(wifiListenerFailures);
  out.print(F(" listener_restarts=")); out.print(wifiListenerRestarts);
  out.print(F(" listener=")); out.print(wifiServerStarted && static_cast<bool>(wifiServer) ? 1 : 0);
  out.print(F(" mdns=")); out.print(mdnsStarted ? 1 : 0);
  out.print(F(" offline_ms=")); out.print(wifiWasOffline ? millis() - wifiOfflineSinceMs : 0);
  out.print(F(" rssi=")); out.print(!wifiApMode && networkOnline() ? WiFi.RSSI() : 0);
  out.print(F(" mode=")); out.print(wifiApMode ? F("AP") : F("STA"));
  out.print(F(" ap_clients=")); out.print(wifiApMode && networkOnline() ? WiFi.softAPgetStationNum() : 0);
  out.print(F(" ap_stops=")); out.println(wifiApStopEvents);
}
void printWiFiApStatus() {
  // AP SSID is a public radio name; PSK and control token never leave NVS.
  out.print(F("WIFI_AP_STATUS mode=")); out.print(wifiApMode ? F("AP") : F("STA"));
  out.print(F(" state=")); out.print(wifiApMode && networkOnline() ? F("ACTIVE") : F("INACTIVE"));
  out.print(F(" ip=")); out.print(wifiApMode && networkOnline() ? WiFi.softAPIP() : IPAddress(0,0,0,0));
  out.print(F(" stations=")); out.print(wifiApMode && networkOnline() ? WiFi.softAPgetStationNum() : 0);
  out.println(F(" channel=6 port=8765 wpa2=1"));
}
bool decodeWiFiCredentials(const char* command, size_t prefixLen,
                            char (&ssid)[33], char (&password)[64],
                            size_t &sn, size_t &pn, size_t minPassword) {
  const char* left = command + prefixLen;
  const char* space = strchr(left, ' ');
  if (!space || strchr(space + 1, ' ')) return false;
  char encSSID[48] = {};
  const size_t firstLen = static_cast<size_t>(space - left);
  sn = 0; pn = 0;
  bool okay = firstLen > 0 && firstLen < sizeof encSSID;
  if (okay) { memcpy(encSSID, left, firstLen); encSSID[firstLen] = 0; }
  okay = okay && validBase64(encSSID, 44) && validBase64(space + 1, 84) &&
         decodeBase64(encSSID, ssid, sizeof ssid, sn) &&
         decodeBase64(space + 1, password, sizeof password, pn) &&
         sn >= 1 && sn <= 32 && pn >= minPassword && pn <= 63;
  for (size_t i = 0; okay && i < sn; ++i)
    if (static_cast<uint8_t>(ssid[i]) < 32 ||
        static_cast<uint8_t>(ssid[i]) == 127) okay = false;
  for (size_t i = 0; okay && i < pn; ++i)
    if (static_cast<uint8_t>(password[i]) < 32 ||
        static_cast<uint8_t>(password[i]) > 126) okay = false;
  clearSecrets(encSSID, sizeof(encSSID));
  return okay;
}
void processWiFiProvision(const char* command) {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (busSessionActive() || stage == FINISHING ||
      otaUpdating() || otaFirstBootPending) {
    out.println(F("DENIED wifi_busy")); return;
  }
  constexpr size_t prefix = sizeof("WIFI_CONFIG ") - 1;
  if (!prefsReady || !validHexToken(wifiToken)) {
    out.println(F("DENIED wifi_config_invalid")); return;
  }
  char ssid[33] = {}, password[64] = {};
  size_t sn = 0, pn = 0;
  bool okay = decodeWiFiCredentials(command, prefix, ssid, password, sn, pn, 8);
  if (okay) {
    dropTcpClient(false);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    if (wifiApMode) { WiFi.softAPdisconnect(true); wifiApReady = false; }
    WiFi.disconnect(true, false);
    const bool saved = wifiPrefs.putString("ssid", ssid) == sn &&
                       wifiPrefs.putString("pass", password) == pn &&
                       wifiPrefs.putBool("ap_mode", false) == 1;
    if (saved) {
      wifiApMode = false;
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
}
void processDirectApProvision(const char* command) {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (busSessionActive() || stage == FINISHING ||
      otaUpdating() || otaFirstBootPending || !prefsReady ||
      !validHexToken(wifiToken)) {
    out.println(F("DENIED wifi_ap_busy")); return;
  }
  // Refuse in-place AP PSK rewrites. NVS contains two individual strings;
  // a partial write could otherwise destroy an already working direct link.
  // The existing credentials are reusable via WIFI_AP_MODE.
  const bool hadApSsid = wifiPrefs.isKey("ap_ssid");
  const bool hadApPass = wifiPrefs.isKey("ap_pass");
  if (wifiApMode || (hadApSsid && hadApPass)) {
    out.println(F("DENIED wifi_ap_config_exists")); return;
  }
  char ssid[33] = {}, password[64] = {};
  size_t sn = 0, pn = 0;
  const bool valid = decodeWiFiCredentials(
      command, sizeof("WIFI_AP_CONFIG ") - 1, ssid, password, sn, pn, 16);
  if (!valid) {
    clearSecrets(password, sizeof(password));
    clearSecrets(ssid, sizeof(ssid));
    out.println(F("DENIED wifi_ap_invalid"));
    return;
  }
  // Interrupted first-time provisioning may have committed only one of the
  // two NVS keys. Remove precisely that incomplete half, then retry with the
  // same USB-supplied credentials. NEVER overwrite a complete AP pair.
  if (hadApSsid != hadApPass &&
      ((hadApSsid && !wifiPrefs.remove("ap_ssid")) ||
       (hadApPass && !wifiPrefs.remove("ap_pass")))) {
    clearSecrets(password, sizeof(password));
    clearSecrets(ssid, sizeof(ssid));
    out.println(F("DENIED wifi_ap_nvs_failed"));
    return;
  }
  // NVS stores AP secrets privately; AP isn't activated until the commit flag.
  // On failed writes, fail closed rather than silently selecting an open AP.
  const bool saved = wifiPrefs.putString("ap_ssid", ssid) == sn &&
                     wifiPrefs.putString("ap_pass", password) == pn &&
                     wifiPrefs.putBool("ap_mode", true) == 1;
  clearSecrets(password, sizeof(password));
  clearSecrets(ssid, sizeof(ssid));
  if (!saved) {
    wifiPrefs.remove("ap_mode");
    wifiPrefs.remove("ap_ssid");
    wifiPrefs.remove("ap_pass");
    out.println(F("DENIED wifi_ap_nvs_failed"));
    return;
  }
  dropTcpClient(false);
  if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
  if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
  WiFi.disconnect(true, false);
  wifiApMode = true;
  wifiApReady = false;
  wifiConfigured = true;
  startDirectAp();
  out.println(F("WIFI_AP_CONFIG OK saved=1 starting=1"));
}
void selectStaMode() {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (busSessionActive() || stage == FINISHING || otaUpdating() ||
      otaFirstBootPending || !prefsReady) {
    out.println(F("DENIED wifi_busy")); return;
  }
  const String ssid = wifiPrefs.getString("ssid", "");
  const String pass = wifiPrefs.getString("pass", "");
  if (ssid.length() < 1 || ssid.length() > 32 ||
      pass.length() < 8 || pass.length() > 63 ||
      wifiPrefs.putBool("ap_mode", false) != 1) {
    out.println(F("DENIED wifi_sta_unavailable")); return;
  }
  dropTcpClient(false);
  if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
  if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
  if (wifiApMode) WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  wifiApMode = false;
  wifiApReady = false;
  wifiConfigured = true;
  startSta();
  out.println(F("WIFI_STA_MODE OK reconnecting=1"));
}
void selectApMode() {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (busSessionActive() || stage == FINISHING || otaUpdating() ||
      otaFirstBootPending || !prefsReady || !validHexToken(wifiToken)) {
    out.println(F("DENIED wifi_busy")); return;
  }
  const String ssid = wifiPrefs.getString("ap_ssid", "");
  const String pass = wifiPrefs.getString("ap_pass", "");
  if (ssid.length() < 1 || ssid.length() > 32 ||
      pass.length() < 16 || pass.length() > 63) {
    out.println(F("DENIED wifi_ap_unavailable")); return;
  }
  if (wifiApMode) {
    // Explicit USB recovery must not acknowledge "starting" while waiting
    // for the automatic 10-second retry window after a stopped AP.
    if (!networkOnline()) startDirectAp();
    out.println(F("WIFI_AP_MODE OK starting=1")); return;
  }
  if (wifiPrefs.putBool("ap_mode", true) != 1) {
    out.println(F("DENIED wifi_ap_nvs_failed")); return;
  }
  dropTcpClient(false);
  if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
  if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
  WiFi.disconnect(true, false);
  wifiApMode = true;
  wifiApReady = false;
  wifiConfigured = true;
  startDirectAp();
  out.println(F("WIFI_AP_MODE OK starting=1"));
}

void IRAM_ATTR deOff() {
  GPIO.out_w1tc = 1UL << kDE;
  GPIO.func_out_sel_cfg[kDE].func_sel = SIG_GPIO_OUT_IDX;
}
// One RMT item: 2180us DE HIGH then 80us LOW, followed by an end marker.
constexpr uint32_t kGateItem = 2180u | (1u << 15) | (80u << 16);
// Re-arm the whole one-shot gate on every use: in the 2026-11-04 KOEO run
// channels 2/3 no longer asserted DE on reuse while their UART word still
// reached the pad. Never rely on state left by a previous pulse.
void IRAM_ATTR startDeGate(uint8_t index) {
  const uint8_t channel = static_cast<uint8_t>(2 + index);
  RMT.conf_ch[channel].conf1.tx_start = 0;
  RMT.conf_ch[channel].conf1.mem_owner = 0;
  RMTMEM.chan[channel].data32[0].val = kGateItem;
  RMTMEM.chan[channel].data32[1].val = 0;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 1;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 0;
  GPIO.func_out_sel_cfg[kDE].func_sel = RMT_SIG_OUT2_IDX + index;
  RMT.conf_ch[channel].conf1.tx_start = 1;
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

// Live data: the first TX block loads mode 41H, every later block 21H.
CmdWord IRAM_ATTR dpsWord(uint8_t index) {
  if (isLiveVariant(variant) && index == 2 && dpsBlocks == 0) return CmdWord{0x41, 0x96};
  // 42H loads the address list. 22H (qualifier 000 in slot 3) returns those bytes.
  if (variant == kVariantMem && index == 2)
    return dpsBlocks < 2 ? CmdWord{0x42, 0xF3} : CmdWord{0x22, 0xD3};
  return word(variant, index);
}
uint8_t IRAM_ATTR livePid(uint8_t frame, uint8_t column = 0) {
  if (variant == kVariantAllLive) return allLivePid(frame, column);
  const uint8_t set = variant == kVariantLive2 ? 1 : variant == kVariantLive3 ? 2 : 0;
  return kLivePids[set][frame & 15];
}
bool IRAM_ATTR liveMapFrame(uint8_t frame) {
  return isLiveVariant(variant) && dpsBlocks == 1 && frame < 16 &&
         livePid(frame) != 0 && nearUs(framePeriodUs, kLiveFramePeriodUs, 600);
}
bool IRAM_ATTR memMapFrame(uint8_t frame) {
  // Offset 0 means "send nothing" in Ford's map, so addresses start at 1.
  return variant == kVariantMem && dpsBlocks == 1 && frame >= 1 && frame <= 15 &&
         nearUs(framePeriodUs, 15000, 1200);
}
CmdWord IRAM_ATTR offsetWord(uint8_t offset) {
  const uint8_t par = static_cast<uint8_t>(((offset >> 4) ^ (offset & 15) ^ 0x0A) << 4);
  return CmdWord{offset, par};
}
// Schedule one PID map word in IW2 of `frame` (single shot, own DE gate).
void IRAM_ATTR armExtra(uint8_t frame, uint32_t target, uint8_t column = 0) {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  const int32_t lead = static_cast<int32_t>(target - now);
  if (extraArmed || extraInFlight || slotArmed ||
      lead < static_cast<int32_t>(kSlotMinLeadUs) || lead > 4000 ||
      !armTimer(1, static_cast<uint32_t>(lead))) {
    faultISR(CART_TIMER);
    return;
  }
  extraWord = variant == kVariantMem ? offsetWord(frame) : pidWord(livePid(frame, column));
  extraTargetUs = target;
  extraFrame = frame;
  extraColumn = column;
  extraGate = static_cast<uint8_t>((frame + column + 1) & 3);
  extraArmed = true;
}
void IRAM_ATTR slotISR() {
  disableSlotTimer();
  portENTER_CRITICAL_ISR(&txLock);
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  if (extraArmed) {
    if (stage != CART_READ || stopLatched || slotArmed || slotInFlight || !gateReady ||
        !nearUs(now, extraTargetUs) || UART2.status.txfifo_cnt != 0 ||
        UART2.status.rxfifo_cnt != 0 ||
        UART2.mem_rx_status.rd_addr != UART2.mem_rx_status.wr_addr ||
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
    UART2.int_ena.tx_done = 1;
    extraArmed = false;
    extraInFlight = true;
    slotInFlight = true;
    extraStartUs = now;
    ++pidWordsStarted;
    startDeGate(extraGate);
    WRITE_PERI_REG(UART_FIFO_AHB_REG(2), extraWord.first);
    WRITE_PERI_REG(UART_FIFO_AHB_REG(2), extraWord.second);
    portEXIT_CRITICAL_ISR(&txLock);
    return;
  }
  if (stage != CART_READ || stopLatched || !slotArmed || slotInFlight ||
      pendingSlot != wordsStarted || wordsVerified != wordsStarted ||
      wordsStarted >= 4 || !gateReady ||
      !nearUs(now, targetUs) || UART2.status.txfifo_cnt != 0 ||
      UART2.status.rxfifo_cnt != 0 ||
      UART2.mem_rx_status.rd_addr != UART2.mem_rx_status.wr_addr ||
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
  // ESP32 UART LL documents rxfifo_rst as ineffective. Check for a drained
  // PAD FIFO above; never discard unread pad bytes with that broken bit.
  UART2.int_ena.tx_done = 1;
  slotArmed = false;
  slotInFlight = true;
  const uint8_t index = wordsStarted++;
  txStartUs[index] = now;
  // RMT autonomous single-shot gate: 2180us HIGH then 80us LOW.
  startDeGate(index);
  const CmdWord selected = dpsWord(index);
  // Native UART2 TX AHB FIFO writes, not the APB RX register bitfield.
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.first);
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.second);
  portEXIT_CRITICAL_ISR(&txLock);
}

void IRAM_ATTR uart2ISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & (1UL << 14)) { // TX_DONE shifted final 8N1 stop bit
    // The gate is still HIGH for ~90us after the stop bit: witness the pad.
    const bool deWasHigh = (GPIO.in & (1UL << kDE)) != 0;
    deOff();
    disableDeTimer();
    UART2.int_ena.tx_done = 0;
    const bool extra = extraInFlight;
    extraInFlight = false;
    const uint8_t index = static_cast<uint8_t>(wordsStarted - 1);
    const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
    slotInFlight = false;
    if (stage != CART_READ || stopLatched || (!extra && index >= 4) ||
        !nearUs(now, (extra ? extraStartUs : txStartUs[index]) + 2083, 175)) {
      faultISR(CART_TIMER);
    } else {
      // UART2 RX input matrix is ALSO attached to physical GPIO17.
      // Verify actual pad-decoded pair, not merely requested TX FIFO bytes.
      const uint32_t flags = UART2.int_raw.val;
      const uint32_t count = UART2.status.rxfifo_cnt;
      // Do not read UART2.fifo.rw_byte twice here: the old live-path
      // readback duplicated 0x01 as 01/01 after an actual 01/B0 RO echo.
      // The independently witnessed DE-LOW TX2_BENCH uses APB FIFO reads
      // and verifies that each read consumes exactly one RX entry. Match
      // that proven register access method in the time-critical ISR.
      const uint8_t b0 = count > 0 ?
          static_cast<uint8_t>(READ_PERI_REG(UART_FIFO_REG(2))) : 0;
      const uint32_t countMid = UART2.status.rxfifo_cnt;
      __asm__ __volatile__("nop" ::: "memory");
      const uint8_t b1 = count > 1 ?
          static_cast<uint8_t>(READ_PERI_REG(UART_FIFO_REG(2))) : 0;
      const uint32_t countAfter = UART2.status.rxfifo_cnt;
      if (!extra) {
        padRx[index][0] = b0;
        padRx[index][1] = b1;
        txDoneUs[index] = now;
        __sync_synchronize();
        padCount = index + 1;
      }
      const CmdWord expected = extra ? extraWord : dpsWord(index);
      // RXFIFO_TOUT (bit 8) indicates inactivity, not a UART frame error.
      // Parity, framing and overflow (bits 2..4) invalidate the pad witness.
      if (!deWasHigh) {
        faultISR(DE_MISSING);
      } else if (count != 2 || countMid != 1 || countAfter != 0 ||
          (flags & ((1UL << 2) | (1UL << 3) | (1UL << 4)))) {
        faultISR(PAD_FRAMING);
      } else if (b0 != expected.first || b1 != expected.second) {
        faultISR(PAD_MISMATCH);
      } else if (extra) {
        ++pidWordsVerified;
        // Schedule each following map word only after this word's physical
        // pad and DE checks pass. Keep independent watchdogs/gates per word.
        if (variant == kVariantAllLive && extraColumn + 1 < kAllLiveColumns)
          armExtra(extraFrame, extraTargetUs + 2500, extraColumn + 1);
      } else {
        ++wordsVerified;
        if (wordsVerified == 4 && !repeatDps) captureOnly = true;
        // Frames 1..3 of the map block: PID word follows in IW2.
        if (index >= 1 && (liveMapFrame(index) || memMapFrame(index))) armExtra(index, txStartUs[index] + 2500);
      }
    }
  }
  UART2.int_clr.val = pending;
}

void IRAM_ATTR slideHeader(uint8_t octet, uint32_t at) {
  if (headerUsed < 4) header[headerUsed++] = {at, octet};
  else {
    for (int i = 0; i < 3; ++i) header[i] = header[i + 1];
    header[3] = {at, octet};
  }
}
void IRAM_ATTR restartJoinSearch() {
  frameLocked = false;
  headerUsed = 0;
  baselineCount = 0;
  framePeriodUs = 0;
}
// header[] holds a validated sync+ID for frame `id`.
void IRAM_ATTR onFrameHeader(uint8_t id) {
  const uint32_t sync = header[1].at;
  headerUsed = 0;
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
  nextId = (id + 1) & 15;
  if (extraArmed || extraInFlight) { faultISR(CART_PHASE); return; }
  // A requested DIAGMODE changes the frame length at the next block start.
  if (joinMode && id == 0) framePeriodUs = 0;
  if (id >= 4) {
    if (!repeatDps) faultISR(CART_PHASE);
    else if (liveMapFrame(id) || memMapFrame(id)) armExtra(id, sync + 2917 + 2500);
    return;
  }
  if (id == 0 && repeatDps) {
    // LHBH1: idle DPS means normal mode, so the request is repeated in
    // frames 0..3 of every block. Only a fully verified block may roll over.
    if (wordsStarted != 0 && wordsVerified != 4) { faultISR(CART_PHASE); return; }
    if (variant == kVariantAllLive && dpsBlocks == 1 &&
        (pidWordsStarted != kAllLiveMapWords || pidWordsVerified != kAllLiveMapWords)) {
      faultISR(CART_PHASE); return;
    }
    if (stopAtBlock) { captureOnly = true; return; }
    if (wordsStarted == 4) ++dpsBlocks;
    wordsStarted = wordsVerified = padCount = 0;
  }
  if (wordsVerified != id || wordsStarted != id || slotInFlight || slotArmed) {
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
  pendingSlot = id;
  slotArmed = true;
}
void IRAM_ATTR observeHeader(uint8_t octet, uint32_t at) {
  if (stage != CART_READ && stage != CART_PASSIVE) return;
  if (captureOnly) return;
  // Preserve every byte in raw ring. Ignore likely local echo for *header parsing only*.
  if (wordsStarted > 0 && (uint32_t)(at - txStartUs[wordsStarted - 1]) <= 2600) return;
  if (!frameLocked) {
    slideHeader(octet, at);
    if (headerUsed == 4 && headerValid(0, 255)) {
      frameLocked = true;
      phase = nearUs(header[2].at, header[1].at + 1458) ? 4 : 0;
      baselineCount = 1;
      nextId = 1;
      lastSyncUs = header[1].at;
      headerUsed = 0;
      if (joinMode) framePeriodUs = 0;
    }
    return;
  }
  const uint8_t expectedId = baselineCount < 16 ? baselineCount : nextId;
  if (joinMode && framePeriodUs == 0) {
    // Diagnostic blocks carry data words between headers and the frame
    // period depends on the active frame length. Learn it from frame 0 -> 1.
    // "00 00" is always a sync: a zero data word carries parity A ("00 A0").
    if ((uint32_t)(at - lastSyncUs) > kJoinMaxPeriodUs + 2000) { restartJoinSearch(); return; }
    slideHeader(octet, at);
    if (headerUsed == 4 && headerValid(expectedId, phase)) {
      const uint32_t dt = header[1].at - lastSyncUs;
      if (dt < kJoinMinPeriodUs || dt > kJoinMaxPeriodUs) { restartJoinSearch(); return; }
      framePeriodUs = dt;
      onFrameHeader(expectedId);
    }
    return;
  }
  if (joinMode && headerUsed == 0) {
    // Only a byte at the predicted next-sync instant may start a header.
    const uint32_t expected = lastSyncUs + framePeriodUs - 1042;
    if (!nearUs(at, expected, kJoinGateUs) &&
        !(baselineCount == 16 && nearUs(at, expected + 2500, kJoinGateUs))) {
      if ((int32_t)(at - (expected + 2500 + kJoinGateUs)) > 0) {
        // Expected sync missing. Before TX authority: resync. Within a
        // repeated DPS session a lost frame ends the request (fail closed).
        if (baselineCount < 16) restartJoinSearch();
        else faultISR(CART_HEADER);
      }
      return;
    }
  }
  // Only original consecutive full headers are accepted for grant of TX authority.
  if (headerUsed < 4) header[headerUsed++] = {at, octet};
  else { faultISR(CART_HEADER); return; }
  if (headerUsed != 4) return;
  const uint32_t dt = header[1].at - lastSyncUs;
  const uint32_t period = joinMode ? framePeriodUs : 10000;
  const bool cadence = nearUs(dt, period) ||
      (baselineCount == 16 && nearUs(dt, period + 2500));
  if (!headerValid(expectedId, phase) || !cadence) {
    headerUsed = 0;
    // No TX has been scheduled before a full baseline block: resync instead.
    if (joinMode && baselineCount < 16) { restartJoinSearch(); return; }
    faultISR(CART_HEADER); return;
  }
  onFrameHeader(expectedId);
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
    lastRxAtUs = at;
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
  // Never set UART2.conf0.txfifo_rst: on classic ESP32 it corrupts the
  // UART1/UART2 TX FIFO (IDF uart_ll_txfifo_rst is a no-op for them). With
  // DE off, at most one pending word shifts out to the pad only; openNative()
  // performs a full UART2 module reset before the next session.
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
  gpio_set_direction(GPIO_NUM_18, GPIO_MODE_INPUT_OUTPUT); // DE pad readable
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
  frameLocked = false; captureOnly = false; joinMode = false;
  repeatDps = stopAtBlock = false; dpsBlocks = 0;
  extraArmed = extraInFlight = false; extraColumn = 0; pidWordsStarted = pidWordsVerified = 0;
  baselineCount = 0; headerUsed = 0; phase = 255; nextId = 0; framePeriodUs = 10000;
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
  // The handshake path gets a clean UART2 from HardwareSerial::begin(). A
  // session joining a running stream does not, so reset the module (its
  // FIFO pointers included) explicitly; the first config enables its clock.
  deOff();
  if (uart_param_config(UART_NUM_2, &conf) != ESP_OK) return false;
  periph_module_reset(PERIPH_UART2_MODULE);
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
  // uart_ll_rxfifo_rst() for classic ESP32 drains APB RX FIFO because the
  // rxfifo_rst register bit does NOT reliably reset it. Bound that drain
  // here, before ISR activation, to avoid hanging if GPIO17 is noisy.
  bool padRxEmpty = false;
  for (uint16_t n = 0; n < 128; ++n) {
    if (UART2.status.rxfifo_cnt == 0 &&
        UART2.mem_rx_status.rd_addr == UART2.mem_rx_status.wr_addr) {
      padRxEmpty = true; break;
    }
    (void)READ_PERI_REG(UART_FIFO_REG(2));
  }
  if (!padRxEmpty) return false;
  // Classic ESP32 uart_ll_txfifo_rst() deliberately avoids UART1/2's
  // coupled TX FIFO reset hardware. Never reset UART2 memory after the
  // 2400-baud handshake; require its FIFO and shifter to be truly idle.
  if (UART2.status.txfifo_cnt != 0 || UART2.status.st_utx_out != 0)
    return false;
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
// Decode a completed input-only RMT1 pad waveform using 9600/8N1 bit centers.
// The only accepted start is the FIRST low run: no phase-search that could
// accidentally find matching source data inside an unrelated waveform.
bool decodeFirstTx2RmtPair(const rmt_item32_t* wave, size_t items, CmdWord expected) {
  if (!wave || items == 0 || items > 48) return false;
  uint32_t ends[96] = {};
  uint8_t levels[96] = {};
  size_t runs = 0;
  uint32_t until = 0;
  for (size_t i = 0; i < items; ++i) {
    for (uint8_t j = 0; j < 2; ++j) {
      const uint8_t level = j == 0 ? wave[i].level0 : wave[i].level1;
      uint32_t duration = j == 0 ? wave[i].duration0 : wave[i].duration1;
      if (duration == 0) {
        // RMT's terminal RX_END sometimes encodes the last steady HIGH
        // period as 0. A completed packet with 1500us idle timeout proves
        // that stable final HIGH, but only at the LAST packet half-item.
        if (i != items - 1 || j != 1 || level != 1) return false;
        duration = 1500;
      }
      if (duration > 5000 || until + duration > 5000 ||
          (runs && levels[runs - 1] == level)) return false;
      until += duration;
      levels[runs] = level;
      ends[runs++] = until;
    }
  }
  if (runs < 2) return false;
  size_t firstLow = 0;
  if (levels[0] == 1) {
    if (ends[0] > 300) return false; // no long unmeasured idle prefix
    firstLow = 1;
  }
  if (firstLow >= runs || levels[firstLow] != 0) return false;
  const uint32_t start = firstLow == 0 ? 0 : ends[firstLow - 1];
  // TX starts with 01 (LSB first), thus its start bit must be one
  // approximately 104us LOW run, not a mid-frame low burst.
  const uint32_t firstLowLength = ends[firstLow] - start;
  if (firstLowLength < 80 || firstLowLength > 130) return false;
  for (uint8_t frame = 0; frame < 2; ++frame) {
    const uint8_t expectedByte = frame == 0 ? expected.first : expected.second;
    for (uint8_t bit = 0; bit < 10; ++bit) {
      // ESP32 RMT div80 = 1us, UART 9600 = 1250/12 us per bit.
      const uint32_t sample = start +
          (static_cast<uint32_t>(2 * (frame * 10 + bit) + 1) * 1250) / 24;
      uint8_t observed = 2;
      for (size_t i = 0; i < runs; ++i) {
        if (sample < ends[i]) { observed = levels[i]; break; }
      }
      const uint8_t wanted = bit == 0 ? 0 :
                             bit == 9 ? 1 :
                             (expectedByte >> (bit - 1)) & 1;
      if (observed != wanted) return false;
    }
  }
  return true;
}
// Bench the native TX2 -> physical GPIO17 -> native RX2 path without ever
// enabling MAX487 DE. Operator must ensure the bus is physically disconnected.
// The received bytes come from the GPIO input matrix, not the TX FIFO source.
void dumpGateRmt() {
  for (uint8_t ch = 2; ch <= 6; ++ch) {
    out.print(F("DE_BENCH_RMT ch=")); out.print(ch);
    out.print(F(" item0=0x")); out.print(RMTMEM.chan[ch].data32[0].val, HEX);
    out.print(F(" item1=0x")); out.print(RMTMEM.chan[ch].data32[1].val, HEX);
    out.print(F(" tx_start=")); out.print(RMT.conf_ch[ch].conf1.tx_start);
    out.print(F(" mem_owner=")); out.println(RMT.conf_ch[ch].conf1.mem_owner);
  }
}
// Exercise every DE gate channel three times with DI held at the idle MARK
// level, so an attached bus only ever sees idle. Dumps RMT state first.
void deGateBench() {
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (stage != IDLE || !stopLatched || slotArmed || slotInFlight || nativeReady ||
      refReady || !gateReady || otaUpdating() || out.freeBytes() < 4096) {
    out.println(F("DENIED de_bench_busy")); return;
  }
  dumpGateRmt();
  pinMode(kDI, OUTPUT);
  digitalWrite(kDI, HIGH);
  bool passed = true;
  for (uint8_t round = 0; round < 3; ++round) {
    for (uint8_t index = 0; index < 4; ++index) {
      deOff();
      delayMicroseconds(200);
      const bool lowBefore = (GPIO.in & (1UL << kDE)) == 0;
      portENTER_CRITICAL(&txLock);
      startDeGate(index);
      portEXIT_CRITICAL(&txLock);
      delayMicroseconds(1000);
      const bool highMid = (GPIO.in & (1UL << kDE)) != 0;
      delayMicroseconds(1500);
      const bool lowAfter = (GPIO.in & (1UL << kDE)) == 0;
      deOff();
      const bool ok = lowBefore && highMid && lowAfter;
      passed = passed && ok;
      out.print(F("DE_BENCH_PULSE round=")); out.print(round);
      out.print(F(" ch=")); out.print(2 + index);
      out.print(F(" low_before=")); out.print(lowBefore ? 1 : 0);
      out.print(F(" high_mid=")); out.print(highMid ? 1 : 0);
      out.print(F(" low_after=")); out.println(lowAfter ? 1 : 0);
    }
  }
  deOff();
  pinMode(kDI, INPUT);
  out.print(F("DE_BENCH_END result=")); out.print(passed ? F("PASS") : F("FAIL"));
  out.println(F(" di=MARK DE=LOW"));
}
void tx2PadBench() {
  // TCP requires the same explicit one-shot command on an authenticated
  // connection; no Wi-Fi/USB reconnect or OTA upgrade triggers this routine.
  if (!commandFromUSB && !tcpAuthenticated) {
    out.println(F("DENIED tx2_bench_auth_required")); return;
  }
  if (tx2BenchUsed || stage != IDLE || !stopLatched || slotArmed ||
      slotInFlight || nativeReady || refReady || transmitConsumed ||
      observeConsumed || !gateReady || !deTimer || !slotTimer ||
      // Budget the entire bounded RMT edge report before producing any TX.
      otaUpdating() || otaFirstBootPending || out.freeBytes() < 8192) {
    out.println(F("DENIED tx2_bench_used_or_busy")); return;
  }
  tx2BenchUsed = true; // Consume even if UART initialization fails.
  tx2BenchPassed = false;
  armedVariant = 255; // An old ARM is never preserved across this test.
  disableSlotTimer();
  disableDeTimer();
  deOff();
  // GPIO18 input sensing reads the actual DE pad while its output remains LOW.
  if (gpio_set_direction(GPIO_NUM_18, GPIO_MODE_INPUT_OUTPUT) != ESP_OK) {
    deOff();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL de_input_init=0")); return;
  }
  deOff();
  delayMicroseconds(10);
  const auto deLowOnPad = []() -> bool {
    return GPIO.func_out_sel_cfg[kDE].func_sel == SIG_GPIO_OUT_IDX &&
           (GPIO.in & (1UL << kDE)) == 0 &&
           (GPIO.out & (1UL << kDE)) == 0;
  };
  if (!deLowOnPad()) {
    deOff();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL de_pad_not_low=1")); return;
  }
  // Reproduce the 2400 HardwareSerial -> native 9600 transition, including
  // the two exact 11-byte reference FIFO writes. This is NOT an ECU handshake:
  // no ACK is sought and DE is held LOW throughout the USB-only pad bench.
  if (!openReference()) {
    deOff(); closeReference();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL reference_init=0")); return;
  }
  bool referenceOk = true;
  for (uint8_t frame = 0; frame < 2; ++frame) {
    if (!deLowOnPad() || UART2.status.txfifo_cnt || UART2.status.st_utx_out) {
      referenceOk = false; break;
    }
    const uint32_t refStarted = static_cast<uint32_t>(esp_timer_get_time());
    const uint8_t* fixed = frame == 0 ? kEchoId : kGoCart;
    if (referenceBus.write(fixed, sizeof(kEchoId)) != sizeof(kEchoId)) {
      referenceOk = false; break;
    }
    bool referenceDone = false;
    while (static_cast<uint32_t>(esp_timer_get_time()) - refStarted < 65000) {
      if (!deLowOnPad()) { referenceOk = false; break; }
      const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - refStarted;
      if (elapsed >= 48000 && UART2.status.txfifo_cnt == 0 &&
          UART2.status.st_utx_out == 0) {
        referenceDone = true; break;
      }
      delayMicroseconds(50);
    }
    if (!referenceDone || !referenceOk || !deLowOnPad()) {
      referenceOk = false; break;
    }
    out.print(F("TX2_BENCH_REF frame=")); out.print(frame);
    out.println(F(" bytes=11 uart_baud=2400 de_low=1 external_bus_disabled=1"));
    delay(5);
  }
  if (!referenceOk || !deLowOnPad()) {
    deOff(); closeReference();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL reference_tx_or_de=1")); return;
  }
  if (!openNative() || !deLowOnPad()) {
    deOff(); closeNative();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL native_init=0")); return;
  }
  // RMT1 is a SECOND, input-only physical GPIO17 witness. Unlike reading
  // UART2 RXFIFO twice, a completed RMT packet observes pad level/duration
  // transitions and cannot be mistaken for repeated APB FIFO data. No DE
  // channel is configured or started by this bench.
  rmt_config_t diag = {};
  diag.rmt_mode = RMT_MODE_RX;
  diag.channel = RMT_CHANNEL_1;
  diag.gpio_num = GPIO_NUM_17;
  diag.clk_div = 80; // each RMT run length is 1us
  diag.mem_block_num = 1;
  diag.rx_config.filter_en = false;
  diag.rx_config.idle_threshold = 1500; // 2-byte 9600 frame plus idle ends in 3.6ms
  RingbufHandle_t diagRing = nullptr;
  bool diagInstalled = false;
  if (rmt_config(&diag) == ESP_OK &&
      rmt_driver_install(RMT_CHANNEL_1, 2048, 0) == ESP_OK) {
    diagInstalled = true;
    if (rmt_get_ringbuf_handle(RMT_CHANNEL_1, &diagRing) != ESP_OK)
      diagRing = nullptr;
  }
  // rmt_config() changes the GPIO17 direction. Restore UART2 TX + UART2
  // RX and enable the independent RMT1 input on that very same physical pad.
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_INPUT_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U2TXD_OUT_IDX, false, false);
  gpio_matrix_in(GPIO_NUM_17, U2RXD_IN_IDX, false);
  gpio_matrix_in(GPIO_NUM_17, RMT_SIG_IN1_IDX, false);
  if (!diagRing || !deLowOnPad() ||
      GPIO.func_in_sel_cfg[RMT_SIG_IN1_IDX].func_sel != kDI ||
      GPIO.func_in_sel_cfg[RMT_SIG_IN1_IDX].sig_in_sel != 1 ||
      GPIO.func_out_sel_cfg[kDI].func_sel != U2TXD_OUT_IDX) {
    deOff();
    if (diagInstalled) (void)rmt_driver_uninstall(RMT_CHANNEL_1);
    closeNative();
    transmitConsumed = observeConsumed = true;
    out.println(F("TX2_BENCH_END result=FAIL independent_pad_witness_init=0")); return;
  }
  const uint32_t clockDiv = UART2.clk_div.val;
  const uint32_t uartConf = UART2.conf0.val;
  out.print(F("TX2_BENCH_BEGIN gpio17_pad_rx=1 de18=LOW reference_2400_frames=2 config_9600=1 source=AHB_FIFO clk_div=0x"));
  out.print(clockDiv, HEX);
  out.print(F(" uart_conf0=0x")); out.println(uartConf, HEX);
  bool passed = true;
  uint8_t completed = 0;
  bool rmtFirstStarted = false;
  bool rmtFirstExact = false;
  for (uint8_t index = 0; index < 4 && passed; ++index) {
    const CmdWord expected = word(0, index); // Fixed A4 candidate pair, no USB input bytes.
    if (!deLowOnPad() || UART2.status.txfifo_cnt != 0 ||
        UART2.status.rxfifo_cnt != 0 || UART2.status.st_utx_out != 0 ||
        GPIO.func_out_sel_cfg[kDI].func_sel != U2TXD_OUT_IDX ||
        GPIO.func_in_sel_cfg[U2RXD_IN_IDX].func_sel != kDI ||
        GPIO.func_in_sel_cfg[U2RXD_IN_IDX].sig_in_sel != 1) {
      passed = false;
      out.print(F("TX2_BENCH_DENIED slot=")); out.print(index);
      out.println(F(" reason=pad_or_uart_not_idle"));
      break;
    }
    if (index == 0) {
      if (rmt_rx_start(RMT_CHANNEL_1, true) != ESP_OK) {
        passed = false;
        out.println(F("TX2_BENCH_DENIED slot=0 reason=independent_rmt_start"));
        break;
      }
      rmtFirstStarted = true;
    }
    UART2.int_clr.val = 0xFFFFFFFF;
    const uint32_t started = static_cast<uint32_t>(esp_timer_get_time());
    WRITE_PERI_REG(UART_FIFO_AHB_REG(2), expected.first);
    WRITE_PERI_REG(UART_FIFO_AHB_REG(2), expected.second);
    bool done = false;
    bool deStayedLow = true;
    while (static_cast<uint32_t>(esp_timer_get_time()) - started < 3200) {
      if (!deLowOnPad()) { deStayedLow = false; break; }
      if (UART2.int_raw.tx_done) { done = true; break; }
      delayMicroseconds(20);
    }
    const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - started;
    const uint32_t rxFlags = UART2.int_raw.val;
    const uint32_t count = UART2.status.rxfifo_cnt;
    const uint32_t rxMemBefore = UART2.mem_rx_status.val;
    const uint8_t observed0 = count > 0 ?
        static_cast<uint8_t>(READ_PERI_REG(UART_FIFO_REG(2))) : 0;
    // Snapshot after the first APB FIFO read: if read pointer/count did not
    // move, a duplicate 01/01 may be an RX FIFO access error, not TX pad.
    const uint32_t rxMemMid = UART2.mem_rx_status.val;
    const uint32_t rxCountMid = UART2.status.rxfifo_cnt;
    __asm__ __volatile__("nop" ::: "memory"); // ESP32 uart_ll HAL precaution
    const uint8_t observed1 = count > 1 ?
        static_cast<uint8_t>(READ_PERI_REG(UART_FIFO_REG(2))) : 0;
    const uint32_t rxMemAfter = UART2.mem_rx_status.val;
    const uint32_t rxCountAfter = UART2.status.rxfifo_cnt;
    const bool exact = done && deStayedLow && deLowOnPad() && count == 2 &&
        !(rxFlags & ((1UL << 2) | (1UL << 3) | (1UL << 4))) &&
        elapsed >= 1800 && elapsed <= 3200 &&
        observed0 == expected.first && observed1 == expected.second;
    out.print(F("TX2_BENCH_WORD slot=")); out.print(index);
    out.print(F(" expected=")); outputHex(expected.first); outputHex(expected.second);
    out.print(F(" observed=")); outputHex(observed0); outputHex(observed1);
    out.print(F(" rx_count=")); out.print(count);
    out.print(F(" rx_count_mid=")); out.print(rxCountMid);
    out.print(F(" rx_count_after=")); out.print(rxCountAfter);
    out.print(F(" rx_mem_before=0x")); out.print(rxMemBefore, HEX);
    out.print(F(" rx_mem_mid=0x")); out.print(rxMemMid, HEX);
    out.print(F(" rx_mem_after=0x")); out.print(rxMemAfter, HEX);
    out.print(F(" raw_flags=0x")); out.print(rxFlags, HEX);
    out.print(F(" done=")); out.print(done ? 1 : 0);
    out.print(F(" elapsed_us=")); out.print(elapsed);
    out.print(F(" de_low=")); out.print(deStayedLow && deLowOnPad() ? 1 : 0);
    out.print(F(" match=")); out.println(exact ? 1 : 0);
    if (!exact) { passed = false; break; }
    ++completed;
    delay(8); // Approximately the normal 10ms between CART word starts.
  }
  // No unverified RMTMEM fallback: only publish a complete RX_END packet.
  // First word only is sufficient to distinguish 01B0 from a repeated 0101.
  if (rmtFirstStarted) {
    const uint32_t settleStart = static_cast<uint32_t>(esp_timer_get_time());
    while (static_cast<uint32_t>(esp_timer_get_time()) - settleStart < 5000) {
      if (!deLowOnPad()) { passed = false; break; }
      delayMicroseconds(50);
    }
    (void)rmt_rx_stop(RMT_CHANNEL_1);
    size_t packetBytes = 0;
    void* const packet = xRingbufferReceive(diagRing, &packetBytes, 0);
    const size_t items = packet ? packetBytes / sizeof(rmt_item32_t) : 0;
    const bool complete = packet && packetBytes != 0 &&
                          packetBytes % sizeof(rmt_item32_t) == 0 &&
                          items <= 48;
    out.print(F("TX2_BENCH_RMT scope=GPIO17 source="));
    out.print(complete ? F("RMT_COMPLETE_PACKET") : F("NONE_OR_OVERFLOW"));
    out.print(F(" items=")); out.println(items);
    if (complete) {
      const auto* const wave = static_cast<const rmt_item32_t*>(packet);
      rmtFirstExact = decodeFirstTx2RmtPair(wave, items, word(0, 0));
      out.print(F("TX2_BENCH_RMT_DECODE expected=01B0 match="));
      out.println(rmtFirstExact ? 1 : 0);
      for (size_t i = 0; i < items; ++i) {
        const rmt_item32_t& edge = wave[i];
        out.print(F("TX2_BENCH_RMT_EDGE i=")); out.print(i);
        out.print(F(" l0=")); out.print(edge.level0);
        out.print(F(" d0_us=")); out.print(edge.duration0);
        out.print(F(" l1=")); out.print(edge.level1);
        out.print(F(" d1_us=")); out.println(edge.duration1);
      }
    }
    if (packet) vRingbufferReturnItem(diagRing, packet);
    // The independent pad waveform is a REQUIRED proof for this boot.
    // A correct UART2 FIFO readback alone cannot authorize CART_READ.
    if (!complete || !rmtFirstExact) passed = false;
  }
  if (diagInstalled) (void)rmt_driver_uninstall(RMT_CHANNEL_1);
  deOff();
  closeNative();
  deOff();
  // Only all four exact, electrically sampled DE-LOW pad words grant a
  // volatile source-readback latch. No USB/TCP acknowledgement, TX_DONE,
  // UART TX FIFO write, or partial bench may grant CART_READ authority.
  tx2BenchPassed = passed && completed == 4 && deLowOnPad();
  if (!tx2BenchPassed) transmitConsumed = observeConsumed = true;
  out.print(F("TX2_BENCH_END result=")); out.print(tx2BenchPassed ? F("PASS_LOCAL_PAD") : F("FAIL"));
  out.print(F(" completed=")); out.print(completed);
  out.println(F(" DE=LOW no_rmt_start=1 ecu_tx=0 no_auto_retry=1"));
}
void beginSession(Stage target, uint8_t kind) {
  if (target == CART_READ && !tx2BenchPassed) {
    out.println(F("DENIED tx2_pad_bench_required")); return;
  }
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
  const bool offline = target == CART_READ && kind == kVariantOffline;
  if (target == CART_READ &&
      ((offline ? offlineConsumed : transmitConsumed) ||
       armedVariant != kind || armedFromUSB != commandFromUSB ||
       static_cast<int32_t>(armExpiresMs - millis()) <= 0)) {
    out.println(F("DENIED arm_required_or_consumed")); return;
  }
  if (offline) offlineConsumed = true; // before any DPS TX
  else if (target == CART_READ) transmitConsumed = true; // before any 2400 TX
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
  if (offline) {
    // The ECU is already CART link master; no 2400 handshake and no quiet
    // line. DPS words go out only after a full 16-frame baseline block.
    if (!openNative()) { stopEverything(CART_INIT); out.println(F("FAULT reason=CART_INIT")); return; }
    joinMode = true;
    framePeriodUs = 0;
    stopLatched = false;
    stage = CART_READ; captureStartedMs = millis();
    out.println(F("EVENT session=OFFLINE_JOIN no_handshake=1"));
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
      if (joinsRunningCart(variant)) {
        // Already in CART. openNative() clears joinMode, repeatDps and
        // framePeriodUs, so those are set after it, matching OFFLINE_JOIN.
        // A4/0E leave repeatDps false: four verified words set captureOnly.
        if (!openNative()) { stopEverything(CART_INIT); out.println(F("FAULT reason=CART_INIT")); return; }
        joinMode = true;
        repeatDps = isRepeating(variant);
        framePeriodUs = 0;
        stopLatched = false;
        stage = CART_READ;
        captureStartedMs = now;
        out.println(F("EVENT join=running_cart no_handshake=1"));
        return;
      }
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
        // Self test needs the 25H request repeated every block while frame
        // lengths change, so it uses the adaptive header gate.
        joinMode = repeatDps = isRepeating(variant);
        stage = isRequestVariant(variant) ? CART_READ : CART_PASSIVE;
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
    const CmdWord selected = dpsWord(i);
    out.print(F("TX_PAD slot=")); out.print(i);
    out.print(F(" expected=")); outputHex(selected.first); outputHex(selected.second);
    out.print(F(" observed=")); outputHex(padRx[i][0]); outputHex(padRx[i][1]);
    out.print(F(" tx_us=")); out.print(txStartUs[i]);
    out.print(F(" done_us=")); out.print(txDoneUs[i]);
    out.print(F(" match=")); out.println(i < wordsVerified ? 1 : 0);
  }
}
void flushRaw() {
  if (variant == kVariantAllLive) {
    // Lossless compact batches keep the 39-channel stream below the USB
    // 115200-baud budget. Each byte retains its original MCU timestamp.
    // Flush within 2 ms of the last byte or at 16 events, including at END.
    const uint16_t available = (rxWrite - rxRead) & (kRxRingSize - 1);
    if (!available) return;
    if (available < 16 && (stage == CART_READ || stage == CART_PASSIVE) &&
        static_cast<uint32_t>(esp_timer_get_time()) - lastRxAtUs < 2000) return;
    const uint16_t count = std::min(available, static_cast<uint16_t>(16));
    char line[320];
    const uint32_t base = rxRing[rxRead].at;
    int len = snprintf(line, sizeof(line), "RXB t_us=%lu data=", static_cast<unsigned long>(base));
    for (uint16_t i = 0; i < count; ++i)
      len += snprintf(line + len, sizeof(line) - len, "%02X", rxRing[(rxRead + i) & (kRxRingSize - 1)].value);
    len += snprintf(line + len, sizeof(line) - len, " dt=");
    for (uint16_t i = 0; i < count; ++i)
      len += snprintf(line + len, sizeof(line) - len, "%s%lu", i ? "," : "",
          static_cast<unsigned long>(rxRing[(rxRead + i) & (kRxRingSize - 1)].at - base));
    len += snprintf(line + len, sizeof(line) - len, "\n");
    if (len <= 0 || len >= static_cast<int>(sizeof(line)) || out.freeBytes() < static_cast<size_t>(len)) return;
    out.write(reinterpret_cast<const uint8_t*>(line), len);
    rxRead = (rxRead + count) & (kRxRingSize - 1);
    return;
  }
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
    const uint32_t limit = stage != CART_READ ? kCaptureMs :
        variant == kVariantKoeo ? kKoeoCaptureMs :
        variant == kVariantKoer ? kKoerCaptureMs :
        variant == kVariantClear ? kClearCaptureMs :
        variant == kVariantMem ? kMemCaptureMs :
        isLiveVariant(variant) ? kLiveCaptureMs :
        variant == kVariantOffline ? kOfflineCaptureMs : kCaptureMs;
    const uint32_t elapsed = millis() - captureStartedMs;
    const uint32_t rxAgeUs = static_cast<uint32_t>(esp_timer_get_time()) - lastRxAtUs;
    if (isLiveVariant(variant) && stage == CART_READ && elapsed >= 5000 &&
        rxAgeUs >= 5000000UL) {
      // Distinguish silence at GPIO16/UART1 from a malformed CART header.
      // The former had been reported as CART_HEADER (7), indistinguishable
      // from an ISR framing failure. An RX-board LED is NOT proof that the
      // ESP32 has received a byte. Preserve the fail-closed DE/TX shutdown:
      // suppressing this stop would not restore missing live measurements.
      const uint32_t received = rxTotal;
      const uint32_t blocks = dpsBlocks;
      const uint32_t lastRxUs = lastRxAtUs;
      const uint8_t started = wordsStarted;
      const uint8_t verified = wordsVerified;
      const uint8_t nextFrame = nextId;
      const uint8_t inFlight = slotInFlight ? 1 : 0;
      const uint8_t pending = slotArmed ? 1 : 0;
      const uint8_t uart2Busy = UART2.status.st_utx_out ? 1 : 0;
      const uint8_t roHigh = digitalRead(kRO) == HIGH ? 1 : 0;
      stopEverything(RX_SILENCE);
      out.print(F("EVENT live_rx_silence elapsed_ms=")); out.print(elapsed);
      out.print(F(" last_rx_age_us=")); out.print(rxAgeUs);
      out.print(F(" last_rx_us=")); out.print(lastRxUs);
      out.print(F(" ro_bytes=")); out.print(received);
      out.print(F(" dps_blocks=")); out.print(blocks);
      out.print(F(" words_started=")); out.print(started);
      out.print(F(" words_verified=")); out.println(verified);
      out.print(F("EVENT live_rx_stop_state next_frame=")); out.print(nextFrame);
      out.print(F(" slot_in_flight=")); out.print(inFlight);
      out.print(F(" slot_armed=")); out.print(pending);
      out.print(F(" uart2_busy=")); out.print(uart2Busy);
      out.print(F(" ro_pin_high=")); out.println(roHigh);
      out.println(F("FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW"));
      return;
    }
    if (elapsed >= limit) {
      // A repeated DPS ends only at a block boundary, never mid-request.
      if (stage == CART_READ && repeatDps && !captureOnly && elapsed < limit + 3000) {
        stopAtBlock = true;
        return;
      }
      stopEverything(CAPTURE_TIMEOUT);
    }
  }
}
void reportEnd() {
  // Raw events MUST be drained before END. Retain bounded capture on USB host.
  flushPadReports();
  flushRaw();
  if (rxRead != rxWrite) return;
  if (isLiveVariant(variant)) {
    out.print(F("EVENT live_pid_map set="));
    if (variant == kVariantAllLive) out.print(F("ALL"));
    else out.print(variant == kVariantLive2 ? 2 : variant == kVariantLive3 ? 3 : 1);
    out.print(F(" sent=")); out.print(pidWordsStarted);
    out.print(F(" verified=")); out.println(pidWordsVerified);
  }
  if (repeatDps) {
    out.print(F("EVENT dps_blocks_complete=")); out.print(dpsBlocks + (wordsVerified == 4 ? 1 : 0));
    out.print(F(" frame_period_us=")); out.println(framePeriodUs);
  }
  if (variant == kVariantOffline && wordsVerified == 4) {
    const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
    out.print(F("EVENT offline_quiet_us=")); out.print(now - lastRxAtUs);
    out.print(F(" last_tx_us=")); out.println(txDoneUs[3]);
  }
  out.print(F("END reason=")); out.print(static_cast<unsigned>(failure));
  out.print(F(" ro_bytes=")); out.print(rxTotal);
  out.print(F(" ro_lost=")); out.print(lostRx);
  out.print(F(" uart_errors=")); out.print(uartErr);
  out.print(F(" pad_verified=")); out.print(wordsVerified);
  out.print(F(" words_started=")); out.print(wordsStarted);
  out.println(F(" ecu_verified=0 dtc_verified=0 DE=LOW"));
  // CART_READ only. LISTEN/OBSERVE keep their own one-shot flags.
  // tx2BenchPassed stays valid for the rest of this boot.
  if (isRequestVariant(variant) && faultAllowsRearm(failure)) {
    if (variant == kVariantOffline) offlineConsumed = false;
    else transmitConsumed = false;
  }
  stage = IDLE;
}
void printStatus() {
  out.print(F("STATUS SME105_USB_BRIDGE_V1 stage=")); out.print(static_cast<unsigned>(stage));
  const bool transmitting = (stage == ECHO_TX || stage == GO_TX || slotInFlight);
  out.print(transmitting ? F(" DE=ACTIVE_GUARDED") : F(" DE=LOW"));
  out.print(F(" auto_tx=0 gate4=")); out.print(gateReady ? 1 : 0);
  out.print(F(" pad_rx=")); out.print(nativeReady ? 1 : 0);
  out.print(F(" tx2_bench_used=")); out.print(tx2BenchUsed ? 1 : 0);
  out.print(F(" tx2_bench_pass=")); out.print(tx2BenchPassed ? 1 : 0);
  out.print(F(" read_used=")); out.print(transmitConsumed ? 1 : 0);
  out.print(F(" observe_used=")); out.print(observeConsumed ? 1 : 0);
  out.print(F(" transport_lost=")); out.print(transportFaults);
  out.print(F(" out_overflow=")); out.print(out.overflow());
  out.print(F(" usb_skipped=")); out.print(out.usbSkipped());
  out.print(F(" offline_used=")); out.print(offlineConsumed ? 1 : 0);
  out.print(F(" armed="));
  if (isRequestVariant(armedVariant) &&
      !(armedVariant == kVariantOffline ? offlineConsumed : transmitConsumed) &&
      static_cast<int32_t>(armExpiresMs - millis()) > 0)
    out.print(variantName(armedVariant));
  else out.print(F("NONE"));
  out.print(F(" fault=")); out.print(static_cast<unsigned>(failure));
  out.print(F(" live_all=1 rx_batch=1"));
  out.print(F(" fw=")); out.println(kUsbInstalledBuildVersion);
}
void printPins() {
  out.println(F("PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1"));
}
void printOtaStatus() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* boot = esp_ota_get_boot_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (running) (void)esp_ota_get_state_partition(running, &state);
  const char* const health =
      state == ESP_OTA_IMG_PENDING_VERIFY ? "PENDING_VERIFY" :
      state == ESP_OTA_IMG_VALID ? "VALID" :
      state == ESP_OTA_IMG_NEW ? "NEW" :
      state == ESP_OTA_IMG_ABORTED ? "ABORTED" :
      state == ESP_OTA_IMG_INVALID ? "INVALID" : "UNDEFINED";
  out.print(F("OTA_STATUS state="));
  out.print(signedOta.phase == OtaPhase::Receiving ? F("RECEIVING") :
            signedOta.phase == OtaPhase::RebootPending ? F("REBOOT_PENDING") :
                                                      F("IDLE"));
  out.print(F(" received=")); out.print(signedOta.received);
  out.print(F(" size=")); out.print(signedOta.size);
  out.print(F(" running=")); out.print(running ? running->label : "NONE");
  out.print(F(" boot=")); out.print(boot ? boot->label : "NONE");
  out.print(F(" accepted_version=")); out.print(otaAcceptedVersion);
  out.print(F(" boot_health=")); out.print(health);
  out.print(F(" confirm_required=")); out.print(otaFirstBootPending ? 1 : 0);
  out.println(F(" rollback=1"));
}
void printOtaDebugUsbOnly() {
  // Deliberately bypass BridgeOutput: injecting OTA_DEBUG through the fanout
  // would corrupt the uploader's strict OTA_READY -> OTA_OK response stream.
  // No key, token, SSID, SHA, or firmware bytes are displayed here.
  if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
  if (Serial.availableForWrite() < 64) return;
  const uint32_t now = millis();
  const char* const state =
    signedOta.phase == OtaPhase::Receiving ? "RECEIVING" :
    signedOta.phase == OtaPhase::RebootPending ? "REBOOT_PENDING" : "IDLE";
  char line[272];
  const int n = snprintf(line, sizeof(line),
    "OTA_DEBUG state=%s received=%lu size=%lu last_received=%lu "
    "writes=%lu max_write_us=%lu last_write_us=%lu "
    "idle_ms=%lu elapsed_ms=%lu operation=%s last_failure=%s\n",
    state, static_cast<unsigned long>(signedOta.received),
    static_cast<unsigned long>(signedOta.size),
    static_cast<unsigned long>(otaDiagnostic.lastReceived),
    static_cast<unsigned long>(otaDiagnostic.writes),
    static_cast<unsigned long>(otaDiagnostic.longestWriteUs),
    static_cast<unsigned long>(otaDiagnostic.lastWriteUs),
    static_cast<unsigned long>(now - otaDiagnostic.lastProgressMs),
    static_cast<unsigned long>(signedOta.phase == OtaPhase::Receiving ?
      now - signedOta.beganMs : 0),
    otaDiagnostic.operation, otaDiagnostic.lastFailure);
  if (n > 0 && static_cast<size_t>(n) < sizeof(line))
    (void)Serial.write(reinterpret_cast<const uint8_t*>(line), static_cast<size_t>(n));
}
void printOtaDiag() {
  // Safe post-failure diagnostic over authenticated TCP even if USB was
  // never opened. A USB caller bypasses the shared stream during OTA, so
  // it cannot introduce an unexpected line into OTA_PROGRESS / OTA_OK.
  const bool rtcValid = otaRtcTraceValid();
  const char* state =
      signedOta.phase == OtaPhase::Receiving ? "RECEIVING" :
      signedOta.phase == OtaPhase::RebootPending ? "REBOOT_PENDING" : "IDLE";
  char line[256] = {};
  const int count = snprintf(line, sizeof(line),
      "OTA_DIAG state=%s received=%lu size=%lu last=%lu writes=%lu "
      "max_us=%lu op=%s fail=%s reset=%u rtc=%lu/%lu rtc_phase=%lu "
      "usb_skipped=%lu\n",
      state, static_cast<unsigned long>(signedOta.received),
      static_cast<unsigned long>(signedOta.size),
      static_cast<unsigned long>(otaDiagnostic.lastReceived),
      static_cast<unsigned long>(otaDiagnostic.writes),
      static_cast<unsigned long>(otaDiagnostic.longestWriteUs),
      otaDiagnostic.operation, otaDiagnostic.lastFailure,
      static_cast<unsigned>(esp_reset_reason()),
      static_cast<unsigned long>(rtcValid ? otaRtcTrace.acceptedBytes : 0),
      static_cast<unsigned long>(rtcValid ? otaRtcTrace.imageBytes : 0),
      static_cast<unsigned long>(rtcValid ? otaRtcTrace.phase : 0),
      static_cast<unsigned long>(out.usbSkipped()));
  if (count <= 0 || count >= static_cast<int>(sizeof(line))) return;
  if (commandFromUSB) {
    if (Serial.availableForWrite() >= count)
      (void)Serial.write(reinterpret_cast<const uint8_t*>(line), count);
  } else {
    out.write(reinterpret_cast<const uint8_t*>(line), count);
  }
}
void processTcpLine(char* line) {
  if (!tcpAuthenticated) {
    if (stage != IDLE || otaUpdating() ||
        strncmp(line, "AUTH ", 5) || !tokenMatches(line + 5)) {
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
#ifdef SME105_BLE
void processBleLine(char* line) {
  if (!tcpAuthenticated) {
    // The link itself is passkey-authenticated. Claim the single remote
    // controller role only while idle and when no TCP controller exists.
    if (stage != IDLE || otaUpdating() || wifiClient.connected()) {
      static const char deny[] = "DENIED remote_busy\n";
      ble_transport::write(reinterpret_cast<const uint8_t*>(deny), sizeof(deny) - 1);
      return;
    }
    tcpAuthenticated = true;
    remoteIsBle = true;
    out.markTcpAuthenticated();
    out.print(F("AUTH OK transport=BLE\n"));
    if (!strcmp(line, "AUTH BLE")) return;
  }
  commandFromUSB = false;
  runCommand(line);
  commandFromUSB = true;
}
void pollBle() {
  if (remoteIsBle && !ble_transport::authenticatedLink()) {
    dropTcpClient(true); // link loss mid-session stops the vehicle session
    return;
  }
  if (ble_transport::authenticatedLink()) {
    uint8_t chunk[96]; // bounded input per loop, like the TCP path
    const size_t n = ble_transport::read(chunk, sizeof chunk);
    for (size_t i = 0; i < n; ++i) {
      const char ch = static_cast<char>(chunk[i]);
      if (ch == '\n' || ch == '\r') {
        if (bleLineDiscard) { bleLineDiscard = false; bleLineUsed = 0; continue; }
        if (bleLineUsed) {
          bleLine[bleLineUsed] = 0;
          processBleLine(bleLine);
          bleLineUsed = 0;
        }
      } else if (ch < 32 || ch > 126 || bleLineUsed >= sizeof(bleLine) - 1) {
        bleLineDiscard = true;
      } else if (!bleLineDiscard) {
        bleLine[bleLineUsed++] = ch;
      }
    }
  }
  if (remoteIsBle) {
    if (busSessionActive()) tcpHadActiveSession = true;
    out.drainBLE();
  }
  // Notifications pause during the 2400-baud handshake phases.
  if (stage != QUIET && stage != ECHO_TX && stage != ACK_WAIT && stage != GO_TX)
    ble_transport::poll();
}
#endif
void pollWiFi() {
#ifdef SME105_BLE
  return;
#else
  if (!wifiConfigured || !prefsReady) {
    if (signedOta.phase == OtaPhase::Receiving) abortSignedOta("wifi_unavailable");
    return;
  }
  if (wifiApMode && wifiApStopEvents != wifiLastHandledApStopEvent) {
    wifiLastHandledApStopEvent = wifiApStopEvents;
    // A delayed AP_STOP from an earlier intentional STA/AP mode switch must
    // not tear down a newly live AP. Cross-check actual current radio mode/IP
    // before revoking a controller. Genuine loss is also checked below.
    if (!networkOnline()) wifiApReady = false;
  }
  if (!networkOnline()) {
    if (signedOta.phase == OtaPhase::Receiving) abortSignedOta("wifi_disconnected");
    if (!remoteIsBle && (wifiClient.fd() >= 0 || tcpAuthenticated))
      dropTcpClient(tcpAuthenticated);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    const uint32_t now = millis();
    if (!wifiWasOffline) { wifiWasOffline = true; wifiOfflineSinceMs = now; }
    if (wifiApMode) {
      // Never scan/reassociate with the distant router while in direct mode.
      // Restart a stopped AP only from the normal task loop, never inside
      // the event callback or while an ECU timing session is active.
      if (directApRetryDue(now, wifiLastApAttemptMs, busSessionActive()))
        startDirectAp();
      return;
    }
    // Arduino's auto-reconnect is reason-dependent. Explicit bounded retries
    // also cover NO_AP_FOUND and failed authentication/reassociation.
    // Never reconfigure STA or touch NVS during active vehicle timing.
    switch (chooseWiFiRecovery(now, wifiOfflineSinceMs, wifiLastRetryMs,
                               wifiLastStaReinitMs, busSessionActive())) {
      case kWiFiRecoveryReinitialize:
        wifiLastStaReinitMs = now;
        ++wifiStaReinitializations;
        WiFi.disconnect(false, false); // keep NVS settings and radio enabled
        startSta(); // reload saved credentials, no AP and no vehicle TX
        break;
      case kWiFiRecoveryReconnect:
        wifiLastRetryMs = now;
        ++wifiRetryAttempts;
        (void)WiFi.reconnect(); // fail closed if STA has gone away
        break;
      case kWiFiRecoveryNone: break;
    }
    return;
  }
  wifiWasOffline = false;
  // IP renewal while still associated can invalidate every existing socket.
  // Never preserve a previous controller's authentication across a lease.
  if (!wifiApMode && wifiGotIpEvents != wifiLastHandledIpEvent) {
    wifiLastHandledIpEvent = wifiGotIpEvents;
    if (wifiClient.fd() >= 0 || tcpAuthenticated) dropTcpClient(tcpAuthenticated);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
  }
  if (!wifiServerStarted) {
    // mDNS and socket initialization are task-level potentially costly;
    // never start them during the phase-critical live CART sequence.
    if (busSessionActive()) return;
    const uint32_t now = millis();
    if (listenerRetryDue(now, wifiLastServerAttemptMs)) {
      wifiLastServerAttemptMs = now;
      wifiServer.begin();
      wifiServerStarted = static_cast<bool>(wifiServer);
      if (!wifiServerStarted) {
        // Arduino-ESP32 WiFiServer::begin() returns void and leaves a socket
        // open on bind()/listen() failure. end() reclaims it before retry.
        wifiServer.end();
        ++wifiListenerFailures;
      } else {
        ++wifiListenerRestarts;
      }
    }
    if (!wifiServerStarted) return;
  }
  if (!mdnsStarted && !busSessionActive() &&
      (wifiLastMdnsAttemptMs == 0 ||
       static_cast<uint32_t>(millis() - wifiLastMdnsAttemptMs) >= kMdnsRetryMs)) {
    wifiLastMdnsAttemptMs = millis();
    if (MDNS.begin("sme105-bridge")) {
      mdnsStarted = true;
      MDNS.addService("sme105", "tcp", kWiFiPort);
    } else MDNS.end();
  }
  if (remoteIsBle) {
    // One remote controller at a time: BLE owns the session.
    WiFiClient incoming = wifiServer.accept();
    if (incoming) incoming.stop();
    return;
  }
  // An authenticated controller can disappear just as a new connection
  // arrives. Revoke its ongoing vehicle session BEFORE considering anyone
  // new. A new TCP peer must never inherit command authority mid-session.
  if (tcpAuthenticated && !wifiClient.connected()) dropTcpClient(true);
  WiFiClient incoming = wifiServer.accept();
  if (incoming) {
    if (wifiClient.connected() || busSessionActive() || stage == FINISHING ||
        otaUpdating())
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
    if (signedOta.phase == OtaPhase::Receiving) abortSignedOta("disconnect");
    if (tcpAuthenticated) dropTcpClient(true);
    return;
  }
  if (!tcpAuthenticated &&
      static_cast<uint32_t>(millis() - wifiAuthStartedMs) > kAuthDeadlineMs) {
    dropTcpClient(false);
    return;
  }
  if (signedOta.phase == OtaPhase::Receiving) {
    pollSignedOtaBody();
    // Never reinterpret firmware binary octets as ASCII commands, even if
    // the last firmware chunk and a rogue line share one TCP packet.
    if (tcpAuthenticated) out.drainTCP(wifiClient);
    if (out.tcpSendFailed()) dropTcpClient(true);
    return;
  }
  if (signedOta.phase == OtaPhase::RebootPending) {
    if (tcpAuthenticated) out.drainTCP(wifiClient);
    if (out.tcpSendFailed()) dropTcpClient(true);
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
        if (signedOta.phase == OtaPhase::Receiving) {
          pollSignedOtaBody();
          return;
        }
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
#endif
}
void runCommand(const char* cmd) {
  if (!strcmp(cmd, "OTA_DIAG")) {
    printOtaDiag();
    return;
  }
  if (!strcmp(cmd, "OTA_DEBUG")) {
    printOtaDebugUsbOnly();
    return;
  }
  if (!strcmp(cmd, "OTA_STATUS")) {
    printOtaStatus();
    return;
  }
  if (!strncmp(cmd, "OTA_CONFIRM", sizeof("OTA_CONFIRM") - 1)) {
    confirmOtaBootFromNetwork(cmd);
    return;
  }
  if (!strcmp(cmd, "REBOOT")) {
    // USB, or a remote that already passed processTcpLine/processBleLine.
    if ((commandFromUSB || tcpAuthenticated) &&
        stage == IDLE && !otaUpdating() && !slotInFlight) {
      deOff();
      out.println(F("EVENT reboot=accepted DE=LOW"));
      const uint32_t deadline = millis() + 300;
      do {
        out.drainUSB();
        if (tcpAuthenticated && !remoteIsBle) out.drainTCP(wifiClient);
#ifdef SME105_BLE
        if (remoteIsBle) out.drainBLE();
        ble_transport::poll();
#endif
        const bool usbIdle = out.usbCursor() == out.queued();
        const bool remoteIdle = !tcpAuthenticated || out.tcpCursor() == out.queued();
        if (usbIdle && remoteIdle) break;
        delay(1);
      } while (static_cast<int32_t>(deadline - millis()) > 0);
      ESP.restart();
    }
    out.println(F("DENIED reboot_busy"));
    return;
  }
  if (otaUpdating()) {
    if (signedOta.phase == OtaPhase::Receiving && !strcmp(cmd, "STOP")) {
      abortSignedOta("host_stop");
      out.println(F("EVENT ota_stopped=1 DE=LOW"));
    } else out.println(F("DENIED ota_busy"));
    return;
  }
  if (!strncmp(cmd, "OTA_BEGIN", sizeof("OTA_BEGIN") - 1)) {
    beginSignedOta(cmd);
    return;
  }
  if (otaFirstBootPending &&
      (!strcmp(cmd, "OBSERVE") || !strcmp(cmd, "READ_A4") ||
       !strcmp(cmd, "READ_0E") || !strcmp(cmd, "LISTEN_9600") ||
       !strcmp(cmd, "READ_KOEO") || !strcmp(cmd, "READ_KOER") ||
       !strcmp(cmd, "READ_CLR") || !strcmp(cmd, "READ_MEM") || !strcmp(cmd, "READ_LIVE3") || !strcmp(cmd, "READ_ALL") ||
       !strcmp(cmd, "READ_OFF") ||
       !strcmp(cmd, "READ_LIVE") || !strcmp(cmd, "ARM_LIVE") ||
       !strcmp(cmd, "READ_LIVE2") || !strcmp(cmd, "ARM_LIVE2") ||
       !strcmp(cmd, "TX2_BENCH") || !strcmp(cmd, "DE_BENCH") ||
       !strcmp(cmd, "ARM_A4") || !strcmp(cmd, "ARM_0E") ||
       !strcmp(cmd, "ARM_KOEO") || !strcmp(cmd, "ARM_KOER") ||
       !strcmp(cmd, "ARM_CLR") || !strcmp(cmd, "ARM_MEM") || !strcmp(cmd, "ARM_LIVE3") || !strcmp(cmd, "ARM_ALL") ||
       !strcmp(cmd, "ARM_OFF"))) {
    out.println(F("DENIED boot_health_pending"));
    return;
  }
  if (!strncmp(cmd, "WIFI_CONFIG ", sizeof("WIFI_CONFIG ") - 1)) {
    processWiFiProvision(cmd); return;
  }
  if (!strncmp(cmd, "WIFI_AP_CONFIG ", sizeof("WIFI_AP_CONFIG ") - 1)) {
    processDirectApProvision(cmd); return;
  }
  if (!strcmp(cmd, "WIFI_STA_MODE")) { selectStaMode(); return; }
  if (!strcmp(cmd, "WIFI_AP_MODE")) { selectApMode(); return; }
  if (!strcmp(cmd, "WIFI_STATUS")) { printWiFiStatus(); return; }
  if (!strcmp(cmd, "WIFI_DIAG")) { printWiFiDiag(); return; }
  if (!strcmp(cmd, "WIFI_AP_STATUS")) { printWiFiApStatus(); return; }
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
    if (busSessionActive() || stage == FINISHING || !prefsReady ||
        otaUpdating() || otaFirstBootPending) {
      out.println(F("DENIED wifi_busy")); return;
    }
    dropTcpClient(false);
    if (wifiServerStarted) { wifiServer.end(); wifiServerStarted = false; }
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    wifiConfigured = false;
    wifiPrefs.remove("ssid");
    wifiPrefs.remove("pass");
    wifiPrefs.remove("ap_ssid");
    wifiPrefs.remove("ap_pass");
    wifiPrefs.remove("ap_mode");
    if (wifiApMode) WiFi.softAPdisconnect(true);
    wifiApMode = false;
    wifiApReady = false;
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    if (!generateToken()) out.println(F("DENIED wifi_unready"));
    else out.println(F("WIFI_FORGET OK"));
    return;
  }
#ifdef SME105_BLE
  if (!strcmp(cmd, "BLE_STATUS")) {
    out.print(F("BLE_STATUS enabled=1 link=")); out.print(ble_transport::connected() ? 1 : 0);
    out.print(F(" authenticated=")); out.print(ble_transport::authenticatedLink() ? 1 : 0);
    out.print(F(" controller=")); out.print(remoteIsBle ? 1 : 0);
    out.print(F(" payload=")); out.println(ble_transport::payloadSize());
    return;
  }
  if (!strcmp(cmd, "BLE_PIN")) {
    if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
    // Deliberately bypass fanout: never send the PIN to a remote peer.
    Serial.print(F("BLE_PIN ")); Serial.println(blePin);
    return;
  }
  if (!strncmp(cmd, "BLE_PIN_SET ", sizeof("BLE_PIN_SET ") - 1)) {
    if (!commandFromUSB) { out.println(F("DENIED usb_only")); return; }
    const char* digits = cmd + sizeof("BLE_PIN_SET ") - 1;
    char* end = nullptr;
    const unsigned long pin = strtoul(digits, &end, 10);
    if (busSessionActive() || !prefsReady || strlen(digits) != 6 || *end ||
        pin < 100000 || pin > 999999) {
      out.println(F("DENIED ble_pin")); return;
    }
    wifiPrefs.putUInt("ble_pin", static_cast<uint32_t>(pin));
    if (remoteIsBle) dropTcpClient(false);
    ble_transport::forgetBonds();
    out.println(F("BLE_PIN_SET OK bonds_cleared=1 reboot_required=1"));
    return;
  }
#endif
  if (!strcmp(cmd, "STOP")) {
    armedVariant = 255; // STOP from either transport revokes every pending ARM
    if (stage != IDLE && stage != FINISHING) { stopEverything(HOST_STOP); out.println(F("EVENT stop=accepted DE=LOW")); }
    else { deOff(); out.println(F("EVENT stop=idle DE=LOW")); }
    return;
  }
  if (!strcmp(cmd, "HELLO")) { out.println(F("HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1")); return; }
  if (!strcmp(cmd, "HELP")) {
    out.println(F("COMMANDS HELLO HELP STATUS PINS TX2_BENCH LISTEN_9600 OBSERVE ARM_A4 READ_A4 ARM_0E READ_0E ARM_KOEO READ_KOEO ARM_KOER READ_KOER ARM_LIVE READ_LIVE ARM_LIVE2 READ_LIVE2 ARM_LIVE3 READ_LIVE3 ARM_ALL READ_ALL ARM_CLR READ_CLR ARM_MEM READ_MEM ARM_OFF READ_OFF DE_BENCH RMT_DUMP STOP RESET_IDLE REBOOT"));
    out.println(F("READ_* requires exact 4/4 TX2_BENCH pad pass this boot plus matching ARM_* within 15s; no automatic TX"));
    out.println(F("WIFI USB_ONLY: WIFI_CONFIG <SSID_B64> <PASS_B64> | WIFI_AP_CONFIG <SSID_B64> <PASS_B64> | WIFI_STA_MODE WIFI_AP_MODE | WIFI_TOKEN | WIFI_FORGET"));
    out.println(F("WIFI read-only: WIFI_STATUS WIFI_DIAG WIFI_AP_STATUS; AP-only 10.77.13.1/24 WPA2 and authenticated TCP/8765"));
    out.println(F("OTA authenticated TCP: OTA_STATUS OTA_DIAG OTA_BEGIN2 <size> <sha256_lowerhex> <version> <P256_signature_DER_base64>; then 8192-byte windows plus OTA_PROGRESS received=<n>; final OTA_OK; OTA_CONFIRM after reboot"));
    return;
  }
  if (!strcmp(cmd, "STATUS")) { printStatus(); return; }
  if (!strcmp(cmd, "PINS")) { printPins(); return; }
  if (!strcmp(cmd, "TX2_BENCH")) { tx2PadBench(); return; }
  if (!strcmp(cmd, "DE_BENCH")) { deGateBench(); return; }
  if (!strcmp(cmd, "RMT_DUMP")) { dumpGateRmt(); return; }
  if (!strcmp(cmd, "RESET_IDLE")) {
    if (stage != IDLE || slotInFlight || !stopLatched) out.println(F("DENIED busy"));
    else { failure = NO_FAULT; armedVariant = 255; out.println(F("EVENT idle_reset no_read_rearm=1")); }
    return;
  }
  const uint8_t armKind = !strcmp(cmd, "ARM_A4") ? 0 : !strcmp(cmd, "ARM_0E") ? 1 :
                          !strcmp(cmd, "ARM_KOEO") ? kVariantKoeo :
                          !strcmp(cmd, "ARM_KOER") ? kVariantKoer :
                          !strcmp(cmd, "ARM_CLR") ? kVariantClear :
                          !strcmp(cmd, "ARM_MEM") ? kVariantMem :
                          !strcmp(cmd, "ARM_LIVE3") ? kVariantLive3 :
                          !strcmp(cmd, "ARM_ALL") ? kVariantAllLive :
                          !strcmp(cmd, "ARM_OFF") ? kVariantOffline :
                          !strcmp(cmd, "ARM_LIVE") ? kVariantLive :
                          !strcmp(cmd, "ARM_LIVE2") ? kVariantLive2 : 255;
  if (armKind != 255) {
    // failure is not a gate: a clean END clears the one-shot latch and a
    // new ARM_* is still required (15s, same transport) before READ_*.
    if (stage != IDLE ||
        (armKind == kVariantOffline ? offlineConsumed : transmitConsumed)) {
      out.println(F("DENIED read_used_or_busy")); return;
    }
    armedVariant = armKind;
    armedFromUSB = commandFromUSB;
    armExpiresMs = millis() + kArmMs;
    out.print(F("EVENT read_armed variant=")); out.print(variantName(armedVariant));
    out.println(F(" valid_ms=15000 no_tx_yet=1"));
    return;
  }
  if (!strcmp(cmd, "READ_A4")) { beginSession(CART_READ, 0); return; }
  if (!strcmp(cmd, "READ_0E")) { beginSession(CART_READ, 1); return; }
  if (!strcmp(cmd, "READ_KOEO")) { beginSession(CART_READ, kVariantKoeo); return; }
  if (!strcmp(cmd, "READ_KOER")) { beginSession(CART_READ, kVariantKoer); return; }
  if (!strcmp(cmd, "READ_CLR")) { beginSession(CART_READ, kVariantClear); return; }
  if (!strcmp(cmd, "READ_MEM")) { beginSession(CART_READ, kVariantMem); return; }
  if (!strcmp(cmd, "READ_LIVE3")) { beginSession(CART_READ, kVariantLive3); return; }
  if (!strcmp(cmd, "READ_ALL")) { beginSession(CART_READ, kVariantAllLive); return; }
  if (!strcmp(cmd, "READ_OFF")) { beginSession(CART_READ, kVariantOffline); return; }
  if (!strcmp(cmd, "READ_LIVE")) { beginSession(CART_READ, kVariantLive); return; }
  if (!strcmp(cmd, "READ_LIVE2")) { beginSession(CART_READ, kVariantLive2); return; }
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
  initializeWiFi(); // selected STA/AP credentials + token from NVS; NEVER starts ECU TX
  initializeOtaBootHealth();
#ifdef SME105_BLE
  // Six-digit pairing PIN, random on first boot, readable only over USB.
  blePin = prefsReady ? wifiPrefs.getUInt("ble_pin", 0) : 0;
  if (blePin < 100000 || blePin > 999999) {
    blePin = 100000 + esp_random() % 900000;
    if (prefsReady) wifiPrefs.putUInt("ble_pin", blePin);
  }
  ble_transport::begin("SME105-DCL", blePin);
#endif
}
void loop() {
  serviceSignedOtaTimeout(); // works even when Wi-Fi socket polling exits early
  serviceOtaHealthAndRestart();
  pollUsb();
  pollWiFi();
#ifdef SME105_BLE
  pollBle();
#endif
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
  if (tcpAuthenticated && !remoteIsBle) {
    out.drainTCP(wifiClient);
    if (out.tcpSendFailed()) dropTcpClient(true);
  }
  delay(0);
}
