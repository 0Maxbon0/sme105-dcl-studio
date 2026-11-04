#include <Arduino.h>
#include <esp_timer.h>
#include <cstring>

// Desk-only test that intentionally drives the disconnected MAX487 A/B pair.
// NEVER use with car wiring attached. No bus TX on startup, only USB SELFTEST.
namespace {
HardwareSerial Bus(2);
constexpr int kRx=16, kTx=17, kDe=18;
constexpr uint8_t kHello[11] = {0,0,0,0,0,1,0x82,0,0,0,0x83};
constexpr uint32_t kMaxDriveUs=100000;
esp_timer_handle_t cutoff=nullptr;
volatile bool forced=false;
bool tested=false;
char input[24]={};
size_t inputCount=0;

void forceRelease(void*) {
  digitalWrite(kDe, LOW);
  forced=true;
}
void releaseBus() { digitalWrite(kDe, LOW); pinMode(kDe, OUTPUT); }

bool oneTrial(const uint8_t* bytes,size_t length,uint32_t baud,
              uint32_t format,const char* label) {
  releaseBus();
  Bus.end();
  Bus.setRxBufferSize(512);
  Bus.begin(baud,format,kRx,kTx);
  while (Bus.available()>0) (void)Bus.read();
  uint8_t rx[80]={};
  size_t count=0;
  if (!cutoff || esp_timer_start_once(cutoff,kMaxDriveUs)!=ESP_OK) {
    Serial.println(F("FAIL timer unavailable; no drive"));
    return false;
  }
  forced=false;
  digitalWrite(kDe,HIGH);
  delayMicroseconds(20);
  const size_t sent=Bus.write(bytes,length);
  Bus.flush();
  releaseBus();
  (void)esp_timer_stop(cutoff);
  const uint32_t start=millis();
  while (millis()-start<500 && count<length) {
    const int got=Bus.read();
    if (got>=0) rx[count++]=static_cast<uint8_t>(got);
    else delay(1);
  }
  const bool pass=sent==length && count==length && !forced &&
                  !memcmp(bytes,rx,length);
  Serial.print(pass ? F("PASS ") : F("FAIL "));
  Serial.print(label);
  Serial.print(F(" sent=")); Serial.print(sent);
  Serial.print(F(" recv=")); Serial.print(count);
  Serial.print(F(" watchdog=")); Serial.println(forced ? F("TRIPPED") : F("OK"));
  releaseBus();
  Bus.end();
  return pass;
}

void selftest() {
  tested=true;
  uint8_t cart[64]={};
  for(uint8_t id=0;id<16;++id)
    cart[id*4+3] = static_cast<uint8_t>(((id ^ 0x0A)<<4)|id);
  const bool a=oneTrial(kHello,sizeof(kHello),2400,SERIAL_8N2,"MAX487_2400_8N2");
  const bool b=oneTrial(cart,sizeof(cart),9600,SERIAL_8N1,"MAX487_9600_8N1");
  Serial.print(F("SELFTEST ")); Serial.println(a&&b ? F("PASS") : F("FAIL"));
  releaseBus();
}

void dispatch() {
  if (!strcmp(input,"STATUS")) {
    Serial.print(F("STATUS MAX487_BENCH_ONLY DE=LOW TX="));
    Serial.println(tested ? F("LOCKED") : F("WAITING_FOR_SELFTEST"));
  } else if (!strcmp(input,"SELFTEST")) {
    if(tested) Serial.println(F("LOCKED one physical bench test per boot"));
    else selftest();
  } else {
    Serial.println(F("ERR only STATUS SELFTEST"));
  }
}
}
void setup() {
  releaseBus();
  Serial.begin(115200);
  esp_timer_create_args_t args={};
  args.callback=&forceRelease;
  args.name="de_bench_cutoff";
  if(esp_timer_create(&args,&cutoff)!=ESP_OK) cutoff=nullptr;
  delay(200);
  Serial.println(F("MAX487 PHYSICAL BENCH ONLY. A/B MUST BE DISCONNECTED FROM CAR."));
}
void loop() {
  while(Serial.available()) {
    char c=static_cast<char>(Serial.read());
    if(c=='\r'||c=='\n') {
      if(inputCount) {
        input[inputCount]='\0';
        dispatch();
        inputCount=0;
      }
    } else if(inputCount<sizeof(input)-1) {
      input[inputCount++]=c;
    } else {
      inputCount=0;
      Serial.println(F("ERR input overflow"));
    }
  }
}
