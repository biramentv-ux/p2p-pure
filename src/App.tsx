import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getUnlockMethod } from "./identity";
import type { UnlockedIdentity, UnlockMethod } from "./identity";
import { getContact, lockContacts, unlockContacts, type Contact } from "./contacts/contacts";
import { deriveHistoryKey } from "./history/messageStore";
import { activateStoredTurn, deactivateTurn } from "./p2p/turnStore";
import type { PeerLink } from "./p2p/peer";
import type { SecureSession } from "./p2p/secureSession";
import { useI18n } from "./i18n";
import { CreateIdentityScreen } from "./ui/screens/CreateIdentityScreen";
import { ChatScreen } from "./ui/screens/ChatScreen";
import { ConnectScreen, type ConnectedResult } from "./ui/screens/ConnectScreen";
import { GroupScreen } from "./ui/screens/GroupScreen";
import { GroupSession } from "./group/groupSession";
import { webrtcLinks } from "./group/groupLinker";
import { newProposalId } from "./p2p/suiteNegotiation";
import { ContactsScreen } from "./ui/screens/ContactsScreen";
import { ShowQrScreen } from "./ui/screens/ShowQrScreen";
import { IntroduceScreen, type IntroduceMode } from "./ui/screens/IntroduceScreen";
import { IntroHub } from "./intro/introHub";
import { canAddContact, saveContact } from "./contacts/contacts";
import { TransferReceiveScreen, TransferSendScreen } from "./ui/screens/TransferScreen";
import { UnlockScreen } from "./ui/screens/UnlockScreen";
import { LanguageSwitch } from "./ui/components/LanguageSwitch";
import { useAutoLock } from "./ui/useAutoLock";
import { LOCK_EVENT, loadLockSettings } from "./ui/lockSettings";
import { PanicWipe } from "./ui/components/SecuritySettings";
import { panicWipe } from "./security/panic";
import { purgeExpired } from "./history/messageStore";
import { SWEEP_MS } from "./history/disappearing";
import { parkedFiles } from "./p2p/fileTransfer";
import { listContacts } from "./contacts/contacts";
import { RV_EVENT, configuredRelays, rendezvousEnabled } from "./rendezvous/settings";
import type { Rendezvous } from "./rendezvous/rendezvous";
import { installNotifier, notifyIncoming, previewText } from "./notify/notifier";
import "./App.css";

type AppState =
  | { kind: "loading" }
  | { kind: "no-identity" }
  | { kind: "locked"; method: UnlockMethod }
  | { kind: "unlocked"; identity: UnlockedIdentity };

type Screen =
  | { k: "identity" }
  | { k: "contacts" }
  | { k: "connect"; expected?: Contact; forGroup?: boolean; forIntro?: boolean; rvOffer?: string }
  | { k: "group" }
  | { k: "intro"; mode: IntroduceMode }
  | { k: "transfer" }
  | { k: "chat"; contact: Contact; link: PeerLink; session: SecureSession };

type TabScreen = "identity" | "contacts" | "connect";
const TAB_ORDER: TabScreen[] = ["identity", "contacts", "connect"];

/**
 * Every screen shares one top bar: the tabs (when there are any) and the language switch.
 * The chat screen is full height and has its own header, so it gets the switch there instead.
 */
function Frame({ className = "app", nav, children }: { className?: string; nav?: ReactNode; children: ReactNode }) {
  const isChat = className.includes("app-chat");
  return (
    <main className={className}>
      {!isChat && (
        <div className="topbar">
          {nav}
          <LanguageSwitch />
        </div>
      )}
      {children}
    </main>
  );
}

