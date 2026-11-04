import { describe, expect, it } from "vitest";
import { IntroHub, type IntroContacts } from "../../src/intro/introHub";
import { ContactLimitError, type Contact } from "../../src/contacts/contacts";
import { decodeIntroControl, encodeControl } from "../../src/p2p/control";
import { createInvitation, encodeInvitation } from "../../src/p2p/invitation";
import { createEphemeralKeyPair, type SecureSession } from "../../src/p2p/secureSession";
import { INTRO_TTL_MS } from "../../src/intro/introMessages";
import { AutoFakeLink, connectedPair, fakeFactory, person, quiet, until, type Person } from "../group/fakeLinks";

/** An in-memory contact book with a size limit, like contacts.ts. */
class Book implements IntroContacts {
  readonly map = new Map<string, Contact>();
  /** How many times the whole book was read as a list: must stay 0 (the hub has no list call). */
  limit = 99;
  constructor(contacts: Contact[] = []) {
    for (const c of contacts) this.map.set(c.did, c);
  }
  async get(did: string) {
    return this.map.get(did) ?? null;
  }
  async save(c: Contact) {
    if (!this.map.has(c.did) && this.map.size >= this.limit) throw new ContactLimitError();
    this.map.set(c.did, c);
  }
  async canAdd() {
    return this.map.size < this.limit;
  }
}

interface Node {
  p: Person;
  hub: IntroHub;
  book: Book;
}

function node(p: Person, book: Book, clock?: () => number): Node {
  return {
    p,
    book,
    hub: new IntroHub({ identity: p.keys, factory: fakeFactory, contacts: book, timeoutMs: 3_000, sweepMs: 0, now: clock }),
  };
}

interface Wire {
  /** Plaintexts x sent to y, decrypted with a copy-free tap. */
  links: Array<{ from: string; to: string; link: AutoFakeLink }>;
}

/** Links x and y with an encrypted session, as after the normal connect flow, and attaches both hubs. */
function link(x: Node, y: Node, wire: Wire): { lx: AutoFakeLink; ly: AutoFakeLink; sx: SecureSession; sy: SecureSession } {
  const { la, lb, sa, sb } = connectedPair(x.p, y.p);
  x.hub.attach({ ...y.p.contact, name: nameIn(x, y) }, la, sa);
  y.hub.attach({ ...x.p.contact, name: nameIn(y, x) }, lb, sb);
  wire.links.push({ from: x.p.did, to: y.p.did, link: la }, { from: y.p.did, to: x.p.did, link: lb });
  return { lx: la, ly: lb, sx: sa, sy: sb };
}

function nameIn(owner: Node, other: Node): string {
  return owner.book.map.get(other.p.did)?.name ?? other.p.contact.name;
}

/** C knows A and B; A and B do not know each other. C also knows D (who must never be revealed). */
function trio(clock?: () => number) {
  const pa = person("Ана");
  const pb = person("Боян");
  const pc = person("Цвети");
  const pd = person("Тайна Диана");
  const a = node(pa, new Book([{ ...pc.contact, name: "Цвети" }]), clock);
  const b = node(pb, new Book([{ ...pc.contact, name: "Цвети" }]), clock);
  const c = node(
    pc,
    new Book([
      { ...pa.contact, name: "Ана" },
      { ...pb.contact, name: "Боян" },
      { ...pd.contact, name: "Тайна Диана" },
    ]),
    clock,
  );
  const wire: Wire = { links: [] };
  const ca = link(c, a, wire);
  const cb = link(c, b, wire);
  return { a, b, c, d: pd, wire, ca, cb };
}

function contactOf(n: Node, did: string): Contact {
  const c = n.book.map.get(did);
  if (!c) throw new Error("not in book");
  return c;
}

