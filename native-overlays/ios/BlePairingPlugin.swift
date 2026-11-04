import Foundation
import CoreBluetooth
import Capacitor

/// BLE first-contact pairing transport (iOS).
///
/// Contract shared with the JS side and the Android plugin:
///   INITIATOR = PERIPHERAL (advertises "P2P-<TAG>", hosts RX write / TX notify)
///   RESPONDER = CENTRAL    (scans, connects, writes RX, subscribes TX)
///
/// Threading: every CoreBluetooth delegate runs on `queue` and all mutable state is only
/// touched on `queue`. Plugin methods hop onto `queue` first. Events and call results
/// are delivered to JS from there (Capacitor handles the main-thread hop itself).
@objc(BlePairingPlugin)
public class BlePairingPlugin: CAPPlugin, CAPBridgedPlugin, CBCentralManagerDelegate, CBPeripheralDelegate, CBPeripheralManagerDelegate {
    public let identifier = "BlePairingPlugin"
    public let jsName = "BlePairing"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPeripheral", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let serviceUUID = CBUUID(string: "3da7960c-96f3-4d14-a3c8-b842772e603e")
    private let rxUUID = CBUUID(string: "7b8af345-7943-48e4-9134-e268f787d5cf")
    private let txUUID = CBUUID(string: "ae4c0870-c466-48e6-af14-d814739213db")

    private let queue = DispatchQueue(label: "bg.p2pmessenger.ble")

    // Managers (created lazily; creating one triggers the system Bluetooth prompt).
    private var central: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?

    // Callbacks waiting for the first state update of a manager.
    private var centralStateWaiters: [() -> Void] = []

    // Peripheral (initiator) state.
    private var localRx: CBMutableCharacteristic?
    private var localTx: CBMutableCharacteristic?
    private var advertisedTag: String?
    private var startCall: CAPPluginCall?
    private var subscribedCentral: CBCentral?
    private var sendQueue: [(data: Data, call: CAPPluginCall)] = []

    // Central (responder) state.
    private var wantScan = false
    private var discovered: [String: CBPeripheral] = [:]
    private var remote: CBPeripheral?
    private var remoteRx: CBCharacteristic?
    private var remoteTx: CBCharacteristic?
    private var connectCall: CAPPluginCall?
    private var connectToken = 0
    private var writeCalls: [CAPPluginCall] = []

    // MARK: - JS methods

    @objc func checkAvailability(_ call: CAPPluginCall) {
        queue.async {
            self.whenCentralStateKnown {
                guard let central = self.central else {
                    call.resolve(["available": false, "reason": "unsupported"])
                    return
                }
                switch CBManager.authorization {
                case .denied, .restricted:
                    call.resolve(["available": false, "reason": "unauthorized"])
                    return
                default:
                    break
                }
                switch central.state {
                case .poweredOn:
                    call.resolve(["available": true])
                case .unsupported:
                    call.resolve(["available": false, "reason": "unsupported"])
                case .unauthorized:
                    call.resolve(["available": false, "reason": "unauthorized"])
                default:
                    call.resolve(["available": false, "reason": "off"])
                }
            }
        }
    }

    @objc func requestPermissions(_ call: CAPPluginCall) {
        queue.async {
            self.whenCentralStateKnown {
                call.resolve(["granted": CBManager.authorization == .allowedAlways])
            }
        }
    }

    @objc func startPeripheral(_ call: CAPPluginCall) {
        guard let tag = call.getString("tag"), !tag.isEmpty else {
            call.reject("tag is required")
            return
        }
        queue.async {
            self.resetAll(reason: nil, emit: false)
            self.advertisedTag = tag
            self.startCall = call
            let manager = CBPeripheralManager(delegate: self, queue: self.queue)
            self.peripheralManager = manager
            // Service is added from peripheralManagerDidUpdateState once poweredOn.
            if manager.state != .unknown {
                self.peripheralManagerDidUpdateState(manager)
            }
        }
    }

