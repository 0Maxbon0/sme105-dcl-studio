# LinkedIn showcase draft

The text below describes **engineering work and software/bench evidence**,
not a finished commercial scanner. Update the GitHub URL and test numbers
after the reviewed local changes are intentionally published.

## English — technical audience

I've been building **Escort SME-105 Diagnostic Lab**, an independent Android +
ESP32 research project for exploring the legacy Ford EEC-IV diagnostics
used in a 1998 Escort 1.6 Zetec-E.

The challenge isn't just reading bytes from an ECU. It's making the
complete chain reliable and explainable: a safe experimental electrical
interface, direct phone-to-ESP32 Wi-Fi, authenticated sessions, robust
reconnection, bounded raw-data replay, and reproducible diagnostics.

The project includes a Capacitor Android app, native Wi-Fi transport,
ESP32 firmware, an offline evidence archive, automated regression
tests and an experimental compact PCB design in KiCad.

My approach is **evidence first**: raw captures are preserved, and
candidate ECU commands, PID interpretations and sensor scaling remain
clearly marked as unverified until supported by direct measurements.

It's an ongoing engineering research project—not a certified Ford
diagnostic tool or production-ready automotive PCB.

Source and technical breakdown (after the GitHub repository rename): https://github.com/0Maxbon0/escort-sme105-diagnostic-lab

#ESP32 #AndroidDevelopment #EmbeddedSystems #AutomotiveEngineering
#ReverseEngineering #KiCad #DiagnosticResearch

## العربية — شرح مختصر

من المشاريع اللي بشتغل عليها **Escort SME-105 Diagnostic Lab**: تطبيق أندرويد
مع وحدة ESP32 لفهم وقراءة البيانات الخام الخاصة ببروتوكول التشخيص
القديم Ford EEC-IV على Escort 1998 بمحرك Zetec-E.

الفكرة مش مجرد استقبال بيانات؛ بنشتغل على سلسلة كاملة تشمل
دائرة الواجهة الإلكترونية، اتصال Wi-Fi مباشر بين الموبايل
والـESP32، إدارة انقطاع الاتصال واستعادة الجلسات، تسجيل البيانات
الأصلية وتحليلها، واختبارات برمجية قابلة للتكرار.

وفي نفس الوقت صممت تصور PCB مدمج باستخدام KiCad، ولسه في
مرحلة المراجعة الهندسية مش التصنيع أو الاعتماد للاستخدام على العربية.
كمان أي أوامر أو قراءات حساسات ما اتأكدناش منها عمليًا
بنوضح إنها فرضيات بحثية مش مواصفات معتمدة.

المشروع بحث هندسي مستمر، ومش جهاز تشخيص تجاري أو منتج معتمد من Ford.

GitHub (بعد تغيير اسم الريبو): https://github.com/0Maxbon0/escort-sme105-diagnostic-lab

## Optional publication visuals

1. A **labeled historical** screenshot from
   `artifacts/screenshots/live-360dp-light.png`.
2. An architecture diagram based on
   [ARCHITECTURE.md](ARCHITECTURE.md).
3. A **concept-only** PCB preview from the R1 KiCad folder with
   "review design — not assembled or vehicle-qualified" in the caption.

Before using the draft, apply the
[publication checklist](PUBLICATION_CHECKLIST.md).
The repository does **not** currently grant an open-source license.