function App() {
  const { t } = useI18n();
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [screen, setScreen] = useState<Screen>({ k: "identity" });
  // The group lives across screens. It is closed only when the device locks, and it is
  // saved encrypted, so it comes back after unlock.
  const groupRef = useRef<GroupSession | null>(null);
  /** The group restore that runs after unlock, until it settles (the panic wipe waits for it). */
  const restoreRef = useRef<Promise<GroupSession | null> | null>(null);
  const wipingRef = useRef(false);
  // Sounds and notifications for the group: it runs behind every screen, so it is watched here.
  const groupWatch = useRef<{ group: GroupSession; off: () => void } | null>(null);
  const [, setGroupRestored] = useState(0);
  // Introductions (src/intro): several live links at once, behind every screen like the group.
  // Nothing is saved: it is closed on lock, on "Край", and every pending entry expires.
  const introRef = useRef<IntroHub | null>(null);
  const introWatch = useRef<{ hub: IntroHub; off: () => void } | null>(null);
  const [introPending, setIntroPending] = useState(0);
  // Н2: rendezvous through public Nostr relays (opt-in), running while unlocked.
  const [rvOn, setRvOn] = useState(() => rendezvousEnabled());
  const [rv, setRv] = useState<Rendezvous | null>(null);
  /** A known contact's device is looking for this one. */
  const [rvIncoming, setRvIncoming] = useState<{ contact: Contact; offer: string } | null>(null);
  // New device without an identity: receiving one from another device (src/transfer).
  const [receiving, setReceiving] = useState(false);
  /** The introductions screen to return to after a connect for the hub. */
  const lastIntroMode = useRef<IntroduceMode>({ k: "hub" });

  useEffect(() => installNotifier(), []);

  /** Counts invitations and requests waiting for this user, and alerts on new ones. */
  function watchIntro(hub: IntroHub | null): void {
    if (introWatch.current?.hub === hub) return;
    introWatch.current?.off();
    introWatch.current = null;
    setIntroPending(0);
    if (!hub) return;
    const seen = new Set<string>();
    const off = hub.subscribe(() => {
      const snap = hub.snapshot;
      const waiting = [
        ...snap.invites.filter((i) => i.state === "pending").map((i) => ({ id: i.id, title: i.via.name })),
        ...snap.requestsIn.filter((r) => r.state === "pending").map((r) => ({ id: r.id, title: r.peer.name })),
      ];
      setIntroPending(waiting.length);
      for (const w of waiting) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const tr = tRef.current;
        notifyIncoming(
          { chatId: "intro", known: true, title: w.title, preview: tr("Покана за запознанство"), hidden: tr("Ново съобщение") },
          screenRef.current.k === "intro",
        );
      }
    });
    introWatch.current = { hub, off };
  }

  function closeIntro(): void {
    introRef.current?.close();
    introRef.current = null;
    watchIntro(null);
  }

  const tRef = useRef(t);
  tRef.current = t;
  /** Watches the current group for messages from other members (once per group object). */
  function watchGroup(group: GroupSession | null): void {
    if (groupWatch.current?.group === group) return;
    groupWatch.current?.off();
    groupWatch.current = null;
    if (!group) return;
    const off = group.onIncoming((m) => {
      const tr = tRef.current;
      const who = m.fromName || tr("Участник");
      notifyIncoming(
        {
          chatId: `group:${m.groupId ?? "current"}`,
          // only members reach the group mesh; a message without a sender name is still a member's
          known: true,
          title: m.groupName ? tr("{group} · {name}", { group: m.groupName, name: who }) : who,
          preview: m.file ? tr("Файл: {name}", { name: m.file.name }) : previewText(m.text),
          hidden: tr("Ново съобщение"),
        },
        screenRef.current.k === "group",
      );
    });
    groupWatch.current = { group, off };
  }

  useEffect(() => {
    getUnlockMethod()
      .then((method) => {
        setState(method ? { kind: "locked", method } : { kind: "no-identity" });
      })
      .catch(() => setState({ kind: "no-identity" }));
  }, []);

  // Idle lock: after a quiet period the identity leaves memory and the unlock screen returns.
  // The open chat's link is closed first, so nothing keeps running behind the lock.
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  const [lock, setLock] = useState(() => loadLockSettings());
  useEffect(() => {
    const reload = () => setLock(loadLockSettings());
    window.addEventListener(LOCK_EVENT, reload);
    return () => window.removeEventListener(LOCK_EVENT, reload);
  }, []);

  /** Closes every link and forgets every key in memory (lock and panic wipe). */
  function dropEverything() {
    const current = screenRef.current;
    if (current.k === "chat") current.link.close();
    closeIntro();
    const group = groupRef.current;
    groupRef.current = null;
    watchGroup(null);
    lockContacts();
    deactivateTurn();
    parkedFiles.clear();
    setScreen({ k: "identity" });
    return group;
  }

  useAutoLock(
    state.kind === "unlocked",
    () => {
      dropEverything()?.closeAll();
      // Closing group links parks accepted transfers (keys, plaintext): forget them after that.
      parkedFiles.clear();
      getUnlockMethod()
        .then((method) => setState(method ? { kind: "locked", method } : { kind: "no-identity" }))
        .catch(() => setState({ kind: "no-identity" }));
    },
    lock.minutes * 60 * 1000,
    lock.onHide,
  );

  /** Panic wipe (Н7): from the settings, or from the unlock screen without unlocking. */
  async function panic() {
    unlockGen.current++;
    wipingRef.current = true;
    try {
      const group = dropEverything();
      // A group still being restored after unlock would save its secrets back after the wipe:
      // wait for it, and stop and drain it together with the others.
      const restoring = await (restoreRef.current ?? Promise.resolve(null)).catch(() => null);
      await panicWipe([group, restoring]);
    } finally {
      wipingRef.current = false;
    }
    setLock(loadLockSettings());
    // The wipe removed the opt-in for the relays too: the next identity starts with it off.
    setRvOn(rendezvousEnabled());
    setState({ kind: "no-identity" });
  }

  useEffect(() => {
    const reload = () => setRvOn(rendezvousEnabled());
    window.addEventListener(RV_EVENT, reload);
    return () => window.removeEventListener(RV_EVENT, reload);
  }, []);

  // Н2: listen for known contacts on their rotating topics while unlocked and turned on. The
  // relay code loads only then (dynamic import), so nobody else pays for it.
  useEffect(() => {
    if (state.kind !== "unlocked" || !rvOn) return;
    let alive = true;
    let service: Rendezvous | null = null;
    let refresh: ReturnType<typeof setInterval> | undefined;
    const keyPair = state.identity.keyPair;
    const did = state.identity.did;
    void Promise.all([import("./rendezvous/rendezvous"), import("./rendezvous/relayPool")]).then(([{ Rendezvous }, { RelayPool }]) => {
      if (!alive) return;
      service = new Rendezvous({
        myDid: did,
        mySecretKey: keyPair.secretKey,
        pool: new RelayPool(configuredRelays()),
        contacts: () => listContacts().catch(() => []),
        onOffer: (contact, offer) => {
          void getContact(contact.did).then((full) => {
            if (!alive || !full) return;
            setRvIncoming({ contact: full, offer });
            notifyIncoming(
              { chatId: `rv:${full.did}`, known: full.verified, title: full.name, preview: tRef.current("Търси те през интернет"), hidden: tRef.current("Ново съобщение") },
              false,
            );
          });
        },
      });
      void service.refresh();
      // New or deleted contacts are picked up within a minute.
      refresh = setInterval(() => void service?.refresh(), 60_000);
      setRv(service);
    });
    return () => {
      alive = false;
      clearInterval(refresh);
      service?.stop();
      setRv(null);
      setRvIncoming(null);
    };
  }, [state, rvOn]);

  // Disappearing messages: expired rows (and their files) leave the device, also while locked.
  // Paused file transfers past their 30 minutes are forgotten here too.
  useEffect(() => {
    const sweep = () => {
      parkedFiles.expire();
      void purgeExpired().catch(() => undefined);
    };
    sweep();
    const timer = setInterval(sweep, SWEEP_MS);
    return () => clearInterval(timer);
  }, []);

  // The contact book is encrypted with a key derived from the history key, so it is opened
  // (and pre-v5 plaintext contacts migrated) before any screen can read it. If the migration
  // fails the keys are still set and the plaintext rows stay for the next unlock to retry.
  /**
   * Each panic wipe starts a new generation. An unlock that began before it (a passkey prompt
   * or a password derivation still running) finishes into a stale generation and is dropped:
   * the wiped identity must not come back into memory.
   */
  const unlockGen = useRef(0);
  const enterFrom = (gen: number) => (identity: UnlockedIdentity) => {
    if (gen !== unlockGen.current) return;
    Promise.all([
      activateStoredTurn(deriveHistoryKey(identity)).catch(() => undefined),
      unlockContacts(deriveHistoryKey(identity)).catch(() => undefined),
    ]).finally(() => {
      if (gen !== unlockGen.current) {
        lockContacts();
        deactivateTurn();
        return;
      }
      setState({ kind: "unlocked", identity });
    });
  };
  const enter = enterFrom(unlockGen.current);

  const historyKey = useMemo(
    () => (state.kind === "unlocked" ? deriveHistoryKey(state.identity) : null),
    [state],
  );

  // After unlock: bring back the saved group, unless one was already started meanwhile.
  useEffect(() => {
    if (state.kind !== "unlocked" || !historyKey) return;
    let alive = true;
    const keys = state.identity.keyPair;
    const restoring = GroupSession.restore(keys, historyKey, { linkFactory: webrtcLinks, findContact: getContact });
    restoreRef.current = restoring;
    restoring
      .then((restored) => {
        if (restoreRef.current === restoring) restoreRef.current = null;
        const current = groupRef.current;
        if (!restored) return;
        // A panic wipe is running: it stops and drains this session itself (panic()).
        if (wipingRef.current) return;
        if (!alive || (current && (current.snapshot.state !== null || current.snapshot.linked.length > 0))) {
          restored.closeAll();
          return;
        }
        current?.closeAll();
        groupRef.current = restored;
        watchGroup(restored);
        setGroupRestored((n) => n + 1);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [state, historyKey]);

  if (state.kind === "loading") {
    return (
      <Frame>
        <p>{t("Зареждане…")}</p>
      </Frame>
    );
  }

  if (state.kind === "no-identity") {
    if (receiving) {
      return (
        <Frame>
          <TransferReceiveScreen onDone={enter} onCancel={() => setReceiving(false)} />
        </Frame>
      );
    }
    return (
      <Frame>
        <CreateIdentityScreen
          onIdentityCreated={enter}
          onHaveOtherDevice={() => setReceiving(true)}
        />
      </Frame>
    );
  }

  if (state.kind === "locked") {
    return (
      <Frame>
        <div className="unlock-stack">
          <UnlockScreen
            method={state.method}
            onUnlocked={enter}
          />
          <div className="screen panic-locked">
            <PanicWipe onPanic={panic} />
          </div>
        </div>
      </Frame>
    );
  }

  const identity = state.identity;

  function goTab(tab: TabScreen) {
    setScreen(tab === "connect" ? { k: "connect" } : { k: tab });
  }

  function onConnected(result: ConnectedResult) {
    if (screen.k === "connect" && screen.forIntro) {
      // A link for introductions: the hub keeps it open next to the others.
      ensureIntro().attach(result.contact, result.link, result.session);
      setScreen({ k: "intro", mode: lastIntroMode.current });
      return;
    }
    if (screen.k === "connect" && screen.forGroup) {
      // A link for the group: it joins the mesh, not a one-to-one chat.
      ensureGroup().attach(result.contact, result.link, result.session);
      setScreen({ k: "group" });
      return;
    }
    setScreen({ k: "chat", contact: result.contact, link: result.link, session: result.session });
  }

  /** The introduction hub, created the first time the introductions screen opens. */
  function ensureIntro(): IntroHub {
    if (!introRef.current || introRef.current.isClosed) {
      introRef.current = new IntroHub({
        identity: identity.keyPair,
        factory: webrtcLinks,
        contacts: { get: getContact, save: (c) => saveContact(c), canAdd: canAddContact },
      });
      watchIntro(introRef.current);
    }
    return introRef.current;
  }

  function openIntro(mode: IntroduceMode): void {
    ensureIntro();
    lastIntroMode.current = mode;
    setScreen({ k: "intro", mode });
  }

  /** The group on this device, created empty the first time the group screen opens. */
  function ensureGroup(): GroupSession {
    if (!groupRef.current) {
      groupRef.current = new GroupSession(identity.keyPair, { historyKey, linkFactory: webrtcLinks, findContact: getContact });
      watchGroup(groupRef.current);
    }
    return groupRef.current;
  }

  function closeChat() {
    if (screen.k === "chat") screen.link.close();
    setScreen({ k: "contacts" });
  }

  if (screen.k === "chat" && historyKey) {
    return (
      <Frame className="app app-chat">
        <ChatScreen
          key={screen.contact.did}
          contact={screen.contact}
          link={screen.link}
          session={screen.session}
          historyKey={historyKey}
          onClose={closeChat}
        />
      </Frame>
    );
  }

  const activeTab: TabScreen = screen.k === "connect" ? "connect" : screen.k === "group" || screen.k === "intro" ? "contacts" : screen.k === "transfer" ? "identity" : (screen.k as TabScreen);

  return (
    <Frame
      nav={
        <nav className="tabs" aria-label={t("Навигация")}>
          <span
            className="tab-glider"
            aria-hidden="true"
            style={{ transform: `translateX(${TAB_ORDER.indexOf(activeTab) * 100}%)` }}
          />
          <button
            className={activeTab === "identity" ? "tab active" : "tab"}
            onClick={() => goTab("identity")}
            aria-current={activeTab === "identity"}
          >
            {t("Идентичност")}
          </button>
          <button
            className={activeTab === "contacts" ? "tab active" : "tab"}
            onClick={() => goTab("contacts")}
            aria-current={activeTab === "contacts"}
          >
            {t("Контакти")}
          </button>
          <button
            className={activeTab === "connect" ? "tab active" : "tab"}
            onClick={() => goTab("connect")}
            aria-current={activeTab === "connect"}
          >
            {t("Свържи се")}
          </button>
        </nav>
      }
    >
      {rvIncoming && screen.k !== "connect" && (
        <section className="screen rv-banner" role="alertdialog" aria-label={t("Търси те през интернет")}>
          <p>
            <strong>{rvIncoming.contact.name}</strong> {t("те търси през интернет.")}
          </p>
          <div className="call-actions">
            <button
              onClick={() => {
                const { contact, offer } = rvIncoming;
                setRvIncoming(null);
                setScreen({ k: "connect", expected: contact, rvOffer: offer });
              }}
            >
              {t("Свържи се")}
            </button>
            <button className="secondary" onClick={() => setRvIncoming(null)}>
              {t("Не сега")}
            </button>
          </div>
        </section>
      )}
      {screen.k === "identity" && (
        <ShowQrScreen identity={identity} onMove={() => setScreen({ k: "transfer" })} onPanic={panic} />
      )}
      {screen.k === "transfer" && (
        <TransferSendScreen
          identity={identity}
          onCancel={() => setScreen({ k: "identity" })}
          takeWriters={() => {
            // The group is stopped and its queued saves drained BEFORE the wipe (transfer/wipe.ts).
            const group = groupRef.current;
            groupRef.current = null;
            watchGroup(null);
            return [group];
          }}
          onMoved={() => {
            // The device was wiped: drop everything in memory and return to the first-run screen.
            lockContacts();
            parkedFiles.clear();
            setScreen({ k: "identity" });
            setState({ kind: "no-identity" });
          }}
        />
      )}
      {screen.k === "contacts" && (
        <ContactsScreen
          onChat={(contact) => setScreen({ k: "connect", expected: contact })}
          onNewContact={() => setScreen({ k: "connect" })}
          onGroups={() => {
            ensureGroup();
            setScreen({ k: "group" });
          }}
          onIntroduce={() => openIntro({ k: "pair" })}
          onAskIntro={(contact) => openIntro({ k: "ask", contact })}
          onIntroductions={() => openIntro({ k: "hub" })}
          introPending={introPending}
          myPublicKey={identity.keyPair.publicKey}
        />
      )}
      {screen.k === "connect" && (
        <ConnectScreen
          key={`${screen.expected?.did ?? "new"}${screen.rvOffer ? ":rv" : ""}`}
          identity={identity}
          expected={screen.expected}
          rendezvous={screen.forGroup || screen.forIntro ? null : rv}
          rvOffer={screen.rvOffer}
          onConnected={onConnected}
          onCancel={() =>
            setScreen(
              screen.forGroup ? { k: "group" } : screen.forIntro ? { k: "intro", mode: lastIntroMode.current } : { k: "contacts" },
            )
          }
        />
      )}
      {screen.k === "intro" && introRef.current && (
        <IntroduceScreen
          key={screen.mode.k === "ask" ? `ask:${screen.mode.contact.did}` : screen.mode.k}
          hub={introRef.current}
          mode={screen.mode}
          myPublicKey={identity.keyPair.publicKey}
          onLink={(contact) => setScreen({ k: "connect", expected: contact, forIntro: true })}
          onChat={(did) => {
            const fresh = introRef.current?.takeFresh(did);
            if (!fresh) return;
            // The introduction link is a real PeerLink in the app (webrtcLinks).
            setScreen({ k: "chat", contact: fresh.contact, link: fresh.link as PeerLink, session: fresh.session });
          }}
          onClose={() => {
            closeIntro();
            setScreen({ k: "contacts" });
          }}
          onBack={() => setScreen({ k: "contacts" })}
        />
      )}
      {screen.k === "group" && (
        <GroupScreen
          session={groupRef.current}
          onCreate={(name, creatorName) => {
            groupRef.current?.closeAll();
            groupRef.current = GroupSession.create(identity.keyPair, newProposalId(), name, creatorName, {
              historyKey,
              linkFactory: webrtcLinks,
              findContact: getContact,
            });
            watchGroup(groupRef.current);
            setScreen({ k: "group" });
          }}
          onLink={(contact) => setScreen({ k: "connect", expected: contact, forGroup: true })}
          onLeave={() => setScreen({ k: "contacts" })}
        />
      )}
    </Frame>
  );
}

export default App;
