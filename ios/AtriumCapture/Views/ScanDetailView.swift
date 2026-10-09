import QuickLook
import SwiftUI

struct ScanDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let scanId: UUID

    @State private var previewURL: URL?
    @State private var confirmDelete = false
    @State private var showingPairing = false
    @State private var photorealSize: (photos: Int, bytes: Int64)?

    private var scan: ScanRecord? { model.scans.first { $0.id == scanId } }

    var body: some View {
        ScrollView {
            if let scan {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(scan.createdAt.formatted(date: .complete, time: .shortened))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text(scan.title).font(Theme.display(30))
                    }
                    stats(scan)
                    if needsRebuild(scan) { rebuildCard(scan) }
                    sendCard(scan)
                    if !scan.isDemo && model.store.hasPhotorealData(scan.id) { photorealCard(scan) }
                    VStack(spacing: 10) {
                        ShareLink(item: model.store.modelURL(for: scan.id)) {
                            Label("Share 3D model (.glb)", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(PillButtonStyle(primary: false))
                        if !needsRebuild(scan) && ScanBuilder.canRebuild(scan, directory: model.store.directory(for: scan.id)) {
                            Button {
                                model.rebuild(scan)
                            } label: {
                                Label("Rebuild walkthrough", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .buttonStyle(PillButtonStyle(primary: false))
                            .disabled(model.building != nil || model.isSending(scan.id))
                        }
                        if FileManager.default.fileExists(atPath: model.store.previewURL(for: scan.id).path) {
                            Button {
                                previewURL = model.store.previewURL(for: scan.id)
                            } label: {
                                Label("View RoomPlan model in AR", systemImage: "arkit")
                            }
                            .buttonStyle(PillButtonStyle(primary: false))
                        }
                        Button("Delete scan", role: .destructive) { confirmDelete = true }
                            .font(.subheadline)
                            .padding(.top, 6)
                    }
                }
                .padding(20)
            } else {
                Text("This scan was deleted.").foregroundStyle(.secondary).padding(40)
            }
        }
        .background(Theme.paper.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .quickLookPreview($previewURL)
        .sheet(isPresented: $showingPairing) { PairingSheet() }
        .confirmationDialog("Delete this scan from the iPhone?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let scan { model.delete(scan) }
                dismiss()
            }
        } message: {
            Text("Tours already sent to Atrium stay online.")
        }
    }

    private func stats(_ scan: ScanRecord) -> some View {
        let s = scan.stats
        return VStack(spacing: 12) {
            HStack(spacing: 0) {
                stat("\(s.rooms)", s.rooms == 1 ? "room" : "rooms")
                stat("\(s.floors)", s.floors == 1 ? "floor" : "floors")
                stat("\(Int(s.floorArea.rounded()))", "m²")
                stat("\(s.doors + s.openings)", "doorways")
            }
            if let alignment = scan.alignment, scan.stats.rooms > 1 {
                Label(alignment, systemImage: "square.3.layers.3d.down.right")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let coverage = scan.stats.photoCoverage {
                Label("Your photos cover \(Int((coverage * 100).rounded()))% of the surfaces", systemImage: "photo.on.rectangle.angled")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let people = scan.stats.photosWithPeople, people > 0 {
                Label("People painted out of \(people) photo\(people == 1 ? "" : "s")", systemImage: "person.crop.circle.badge.xmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let aligned = scan.stats.photosAligned, aligned > 0 {
                Label(
                    "\(aligned) photos lined up with each other (by \(String(format: "%.1f", scan.stats.photoShiftCm ?? 0)) cm on average)",
                    systemImage: "square.on.square.dashed")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let lidar = lidarNote(scan) {
                Label(lidar.text, systemImage: lidar.used ? "cube.transparent" : "cube")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .card()
    }

    /// Whether furniture was shaped from the LiDAR mesh, from the scan's info.json (scans captured
    /// with build 7 on): a positive line, or why the boxes were used.
    private func lidarNote(_ scan: ScanRecord) -> (text: String, used: Bool)? {
        let url = model.store.directory(for: scan.id).appendingPathComponent("info.json")
        guard let data = try? Data(contentsOf: url), let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = info["lidarMesh"] as? String, mode != "not recorded"
        else { return nil }
        let rooms = info["lidarMeshRooms"] as? Int ?? 0, triangles = info["meshTriangles"] as? Int ?? 0
        if triangles > 0 {
            return ("Furniture shaped from the LiDAR mesh (\(rooms) of \(scan.stats.rooms) room\(scan.stats.rooms == 1 ? "" : "s"))", true)
        }
        if mode == "switched off" { return ("Real furniture shapes were off for this scan", false) }
        if rooms == 0 { return ("No LiDAR mesh was recorded (session: \(mode)) — furniture uses RoomPlan's shapes", false) }
        return ("The LiDAR mesh had no furniture in it — furniture uses RoomPlan's shapes", false)
    }

    /// Scans built by an older pipeline (see ScanBuilder.pipelineVersion).
    private func needsRebuild(_ scan: ScanRecord) -> Bool {
        (scan.pipeline ?? 1) < ScanBuilder.pipelineVersion && ScanBuilder.canRebuild(scan, directory: model.store.directory(for: scan.id))
    }

    private func rebuildCard(_ scan: ScanRecord) -> some View {
        let title: String, text: String
        switch scan.pipeline ?? 1 {
        case ..<3:
            title = "Fix overlapping rooms"
            text = "This scan was built before Atrium Capture lined rooms up with each other or used your photos, so rooms may overlap. Rebuilding fixes that and paints the photos taken while scanning onto the walls, floors and furniture. No rescanning needed. Afterwards, send it to Atrium again."
        case 3:
            title = "Add your photos to the walkthrough"
            text = "This scan was built before Atrium Capture painted the photos taken while scanning onto the model. Rebuild to see your real walls, floors and furniture. No rescanning needed. Afterwards, send it to Atrium again."
        case 4:
            title = "Sharpen the photo walkthrough"
            text = "Atrium Capture now paints each surface from its sharpest photo instead of blending several, shapes furniture (mattress, headboard, seat, back), paints people out of the photos and closes gaps under ceilings. Rebuild to apply it — this also adds a clean 3D view buyers can switch to. No rescanning needed. Afterwards, send it to Atrium again."
        case 5:
            title = "Add the photos-off view"
            text = "Buyers and you can now switch the photos off in the walkthrough and see a clean 3D model of the home, and people in your photos are painted out. Rebuild to apply it. No rescanning needed. Afterwards, send it to Atrium again."
        case 6:
            title = "Paint people out of the photos"
            text = "Atrium Capture now paints people out of the walkthrough — someone walking through, or you reflected in a mirror — using the other photos of the same spot. Rebuild to apply it. No rescanning needed. Afterwards, send it to Atrium again."
        case 7:
            title = "Sharpen edges and line up the photos"
            text = "Atrium Capture now lines your photos up with each other before painting (the phone's tracking drifts a centimeter or two), keeps furniture edges from smearing onto the walls behind them, gives LiDAR furniture finer, smoother shapes and draws TVs as thin screens. Rebuilding also gets the scan ready for a photoreal walkthrough. No rescanning needed. Afterwards, send it to Atrium again."
        default:
            title = "Thin TVs, and ready for photoreal"
            text = "Atrium Capture now draws TVs as thin screens instead of thick boxes, and gives the sides of furniture no photo saw the color of the rest of the piece. Rebuilding also gets the scan ready for a photoreal walkthrough. No rescanning needed. Afterwards, send it to Atrium again."
        }
        return VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: "wand.and.stars")
                .font(.headline)
            Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            Button {
                model.rebuild(scan)
            } label: {
                Label("Rebuild walkthrough", systemImage: "arrow.triangle.2.circlepath")
            }
            .buttonStyle(PillButtonStyle())
            .disabled(model.building != nil || model.isSending(scan.id))
        }
        .card()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(Theme.display(26))
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func sendCard(_ scan: ScanRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Atrium").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
            switch model.uploads[scan.id] {
            case .preparing?:
                progressRow("Preparing upload…", nil)
            case let .uploading(fraction)?:
                progressRow("Uploading…", fraction)
            case .finishing?:
                progressRow("Building the walkthrough…", nil)
            case let .done(result)?:
                delivered(rooms: result.rooms, previewUrl: result.previewUrl, label: model.pairing?.propertyLabel)
            case let .failed(message)?:
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                sendButton(scan, title: "Try again")
            case nil:
                if let delivery = scan.delivery {
                    delivered(rooms: scan.stats.rooms, previewUrl: delivery.previewUrl, label: delivery.propertyLabel)
                    if model.pairing != nil { sendButton(scan, title: "Send again") }
                } else if model.pairing == nil || model.pairing?.isExpired == true {
                    Text("Connect to a listing to send this scan. In the dashboard, open the listing and tap **Connect an iPhone**.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button {
                        showingPairing = true
                    } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(PillButtonStyle())
                } else {
                    Text("Becomes the walkthrough of **\(model.pairing?.propertyLabel ?? "")**, replacing its current 3D capture.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    sendButton(scan, title: "Send to Atrium")
                }
            }
        }
        .card()
    }

    // MARK: Photoreal (docs/photoreal.md)

    private func photorealCard(_ scan: ScanRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Photoreal walkthrough", systemImage: "sparkles").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
            switch model.photorealUploads[scan.id] {
            case .preparing?:
                progressRow("Getting the photos ready…", nil)
            case let .uploading(fraction)?:
                progressRow("Uploading the photos…", fraction)
            case .finishing?:
                progressRow("Handing them to the cloud GPU…", nil)
            case let .failed(message)?:
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                photorealButton(scan, title: "Try again")
            case nil:
                if let job = scan.photoreal {
                    photorealStatus(scan, job)
                } else {
                    Text("A cloud GPU learns the home from this scan's photos — window views, reflections, every plant — and buyers can switch to it in the walkthrough. It takes about half an hour after the upload.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if scan.delivery == nil {
                        Text("Send the scan to Atrium first.").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        if let size = photorealSize {
                            Text("Uploads \(size.photos) photos (\(megabytes(size.bytes))). Best on Wi-Fi.").font(.footnote).foregroundStyle(.secondary)
                        }
                        photorealButton(scan, title: "Make it photoreal")
                    }
                }
            }
        }
        .card()
        .task(id: scan.photoreal?.jobId) {
            if scan.photoreal == nil {
                photorealSize = await model.photorealSize(scan)
            } else {
                await model.refreshPhotoreal(scan)
            }
        }
    }

    @ViewBuilder
    private func photorealStatus(_ scan: ScanRecord, _ sent: ScanRecord.Photoreal) -> some View {
        let job = model.photorealJobs[scan.id]
        switch job?.status {
        case "done"?:
            Label("Ready. Open the walkthrough and tap Photoreal.", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.green)
        case "failed"?:
            Label("The cloud GPU couldn't finish: \(job?.message ?? "unknown error")", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline)
                .foregroundStyle(.orange)
            Text("Try again from the listing in the Atrium dashboard; the photos are still there.").font(.footnote).foregroundStyle(.secondary)
        case "running"?:
            VStack(alignment: .leading, spacing: 8) {
                let percent = Int(((job?.progress ?? 0) * 100).rounded())
                Text(verbatim: job?.stage == "training" ? "Training on your photos… \(percent)%" : "The cloud GPU is on it…")
                    .font(.subheadline.weight(.semibold))
                ProgressView(value: max(0.03, job?.progress ?? 0)).tint(Theme.gold)
                Text("You can close the app. Follow it in the Atrium dashboard.").font(.footnote).foregroundStyle(.secondary)
            }
        default:
            Text("Photos uploaded \(sent.sentAt.formatted(.relative(presentation: .named))).").font(.subheadline.weight(.semibold))
            Text(job?.message ?? "Waiting for the cloud GPU. Follow it in the Atrium dashboard.").font(.footnote).foregroundStyle(.secondary)
        }
        if job?.status != "done" && model.pairing?.propertyId == sent.propertyId {
            Button {
                Task { await model.refreshPhotoreal(scan) }
            } label: {
                Label("Check progress", systemImage: "arrow.clockwise")
            }
            .buttonStyle(PillButtonStyle(primary: false))
        }
    }

    private func photorealButton(_ scan: ScanRecord, title: String) -> some View {
        Button {
            model.makePhotoreal(scan)
        } label: {
            Label(title, systemImage: "sparkles")
        }
        .buttonStyle(PillButtonStyle())
        .disabled(model.building != nil || model.isSending(scan.id))
    }

    private func megabytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func sendButton(_ scan: ScanRecord, title: String) -> some View {
        Button {
            model.send(scan)
        } label: {
            Label(title, systemImage: "paperplane.fill")
        }
        .buttonStyle(PillButtonStyle())
        .disabled(model.isSending(scan.id))
    }

    private func progressRow(_ title: String, _ fraction: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            if let fraction {
                ProgressView(value: fraction).tint(Theme.gold)
            } else {
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Keep Atrium Capture open until the upload finishes. The screen stays on meanwhile.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func delivered(rooms: Int, previewUrl: String, label: String?) -> some View {
        Label("Sent\(label.map { " to \($0)" } ?? "")", systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.green)
        Text("\(rooms) room\(rooms == 1 ? "" : "s") are ready to walk through. Review them in the dashboard, then publish the tour.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        if let url = URL(string: previewUrl) {
            Button {
                openURL(url)
            } label: {
                Label("Open the walkthrough", systemImage: "safari")
            }
            .buttonStyle(PillButtonStyle(primary: false))
        }
    }
}
