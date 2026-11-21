/*
 * Strings for the failure diagnosis (Н8) and the native transport experiment (П4). Same rules as
 * protect.ts: keys are the Bulgarian source strings, placeholders must match.
 */
type Pack = Record<string, string>;

const KEYS = [
  "Твоята мрежа не пропуска UDP (STUN не отговори). Директна връзка от тази мрежа няма да мине. Опитай друга Wi-Fi мрежа, мобилни данни или собствен TURN релей.",
  "Мрежата на другия човек не пропуска UDP (STUN не отговори там). Нека той опита друга Wi-Fi мрежа, мобилни данни или собствен TURN релей.",
  "Едното устройство е само с IPv6, а другото само с IPv4. Те не могат да се свържат директно. Нека едното смени мрежата (например Wi-Fi вместо мобилни данни) или ползвайте TURN релей.",
  "И двете устройства са зад NAT и директната връзка не мина. Обикновено поне едното е зад симетричен NAT или NAT на оператора (CGNAT). Опитайте с една Wi-Fi мрежа или собствен TURN релей.",
  "Експериментален нативен транспорт",
  "Пробивай NAT със собствени UDP сокети, когато WebRTC не успее",
  "Поканата носи и публичния адрес на устройството. При симетричен NAT приложението отваря до 256 сокета за няколко секунди. Може да поиска от рутера временно пренасочване на порт (UPnP, NAT-PMP, PCP). Съобщенията остават шифровани както винаги; разговорите през този път не работят.",
  "Разговорите не работят през експерименталния нативен транспорт.",
] as const;

function pack(values: readonly string[]): Pack {
  if (values.length !== KEYS.length) throw new Error("nativeNet.ts: wrong number of strings");
  return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]));
}

export const NATIVE_NET_EN = pack([
  "Your network doesn't let UDP through (STUN didn't answer). A direct connection from this network won't work. Try another Wi-Fi network, mobile data or your own TURN relay.",
  "The other person's network doesn't let UDP through (STUN didn't answer there). Ask them to try another Wi-Fi network, mobile data or their own TURN relay.",
  "One device has only IPv6 and the other only IPv4. They can't connect directly. Ask one of you to switch networks (for example Wi-Fi instead of mobile data) or use a TURN relay.",
  "Both devices are behind NAT and the direct connection didn't get through. Usually at least one is behind a symmetric NAT or the carrier's NAT (CGNAT). Try one shared Wi-Fi network or your own TURN relay.",
  "Experimental native transport",
  "Punch through NAT with the app's own UDP sockets when WebRTC fails",
  "The invitation also carries the device's public address. Behind a symmetric NAT the app opens up to 256 sockets for a few seconds. It may ask the router for a temporary port forward (UPnP, NAT-PMP, PCP). Messages stay encrypted as always; calls don't work over this path.",
  "Calls don't work over the experimental native transport.",
]);

export const NATIVE_NET_DE = pack([
  "Dein Netz lässt kein UDP durch (STUN hat nicht geantwortet). Eine direkte Verbindung aus diesem Netz klappt nicht. Versuche ein anderes WLAN, mobile Daten oder ein eigenes TURN-Relay.",
  "Das Netz der anderen Person lässt kein UDP durch (STUN hat dort nicht geantwortet). Sie soll ein anderes WLAN, mobile Daten oder ein eigenes TURN-Relay versuchen.",
  "Ein Gerät hat nur IPv6, das andere nur IPv4. Sie können sich nicht direkt verbinden. Einer von euch soll das Netz wechseln (zum Beispiel WLAN statt mobiler Daten) oder ihr nutzt ein TURN-Relay.",
  "Beide Geräte sind hinter NAT und die direkte Verbindung kam nicht durch. Meist ist mindestens eines hinter einem symmetrischen NAT oder dem NAT des Anbieters (CGNAT). Versucht ein gemeinsames WLAN oder ein eigenes TURN-Relay.",
  "Experimenteller nativer Transport",
  "NAT mit eigenen UDP-Sockets durchbrechen, wenn WebRTC scheitert",
  "Die Einladung enthält auch die öffentliche Adresse des Geräts. Hinter einem symmetrischen NAT öffnet die App für einige Sekunden bis zu 256 Sockets. Sie kann den Router um eine vorübergehende Portweiterleitung bitten (UPnP, NAT-PMP, PCP). Nachrichten bleiben wie immer verschlüsselt; Anrufe funktionieren über diesen Weg nicht.",
  "Anrufe funktionieren über den experimentellen nativen Transport nicht.",
]);

