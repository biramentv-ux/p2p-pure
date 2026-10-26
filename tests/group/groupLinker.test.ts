import { describe, expect, it } from "vitest";
import { GroupLinker, type AutoLink } from "../../src/group/groupLinker";
import { createInvitation, encodeInvitation, INVITATION_TTL_MS } from "../../src/p2p/invitation";
import { createEphemeralKeyPair, type SecureSession } from "../../src/p2p/secureSession";
import { fakeFactory, person, until, type Person } from "./fakeLinks";

interface Side {
  p: Person;
  linker: GroupLinker;
  done: Array<{ peer: string; link: AutoLink; session: SecureSession }>;
  /** Invitations this side relayed, by target. */
  out: Array<{ to: string; inv: string }>;
}

/** Two linkers whose relay hands the invitation straight to the other side, as an honest admin would. */
function pair(): { a: Side; b: Side } {
  const make = (p: Person): Side => {
    const side: Side = { p, linker: null as unknown as GroupLinker, done: [], out: [] };
    side.linker = new GroupLinker({
      identity: p.keys,
      factory: fakeFactory,
      timeoutMs: 3_000,
      relay: async (to, inv) => {
        side.out.push({ to, inv });
        const other = to === a.p.did ? a : b;
        void other.linker.receive(p.did, inv).catch(() => undefined);
      },
      linked: (peer, _pk, link, session) => side.done.push({ peer, link, session }),
    });
    return side;
  };
  const a = make(person("Алиса"));
  const b = make(person("Боб"));
  return { a, b };
}

describe("group linker: links through a relay", () => {
  it("an offer and its answer make a working encrypted link on both sides", async () => {
    const { a, b } = pair();
    await a.linker.offerTo(b.p.did);
    await until(() => a.done.length === 1 && b.done.length === 1, "both linked");
    expect(a.done[0].peer).toBe(b.p.did);
    expect(b.done[0].peer).toBe(a.p.did);
    const wire = await a.done[0].session.seal("здрасти направо");
    expect(await b.done[0].session.open(wire)).toBe("здрасти направо");
  });

  it("an invitation signed by someone else than the claimed sender is refused", async () => {
    const { a, b } = pair();
    const mallory = person("Злодей");
    // The admin (or anyone on the way) builds its own offer and says it is from Alice.
    const { sdp } = await fakeFactory.createOffer();
    const forged = await encodeInvitation(createInvitation("offer", sdp, mallory.keys, createEphemeralKeyPair().publicKey));
    await expect(b.linker.receive(a.p.did, forged)).rejects.toThrow("не е подписана от участника");
    expect(b.done).toHaveLength(0);
  });

  it("an invitation with a changed SDP fails its signature", async () => {
    const { a, b } = pair();
    await a.linker.offerTo(b.p.did).catch(() => undefined);
    const { inv } = a.out[0];
    // Re-encode the same invitation with a different SDP but the old signature.
    const { decodeInvitation } = await import("../../src/p2p/invitation");
    const decoded = await decodeInvitation(inv);
    const tampered = await encodeInvitation({ ...decoded, sdp: decoded.sdp + " evil" });
    await expect(b.linker.receive(a.p.did, tampered)).rejects.toThrow(/signature/i);
  });

  it("a replayed offer is refused", async () => {
    const { a, b } = pair();
    await a.linker.offerTo(b.p.did);
    await until(() => b.done.length === 1, "linked");
    await expect(b.linker.receive(a.p.did, a.out[0].inv)).rejects.toThrow("вече беше използвана");
  });

  it("an answer that is not for one of our offers, or from the wrong person, is refused", async () => {
    const { a, b } = pair();
    const carol = person("Кера");
    const { sdp } = await fakeFactory.createOffer();
    const offer = createInvitation("offer", sdp, carol.keys, createEphemeralKeyPair().publicKey);
    const answer = createInvitation("answer", sdp, b.p.keys, createEphemeralKeyPair().publicKey, { answersNonce: offer.nonce });
    await expect(a.linker.receive(b.p.did, await encodeInvitation(answer))).rejects.toThrow("не е за тази покана");

    // Alice offers to Bob, but Carol answers it.
    const silent = new GroupLinker({
      identity: a.p.keys,
      factory: fakeFactory,
      relay: async (_to, inv) => {
        a.out.push({ to: _to, inv });
      },
      linked: () => undefined,
    });
    await silent.offerTo(b.p.did);
    const { decodeInvitation } = await import("../../src/p2p/invitation");
    const sent = await decodeInvitation(a.out[a.out.length - 1].inv);
    const wrong = createInvitation("answer", "v=0 x", carol.keys, createEphemeralKeyPair().publicKey, { answersNonce: sent.nonce });
    await expect(silent.receive(carol.did, await encodeInvitation(wrong))).rejects.toThrow("не е за тази покана");
    silent.close();
  });

  it("an expired invitation is refused", async () => {
    const { a, b } = pair();
    const { sdp } = await fakeFactory.createOffer();
    const old = createInvitation("offer", sdp, a.p.keys, createEphemeralKeyPair().publicKey, {
      now: Date.now() - INVITATION_TTL_MS - 1_000,
    });
    await expect(b.linker.receive(a.p.did, await encodeInvitation(old))).rejects.toThrow(/expired/i);
  });

  it("a closed linker makes no links", async () => {
    const { a, b } = pair();
    b.linker.close();
    await a.linker.offerTo(b.p.did);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.done).toHaveLength(0);
    a.linker.close();
  });
});
