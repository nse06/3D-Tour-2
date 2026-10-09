#if DEBUG
    import Foundation

    /// Drives the app from launch arguments for the simulator smoke test in CI
    /// (.github/workflows/ios.yml):
    ///
    ///     -atrium-automation "pair=<atriumcapture://pair?…>|demo|send"
    ///     -atrium-automation "rebuild"       (rebuilds every scan from an older pipeline)
    ///     -atrium-automation "pair=<…>|photoreal"  (sends a scan with photos, then uploads them for photoreal)
    ///
    /// Progress goes to Documents/automation-status.json so the test can wait
    /// on each stage and take screenshots. Debug builds only.
    extension AppModel {
        func runAutomationIfRequested() async {
            let args = ProcessInfo.processInfo.arguments
            guard let index = args.firstIndex(of: "-atrium-automation"), index + 1 < args.count else { return }
            let steps = args[index + 1].split(separator: "|").map(String.init)
            report("started")
            for step in steps {
                if step.hasPrefix("pair=") {
                    guard let url = URL(string: String(step.dropFirst(5))), let link = PairingLink(url: url) else {
                        return report("failed", "not a pairing link: \(step)")
                    }
                    await pair(with: link)
                    guard let pairing else { return report("failed", banner?.message ?? "pairing failed") }
                    report("paired", pairing.propertyLabel)
                } else if step == "demo" {
                    guard let record = await makeDemoScan() else { return report("failed", banner?.message ?? "demo scan failed") }
                    report("built", "\(record.stats.rooms) rooms, \(record.stats.glbBytes) bytes")
                } else if step == "send" {
                    guard let record = scans.first else { return report("failed", "no scan to send") }
                    await performSend(record)
                    switch uploads[record.id] {
                    case let .done(result)?: report("sent", "\(result.rooms) rooms on \(result.floors) floor(s)")
                    case let .failed(message)?: return report("failed", message)
                    default: return report("failed", "upload did not finish")
                    }
                } else if step == "rebuild" {
                    let old = scans.filter { !$0.isDemo && ($0.pipeline ?? 1) < ScanBuilder.pipelineVersion }
                    guard !old.isEmpty else { return report("failed", "no scan to rebuild") }
                    for record in old {
                        await performRebuild(record)
                        guard let rebuilt = scans.first(where: { $0.id == record.id }), rebuilt.pipeline == ScanBuilder.pipelineVersion else {
                            return report("failed", banner?.message ?? "rebuild failed")
                        }
                        report("rebuilt", "\(rebuilt.stats.rooms) rooms · \(rebuilt.alignment ?? "")")
                    }
                } else if step == "photoreal" {
                    guard let record = scans.first(where: { !$0.isDemo && store.hasPhotorealData($0.id) }) else {
                        return report("failed", "no scan with photoreal data")
                    }
                    await performSend(record)
                    guard case .done? = uploads[record.id], let sent = scans.first(where: { $0.id == record.id }) else {
                        if case let .failed(message)? = uploads[record.id] { return report("failed", "send: \(message)") }
                        return report("failed", "send did not finish")
                    }
                    report("sent", "\(sent.stats.rooms) rooms")
                    await performPhotoreal(sent)
                    if case let .failed(message)? = photorealUploads[record.id] { return report("failed", "photoreal: \(message)") }
                    guard let job = photorealJobs[record.id], scans.first(where: { $0.id == record.id })?.photoreal?.jobId == job.id else {
                        return report("failed", "photoreal upload did not finish")
                    }
                    report("photoreal", "\(job.status): \(job.message ?? "")")
                } else if step.hasPrefix("wait=") {
                    try? await Task.sleep(for: .seconds(Double(step.dropFirst(5)) ?? 1))
                }
            }
            report("done")
        }

        private func report(_ stage: String, _ detail: String = "") {
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let status: [String: Any] = ["stage": stage, "detail": detail, "time": Date().timeIntervalSince1970]
            if let data = try? JSONSerialization.data(withJSONObject: status) {
                try? data.write(to: documents.appendingPathComponent("automation-status.json"), options: .atomic)
            }
            print("[automation] \(stage) \(detail)")
        }
    }
#endif
