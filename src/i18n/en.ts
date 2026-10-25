/*
 * English package. Keys are the exact Bulgarian source strings used in the code.
 * Placeholders ({name}, {n}, ...) must appear in both the key and the value;
 * tests/i18n/i18n.test.ts enforces this.
 */
export const EN_DICTIONARY: Record<string, string> = {
  // App shell and tabs
  "Език": "Language",
  "Зареждане…": "Loading…",
  "Навигация": "Navigation",
  "Идентичност": "Identity",
  "Контакти": "Contacts",
  "Свържи се": "Connect",

  // Create identity
  "Този passkey не поддържа PRF. Задай парола за това устройство.":
    "This passkey does not support PRF. Set a password for this device.",
  "Неочаквана грешка при създаване на идентичност.": "Unexpected error while creating the identity.",
  "Паролата трябва да е поне {n} символа.": "The password must be at least {n} characters.",
  "Паролите не съвпадат.": "The passwords do not match.",
  "Запиши тези 12 думи": "Write down these 12 words",
  "Това е единственият начин да възстановиш идентичността си на ново устройство. Приложението не може да ти ги покаже отново.":
    "This is the only way to restore your identity on a new device. The app cannot show them to you again.",
  "Записах тези думи на сигурно място": "I wrote these words down somewhere safe",
  "Продължи": "Continue",
  "Парола за устройството": "Device password",
  "Паролата криптира идентичността на това устройство. Без нея не можеш да я отключиш тук. С 12-те думи обаче можеш да възстановиш идентичността на друго устройство.":
    "The password encrypts the identity on this device. Without it you cannot unlock it here. With the 12 words, however, you can restore the identity on another device.",
  "Парола": "Password",
  "Повтори паролата": "Repeat the password",
  "Създай идентичност": "Create identity",
  "Идентичността се генерира локално на това устройство. Нищо не се изпраща към сървър.":
    "The identity is generated locally on this device. Nothing is sent to a server.",
  "Локално": "Local",
  "Без сървър": "No server",
  "Без телефон": "No phone",
  "Този браузър няма WebAuthn. Ще използваме парола за защита на идентичността.":
    "This browser has no WebAuthn. We will use a password to protect the identity.",
  "Създаване…": "Creating…",

  // Unlock
  "Грешна парола.": "Wrong password.",
  "Не успяхме да отключим идентичността.": "We could not unlock the identity.",
  "Грешка при отключване.": "Unlock failed.",
  "Отключи": "Unlock",
  "Отключване…": "Unlocking…",
  "Добре дошъл отново": "Welcome back",
  "Отключи с passkey, за да продължиш.": "Unlock with your passkey to continue.",

  // Own QR code
  "Твоята идентичност": "Your identity",
  "Покажи този QR код на контакт, за да установите връзка.": "Show this QR code to a contact to connect.",
  "Идентификационен QR код": "Identity QR code",

  // Contacts
  "Контактите не можаха да се заредят.": "Contacts could not be loaded.",
  "Зареждане на контактите": "Loading contacts",
  "Да се изтрие ли „{name}“ от това устройство?": "Delete „{name}“ from this device?",
  "потвърден": "verified",
  "Чат": "Chat",
  "Изтрий": "Delete",
  "Още няма потвърдени контакти. Добави първия с QR код, лично.":
    "No verified contacts yet. Add your first one in person with a QR code.",
  "Добави контакт": "Add contact",

  // Connect
  "Свързване с {name}": "Connecting with {name}",
  "Нов контакт": "New contact",
  "Връзката е директна между двете устройства. Нищо не минава през сървър. Двамата трябва да са на едно място или да могат да си показват екраните.":
    "The connection is direct between the two devices. Nothing goes through a server. You need to be in the same place, or be able to show each other your screens.",
  "Покажи моята покана": "Show my invitation",
  "Сканирай чужда покана": "Scan someone else's invitation",
  "Назад": "Back",
  "Подготвям покана…": "Preparing invitation…",
  "Няма активна покана.": "There is no active invitation.",
  "Този отговор не е за тази покана.": "This answer is not for this invitation.",
  "Свързвам…": "Connecting…",
  "Другият човек не е същият контакт. Връзката е прекратена.":
    "The other person is not the same contact. The connection was closed.",
  "Подготвям отговор…": "Preparing answer…",
  "Неизвестна грешка при свързване.": "Unknown connection error.",
  "Криптография": "Cryptography",
  "Криптографски настройки": "Cryptographic settings",
  "Текущ метод": "Current method",
  "Промяната влиза в сила само когато и двамата я потвърдите. Ключовете и Double Ratchet остават същите; сменя се само шифроването на съобщенията.": "A change takes effect only when both of you confirm it. Keys and the Double Ratchet stay the same; only the message encryption changes.",
  "Събеседникът предлага {suite}.": "The other person proposes {suite}.",
  "Предложение за смяна": "Proposed change",
  "Чака потвърждение от събеседника за {suite}.": "Waiting for the other person to confirm {suite}.",
  "Предложи {suite}": "Propose {suite}",
  "Методът е сменен на {suite}.": "The method was changed to {suite}.",
  "Този метод вече е активен.": "This method is already active.",
  "Събеседникът отказа смяната на метода.": "The other person declined the change.",
  "Връзката е прекъсната. Опитайте отново, когато се свържете.": "The connection was lost. Try again when you are connected.",
  "Връзката не се установи навреме. Мрежата може да блокира директната връзка.": "The connection did not open in time. The network may be blocking a direct connection.",
  "Опитайте с една Wi-Fi мрежа за първото сдвояване.": "For the first pairing, try the same Wi-Fi network.",
  "Покана": "Invitation",
  "Другият човек сканира този код. След това натисни „Сканирай отговора“.":
    "The other person scans this code. Then press „Scan the answer“.",
  "Няма камера на другото устройство?": "The other device has no camera?",
  "Копирай този код и го изпрати по сигурен начин. Другият човек го поставя с „Няма камера?“.":
    "Copy this code and send it through a secure channel. The other person pastes it using „No camera?“.",
  "Покана като hex": "Invitation as hex",
  "Копирано": "Copied",
  "Копирай кода": "Copy code",
  "Не може да сканира? Използвай кратък код:": "Can't scan it? Use a short code:",
  "Отказ": "Cancel",
  "Сканирай отговора": "Scan the answer",
  "Сканирай QR кода, който се показва на другото устройство.": "Scan the QR code shown on the other device.",
  "Или въведи кратък код:": "Or enter a short code:",
  "Сканирай поканата": "Scan the invitation",
  "Сканирай QR кода, който показва другият човек.": "Scan the QR code the other person shows.",
  "Отговор": "Answer",
  "Нека другият човек сканира този код. Чакаме връзката…":
    "Let the other person scan this code. Waiting for the connection…",
  "Потвърди контакта": "Confirm the contact",
  "Сравнете тези думи с човека до вас (или по видео). Трябва да са":
    "Compare these words with the person next to you (or on video). They must be",
  "едни и същи": "identical",
  "на двете устройства.": "on both devices.",
  "Код за сигурност": "Safety code",
  "Име на контакта": "Contact name",
  "Например: Иван": "For example: John",
  "Контакт": "Contact",
  "Думите съвпадат": "The words match",
  "Не съвпадат": "They don't match",
  "Кодовете не съвпаднаха. Връзката е прекратена и контактът не е запазен.":
    "The codes did not match. The connection was closed and the contact was not saved.",

  // Chat
  "Историята не можа да се прочете.": "The history could not be read.",
  "Другият човек изтри чата. Историята е изтрита и тук.":
    "The other person deleted the chat. The history is deleted here too.",
  "Съобщението не можа да се разшифрова.": "The message could not be decrypted.",
  "Получавам снимка": "Receiving photo",
  "Съобщението не беше изпратено.": "The message was not sent.",
  "Устройството не поддържа локация.": "This device does not support location.",
  "Не успях да определя локацията навреме. Провери разрешението за локация.":
    "I could not get the location in time. Check the location permission.",
  "Не успях да определя локацията.": "I could not get the location.",
  "Локацията не беше изпратена.": "The location was not sent.",
  "Нямаш разрешение за локацията.": "You don't have permission to use the location.",
  "Определянето на локацията отне твърде дълго.": "Getting the location took too long.",
  "Чатът е изтрит и за двамата.": "The chat was deleted for both of you.",
  "Чатът е изтрит тук. Другият човек не беше на линия, затова няма да се изтрие при него.":
    "The chat was deleted here. The other person was offline, so it will not be deleted on their side.",
  "Изпращам снимка": "Sending photo",
  "Снимката не беше изпратена.": "The photo was not sent.",
  "Изтрий чата за двамата": "Delete the chat for both",
  "Изтрий чата": "Delete chat",
  "Аудио разговор": "Audio call",
  "Видео разговор": "Video call",
  "Аудио": "Audio",
  "Видео": "Video",
  " · свързан": " · connected",
  " · връзката е прекъсната": " · connection lost",
  "Потвърди изтриването": "Confirm deletion",
  "Чатът ще се изтрие и при двама ви. Това не може да се отмени.":
    "The chat will be deleted for both of you. This cannot be undone.",
  "Да, изтрий за двамата": "Yes, delete for both",
  "Не": "No",
  "Снимка": "Photo",
  "Няма съобщения още. Кажи здравей.": "No messages yet. Say hello.",
  "{label}: {percent}%": "{label}: {percent}%",
  "Снимай с камерата": "Take a photo with the camera",
  "Камера": "Camera",
  "Сподели точната си локация": "Share your exact location",
  "Локация…": "Locating…",
  "Локация": "Location",
  "Избери снимка от галерията": "Choose a photo from the gallery",
  "Галерия": "Gallery",
  "Съобщение": "Message",
  "Изпрати": "Send",
  "точност ±{accuracy} м": "accuracy ±{accuracy} m",
  "Покажи на картата": "Show on the map",

  // Calls
  "Входящ разговор": "Incoming call",
  "{name} ти звъни: {kind} разговор.": "{name} is calling you: {kind} call.",
  "видео": "video",
  "аудио": "audio",
  "Приеми": "Accept",
  "Откажи": "Decline",
  "Звъня…": "Calling…",
  "Свързвам разговора…": "Connecting the call…",
  "В разговор": "In call",
  "{label} ({kind})": "{label} ({kind})",
  "Разговор": "Call",
  "Видео на събеседника": "Video of the other person",
  "Твоето видео": "Your video",
  "Заглуши": "Mute",
  "Включи микрофона": "Unmute",
  "Изключи камерата": "Turn camera off",
  "Включи камерата": "Turn camera on",
  "Край": "End",
  "Разговорът приключи.": "The call has ended.",
  "Разговорът приключи": "Call ended",
  "Нямаш разрешение за микрофона или камерата.": "You don't have permission for the microphone or camera.",
  "Не намерих микрофон или камера.": "No microphone or camera found.",
  "Не успях да включа микрофона или камерата.": "I could not turn on the microphone or camera.",
  "Връзката за разговора не можа да се установи.": "The call connection could not be established.",
  "Няма отговор.": "No answer.",
  "Другият човек отказа.": "The other person declined.",
  "Другият човек затвори разговора.": "The other person ended the call.",
  "Неуспешно договаряне на разговора.": "Call negotiation failed.",
  "Устройството не поддържа аудио и видео.": "This device does not support audio and video.",

  // QR scanner and QR code
  "Камера: {error}": "Camera: {error}",
  "Няма камера? Постави кода ръчно": "No camera? Paste the code manually",
  "Поканен код": "Invitation code",
  "p2p1: или p2p1h: (hex)…": "p2p1: or p2p1h: (hex)…",
  "Използвай кода": "Use the code",
  "Камерата не е достъпна в този контекст (нужен е HTTPS или localhost).":
    "The camera is not available in this context (HTTPS or localhost is required).",
  "Камерата не може да бъде стартирана.": "The camera cannot be started.",
  "QR грешка: {error}": "QR error: {error}",
  "QR код": "QR code",

  // Short codes
  "Кратък код:": "Short code:",
  "Важи {minutes} минути и работи само веднъж.": "Valid for {minutes} minutes and works only once.",
  "Създавам код…": "Creating code…",
  "Покажи кратък код": "Show short code",
  "Не успях да създам кратък код.": "I could not create a short code.",
  "Кратък код": "Short code",
  "Проверявам…": "Checking…",
  "Провери кода": "Check the code",
  "Не успях да прочета кода.": "I could not read the code.",
  "Няма връзка със сървъра за кодове.": "No connection to the code server.",
  "Опитай пак след малко.": "Try again in a moment.",
  "Сървърът отказа поканата.": "The server rejected the invitation.",
  "Неочакван отговор от сървъра.": "Unexpected response from the server.",
  "Кодът трябва да е 10 символа.": "The code must be 10 characters.",
  "Кодът не е валиден или вече е използван. Поискай нов.":
    "The code is not valid or was already used. Ask for a new one.",
  "Сървърът не можа да провери кода.": "The server could not check the code.",

  // Network hints
  "Мрежата има публичен IPv6 адрес. Връзка от разстояние е възможна, ако и другото устройство има IPv6.":
    "The network has a public IPv6 address. A remote connection is possible if the other device also has IPv6.",
  "Има само IPv4 адрес през STUN. Връзка между две мобилни мрежи често не успява заради оператора (CGNAT). Опитайте, но може да се наложи Wi-Fi.":
    "There is only an IPv4 address through STUN. A connection between two mobile networks often fails because of the carrier (CGNAT). Try it, but you may need Wi-Fi.",
  "Адресите на устройството са скрити от браузъра. Връзка от разстояние вероятно няма да успее.":
    "The browser hides the device addresses. A remote connection will probably fail.",
  "Няма публичен адрес. Връзка от разстояние вероятно няма да успее.":
    "There is no public address. A remote connection will probably fail.",

  // Photos and images
  "Снимката е прекалено голяма.": "The photo is too large.",
  "Файлът не е валидна снимка.": "The file is not a valid photo.",
  "Непознат тип съобщение.": "Unknown message type.",
  "Повредена снимка.": "The photo is damaged.",
  "Неподдържан формат на снимката.": "Unsupported photo format.",
  "Неочаквана част от снимка.": "Unexpected part of a photo.",
  "Частите на снимката са в грешен ред.": "The photo parts are out of order.",
  "Избери снимка.": "Choose a photo.",
  "Снимката не може да се прочете.": "The photo cannot be read.",
  "Снимката не може да се обработи.": "The photo cannot be processed.",
};
