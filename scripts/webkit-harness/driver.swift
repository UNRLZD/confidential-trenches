// Card signpage-shell: one WKWebView on the Mac's own WebKit.framework (Safari's engine, default preferences,
// a non-persistent data store), driven by index.mjs over JSON lines on stdin/stdout.
// Every load (main frame, subframes, subresources) goes through the harness's CONNECT proxy on 127.0.0.1, so the
// two hosts are served by the local build and nothing else reaches the network. A server-trust challenge is
// answered only for those two hosts and only when the leaf certificate is the harness's own (DER compared byte
// for byte with the certificate index.mjs generated this run).
// The view is <width> x <height> CSS px (800 x 600 when not given). WebKit's WebCrypto master key (it wraps every
// CryptoKey a page keeps in IndexedDB) is 16 random bytes made per run and held in memory, so the driver never
// reads or writes the login keychain: a keychain item is bound to one build's code hash, and a rebuilt driver would
// wait on a macOS keychain prompt.
//   driver <proxyPort> <certPemPath> <host1> <host2> [<width> <height>]
import AppKit
import Network
import WebKit

let args = CommandLine.arguments
guard args.count == 5 || args.count == 7, let proxyPort = UInt16(args[1]), let nwPort = NWEndpoint.Port(rawValue: proxyPort) else {
  FileHandle.standardError.write("usage: driver <proxyPort> <certPemPath> <host1> <host2> [<width> <height>]\n".data(using: .utf8)!)
  exit(2)
}
let viewWidth = args.count == 7 ? Double(args[5]) ?? 0 : 800
let viewHeight = args.count == 7 ? Double(args[6]) ?? 0 : 600
guard viewWidth >= 200, viewHeight >= 200 else {
  FileHandle.standardError.write("driver: width and height must be numbers of at least 200\n".data(using: .utf8)!)
  exit(2)
}
var masterKeyBytes = [UInt8](repeating: 0, count: 16)
guard SecRandomCopyBytes(kSecRandomDefault, masterKeyBytes.count, &masterKeyBytes) == errSecSuccess else {
  FileHandle.standardError.write("driver: no random bytes\n".data(using: .utf8)!)
  exit(2)
}
let webCryptoMasterKey = Data(masterKeyBytes)
let allowedHosts: Set<String> = [args[3], args[4]]

func pemToDer(_ path: String) -> Data? {
  guard let pem = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
  let b64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
  return Data(base64Encoded: b64)
}
guard let pinnedDer = pemToDer(args[2]) else {
  FileHandle.standardError.write("driver: cannot read the certificate\n".data(using: .utf8)!)
  exit(2)
}

func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  FileHandle.standardOutput.write(d)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func jsErrorText(_ error: Error) -> String {
  let e = error as NSError
  if let m = e.userInfo["WKJavaScriptExceptionMessage"] as? String { return m }
  return e.localizedDescription
}

// Wraps a function body so the page returns a JSON string; the driver never converts JS values itself.
func wrap(_ body: String) -> String {
  return "const __v = await (async () => {\n\(body)\n})();\nreturn __v === undefined ? \"null\" : JSON.stringify(__v);"
}

final class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
}

