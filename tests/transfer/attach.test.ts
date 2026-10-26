import { describe, expect, it } from "vitest";
import { attachEndpoint } from "../../src/transfer/attach";
import { TransferEndpoint, type TransferState } from "../../src/transfer/endpoint";
import { makeKeys, setup, waitFor } from "./helpers";

/** The view logic of TransferScreen, reduced to what the ordering bug was about. */
function screen() {
  const views: string[] = [];
  return {
    views,
    get view() {
      return views[views.length - 1];
    },
    enter: () => views.push("protocol"),
    onState: (s: TransferState) => {
      if (s === "received") views.push("unlock");
      else if (s === "failed" || s === "aborted") views.push("intro");
    },
  };
}

describe("attachEndpoint (Codex P2: TransferScreen ~203)", () => {
  it("an endpoint that failed during start ends on the intro view, not a dead protocol view", async () => {
    const keys = makeKeys();
    const endpoint = new TransferEndpoint({
      keys: keys.sender,
      channel: {
        send: () => {
          throw new Error("Data channel is not open.");
        },
        onMessage: () => () => undefined,
        close: () => undefined,
      },
    });
    await endpoint.start(); // hello cannot be sent
    expect(endpoint.state).toBe("failed");
    const ui = screen();
    attachEndpoint(endpoint, ui.enter, ui.onState);
    expect(ui.view).toBe("intro");
  });

  it("an endpoint whose channel closed before the screen attached ends on intro", async () => {
    const s = setup();
    await s.sender.start();
    await s.receiver.start();
    await Promise.all([waitFor(s.sender, "compare"), waitFor(s.receiver, "compare")]);
    s.ch.a.kill();
    await waitFor(s.receiver, "failed");
    const ui = screen();
    attachEndpoint(s.receiver, ui.enter, ui.onState);
    expect(ui.view).toBe("intro");
  });

  it("an aborted endpoint is replayed too (receiver init)", async () => {
    const s = setup();
    await s.sender.start();
    await s.receiver.start();
    await Promise.all([waitFor(s.sender, "compare"), waitFor(s.receiver, "compare")]);
    await s.sender.confirmSas(false);
    await waitFor(s.receiver, "aborted");
    const ui = screen();
    attachEndpoint(s.receiver, ui.enter, ui.onState);
    expect(ui.view).toBe("intro");
  });

  it("a live endpoint shows the protocol view and follows later states", async () => {
    const s = setup();
    await s.sender.start();
    await s.receiver.start();
    await Promise.all([waitFor(s.sender, "compare"), waitFor(s.receiver, "compare")]);
    const ui = screen();
    attachEndpoint(s.receiver, ui.enter, ui.onState);
    expect(ui.view).toBe("protocol");
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    expect(ui.view).toBe("unlock");
  });
});