describe("introduction hub: flow (a), C introduces A and B", () => {
  it("both accept: a direct encrypted A-B link, saved unverified with introducedBy", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");

    const invA = a.hub.snapshot.invites[0];
    expect(invA.id).toBe(id);
    expect(invA.via).toEqual({ did: c.p.did, name: "Цвети" });
    expect(invA.peer).toEqual({ did: b.p.did, name: "Боян" });
    expect(b.hub.snapshot.invites[0].peer).toEqual({ did: a.p.did, name: "Ана" });

    // Nothing happens before both accept.
    await a.hub.accept(id);
    await quiet();
    expect(c.hub.snapshot.introductions[0].aState).toBe("accepted");
    expect(c.hub.snapshot.introductions[0].state).toBe("sent");
    expect(a.book.map.has(b.p.did)).toBe(false);

    await b.hub.accept(id);
    await until(() => a.hub.snapshot.fresh.length === 1 && b.hub.snapshot.fresh.length === 1, "linked");

    const savedB = a.book.map.get(b.p.did)!;
    expect(savedB.verified).toBe(false);
    expect(savedB.name).toBe("Боян");
    expect(savedB.introducedBy).toEqual({ did: c.p.did, name: "Цвети" });
    const savedA = b.book.map.get(a.p.did)!;
    expect(savedA.verified).toBe(false);
    expect(savedA.introducedBy).toEqual({ did: c.p.did, name: "Цвети" });
    expect(a.hub.snapshot.invites[0].state).toBe("done");

    const fa = a.hub.takeFresh(b.p.did)!;
    const fb = b.hub.takeFresh(a.p.did)!;
    // The side that made the WebRTC offer is the session initiator and speaks first.
    const [first, second] = a.p.did < b.p.did ? [fa, fb] : [fb, fa];
    const wire = await first.session.seal("здрасти");
    expect(await second.session.open(wire)).toBe("здрасти");
    const back = await second.session.seal("и на теб");
    expect(await first.session.open(back)).toBe("и на теб");
    expect(fa.contact.did).toBe(b.p.did);
    expect(a.hub.snapshot.fresh).toHaveLength(0);
  });

  it("the answering side can write first: the hub starts the ratchet on the new link", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    await a.hub.accept(id);
    await b.hub.accept(id);
    await until(() => a.hub.snapshot.fresh.length === 1 && b.hub.snapshot.fresh.length === 1, "linked");
    const fa = a.hub.takeFresh(b.p.did)!;
    const fb = b.hub.takeFresh(a.p.did)!;
    const [first, second] = a.p.did < b.p.did ? [fa, fb] : [fb, fa];
    // The chat on the answering side subscribes later; the ping waits on the link until then.
    const got: string[] = [];
    second.link.onMessage((text: string) => got.push(text));
    await until(() => got.length > 0, "ping");
    for (const w of got) await second.session.open(w);
    const wire = await second.session.seal("аз пиша пръв");
    expect(await first.session.open(wire)).toBe("аз пиша пръв");
  });

  it("one side declines: the other is told, nothing is saved, no link attempt", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    await a.hub.accept(id);
    await b.hub.decline(id);
    await until(() => a.hub.snapshot.invites[0].state === "cancelled", "A told");
    expect(c.hub.snapshot.introductions[0].state).toBe("declined");
    expect(c.hub.snapshot.introductions[0].bState).toBe("declined");
    expect(a.book.map.has(b.p.did)).toBe(false);
    expect(b.book.map.has(a.p.did)).toBe(false);
  });

  it("an accept after expiry does nothing, and sweep marks everything expired", async () => {
    let now = Date.now();
    const { a, b, c } = trio(() => now);
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    now += INTRO_TTL_MS + 1;
    await a.hub.accept(id);
    expect(a.hub.snapshot.invites[0].state).toBe("expired");
    b.hub.sweep();
    c.hub.sweep();
    expect(b.hub.snapshot.invites[0].state).toBe("expired");
    expect(c.hub.snapshot.introductions[0].state).toBe("expired");
  });

  it("an offer with an expiry far in the future is ignored", async () => {
    const { a, c, ca } = trio();
    const bogus = person("Х").did;
    ca.lx.send(await ca.sx.seal(encodeControl({ t: "intro-offer", id: "AAAAAAAAAAAAAAAAAAAAAA", did: bogus, name: "Х", exp: Date.now() + 365 * 86_400_000 })));
    await quiet();
    expect(a.hub.snapshot.invites).toHaveLength(0);
    void c;
  });

  it("C cancelling closes the invitation on both sides", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    await c.hub.cancelIntroduction(id);
    await until(() => a.hub.snapshot.invites[0].state === "cancelled" && b.hub.snapshot.invites[0].state === "cancelled", "cancelled");
  });

  it("a lost link to C cancels the pending invitation", async () => {
    const { a, b, c } = trio();
    await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1, "invite");
    a.hub.detach(c.p.did);
    expect(a.hub.snapshot.invites[0].state).toBe("cancelled");
  });

  it("C needs live links to both and two different people", async () => {
    const { a, b, c } = trio();
    await expect(c.hub.introduce(contactOf(c, a.p.did), contactOf(c, a.p.did))).rejects.toThrow("различни");
    c.hub.detach(b.p.did);
    await expect(c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did))).rejects.toThrow("свържи");
  });

  it("a full contact book cannot accept, and a book that fills meanwhile saves nothing", async () => {
    const { a, b, c } = trio();
    a.book.limit = 1; // A holds only C
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    await expect(a.hub.accept(id)).rejects.toThrow("пълен");
    expect(a.hub.snapshot.invites[0].state).toBe("pending");

    // B accepts, then its book fills before the link is made.
    a.book.limit = 99;
    await b.hub.accept(id);
    b.book.limit = 1;
    await a.hub.accept(id);
    await until(() => b.hub.snapshot.invites[0].state === "failed", "B failed");
    expect(b.hub.snapshot.invites[0].error).toContain("пълен");
    expect(b.book.map.has(a.p.did)).toBe(false);
  });

  it("an already known contact keeps its name and verified flag", async () => {
    const { a, b, c } = trio();
    a.book.map.set(b.p.did, { ...b.p.contact, name: "Бобо", verified: true, verifiedAt: 5 });
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    expect(a.hub.snapshot.invites[0].known).toBe(true);
    await a.hub.accept(id);
    await b.hub.accept(id);
    await until(() => a.hub.snapshot.fresh.length === 1, "linked");
    expect(a.book.map.get(b.p.did)).toMatchObject({ name: "Бобо", verified: true });
  });
});

