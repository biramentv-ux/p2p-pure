import { useEffect, useRef, useState } from "react";
import { CallController, type CallSnapshot } from "../call/callController";
import { acquireCamera, acquireMedia, acquireScreen, hasSeveralCameras, networkTargets } from "../call/media";
import { encodeSignal, SignalAssembler } from "../call/signal";
import type { PeerLink } from "../p2p/peer";
import type { SecureSession } from "../p2p/secureSession";

/**
 * Calls in a 1:1 chat (Н6): the controller on this link, its state for the panel, and whether
 * the device has two cameras. The chat routes decrypted call frames to `handleFrame`.
 */
export function useChatCall(link: PeerLink, session: SecureSession, enqueue: <T>(task: () => Promise<T>) => Promise<T>) {
  const [call, setCall] = useState<CallSnapshot | null>(null);
  const [cameras, setCameras] = useState(false);
  const callRef = useRef<CallController | null>(null);
  const assemblerRef = useRef(new SignalAssembler());

  useEffect(() => {
    let alive = true;
    const controller = new CallController({
      pc: link.pc,
      acquire: acquireMedia,
      send: (signal) =>
        enqueue(async () => {
          for (const part of encodeSignal(signal)) link.send(await session.seal(part));
        }),
      onChange: (snap) => alive && setCall(snap),
      acquireVideo: acquireCamera,
      acquireScreen,
      // Perfect negotiation needs one polite side for an ICE restart outside a call.
      polite: !session.isInitiator,
      network: networkTargets(),
    });
    callRef.current = controller;
    setCall(controller.state);
    // Before camera permission some browsers list only one camera: read again on changes.
    const recount = () => void hasSeveralCameras().then((several) => alive && setCameras(several));
    recount();
    navigator.mediaDevices?.addEventListener?.("devicechange", recount);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", recount);
      callRef.current = null;
      void controller.hangup().finally(() => controller.dispose());
    };
    // Mount-only: the link and session are owned by the parent for this chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Camera permission is granted when a call starts: count the cameras again then.
  const callActive = call?.phase === "active";
  useEffect(() => {
    if (!callActive) return;
    let alive = true;
    void hasSeveralCameras().then((several) => alive && setCameras(several));
    return () => {
      alive = false;
    };
  }, [callActive]);

  return {
    call,
    controller: callRef,
    cameras,
    /** A decrypted call frame; not awaited, the controller may need the queue to reply. */
    handleFrame: (plaintext: string) => {
      const signal = assemblerRef.current.feed(plaintext);
      if (signal) void callRef.current?.handle(signal);
    },
  };
}
