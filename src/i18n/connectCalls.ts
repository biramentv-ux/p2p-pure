/*
 * Strings for rendezvous (Н2), calls (Н6) and the protocol-version notice (Н10). Same layout
 * as protect.ts: keys are the Bulgarian source strings, placeholders must match.
 */
type Pack = Record<string, string>;

const KEYS = [
  "Закъснение {rtt} ms · загуби {loss}%",
  "Мрежата се смени. Премествам разговора…",
  "Споделяш екрана си.",
  "Спри споделянето",
  "Сподели екрана",
  "Смени камерата",
  "Добра връзка",
  "Средна връзка",
  "Слаба връзка",
  "Откриване през интернет",
  "Намирай познатите ми контакти без нов QR (през публични Nostr релета)",
  "Релетата пренасят само шифрован текст под тема, която се сменя на всеки 15 минути: не виждат кой с кого говори, нито поканата. Виждат обаче IP адреса на устройството и кога публикува. Работи само докато приложението е отворено и отключено и при двамата.",
  "Релета: {list}",
  "Търся {name} през интернет… Приложението трябва да е отворено и при него.",
  "Намери {name} през интернет",
  "Търси те през интернет",
  "те търси през интернет.",
  "Не сега",
  "Другият човек е със стара версия: прекъснатите файлове няма да продължат и изчезващите съобщения няма да работят при него."
] as const;

function pack(values: readonly string[]): Pack {
  if (values.length !== KEYS.length) throw new Error("connectCalls.ts: wrong number of strings");
  return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]));
}

export const CONNECT_EN = pack([
  "Delay {rtt} ms · loss {loss}%",
  "The network changed. Moving the call…",
  "You are sharing your screen.",
  "Stop sharing",
  "Share screen",
  "Switch camera",
  "Good connection",
  "Fair connection",
  "Weak connection",
  "Find over the internet",
  "Find my known contacts without a new QR (through public Nostr relays)",
  "The relays carry only encrypted text under a topic that changes every 15 minutes: they cannot see who talks to whom, nor the invitation. They do see this device's IP address and when it publishes. It works only while the app is open and unlocked on both sides.",
  "Relays: {list}",
  "Looking for {name} over the internet… The app must be open on their side too.",
  "Find {name} over the internet",
  "Is looking for you over the internet",
  "is looking for you over the internet.",
  "Not now",
  "The other person has an old version: interrupted files will not continue and disappearing messages will not work on their side."
]);

export const CONNECT_DE = pack([
  "Verzögerung {rtt} ms · Verlust {loss}%",
  "Das Netz hat gewechselt. Ich verlege das Gespräch…",
  "Du teilst deinen Bildschirm.",
  "Teilen beenden",
  "Bildschirm teilen",
  "Kamera wechseln",
  "Gute Verbindung",
  "Mittlere Verbindung",
  "Schwache Verbindung",
  "Über das Internet finden",
  "Meine bekannten Kontakte ohne neuen QR finden (über öffentliche Nostr-Relays)",
  "Die Relays transportieren nur verschlüsselten Text unter einem Thema, das alle 15 Minuten wechselt: Sie sehen nicht, wer mit wem spricht, und nicht die Einladung. Sie sehen aber die IP-Adresse des Geräts und wann es veröffentlicht. Es funktioniert nur, solange die App bei beiden geöffnet und entsperrt ist.",
  "Relays: {list}",
  "Suche {name} über das Internet… Die App muss auch dort geöffnet sein.",
  "{name} über das Internet finden",
  "Sucht dich über das Internet",
  "sucht dich über das Internet.",
  "Nicht jetzt",
  "Die andere Person hat eine alte Version: Unterbrochene Dateien werden nicht fortgesetzt, und verschwindende Nachrichten funktionieren bei ihr nicht."
]);

export const CONNECT_ES = pack([
  "Retardo {rtt} ms · pérdida {loss}%",
  "La red cambió. Trasladando la llamada…",
  "Estás compartiendo tu pantalla.",
  "Dejar de compartir",
  "Compartir pantalla",
  "Cambiar cámara",
  "Buena conexión",
  "Conexión regular",
  "Conexión débil",
  "Encontrar por internet",
  "Encontrar a mis contactos conocidos sin un QR nuevo (a través de relés públicos de Nostr)",
  "Los relés solo transportan texto cifrado bajo un tema que cambia cada 15 minutos: no ven quién habla con quién ni la invitación. Sí ven la dirección IP del dispositivo y cuándo publica. Solo funciona mientras la app está abierta y desbloqueada en los dos lados.",
  "Relés: {list}",
  "Buscando a {name} por internet… La app también debe estar abierta en su lado.",
  "Encontrar a {name} por internet",
  "Te busca por internet",
  "te busca por internet.",
  "Ahora no",
  "La otra persona tiene una versión antigua: los archivos interrumpidos no continuarán y los mensajes temporales no funcionarán en su lado."
]);

export const CONNECT_PT = pack([
  "Atraso {rtt} ms · perda {loss}%",
  "A rede mudou. Movendo a chamada…",
  "Você está compartilhando a tela.",
  "Parar de compartilhar",
  "Compartilhar tela",
  "Trocar câmera",
  "Conexão boa",
  "Conexão média",
  "Conexão fraca",
  "Encontrar pela internet",
  "Encontrar meus contatos conhecidos sem um QR novo (por relays públicos do Nostr)",
  "Os relays levam só texto criptografado sob um tópico que muda a cada 15 minutos: não veem quem fala com quem nem o convite. Mas veem o endereço IP do aparelho e quando ele publica. Só funciona enquanto o app está aberto e desbloqueado dos dois lados.",
  "Relays: {list}",
  "Procurando {name} pela internet… O app também precisa estar aberto do outro lado.",
  "Encontrar {name} pela internet",
  "Está procurando você pela internet",
  "está procurando você pela internet.",
  "Agora não",
  "A outra pessoa tem uma versão antiga: arquivos interrompidos não vão continuar e as mensagens temporárias não vão funcionar do lado dela."
]);

export const CONNECT_RU = pack([
  "Задержка {rtt} мс · потери {loss}%",
  "Сеть сменилась. Переношу звонок…",
  "Ты показываешь свой экран.",
  "Остановить показ",
  "Показать экран",
  "Сменить камеру",
  "Хорошая связь",
  "Средняя связь",
  "Слабая связь",
  "Поиск через интернет",
  "Находить знакомые контакты без нового QR (через публичные реле Nostr)",
  "Реле передают только зашифрованный текст под темой, которая меняется каждые 15 минут: они не видят, кто с кем говорит, и не видят приглашение. Но видят IP-адрес устройства и время публикации. Работает, только пока приложение открыто и разблокировано у обоих.",
  "Реле: {list}",
  "Ищу {name} через интернет… Приложение должно быть открыто и у него.",
  "Найти {name} через интернет",
  "Ищет тебя через интернет",
  "ищет тебя через интернет.",
  "Не сейчас",
  "У собеседника старая версия: прерванные файлы не продолжатся, а исчезающие сообщения у него не будут работать."
]);
