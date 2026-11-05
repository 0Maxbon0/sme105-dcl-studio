export { Capacitor } from "@capacitor/core";
export { BleClient } from "@capacitor-community/bluetooth-le";
export { Directory, Filesystem } from "@capacitor/filesystem";
export { Share } from "@capacitor/share";

import { registerPlugin } from "@capacitor/core";
export const ExportStorage = registerPlugin("ExportStorage");
