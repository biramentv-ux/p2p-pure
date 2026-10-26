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
import { UnlockScreen } from "./ui/screens/UnlockScreen";
import { LanguageSwitch } from "./ui/components/LanguageSwitch";
import { useAutoLock } from "./ui/useAutoLock";
import "./App.css";

type AppState =
  | { kind: "loading" }
  | { kind: "no-identity" }
  | { kind: "locked"; method: UnlockMethod }
  | { kind: "unlocked"; identity: UnlockedIdentity };

type Screen =
  | { k: "identity" }
  | { k: "contacts" }
  | { k: "connect"; expected?: Contact; forGroup?: boolean }
  | { k: "group" }
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
  const [, setGroupRestored] = useState(0);

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
  useAutoLock(state.kind === "unlocked", () => {
    const current = screenRef.current;
    if (current.k === "chat") current.link.close();
    groupRef.current?.closeAll();
    groupRef.current = null;
    lockContacts();
    deactivateTurn();
    setScreen({ k: "identity" });
    getUnlockMethod()
      .then((method) => setState(method ? { kind: "locked", method } : { kind: "no-identity" }))
      .catch(() => setState({ kind: "no-identity" }));
  });

  // The contact book is encrypted with a key derived from the history key, so it is opened
  // (and pre-v5 plaintext contacts migrated) before any screen can read it. If the migration
  // fails the keys are still set and the plaintext rows stay for the next unlock to retry.
  const enter = (identity: UnlockedIdentity) => {
    Promise.all([
      activateStoredTurn(deriveHistoryKey(identity)).catch(() => undefined),
      unlockContacts(deriveHistoryKey(identity)).catch(() => undefined),
    ])
      .finally(() => setState({ kind: "unlocked", identity }));
  };

  const historyKey = useMemo(
    () => (state.kind === "unlocked" ? deriveHistoryKey(state.identity) : null),
    [state],
  );

  // After unlock: bring back the saved group, unless one was already started meanwhile.
  useEffect(() => {
    if (state.kind !== "unlocked" || !historyKey) return;
    let alive = true;
    const keys = state.identity.keyPair;
    GroupSession.restore(keys, historyKey, { linkFactory: webrtcLinks, findContact: getContact })
      .then((restored) => {
        const current = groupRef.current;
        if (!restored) return;
        if (!alive || (current && (current.snapshot.state !== null || current.snapshot.linked.length > 0))) {
          restored.closeAll();
          return;
        }
        current?.closeAll();
        groupRef.current = restored;
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
    return (
      <Frame>
        <CreateIdentityScreen
          onIdentityCreated={enter}
        />
      </Frame>
    );
  }

  if (state.kind === "locked") {
    return (
      <Frame>
        <UnlockScreen
          method={state.method}
          onUnlocked={enter}
        />
      </Frame>
    );
  }

  const identity = state.identity;

  function goTab(tab: TabScreen) {
    setScreen(tab === "connect" ? { k: "connect" } : { k: tab });
  }

  function onConnected(result: ConnectedResult) {
    if (screen.k === "connect" && screen.forGroup) {
      // A link for the group: it joins the mesh, not a one-to-one chat.
      ensureGroup().attach(result.contact, result.link, result.session);
      setScreen({ k: "group" });
      return;
    }
    setScreen({ k: "chat", contact: result.contact, link: result.link, session: result.session });
  }

  /** The group on this device, created empty the first time the group screen opens. */
  function ensureGroup(): GroupSession {
    if (!groupRef.current) {
      groupRef.current = new GroupSession(identity.keyPair, { historyKey, linkFactory: webrtcLinks, findContact: getContact });
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

  const activeTab: TabScreen = screen.k === "connect" ? "connect" : screen.k === "group" ? "contacts" : (screen.k as TabScreen);

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
      {screen.k === "identity" && <ShowQrScreen identity={identity} />}
      {screen.k === "contacts" && (
        <ContactsScreen
          onChat={(contact) => setScreen({ k: "connect", expected: contact })}
          onNewContact={() => setScreen({ k: "connect" })}
          onGroups={() => {
            ensureGroup();
            setScreen({ k: "group" });
          }}
        />
      )}
      {screen.k === "connect" && (
        <ConnectScreen
          key={screen.expected?.did ?? "new"}
          identity={identity}
          expected={screen.expected}
          onConnected={onConnected}
          onCancel={() => setScreen(screen.forGroup ? { k: "group" } : { k: "contacts" })}
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
