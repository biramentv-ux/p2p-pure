/*
 * Strings for disappearing messages and resumed files in groups, and the internet-discovery
 * timeout. Same rules as protect.ts: keys are the Bulgarian source strings, placeholders must match.
 */
type Pack = Record<string, string>;

const KEYS = [
  "Изчезващи съобщения: {time}. Важи за новите съобщения на всички в групата.",
  "Изчезващите съобщения са изключени за групата.",
  "Изчезващо съобщение",
  "Файлът стигна до {done} от {all} участници. При {paused} ще продължи при следващото свързване.",
  "Не намерих {name} през интернет. Приложението при него трябва да е отворено, с включено „Откриване през интернет“.",
] as const;

function pack(values: readonly string[]): Pack {
  if (values.length !== KEYS.length) throw new Error("groupTimer.ts: wrong number of strings");
  return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]));
}

export const GROUP_TIMER_EN = pack([
  "Disappearing messages: {time}. Applies to new messages for everyone in the group.",
  "Disappearing messages are off for the group.",
  "Disappearing message",
  "The file reached {done} of {all} members. For {paused} it will continue on the next connection.",
  "Couldn't find {name} over the internet. Their app must be open, with “Find over the internet” turned on.",
]);

export const GROUP_TIMER_DE = pack([
  "Selbstlöschende Nachrichten: {time}. Gilt für neue Nachrichten aller in der Gruppe.",
  "Selbstlöschende Nachrichten sind für die Gruppe aus.",
  "Selbstlöschende Nachricht",
  "Die Datei hat {done} von {all} Mitgliedern erreicht. Bei {paused} geht sie bei der nächsten Verbindung weiter.",
  "{name} wurde über das Internet nicht gefunden. Die App dort muss geöffnet sein, mit „Über das Internet finden“ eingeschaltet.",
]);

export const GROUP_TIMER_ES = pack([
  "Mensajes temporales: {time}. Se aplica a los mensajes nuevos de todos en el grupo.",
  "Los mensajes temporales están desactivados para el grupo.",
  "Mensaje temporal",
  "El archivo llegó a {done} de {all} miembros. Para {paused} continuará en la próxima conexión.",
  "No encontré a {name} por internet. Su app debe estar abierta, con «Encontrar por internet» activado.",
]);

export const GROUP_TIMER_PT = pack([
  "Mensagens temporárias: {time}. Vale para as mensagens novas de todos no grupo.",
  "As mensagens temporárias estão desativadas para o grupo.",
  "Mensagem temporária",
  "O arquivo chegou a {done} de {all} membros. Para {paused}, continuará na próxima conexão.",
  "Não encontrei {name} pela internet. O app dessa pessoa precisa estar aberto, com “Encontrar pela internet” ativado.",
]);

export const GROUP_TIMER_RU = pack([
  "Исчезающие сообщения: {time}. Действует для новых сообщений всех в группе.",
  "Исчезающие сообщения в группе выключены.",
  "Исчезающее сообщение",
  "Файл дошёл до {done} из {all} участников. У {paused} он продолжится при следующем подключении.",
  "Не удалось найти {name} через интернет. Приложение у него должно быть открыто, с включённым «Поиск через интернет».",
]);