    @objc func startScan(_ call: CAPPluginCall) {
        queue.async {
            self.resetAll(reason: nil, emit: false)
            self.wantScan = true
            self.discovered.removeAll()
            let manager = CBCentralManager(delegate: self, queue: self.queue)
            self.central = manager
            if manager.state == .poweredOn {
                self.beginScan()
                call.resolve()
            } else if manager.state == .unknown {
                // Scanning starts from centralManagerDidUpdateState; report errors there.
                self.whenCentralStateKnown {
                    if self.central?.state == .poweredOn {
                        call.resolve()
                    } else {
                        self.wantScan = false
                        call.reject("Bluetooth is not available", "BLE_UNAVAILABLE")
                    }
                }
            } else {
                self.wantScan = false
                call.reject("Bluetooth is not available", "BLE_UNAVAILABLE")
            }
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId") else {
            call.reject("deviceId is required")
            return
        }
        queue.async {
            guard let central = self.central, central.state == .poweredOn else {
                call.reject("Bluetooth is not available", "BLE_UNAVAILABLE")
                return
            }
            guard let peripheral = self.discovered[deviceId] else {
                call.reject("Unknown device", "UNKNOWN_DEVICE")
                return
            }
            if self.connectCall != nil || self.remote != nil {
                call.reject("Already connecting or connected", "BUSY")
                return
            }
            central.stopScan()
            self.connectCall = call
            self.remote = peripheral
            peripheral.delegate = self
            self.connectToken += 1
            let token = self.connectToken
            central.connect(peripheral, options: nil)
            self.queue.asyncAfter(deadline: .now() + 20) {
                if self.connectToken == token, let pending = self.connectCall {
                    self.connectCall = nil
                    if let p = self.remote { self.central?.cancelPeripheralConnection(p) }
                    self.remote = nil
                    pending.reject("Connection timed out", "TIMEOUT")
                }
            }
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("data (base64) is required")
            return
        }
        queue.async {
            if let peripheral = self.remote, let rx = self.remoteRx, self.central != nil {
                // Central -> peripheral: write with response, resolved in didWriteValueFor.
                guard peripheral.state == .connected else {
                    call.reject("Not connected", "NOT_CONNECTED")
                    return
                }
                self.writeCalls.append(call)
                peripheral.writeValue(data, for: rx, type: .withResponse)
            } else if self.peripheralManager != nil, self.localTx != nil {
                guard self.subscribedCentral != nil else {
                    call.reject("No subscribed central", "NOT_CONNECTED")
                    return
                }
                self.sendQueue.append((data: data, call: call))
                self.flushSendQueue()
            } else {
                call.reject("Not connected", "NOT_CONNECTED")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.resetAll(reason: "stopped", emit: false)
            call.resolve()
        }
    }

    // MARK: - Helpers (call only on `queue`)

    private func emit(_ event: String, _ data: [String: Any] = [:]) {
        notifyListeners(event, data: data)
    }

    private func whenCentralStateKnown(_ done: @escaping () -> Void) {
        if central == nil {
            central = CBCentralManager(delegate: self, queue: queue)
        }
        if let c = central, c.state != .unknown {
            done()
            return
        }
        var fired = false
        let once: () -> Void = {
            if fired { return }
            fired = true
            done()
        }
        centralStateWaiters.append(once)
        // Short timeout: the prompt may stay on screen; report what we know afterwards.
        queue.asyncAfter(deadline: .now() + 30) { once() }
    }

    private func beginScan() {
        central?.scanForPeripherals(withServices: [serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    private func flushSendQueue() {
        guard let pm = peripheralManager, let tx = localTx, let target = subscribedCentral else { return }
        while let first = sendQueue.first {
            if pm.updateValue(first.data, for: tx, onSubscribedCentrals: [target]) {
                sendQueue.removeFirst()
                first.call.resolve()
            } else {
                break // retried from peripheralManagerIsReady(toUpdateSubscribers:)
            }
        }
    }

    /// Tear everything down and reject pending calls. `emit` sends "disconnected" to JS.
    private func resetAll(reason: String?, emit shouldEmit: Bool) {
        let hadLink = remote != nil || subscribedCentral != nil

        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        peripheralManager?.delegate = nil
        peripheralManager = nil
        localRx = nil
        localTx = nil
        subscribedCentral = nil
        advertisedTag = nil

        wantScan = false
        central?.stopScan()
        if let p = remote {
            p.delegate = nil
            central?.cancelPeripheralConnection(p)
        }
        central?.delegate = nil
        central = nil
        remote = nil
        remoteRx = nil
        remoteTx = nil
        discovered.removeAll()
        connectToken += 1

        let err = "BLE stopped"
        startCall?.reject(err, "STOPPED"); startCall = nil
        connectCall?.reject(err, "STOPPED"); connectCall = nil
        for c in writeCalls { c.reject(err, "STOPPED") }
        writeCalls.removeAll()
        for item in sendQueue { item.call.reject(err, "STOPPED") }
        sendQueue.removeAll()

        // Wake state waiters so no call hangs; they see central == nil.
        let waiters = centralStateWaiters
        centralStateWaiters.removeAll()
        for w in waiters { w() }

        if shouldEmit && hadLink {
            var payload: [String: Any] = [:]
            if let r = reason { payload["reason"] = r }
            emit("disconnected", payload)
        }
    }

    private func parseTag(advertisementData: [String: Any], peripheral: CBPeripheral) -> String? {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
        if let name = name, name.hasPrefix("P2P-") {
            let tag = String(name.dropFirst(4))
            if !tag.isEmpty { return tag }
        }
        // Android may put the 4-char ASCII tag into service data instead of the name.
        if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
           let raw = serviceData[serviceUUID],
           let tag = String(data: raw, encoding: .ascii), !tag.isEmpty {
            return tag
        }
        return nil
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central === self.central else { return }
        if central.state != .unknown {
            let waiters = centralStateWaiters
            centralStateWaiters.removeAll()
            for w in waiters { w() }
        }
        if central.state == .poweredOn {
            if wantScan { beginScan() }
        } else if central.state != .unknown {
            if remote != nil || connectCall != nil {
                resetAll(reason: "bluetooth-off", emit: true)
            }
        }
    }

    public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard let tag = parseTag(advertisementData: advertisementData, peripheral: peripheral) else { return }
        let id = peripheral.identifier.uuidString
        discovered[id] = peripheral // strong ref, required for connect()
        emit("deviceFound", ["deviceId": id, "tag": tag, "rssi": RSSI.intValue])
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === remote else { return }
        peripheral.discoverServices([serviceUUID])
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === remote else { return }
        remote = nil
        let pending = connectCall
        connectCall = nil
        pending?.reject(error?.localizedDescription ?? "Connection failed", "CONNECT_FAILED")
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === remote else { return }
        let hadConnected = connectCall == nil
        remote = nil
        remoteRx = nil
        remoteTx = nil
        let msg = error?.localizedDescription ?? "Disconnected"
        connectCall?.reject(msg, "DISCONNECTED"); connectCall = nil
        for c in writeCalls { c.reject(msg, "DISCONNECTED") }
        writeCalls.removeAll()
        if hadConnected {
            var payload: [String: Any] = [:]
            if let e = error { payload["reason"] = e.localizedDescription }
            emit("disconnected", payload)
        }
    }

    // MARK: - CBPeripheralDelegate (central role)

    private func failConnect(_ message: String) {
        let pending = connectCall
        connectCall = nil
        if let p = remote { central?.cancelPeripheralConnection(p) }
        remote = nil
        remoteRx = nil
        remoteTx = nil
        pending?.reject(message, "CONNECT_FAILED")
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === remote else { return }
        if let error = error { failConnect(error.localizedDescription); return }
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            failConnect("Service not found")
            return
        }
        peripheral.discoverCharacteristics([rxUUID, txUUID], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === remote else { return }
        if let error = error { failConnect(error.localizedDescription); return }
        remoteRx = service.characteristics?.first(where: { $0.uuid == rxUUID })
        remoteTx = service.characteristics?.first(where: { $0.uuid == txUUID })
        guard remoteRx != nil, let tx = remoteTx else {
            failConnect("Characteristics not found")
            return
        }
        peripheral.setNotifyValue(true, for: tx)
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === remote, characteristic.uuid == txUUID else { return }
        if let error = error { failConnect(error.localizedDescription); return }
        guard characteristic.isNotifying, let pending = connectCall else { return }
        connectCall = nil
        let mtu = peripheral.maximumWriteValueLength(for: .withResponse) + 3
        pending.resolve(["mtu": mtu])
        emit("connected", ["mtu": mtu])
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === remote, characteristic.uuid == txUUID else { return }
        if let error = error {
            emit("error", ["message": error.localizedDescription])
            return
        }
        if let value = characteristic.value {
            emit("data", ["data": value.base64EncodedString()])
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === remote, characteristic.uuid == rxUUID else { return }
        guard !writeCalls.isEmpty else { return }
        let call = writeCalls.removeFirst()
        if let error = error {
            call.reject(error.localizedDescription, "WRITE_FAILED")
        } else {
            call.resolve()
        }
    }

    // MARK: - CBPeripheralManagerDelegate (peripheral role)

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral === peripheralManager else { return }
        switch peripheral.state {
        case .poweredOn:
            guard localTx == nil, startCall != nil else { return }
            let rx = CBMutableCharacteristic(type: rxUUID, properties: [.write], value: nil, permissions: [.writeable])
            let tx = CBMutableCharacteristic(type: txUUID, properties: [.notify], value: nil, permissions: [.readable])
            localRx = rx
            localTx = tx
            let service = CBMutableService(type: serviceUUID, primary: true)
            service.characteristics = [rx, tx]
            peripheral.add(service)
        case .unknown:
            break
        default:
            let pending = startCall
            startCall = nil
            if pending != nil {
                pending?.reject("Bluetooth is not available", "BLE_UNAVAILABLE")
            } else if subscribedCentral != nil {
                resetAll(reason: "bluetooth-off", emit: true)
            }
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard peripheral === peripheralManager else { return }
        if let error = error {
            let pending = startCall
            startCall = nil
            pending?.reject(error.localizedDescription, "ADD_SERVICE_FAILED")
            return
        }
        let tag = advertisedTag ?? ""
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: "P2P-\(tag)"
        ])
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard peripheral === peripheralManager else { return }
        let pending = startCall
        startCall = nil
        if let error = error {
            pending?.reject(error.localizedDescription, "ADVERTISE_FAILED")
        } else {
            pending?.resolve()
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didSubscribeTo characteristic: CBCharacteristic) {
        guard peripheral === peripheralManager, characteristic.uuid == txUUID else { return }
        subscribedCentral = central
        emit("subscribed", ["mtu": central.maximumUpdateValueLength + 3])
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard peripheral === peripheralManager, characteristic.uuid == txUUID else { return }
        guard subscribedCentral?.identifier == central.identifier else { return }
        subscribedCentral = nil
        for item in sendQueue { item.call.reject("Disconnected", "DISCONNECTED") }
        sendQueue.removeAll()
        emit("disconnected")
    }

    public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        guard peripheral === peripheralManager else { return }
        flushSendQueue()
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard peripheral === peripheralManager else { return }
        for request in requests where request.characteristic.uuid == rxUUID {
            if let value = request.value {
                emit("data", ["data": value.base64EncodedString()])
            }
        }
        // One response answers the whole batch (Apple: respond to the first request).
        if let first = requests.first {
            peripheral.respond(to: first, withResult: .success)
        }
    }
}
