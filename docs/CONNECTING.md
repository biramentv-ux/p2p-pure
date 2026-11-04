# Първа връзка: всички начини

[Български](#български) · [English](#english)

---

## Български

Преди първия чат двете устройства трябва да си разменят по една подписана покана. Приложението има седем начина за това. Изборът зависи от това дали сте заедно, имате ли Bluetooth и искате ли да ползвате сървър.

След първата връзка съобщенията вървят директно през WebRTC. Сървър за съобщения няма.

### Сравнение

| Начин | Заедно или отдалеч | Сървър за сигнализация? Какво вижда | Платформи | Време | Бележки за сигурността |
|---|---|---|---|---|---|
| **QR лице в лице** (локален режим) | Заедно | Не. Няма мрежови заявки. | Уеб, Windows, Linux, Android, iOS (трябва камера) | 1 до 2 минути (два QR кода) | Двата кода се виждат от всеки до вас. Подписът пази от подправяне, но не от препращане. Сравнете 12-те думи. |
| **Кратък код** (демо стая, PAKE) | Отдалеч | Да, Worker-ът. Вижда номера на стаята (5 знака), IP адресите, времето и шифрован текст. Не вижда поканата, SDP, ключовете и трите думи. | Навсякъде, където работи приложението | около 1 минута | Кодът (5 знака и 3 думи) се казва по телефона или лично. Ползва се CPace. Един опит на стая; грешна дума проваля сдвояването. Проверен срещу тестовите вектори на draft-irtf-cfrg-cpace-21. Ако думите изтекат, PAKE не пази: сравнете 12-те думи. |
| **Bluetooth** | Заедно (до около 10 м) | Не за поканата. После WebRTC връзката се прави по мрежата. | Само приложението за Android и iOS (собствен Capacitor плъгин) | около 30 секунди, най-много 60 | Който е наблизо, вижда поканата (с IP адреси) и може да я препрати. 4-знаковият код само избира телефон, не е защита. Сравнете 12-те думи. [docs/BLUETOOTH.md](BLUETOOTH.md) |
| **QR + звук** *(ново)* | Заедно (в една стая) | Не. | Устройства с микрофон и говорител | около 15 секунди за звука, плюс QR | Отговорът (около 200 байта, подписан) се чува от всеки в стаята. Подписът пази от подправяне, не от препращане. При проблем има QR вместо звук. Сравнете 12-те думи. [docs/SOUND-PAIRING.md](SOUND-PAIRING.md) |
| **QR + светлина** *(ново)* | Заедно (лице в лице) | Не. | Уеб и приложение, с камера на двете устройства | около 5 до 8 секунди за анимацията, плюс QR | Отговорът (около 210 байта, подписан) се вижда от всеки, който гледа екрана. Подписът пази от подправяне, не от препращане. При „намалено движение“ или проблем се показва QR на отговора. Анимацията е щадяща (най-много 3 смени в секунда). Сравнете 12-те думи. [docs/LIGHT-PAIRING.md](LIGHT-PAIRING.md) |
| **Запознаване чрез общ приятел** *(ново)* | Отдалеч, ако имате общ контакт | Не. Покани минават по вече шифрованите връзки. | Навсякъде, където работи приложението | около 1 минута, зависи от приятеля | Приятелят препраща подписаните покани. Тримата трябва да са свързани едновременно. И двамата трябва да приемат. Запознатият контакт започва като непроверен. Приятелят може да застане по средата, затова сравнете 12-те думи по друг канал. [docs/INTRODUCTIONS.md](INTRODUCTIONS.md) |
| **Telegram бот / копиране на поканата** | Отдалеч | Telegram вижда текста на поканата. Worker-ът пази до 10 минути само номер на чат и на съобщение, за да го изтрие. Или без бот: поканата се копира и праща ръчно. | Навсякъде | 2 до 3 минути | Ботът не е шифрован канал. Поканата съдържа IP адреси, но не и ключове за съобщения. Който подменя канала, може да препрати поканата. Сравнете 12-те думи. [docs/telegram-bot-guide.md](telegram-bot-guide.md) |

### Как работи всеки начин, накратко

**QR лице в лице.** Избери „Локален (QR)“. Единият показва поканата като QR код, другият го сканира и показва своя отговор като втори QR код, който първият сканира. Сървър не се ползва.

**Кратък код.** Избери „Демо (стая)“. Единият отваря стая и получава код като `K7M2Q · lemon-rocket-bridge`. Петте знака са номерът на стаята, а трите думи се правят на устройството и не стигат до сървъра. Казва кода на другия по телефона или лично. Другият го въвежда. Стигат първите 4 букви от всяка дума. Двете устройства пускат CPace с трите думи и потвърждават ключа. Чак тогава поканата тръгва, шифрована. Подробности: [DEMO-SIGNALING.md](DEMO-SIGNALING.md).

**Bluetooth.** Само в приложението за Android и iOS. Единият телефон показва 4-знаков код, другият го избира от списъка с намерени. Поканата минава на части по BLE. Подробности и тестов план: [BLUETOOTH.md](BLUETOOTH.md).

**QR + звук.** Единият показва QR с поканата. Другият отговаря с кратък подписан отговор (около 200 байта), който се пуска като чуваем звук с няколко тона (FSK) около 15 секунди. Първият слуша с микрофона. Ако звукът не стигне, отговорът се показва като QR. Подробности: [SOUND-PAIRING.md](SOUND-PAIRING.md).

**QR + светлина.** Единият показва QR с поканата. Другият го сканира и показва на екрана си кратка анимация от цветни квадратчета, която носи подписания му отговор (около 210 байта) за около 5 до 8 секунди. Първият я чете с камерата. Сървър не се ползва, а носителят е екранът и въздухът, както при QR. Нужна е камера и от двете страни, работи в браузъра и в приложението. Заради хора с фоточувствителност анимацията е бавна (най-много 3 смени в секунда), без червено и с почти постоянна яркост; преди началото има предупреждение, а при „намалено движение“ в системата се показва QR на отговора. Подробности: [LIGHT-PAIRING.md](LIGHT-PAIRING.md).

**Запознаване чрез общ приятел.** Ако и вие двамата сте контакти на трети човек, той може да ви запознае. Приложението му праща подписаните покани по вече шифрованите връзки. Тримата трябва да са свързани по едно и също време. Двамата приемат. Сървър не се ползва. Новият контакт започва като непроверен. Подробности: [INTRODUCTIONS.md](INTRODUCTIONS.md).

**Telegram бот / копиране.** В „Свържи се“ копираш поканата (започва с `p2p1:`). Пращаш я на другия през Telegram с `/send <код на получателя>` или през който и да е канал. Той я поставя в „Постави покана“. Ботът препраща и изтрива съобщението, след като получателят натисне „Копирах — изтрий“, или след 10 минути. Подробности: [telegram-bot-guide.md](telegram-bot-guide.md).

### След всеки начин: сравнете 12-те думи

Всеки начин носи поканата през канал, който някой може да наблюдава или да препрати: въздухът (звук, Bluetooth), екранът (QR, светлина), Telegram, общ приятел или сървър.

Поканите са подписани. Подписът не позволява на нападателя да промени поканата или да се представи за друг. Но не го спира да я **препрати**: ако той е между двама ви още при първия контакт, всеки от вас може да говори с него, мислейки, че говори с другия.

Затова и двамата виждат 12 думи, изчислени от двата публични ключа. Ако има човек по средата, думите няма да съвпаднат. Сравнете ги на глас, по видео или по друг канал, различен от този на поканата. Чак тогава натиснете „Думите съвпадат“. Без това контактът не е проверен.

Единствено при лице в лице (QR) и при PAKE няма канал, който нападателят да препраща лесно. При QR нападателят трябва да е физически там. При PAKE той трябва да познае трите думи от първия път. Дори тук сравнението е препоръчително: ако думите са изтекли, PAKE не пази.

### Ако не се свързва

Връзката е директна. Някои мрежи я блокират. Опитайте с една Wi‑Fi мрежа за първото сдвояване. Приложението няма TURN релей по подразбиране; по избор можеш да въведеш свой (виж [SECURITY.md](../SECURITY.md)).

---

## English

Before the first chat, the two devices must swap one signed invitation each. The app has seven ways to do it. Pick by whether you are in the same place, whether you have Bluetooth, and whether you accept a server in the path.

After the first connection, messages go straight over WebRTC. There is no message server.

### Comparison

| Method | In person or remote | Signalling server? What it sees | Platforms | Typical time | Security notes |
|---|---|---|---|---|---|
| **QR, face to face** (local mode) | In person | No. No network requests. | Web, Windows, Linux, Android, iOS (needs a camera) | 1 to 2 minutes (two QR codes) | Anyone next to you can see both codes. The signature stops forgery, not relaying. Compare the 12 words. |
| **Short code** (demo room, PAKE) | Remote | Yes, the Worker. It sees the room id (5 characters), IP addresses, timing and ciphertext. It does not see the invitation, SDP, keys or the three words. | Everywhere the app runs | about 1 minute | Say the code (5 characters and 3 words) by phone or in person. Uses CPace. One guess per room; a wrong word fails the pairing. Verified against the draft-irtf-cfrg-cpace-21 test vectors. If the words leak, PAKE no longer protects: compare the 12 words. |
| **Bluetooth** | In person (about 10 m) | None for the invitation. The WebRTC link is made over the network afterwards. | Android and iOS app only (own Capacitor plugin) | about 30 seconds, 60 at most | Anyone nearby can see the invitation (with IP addresses) and relay it. The 4-character code only picks a phone; it is not protection. Compare the 12 words. [docs/BLUETOOTH.md](BLUETOOTH.md) |
| **QR + sound** *(new)* | In person (same room) | None. | Devices with a microphone and a speaker | about 15 seconds of sound, plus the QR | The answer (about 200 bytes, signed) can be heard by everyone in the room. The signature stops forgery, not relaying. A QR fallback exists. Compare the 12 words. [docs/SOUND-PAIRING.md](SOUND-PAIRING.md) |
| **QR + light** *(new)* | In person (face to face) | None. | Web and app, with a camera on both devices | about 5 to 8 seconds of animation, plus the QR | The answer (about 210 bytes, signed) can be seen by anyone who can see the screen. The signature stops forgery, not relaying. With "reduce motion", or if it fails, the answer QR is shown instead. The animation is gentle (at most 3 changes per second). Compare the 12 words. [docs/LIGHT-PAIRING.md](LIGHT-PAIRING.md) |
| **Introduction by a mutual friend** *(new)* | Remote, if you share a contact | None. Invitations travel over existing encrypted links. | Everywhere the app runs | about 1 minute, depends on the friend | The friend relays the signed invitations. All three must be connected at the same time. Both sides must accept. The introduced contact starts as not verified. The friend could sit in the middle, so compare the 12 words over another channel. [docs/INTRODUCTIONS.md](INTRODUCTIONS.md) |
| **Telegram bot / copy the invitation** | Remote | Telegram sees the invitation text. The Worker keeps only a chat id and message id for up to 10 minutes, to delete the message. Or no bot: copy the invitation and send it yourself. | Everywhere | 2 to 3 minutes | The bot is not an encrypted channel. The invitation holds IP addresses, not message keys. Whoever controls the channel can relay the invitation. Compare the 12 words. [docs/telegram-bot-guide.md](telegram-bot-guide.md) (Bulgarian) |

### After any method: compare the 12 words

Every method carries the invitation through a channel someone could watch or relay: air (sound, Bluetooth), a screen (QR, light), Telegram, a mutual friend or a server.

Invitations are signed. A signature stops an attacker from changing an invitation or posing as someone else. It does not stop them from **relaying** it. If an attacker is between you at the first contact, each of you can end up talking to them, thinking you talk to each other.

So both sides see 12 words computed from the two public keys. If someone is in the middle, the words will not match. Compare them out loud, on video, or over a channel other than the one that carried the invitation. Only then tap "The words match". Until then the contact is not verified.

Only in-person QR and PAKE have no channel an attacker can easily relay. With QR the attacker must be physically there. With PAKE the attacker must guess the three words on the first try. Even then, compare: if the words leaked, PAKE does not protect.

### If it does not connect

The link is direct, and some networks block it. Try one Wi-Fi network for the first pairing. The app has no TURN relay by default; you can enter your own (see [SECURITY.md](../SECURITY.md)).
