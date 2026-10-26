/*
 * English strings of the device transfer (src/transfer, src/ui/screens/TransferScreen.tsx).
 * Kept in its own file and spread into EN_DICTIONARY so the feature touches en.ts in one line.
 * The error messages come from the transfer services, which keep them in Bulgarian; the UI
 * translates them with t(error.message).
 */
export const EN_TRANSFER: Record<string, string> = {
  // Screens
  "Премести на ново устройство": "Move to a new device",
  "Имам друго устройство": "I have another device",
  "Премести идентичността на ново устройство": "Move your identity to a new device",
  "Прехвърлянето е директно между двете устройства, без сървър. Не се копират сесии: контактите ти се свързват наново с новото устройство.":
    "The transfer goes directly between the two devices, with no server. Sessions are not copied: your contacts connect again with the new device.",
  "Това е преместване, не синхронизация: след потвърждение тук всичко се изтрива.":
    "This is a move, not a sync: after you confirm, everything here is deleted.",
  "Започни": "Start",
  "Потвърждавам самоличността…": "Confirming your identity…",
  "Подготвям код…": "Preparing the code…",
  "1. Покажи кода на новото устройство": "1. Show the code to the new device",
  "На новото устройство избери „Имам друго устройство“ и сканирай този код. Кодът важи 10 минути и само веднъж.":
    "On the new device choose “I have another device” and scan this code. The code is valid for 10 minutes and works once.",
  "QR код за прехвърляне": "Transfer QR code",
  "Сканирай отговора на новото устройство": "Scan the new device's reply",
  "2. Сканирай отговора": "2. Scan the reply",
  "Новото устройство показва втори код. Насочи камерата към него.":
    "The new device shows a second code. Point the camera at it.",
  "3. Сравни думите": "3. Compare the words",
  "Същите 6 думи трябва да се виждат на новото устройство. Ако не са същите, спри.":
    "The same 6 words must show on the new device. If they differ, stop.",
  "Същите 6 думи трябва да се виждат на старото устройство. Ако не са същите, спри.":
    "The same 6 words must show on the old device. If they differ, stop.",
  "Думите съвпадат": "The words match",
  "Не съвпадат": "They do not match",
  "Чакам потвърждение от новото устройство…": "Waiting for the new device to confirm…",
  "Чакам старото устройство…": "Waiting for the old device…",
  "Изпращам. Не затваряй приложението…": "Sending. Do not close the app…",
  "Прекрати": "Cancel the transfer",
  "Прехвърлено": "Transferred",
  "Новото устройство запази идентичността. За да остане само едно място с ключа, изтрий данните от това устройство.":
    "The new device has stored the identity. To keep the key in one place only, delete the data from this device.",
  "Ще се изтрият идентичността, контактите и историята на чатовете тук. Историята и групите не се прехвърлят. С 12-те думи можеш да възстановиш идентичността.":
    "The identity, contacts and chat history on this device will be deleted. History and groups are not transferred. You can restore the identity with the 12 words.",
  "Разбирам, изтрий това устройство": "I understand, delete this device",
  "Изтрий от това устройство": "Delete from this device",
  "По-късно (идентичността остава на двете устройства)": "Later (the identity stays on both devices)",
  "1. Сканирай кода от старото устройство": "1. Scan the code from the old device",
  "2. Покажи този код на старото устройство": "2. Show this code to the old device",
  "Старото устройство го сканира. После ще сравните 6 думи.":
    "The old device scans it. Then you compare 6 words.",
  "QR код за отговор": "Reply QR code",
  "Защити идентичността на това устройство": "Protect the identity on this device",
  "Идентичността е получена. Избери как да се отключва на това устройство. Паролата не се прехвърля от старото устройство.":
    "The identity has arrived. Choose how it unlocks on this device. The password is not carried over from the old device.",
  "Използвай passkey": "Use a passkey",
  "Запази с парола": "Save with a password",
  "Вземи старото устройство, отключено. На него отвори Идентичност и избери „Премести на ново устройство“.":
    "Take the old device, unlocked. On it open Identity and choose “Move to a new device”.",
  "Сканирай кода": "Scan the code",
  "Копирай кода само по доверен път. Подмяна на кода е атака: сравни думите накрая.":
    "Copy the code only over a trusted path. A swapped code is an attack: compare the words at the end.",
  "Код като hex": "Code as hex",
  "Неизвестна грешка при прехвърлянето.": "Unknown error during the transfer.",
  "Прехвърлянето е прекратено.": "The transfer was cancelled.",
  "Идентичността е запазена тук": "The identity is stored here",
  "Старото устройство не получи потвърждение, затова няма да предложи изтриване. Не го изтривай, докато не провериш, че новото устройство работи; после го изтрий ръчно.":
    "The old device did not get the confirmation, so it will not offer to delete itself. Do not delete it until you have checked that the new device works; then delete it by hand.",

  // Errors from src/transfer (shown through t(error.message))
  "Времето за прехвърляне изтече.": "The transfer time ran out.",
  "Връзката е подправена или повредена. Прекратено.": "The connection was tampered with or damaged. Cancelled.",
  "Грешен вид код.": "Wrong kind of code.",
  "Другото устройство прекрати прехвърлянето.": "The other device cancelled the transfer.",
  "Думите не съвпаднаха. Прехвърлянето е прекратено.": "The words did not match. The transfer was cancelled.",
  "Запазването на това устройство не успя.": "Saving on this device failed.",
  "Каналът е затворен.": "The channel is closed.",
  "Кодът е изтекъл. Започни прехвърлянето отначало.": "The code has expired. Start the transfer again.",
  "Кодът не е валиден код за прехвърляне.": "This is not a valid transfer code.",
  "Невалиден SDP.": "Invalid connection data.",
  "Невалиден hex код.": "Invalid hex code.",
  "Невалиден nonce.": "Invalid nonce.",
  "Невалиден ключ.": "Invalid key.",
  "Невалидно семе.": "Invalid seed.",
  "Неочакван ред на съобщенията.": "Unexpected message order.",
  "Неочаквана грешка.": "Unexpected error.",
  "Нищо за потвърждаване.": "Nothing to confirm.",
  "Новото устройство не успя да запази идентичността.": "The new device could not store the identity.",
  "Новото устройство съобщи различна идентичност.": "The new device reported a different identity.",
  "Няма данни за изпращане.": "There is nothing to send.",
  "Няма активно прехвърляне.": "No transfer is in progress.",
  "Отговорът не е за тази покана.": "This reply is not for this invitation.",
  "Пакетът е твърде голям.": "The package is too large.",
  "Подправена връзка.": "Tampered connection.",
  "Получените данни не са валидни.": "The received data is not valid.",
  "Прекратено.": "Cancelled.",
  "Сега не е време за сравнение.": "It is not time to compare yet.",
  "Тази покана вече е използвана.": "This invitation has already been used.",
  "Това не е код за прехвърляне.": "This is not a transfer code.",
  "Това не е отговор.": "This is not a reply.",
  "Това не е покана.": "This is not an invitation.",
  "Твърде много контакти за прехвърляне.": "Too many contacts to transfer.",
  "Връзката с другото устройство прекъсна.": "The connection to the other device was lost.",
  "Връзката прекъсна след изпращането. Провери новото устройство; това устройство не е изтрито.":
    "The connection was lost after sending. Check the new device; this device has not been deleted.",
  "Новото устройство не потвърди навреме. Провери го; това устройство не е изтрито.":
    "The new device did not confirm in time. Check it; this device has not been deleted.",
  "Прехвърлянето не успя. Опитай отново.": "The transfer failed. Try again.",
  "Старото устройство вече не чака потвърждение.": "The old device is no longer waiting for the confirmation.",
  "Старото устройство вече не чака. Можеш да запазиш идентичността тук, но то няма да предложи изтриване.":
    "The old device is no longer waiting. You can still store the identity here, but it will not offer to delete itself.",
};
