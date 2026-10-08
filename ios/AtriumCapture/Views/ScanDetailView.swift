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
                            .disabled(model.building != nil || model.uploads[scan.id]?.isBusy == true)
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
            if let triangles = scan.stats.meshTriangles, triangles > 0 {
                Label("Furniture shaped from the LiDAR mesh", systemImage: "cube.transparent")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .card()
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
        default:
            title = "Paint people out of the photos"
            text = "Atrium Capture now paints people out of the walkthrough — someone walking through, or you reflected in a mirror — using the other photos of the same spot. Rebuild to apply it. No rescanning needed. Afterwards, send it to Atrium again."
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
            .disabled(model.building != nil || model.uploads[scan.id]?.isBusy == true)
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

    private func sendButton(_ scan: ScanRecord, title: String) -> some View {
        Button {
            model.send(scan)
        } label: {
            Label(title, systemImage: "paperplane.fill")
        }
        .buttonStyle(PillButtonStyle())
    }

    private func progressRow(_ title: String, _ fraction: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            if let fraction {
                ProgressView(value: fraction).tint(Theme.gold)
            } else {
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("Keep Atrium Capture open until the upload finishes.").font(.footnote).foregroundStyle(.secondary)
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