export const NATIVE_NET_ES = pack([
  "Tu red no deja pasar UDP (STUN no respondió). Una conexión directa desde esta red no funcionará. Prueba otra red Wi-Fi, datos móviles o tu propio relé TURN.",
  "La red de la otra persona no deja pasar UDP (STUN no respondió allí). Pídele que pruebe otra red Wi-Fi, datos móviles o su propio relé TURN.",
  "Un dispositivo solo tiene IPv6 y el otro solo IPv4. No pueden conectarse directamente. Que uno cambie de red (por ejemplo Wi-Fi en vez de datos móviles) o usad un relé TURN.",
  "Los dos dispositivos están detrás de NAT y la conexión directa no pasó. Normalmente al menos uno está detrás de un NAT simétrico o del NAT del operador (CGNAT). Probad una misma red Wi-Fi o vuestro propio relé TURN.",
  "Transporte nativo experimental",
  "Atravesar el NAT con sockets UDP propios cuando WebRTC falle",
  "La invitación también lleva la dirección pública del dispositivo. Detrás de un NAT simétrico la app abre hasta 256 sockets durante unos segundos. Puede pedir al router una redirección de puerto temporal (UPnP, NAT-PMP, PCP). Los mensajes siguen cifrados como siempre; las llamadas no funcionan por esta vía.",
  "Las llamadas no funcionan por el transporte nativo experimental.",
]);

export const NATIVE_NET_PT = pack([
  "A tua rede não deixa passar UDP (o STUN não respondeu). Uma ligação direta a partir desta rede não vai funcionar. Experimenta outra rede Wi-Fi, dados móveis ou o teu próprio relé TURN.",
  "A rede da outra pessoa não deixa passar UDP (o STUN não respondeu lá). Pede-lhe que experimente outra rede Wi-Fi, dados móveis ou o seu próprio relé TURN.",
  "Um dispositivo só tem IPv6 e o outro só IPv4. Não se conseguem ligar diretamente. Um de vocês deve mudar de rede (por exemplo Wi-Fi em vez de dados móveis) ou usem um relé TURN.",
  "Os dois dispositivos estão atrás de NAT e a ligação direta não passou. Normalmente pelo menos um está atrás de um NAT simétrico ou do NAT do operador (CGNAT). Experimentem a mesma rede Wi-Fi ou o vosso próprio relé TURN.",
  "Transporte nativo experimental",
  "Atravessar o NAT com sockets UDP próprios quando o WebRTC falhar",
  "O convite também leva o endereço público do dispositivo. Atrás de um NAT simétrico a app abre até 256 sockets durante alguns segundos. Pode pedir ao router um reencaminhamento de porta temporário (UPnP, NAT-PMP, PCP). As mensagens continuam cifradas como sempre; as chamadas não funcionam por este caminho.",
  "As chamadas não funcionam pelo transporte nativo experimental.",
]);

export const NATIVE_NET_RU = pack([
  "Твоя сеть не пропускает UDP (STUN не ответил). Прямое соединение из этой сети не получится. Попробуй другую сеть Wi-Fi, мобильные данные или свой TURN-ретранслятор.",
  "Сеть собеседника не пропускает UDP (STUN там не ответил). Пусть он попробует другую сеть Wi-Fi, мобильные данные или свой TURN-ретранслятор.",
  "У одного устройства только IPv6, у другого только IPv4. Напрямую они не соединятся. Пусть один из вас сменит сеть (например, Wi-Fi вместо мобильных данных) или используйте TURN-ретранслятор.",
  "Оба устройства за NAT, и прямое соединение не прошло. Обычно хотя бы одно за симметричным NAT или NAT оператора (CGNAT). Попробуйте одну общую сеть Wi-Fi или свой TURN-ретранслятор.",
  "Экспериментальный нативный транспорт",
  "Пробивать NAT собственными UDP-сокетами, когда WebRTC не справился",
  "Приглашение несёт и публичный адрес устройства. За симметричным NAT приложение открывает до 256 сокетов на несколько секунд. Оно может попросить у роутера временный проброс порта (UPnP, NAT-PMP, PCP). Сообщения, как всегда, остаются зашифрованными; звонки этим путём не работают.",
  "Звонки не работают через экспериментальный нативный транспорт.",
]);