describe("introduction hub: flow (b), A asks C", () => {
  it("A's request carries no names; C picks B from its own book; then both accept", async () => {
    const { a, b, c } = trio();
    const req = await a.hub.requestIntroduction(c.p.did);
    await until(() => c.hub.snapshot.requestsIn.length === 1, "request at C");
    const r = c.hub.snapshot.requestsIn[0];
    expect(r).toMatchObject({ id: req, state: "pending", peer: { did: a.p.did, name: "Ана" } });

    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did), req);
    expect(c.hub.snapshot.requestsIn[0].state).toBe("answered");
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    expect(a.hub.snapshot.invites[0].requested).toBe(true);
    expect(b.hub.snapshot.invites[0].requested).toBe(false);
    expect(a.hub.snapshot.requestsOut[0].state).toBe("answered");
    // A still has to accept, even though A asked.
    await b.hub.accept(id);
    await quiet();
    expect(a.book.map.has(b.p.did)).toBe(false);
    await a.hub.accept(id);
    await until(() => a.hub.snapshot.fresh.length === 1 && b.hub.snapshot.fresh.length === 1, "linked");
    expect(a.book.map.get(b.p.did)?.introducedBy?.did).toBe(c.p.did);
  });

  it("C can decline a request", async () => {
    const { a, c } = trio();
    const req = await a.hub.requestIntroduction(c.p.did);
    await until(() => c.hub.snapshot.requestsIn.length === 1, "request");
    await c.hub.declineRequest(req);
    await until(() => a.hub.snapshot.requestsOut[0].state === "declined", "declined");
  });

  it("only the asked contact may answer a request", async () => {
    const { a, b, c } = trio();
    const req = await a.hub.requestIntroduction(c.p.did);
    // B links to A directly and pretends to answer A's request to C.
    const wire: Wire = { links: [] };
    a.book.map.set(b.p.did, { ...b.p.contact });
    const ab = link(a, b, wire);
    await quiet(); // A's ping starts B's sending chain
    ab.ly.send(await ab.sy.seal(encodeControl({ t: "intro-offer", id: "BBBBBBBBBBBBBBBBBBBBBB", did: person("Х").did, name: "Х", exp: Date.now() + 60_000, req })));
    await quiet();
    expect(a.hub.snapshot.invites).toHaveLength(0);
    void c;
  });
});