final class Driver: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  let view: WKWebView
  let window: KeyWindow
  var pendingNav: [ObjectIdentifier: Int] = [:]  // WKNavigation -> request id
  var frames: [String: WKFrameInfo] = [:]  // host -> latest non-main frame that posted a harness message
  let hosts: Set<String>
  let pinned: Data

  init(port: NWEndpoint.Port, pinned: Data, hosts: Set<String>) {
    self.hosts = hosts
    self.pinned = pinned
    let store = WKWebsiteDataStore.nonPersistent()
    store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))]
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = store
    view = WKWebView(frame: NSRect(x: 0, y: 0, width: viewWidth, height: viewHeight), configuration: cfg)
    window = KeyWindow(contentRect: NSRect(x: -4000, y: -4000, width: viewWidth, height: viewHeight), styleMask: [.borderless],
                       backing: .buffered, defer: false)
    super.init()
    cfg.userContentController.add(self, contentWorld: .page, name: "harness")
    view.navigationDelegate = self
    window.contentView = view
    window.orderFront(nil)
  }

  // MARK: WebCrypto master key (WKNavigationDelegatePrivate; both the current and the older form)

  @objc(_webCryptoMasterKeyForWebView:completionHandler:)
  func answerWebCryptoMasterKey(_ w: WKWebView, completionHandler: @escaping (Data?) -> Void) { completionHandler(webCryptoMasterKey) }
  @objc(_webCryptoMasterKeyForWebView:)
  func answerWebCryptoMasterKeyNow(_ w: WKWebView) -> Data? { webCryptoMasterKey }

  // MARK: trust

  func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      completionHandler(.performDefaultHandling, nil); return
    }
    guard hosts.contains(space.host), let trust = space.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
          SecCertificateCopyData(leaf) as Data == pinned else {
      emit(["event": "trust-refused", "host": space.host])
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  // MARK: navigation

  func finish(_ nav: WKNavigation?, error: Error?) {
    guard let nav = nav, let id = pendingNav.removeValue(forKey: ObjectIdentifier(nav)) else { return }
    if let error = error { emit(["id": id, "ok": false, "error": (error as NSError).localizedDescription + " (" + String((error as NSError).code) + ")"]) }
    else { emit(["id": id, "ok": true, "value": "null"]) }
  }
  func webView(_ w: WKWebView, didFinish nav: WKNavigation!) { finish(nav, error: nil) }
  func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) { finish(nav, error: e) }
  func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) { finish(nav, error: e) }

  // MARK: messages

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    let host = m.frameInfo.securityOrigin.host
    if !m.frameInfo.isMainFrame { frames[host] = m.frameInfo }
    let data = (m.body as? String) ?? "null"
    emit(["event": "message", "host": host, "main": m.frameInfo.isMainFrame, "data": data,
          "t": Int(Date().timeIntervalSince1970 * 1000)])
  }

  // MARK: commands

  func evaluate(_ id: Int, _ js: String, frame: WKFrameInfo?) {
    view.callAsyncJavaScript(wrap(js), arguments: [:], in: frame, in: .page) { result in
      switch result {
      case .success(let v): emit(["id": id, "ok": true, "value": (v as? String) ?? "null"])
      case .failure(let e): emit(["id": id, "ok": false, "error": jsErrorText(e)])
      }
    }
  }

  // A trusted click: the element's center in the top document, then native NSEvents into the WKWebView.
  func click(_ id: Int, _ selector: String) {
    let sel = String(data: try! JSONSerialization.data(withJSONObject: [selector], options: []), encoding: .utf8)!
    let js = "const el = document.querySelector(\(sel)[0]); if (!el) throw new Error('no element for selector'); "
      + "el.scrollIntoView({block: 'center', inline: 'center'}); const r = el.getBoundingClientRect(); "
      + "return [r.left + r.width / 2, r.top + r.height / 2];"
    view.callAsyncJavaScript(wrap(js), arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .failure(let e): emit(["id": id, "ok": false, "error": jsErrorText(e)])
      case .success(let v):
        guard let s = v as? String, let d = s.data(using: .utf8), let xy = try? JSONSerialization.jsonObject(with: d) as? [Double],
              xy.count == 2 else { emit(["id": id, "ok": false, "error": "no element center"]); return }
        // CSS px from the viewport's top-left, at page zoom 1.
        let y = self.view.isFlipped ? xy[1] : self.view.bounds.height - xy[1]
        let inWindow = self.view.convert(NSPoint(x: xy[0], y: y), to: nil)
        let wn = self.window.windowNumber
        let t = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.mouseEvent(with: .leftMouseDown, location: inWindow, modifierFlags: [], timestamp: t,
                                            windowNumber: wn, context: nil, eventNumber: 1, clickCount: 1, pressure: 1),
              let up = NSEvent.mouseEvent(with: .leftMouseUp, location: inWindow, modifierFlags: [], timestamp: t + 0.05,
                                          windowNumber: wn, context: nil, eventNumber: 2, clickCount: 1, pressure: 0) else {
          emit(["id": id, "ok": false, "error": "NSEvent.mouseEvent returned nil"]); return
        }
        self.view.mouseDown(with: down)
        self.view.mouseUp(with: up)
        // Resolve once the web process has handled the events: a script round trip after them.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
          self.view.callAsyncJavaScript("return 1", arguments: [:], in: nil, in: .page) { _ in
            emit(["id": id, "ok": true, "value": "null"])
          }
        }
      }
    }
  }

  func handle(_ line: String) {
    guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let id = o["id"] as? Int, let cmd = o["cmd"] as? String else {
      emit(["event": "bad-command", "line": String(line.prefix(200))]); return
    }
    switch cmd {
    case "goto":
      guard let s = o["url"] as? String, let u = URL(string: s) else { emit(["id": id, "ok": false, "error": "bad url"]); return }
      if let nav = view.load(URLRequest(url: u)) { pendingNav[ObjectIdentifier(nav)] = id }
      else { emit(["id": id, "ok": false, "error": "load returned no navigation"]) }
    case "reload":
      if let nav = view.reload() { pendingNav[ObjectIdentifier(nav)] = id }
      else { emit(["id": id, "ok": false, "error": "reload returned no navigation"]) }
    case "evaluate":
      evaluate(id, (o["js"] as? String) ?? "", frame: nil)
    case "evaluateFrame":
      let host = (o["host"] as? String) ?? ""
      guard let f = frames[host] else { emit(["id": id, "ok": false, "error": "no harness message from a frame of " + host]); return }
      evaluate(id, (o["js"] as? String) ?? "", frame: f)
    case "click":
      click(id, (o["selector"] as? String) ?? "")
    case "close":
      emit(["id": id, "ok": true, "value": "null"])
      exit(0)
    default:
      emit(["id": id, "ok": false, "error": "unknown command " + cmd])
    }
  }
}

func webkitVersion() -> String {
  let b = Bundle(for: WKWebView.self)
  let v = (b.infoDictionary?["CFBundleVersion"] as? String) ?? "unknown"
  let os = ProcessInfo.processInfo.operatingSystemVersion
  var size = 0
  sysctlbyname("kern.osversion", nil, &size, nil, 0)
  var buf = [CChar](repeating: 0, count: max(size, 1))
  sysctlbyname("kern.osversion", &buf, &size, nil, 0)
  let build = String(cString: buf)
  return "system WebKit \(v) (macOS \(os.majorVersion).\(os.minorVersion)\(os.patchVersion > 0 ? ".\(os.patchVersion)" : "") \(build))"
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let driver = Driver(port: nwPort, pinned: pinnedDer, hosts: allowedHosts)

var buffer = Data()
FileHandle.standardInput.readabilityHandler = { h in
  let chunk = h.availableData
  if chunk.isEmpty { DispatchQueue.main.async { exit(0) }; h.readabilityHandler = nil; return }  // Node went away
  buffer.append(chunk)
  while let nl = buffer.firstIndex(of: 0x0A) {
    let lineData = buffer.subdata(in: buffer.startIndex..<nl)
    buffer.removeSubrange(buffer.startIndex...nl)
    if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
      DispatchQueue.main.async { driver.handle(line) }
    }
  }
}
emit(["event": "ready", "version": webkitVersion()])
app.run()
