#include <cassert>
#include "../../firmware/sme105_usb_bridge/pad_evidence.h"
#include "../../firmware/sme105_usb_bridge/kline_rx.h"
int main() {
  PadEvidence p;
  // Repeated 0E -> KOER -> 0E -> A4 -> KOEO. Begin may never publish old bytes.
  const unsigned commands[] = {0x260e,0x253e,0x260e,0x260e,0x253e};
  for (int repeat=0; repeat<200; ++repeat) for (unsigned command:commands) {
    auto prior=p.epoch; p.begin(); assert(p.epoch==prior+1);
    assert(!p.first[2].sequence && !p.verified && !p.hasFailure);
    for (int i=0;i<4;++i) {
      p.start(0,i,command>>8,command&255,1000+i*2500);
      assert(!p.first[i].match && !p.first[i].completed);
      p.complete(command>>8,command&255,3083+i*2500,true);
      assert(p.first[i].epoch==p.epoch && p.first[i].match);
    }
    // Later blocks cannot mutate the first block's expected/observed/clock.
    auto first=p.first[2];
    p.start(1,2,0x25,0x3e,50000);p.complete(0x26,0x0e,52083,true);
    assert(p.hasFailure && !p.failed.match && p.failed.sequence==5);
    assert(p.first[2].sequence==first.sequence && p.first[2].start==first.start);
    assert(p.failed.expected0==0x25 && p.failed.observed0==0x26);
  }
  p.begin();p.start(0,0,1,0xb0,0xfffffff0);p.abort();
  assert(p.hasFailure && !p.failed.match && !p.failed.completed);
  p.begin();p.start(0,0,1,0xb0,10);p.complete(1,0xb0,2093,false);
  assert(!p.first[0].match); // Framing/DE invalid despite equal bytes.
  p.begin();p.start(0,0,1,0xb0,0xfffffff0);p.complete(1,0xb0,2067,true);
  assert(p.first[0].match && uint32_t(p.first[0].done-p.first[0].start)==2083);
  p.begin();p.complete(1,0xb0,2093,true);assert(!p.verified); // No start.
  KlineRx k;assert(!KLINE_HW_ENABLED && !KLINE_TX_ENABLED && !k.active);
  assert(!k.receiveSimulation(1,0x55));k.beginSimulation();auto session=k.session;
  assert(k.receiveSimulation(0xfffffff0,0x55));assert(k.receiveSimulation(5,0x08));
  KlineRx::Event e;assert(k.take(e)&&e.monotonic==0xfffffff0ULL);
  assert(k.take(e)&&e.monotonic==0x100000005ULL);
  assert(!k.receiveSimulation(4,0x33)&&k.errors==1);
  assert(!k.receiveSimulation(6,2,true)&&k.errors==2);
  k.stop();assert(!k.receiveSimulation(7,0));k.beginSimulation();assert(k.session==session+1);
  for(unsigned i=0;i<k.capacity;++i)assert(k.receiveSimulation(i,0));
  assert(!k.receiveSimulation(k.capacity,0)&&k.overflow==1&&!k.active);
  assert(p.epoch && p.first[0].sequence==0); // Independent DCL state.
}
