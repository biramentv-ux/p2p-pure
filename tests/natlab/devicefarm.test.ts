// @vitest-environment node
/** Н8 device farm: the parts that run without phones (parsing and the command plan). */
import { describe, expect, it } from "vitest";
import path from "node:path";
// @ts-expect-error plain .mjs script without types
import { APP_ID, installCommands, launchCommands, loadFarm, parseAdbDevices, parseDevicectl, webviewSockets } from "../../scripts/devicefarm/farm.mjs";

describe("Н8 device farm", () => {
  it("reads adb devices -l", () => {
    const text = [
      "List of devices attached",
      "R58M12345AB            device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:3",
      "33081FDH2000AB         unauthorized usb:1-2 transport_id:4",
      "",
    ].join("\n");
    expect(parseAdbDevices(text)).toEqual([
      { serial: "R58M12345AB", state: "device", model: "SM_G973F" },
      { serial: "33081FDH2000AB", state: "unauthorized", model: "" },
    ]);
  });

  it("reads devicectl JSON", () => {
    const json = { result: { devices: [{ identifier: "x", hardwareProperties: { udid: "0000-1" }, deviceProperties: { name: "iPhone", osVersionNumber: "26.0" } }] } };
    expect(parseDevicectl(json)).toEqual([{ udid: "0000-1", name: "iPhone", os: "26.0" }]);
  });

  it("finds the WebView DevTools socket", () => {
    const unix = "00000000: 00000002 0 10000 0001 01 1234 @webview_devtools_remote_4211\n00000000: 0 @chrome_devtools_remote\n";
    expect(webviewSockets(unix)).toEqual(["webview_devtools_remote_4211", "chrome_devtools_remote"]);
  });

  it("plans install and launch for each platform", () => {
    const a = { name: "a", platform: "android", serial: "S1" };
    const i = { name: "i", platform: "ios", udid: "U1" };
    expect(installCommands(a, { apk: "app.apk" })).toEqual([["adb", "-s", "S1", "install", "-r", "-g", "app.apk"]]);
    expect(installCommands(i, { iosApp: "App.app" })).toEqual([["xcrun", "devicectl", "device", "install", "app", "--device", "U1", "App.app"]]);
    expect(installCommands(a, {})).toEqual([]);
    expect(launchCommands(a).at(-1)).toContain(APP_ID);
    expect(launchCommands(i)[0]).toContain(APP_ID);
  });

  it("checks the farm file, and the example is valid", () => {
    const farm = loadFarm(path.resolve("scripts/devicefarm/farm.example.json"));
    expect(farm.devices.length).toBeGreaterThanOrEqual(3);
    expect(() => loadFarm(path.resolve("scripts/devicefarm/missing.json"))).toThrow(/farm.example.json/);
  });
});
