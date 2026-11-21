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
  "Ти си в режим „Само през Tor“, а другият човек не е. Нека и той го включи (само в настолното приложение с Tor) или изключи режима.",
  "Другият човек е в режим „Само през Tor“. Включи го и ти (само в настолното приложение с Tor), за да се свържете.",
  "Свързвам се с мрежата Tor… Първия път отнема до минута.",
  "Връзката през Tor не се установи навреме. Двамата трябва да са в режим „Само през Tor“ и с отворено приложение; публикуването на onion адреса понякога отнема няколко минути.",
  "Само през Tor (експеримент)",
  "Свързвай се само през onion услуги, без да показваш IP адреса си",
  "Поканата съдържа onion адрес вместо IP адреси. Двамата трябва да са включили режима. Свързването е по-бавно (до няколко минути), разговорите не работят. Откриването през интернет (Nostr) показва IP адреса на релетата: в този режим не го ползвай.",
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
  "You're in “Tor only” mode and the other person isn't. Ask them to turn it on (desktop app with Tor only) or turn the mode off.",
  "The other person is in “Tor only” mode. Turn it on too (desktop app with Tor only) to connect.",
  "Connecting to the Tor network… The first time takes up to a minute.",
  "The connection over Tor didn't open in time. Both of you need “Tor only” mode and the app open; publishing the onion address sometimes takes a few minutes.",
  "Tor only (experiment)",
  "Connect only through onion services, without showing your IP address",
  "The invitation carries an onion address instead of IP addresses. Both of you must turn the mode on. Connecting is slower (up to a few minutes) and calls don't work. Finding over the internet (Nostr) shows your IP address to the relays: don't use it in this mode.",
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
  "Du bist im Modus „Nur über Tor“, die andere Person nicht. Sie soll ihn einschalten (nur Desktop-App mit Tor) oder du schaltest ihn aus.",
  "Die andere Person ist im Modus „Nur über Tor“. Schalte ihn auch ein (nur Desktop-App mit Tor), um euch zu verbinden.",
  "Verbinde mit dem Tor-Netz… Beim ersten Mal dauert es bis zu einer Minute.",
  "Die Verbindung über Tor kam nicht rechtzeitig zustande. Ihr braucht beide den Modus „Nur über Tor“ und die geöffnete App; das Veröffentlichen der Onion-Adresse dauert manchmal einige Minuten.",
  "Nur über Tor (Experiment)",
  "Nur über Onion-Dienste verbinden, ohne deine IP-Adresse zu zeigen",
  "Die Einladung enthält eine Onion-Adresse statt IP-Adressen. Ihr müsst den Modus beide einschalten. Das Verbinden ist langsamer (bis zu einigen Minuten), Anrufe funktionieren nicht. Das Finden über das Internet (Nostr) zeigt den Relays deine IP-Adresse: in diesem Modus nicht nutzen.",
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
  "Estás en modo «Solo por Tor» y la otra persona no. Pídele que lo active (solo app de escritorio con Tor) o desactiva el modo.",
  "La otra persona está en modo «Solo por Tor». Actívalo tú también (solo app de escritorio con Tor) para conectaros.",
  "Conectando con la red Tor… La primera vez tarda hasta un minuto.",
  "La conexión por Tor no se abrió a tiempo. Los dos necesitáis el modo «Solo por Tor» y la app abierta; publicar la dirección onion a veces tarda unos minutos.",
  "Solo por Tor (experimento)",
  "Conectar solo a través de servicios onion, sin mostrar tu dirección IP",
  "La invitación lleva una dirección onion en lugar de direcciones IP. Los dos tenéis que activar el modo. Conectar es más lento (hasta unos minutos) y las llamadas no funcionan. Buscar por internet (Nostr) muestra tu IP a los relés: no lo uses en este modo.",
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
  "Estás no modo «Só por Tor» e a outra pessoa não. Pede-lhe que o ative (só app de computador com Tor) ou desativa o modo.",
  "A outra pessoa está no modo «Só por Tor». Ativa-o também (só app de computador com Tor) para se ligarem.",
  "A ligar à rede Tor… Da primeira vez demora até um minuto.",
  "A ligação por Tor não abriu a tempo. Ambos precisam do modo «Só por Tor» e da app aberta; publicar o endereço onion às vezes demora alguns minutos.",
  "Só por Tor (experiência)",
  "Ligar apenas através de serviços onion, sem mostrar o teu endereço IP",
  "O convite leva um endereço onion em vez de endereços IP. Ambos têm de ativar o modo. Ligar é mais lento (até alguns minutos) e as chamadas não funcionam. Encontrar pela internet (Nostr) mostra o teu IP aos relés: não o uses neste modo.",
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
  "Ты в режиме «Только через Tor», а собеседник нет. Пусть он его включит (только настольное приложение с Tor), или выключи режим.",
  "Собеседник в режиме «Только через Tor». Включи его и ты (только настольное приложение с Tor), чтобы соединиться.",
  "Подключаюсь к сети Tor… В первый раз это занимает до минуты.",
  "Соединение через Tor не установилось вовремя. Вам обоим нужен режим «Только через Tor» и открытое приложение; публикация onion-адреса иногда занимает несколько минут.",
  "Только через Tor (эксперимент)",
  "Соединяться только через onion-сервисы, не показывая свой IP-адрес",
  "Приглашение несёт onion-адрес вместо IP-адресов. Режим должны включить оба. Соединение медленнее (до нескольких минут), звонки не работают. Поиск через интернет (Nostr) показывает твой IP ретрансляторам: в этом режиме не используй его.",
]);