describe("introduction hub: identity binding and privacy", () => {
  it("an invitation signed by someone other than the introduced did is refused; nothing is saved", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    const answerer = a.p.did < b.p.did ? b : a;
    const offerer = answerer === a ? b : a;
    await answerer.hub.accept(id);
    // C sends ready only to the answerer (an introducer that cheats), then a forged offer.
    await sendFromC(c, answerer, { t: "intro-ready", id, offer: false });
    await until(() => answerer.hub.snapshot.invites[0].state === "linking", "linking");
    const mallory = person("Злодей");
    const { sdp } = await fakeFactory.createOffer();
    const forged = await encodeInvitation(createInvitation("offer", sdp, mallory.keys, createEphemeralKeyPair().publicKey));
    await sendFromC(c, answerer, { t: "intro-relay", id, inv: forged });
    await until(() => answerer.hub.snapshot.invites[0].state === "failed", "refused");
    expect(answerer.hub.snapshot.invites[0].error).toContain("не е подписана");
    expect(answerer.book.map.has(mallory.did)).toBe(false);
    expect(answerer.book.map.has(offerer.p.did)).toBe(false);
  });

  it("C's contact list is never sent: only the two introduced people appear on the wire", async () => {
    const { a, b, c, d, wire } = trio();
    const req = await a.hub.requestIntroduction(c.p.did);
    await until(() => c.hub.snapshot.requestsIn.length === 1, "request");
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did), req);
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    await a.hub.accept(id);
    await b.hub.accept(id);
    await until(() => a.hub.snapshot.fresh.length === 1 && b.hub.snapshot.fresh.length === 1, "linked");

    // Everything on the wire is ciphertext.
    for (const l of wire.links) for (const text of l.link.sent) {
      expect(text).not.toContain("Тайна Диана");
      expect(text).not.toContain(d.did);
    }
    // And the plaintexts A received mention only B (and nothing about D).
    const seenByA = JSON.stringify(a.hub.snapshot);
    expect(seenByA).not.toContain(d.did);
    expect(seenByA).not.toContain("Тайна Диана");
    // A's request message itself carries only an id.
    const decoded = decodeIntroControl(encodeControl({ t: "intro-request", id: req }));
    expect(Object.keys(decoded!)).toEqual(["t", "id"]);
  });

  it("C forwards relays only for a ready introduction and only between its two people", async () => {
    const { a, b, c } = trio();
    const id = await c.hub.introduce(contactOf(c, a.p.did), contactOf(c, b.p.did));
    await until(() => a.hub.snapshot.invites.length === 1 && b.hub.snapshot.invites.length === 1, "invites");
    const before = c.hub.snapshot.introductions[0];
    // A relays before B accepted: C does not forward.
    await sendTo(a, c, { t: "intro-relay", id, inv: "p2p1:abc" });
    await quiet();
    expect(c.hub.snapshot.introductions[0]).toEqual(before);
    expect(b.hub.snapshot.invites[0].state).toBe("pending");
  });

  it("close() closes every link and forgets everything", async () => {
    const { a, c, ca } = trio();
    await c.hub.introduce(contactOf(c, a.p.did), person("x").contact).catch(() => undefined);
    c.hub.close();
    expect(ca.lx.isClosed).toBe(true);
    expect(c.hub.snapshot.linked).toHaveLength(0);
    expect(c.hub.snapshot.introductions).toHaveLength(0);
    await expect(c.hub.introduce(contactOf(c, a.p.did), contactOf(c, a.p.did))).rejects.toThrow();
  });
});

/** Sends one intro message from `from` to `to` over the hub's own encrypted link (test-only access). */
async function sendTo(from: Node, to: Node, m: Parameters<typeof encodeControl>[0]): Promise<void> {
  const hub = from.hub as unknown as { send(did: string, m: unknown): Promise<void> };
  await hub.send(to.p.did, m);
}

function sendFromC(c: Node, to: Node, m: Parameters<typeof encodeControl>[0]): Promise<void> {
  return sendTo(c, to, m);
}
