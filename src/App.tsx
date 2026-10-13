import { useEffect, useMemo, useState } from "react";
import { getUnlockMethod } from "./identity";
import type { UnlockedIdentity, UnlockMethod } from "./identity";
import type { Contact } from "./contacts/contacts";
import { deriveHistoryKey } from "./history/messageStore";
import type { PeerLink } from "./p2p/peer";
import type { SecureSession } from "./p2p/secureSession";
import { CreateIdentityScreen } from "./ui/screens/CreateIdentityScreen";
import { ChatScreen } from "./ui/screens/ChatScreen";
import { ConnectScreen, type ConnectedResult } from "./ui/screens/ConnectScreen";
import { ContactsScreen } from "./ui/screens/ContactsScreen";
import { ShowQrScreen } from "./ui/screens/ShowQrScreen";
import { UnlockScreen } from "./ui/screens/UnlockScreen";
import "./App.css";

type AppState =
  | { kind: "loading" }
  | { kind: "no-identity" }
  | { kind: "locked"; method: UnlockMethod }
  | { kind: "unlocked"; identity: UnlockedIdentity };

type Screen =
  | { k: "identity" }
  | { k: "contacts" }
  | { k: "connect"; expected?: Contact }
  | { k: "chat"; contact: Contact; link: PeerLink; session: SecureSession };

type TabScreen = "identity" | "contacts" | "connect";

function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [screen, setScreen] = useState<Screen>({ k: "identity" });

  useEffect(() => {
    getUnlockMethod()
      .then((method) => {
        setState(method ? { kind: "locked", method } : { kind: "no-identity" });
      })
      .catch(() => setState({ kind: "no-identity" }));
  }, []);

  const historyKey = useMemo(
    () => (state.kind === "unlocked" ? deriveHistoryKey(state.identity) : null),
    [state],
  );

  if (state.kind === "loading") {
    return (
      <main className="app">
        <p>Зареждане…</p>
      </main>
    );
  }

  if (state.kind === "no-identity") {
    return (
      <main className="app">
        <CreateIdentityScreen
          onIdentityCreated={(identity) => setState({ kind: "unlocked", identity })}
        />
      </main>
    );
  }

  if (state.kind === "locked") {
    return (
      <main className="app">
        <UnlockScreen
          method={state.method}
          onUnlocked={(identity) => setState({ kind: "unlocked", identity })}
        />
      </main>
    );
  }

  const identity = state.identity;

  function goTab(tab: TabScreen) {
    setScreen(tab === "connect" ? { k: "connect" } : { k: tab });
  }

  function onConnected(result: ConnectedResult) {
    setScreen({ k: "chat", contact: result.contact, link: result.link, session: result.session });
  }

  function closeChat() {
    if (screen.k === "chat") screen.link.close();
    setScreen({ k: "contacts" });
  }

  if (screen.k === "chat" && historyKey) {
    return (
      <main className="app app-chat">
        <ChatScreen
          key={screen.contact.did}
          contact={screen.contact}
          link={screen.link}
          session={screen.session}
          historyKey={historyKey}
          onClose={closeChat}
        />
      </main>
    );
  }

  const activeTab: TabScreen = screen.k === "connect" ? "connect" : (screen.k as TabScreen);

  return (
    <main className="app">
      <nav className="tabs" aria-label="Навигация">
        <button
          className={activeTab === "identity" ? "tab active" : "tab"}
          onClick={() => goTab("identity")}
          aria-current={activeTab === "identity"}
        >
          Идентичност
        </button>
        <button
          className={activeTab === "contacts" ? "tab active" : "tab"}
          onClick={() => goTab("contacts")}
          aria-current={activeTab === "contacts"}
        >
          Контакти
        </button>
        <button
          className={activeTab === "connect" ? "tab active" : "tab"}
          onClick={() => goTab("connect")}
          aria-current={activeTab === "connect"}
        >
          Свържи се
        </button>
      </nav>

      {screen.k === "identity" && <ShowQrScreen identity={identity} />}
      {screen.k === "contacts" && (
        <ContactsScreen
          onChat={(contact) => setScreen({ k: "connect", expected: contact })}
          onNewContact={() => setScreen({ k: "connect" })}
        />
      )}
      {screen.k === "connect" && (
        <ConnectScreen
          key={screen.expected?.did ?? "new"}
          identity={identity}
          expected={screen.expected}
          onConnected={onConnected}
          onCancel={() => setScreen({ k: "contacts" })}
        />
      )}
    </main>
  );
}

export default App;
