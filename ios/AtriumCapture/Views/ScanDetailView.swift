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
                    sendCard(scan)
                    VStack(spacing: 10) {
                        ShareLink(item: model.store.modelURL(for: scan.id)) {
                            Label("Share 3D model (.glb)", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(PillButtonStyle(primary: false))
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
        return HStack(spacing: 0) {
            stat("\(s.rooms)", s.rooms == 1 ? "room" : "rooms")
            stat("\(s.floors)", s.floors == 1 ? "floor" : "floors")
            stat("\(Int(s.floorArea.rounded()))", "m²")
            stat("\(s.doors + s.openings)", "doorways")
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
