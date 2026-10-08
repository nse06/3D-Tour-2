import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingPairing = false
    @State private var path: [UUID] = []
    @AppStorage(MeshRecorder.enabledKey) private var lidarShapes = true

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    PairingCard(showingPairing: $showingPairing)
                    scanCard
                    scansList
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
            }
            .background(Theme.paper.ignoresSafeArea())
            .navigationDestination(for: UUID.self) { id in ScanDetailView(scanId: id) }
            .toolbar(.hidden, for: .navigationBar)
        }
        .sheet(isPresented: $showingPairing) { PairingSheet() }
        .fullScreenCover(item: captureBinding) { capture in CaptureScreen(model: capture) }
        .overlay(alignment: .top) { BannerView() }
        .overlay { if let building = model.building { BuildingOverlay(step: building.step) } }
        .onChange(of: model.openScan) { _, id in
            guard let id else { return }
            path = [id]
            model.openScan = nil
        }
    }

    private var captureBinding: Binding<CaptureModel?> {
        Binding(get: { model.capture }, set: { if $0 == nil { model.capture = nil } })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ATRIUM")
                .font(.system(size: 12, weight: .semibold))
                .tracking(3)
                .foregroundStyle(Theme.stone)
            Text("Capture")
                .font(Theme.display(44))
                .foregroundStyle(Theme.ink)
        }
        .padding(.top, 24)
    }

    private var scanCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Scan a home")
                .font(Theme.display(24))
            Text("Walk through room by room. Atrium measures each room with LiDAR, records your path, and builds the 3D walkthrough automatically.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if model.canScan {
                Button {
                    model.startScan()
                } label: {
                    Label("Start a scan", systemImage: "viewfinder")
                }
                .buttonStyle(PillButtonStyle())
                .padding(.top, 4)
                VStack(alignment: .leading, spacing: 6) {
                    tip("lightbulb", "Turn on the lights and open the doors between rooms.")
                    tip("figure.walk", "Move slowly along the walls and pause for a moment on each one — photos are taken while the phone is still.")
                    tip("arrow.triangle.turn.up.right.diamond", "Walk between rooms with the phone up — that path becomes the tour route.")
                }
                .padding(.top, 4)
                Toggle(isOn: $lidarShapes) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Real furniture shapes").font(.footnote.weight(.semibold))
                        Text("Also records the LiDAR mesh, so furniture and clutter keep their shape. Turn off if scanning misbehaves.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(Theme.gold)
                .padding(.top, 2)
            } else {
                Label("Scanning needs an iPhone with LiDAR — iPhone 12 Pro or a newer Pro model.", systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
            }
            Button("Create a demo scan (no LiDAR needed)") { model.createDemoScan() }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.stone)
                .padding(.top, 2)
        }
        .card()
    }

    private func tip(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(Theme.gold)
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var scansList: some View {
        if !model.scans.isEmpty {
            Text("Your scans")
                .font(Theme.display(24))
                .padding(.top, 8)
            VStack(spacing: 10) {
                ForEach(model.scans) { scan in
                    NavigationLink(value: scan.id) { ScanRow(scan: scan) }
                        .buttonStyle(.plain)
                }
            }
        }
    }
}

struct ScanRow: View {
    @EnvironmentObject private var model: AppModel
    let scan: ScanRecord

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: scan.isDemo ? "sparkles" : "cube.transparent")
                .font(.title2)
                .foregroundStyle(Theme.gold)
                .frame(width: 44, height: 44)
                .background(Theme.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(scan.title).font(.headline).lineLimit(1)
                Text("\(scan.stats.rooms) room\(scan.stats.rooms == 1 ? "" : "s") · \(Int(scan.stats.floorArea.rounded())) m² · \(scan.createdAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            status
        }
        .card()
    }

    @ViewBuilder
    private var status: some View {
        switch model.uploads[scan.id] {
        case let .uploading(fraction)?:
            Text("\(Int(fraction * 100))%").font(.footnote.monospacedDigit()).foregroundStyle(Theme.gold)
        case .preparing?, .finishing?:
            ProgressView()
        case .failed?:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
        default:
            if scan.delivery != nil {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
        }
    }
}

/// Where scans go: the paired listing, or how to pair.
struct PairingCard: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showingPairing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pairing = model.pairing, !pairing.isExpired {
                Label("Connected", systemImage: "checkmark.seal.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.green)
                Text(pairing.propertyLabel).font(.headline)
                Text("Scans upload to \(pairing.host) · code valid until \(pairing.expiresAt.formatted(date: .omitted, time: .shortened))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Change listing") { showingPairing = true }
                    Spacer()
                    Button("Disconnect", role: .destructive) { model.unpair() }
                }
                .font(.footnote.weight(.semibold))
                .padding(.top, 2)
            } else {
                Label(model.pairing?.isExpired == true ? "Pairing code expired" : "Not connected to a listing", systemImage: "link")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.stone)
                Text("In the Atrium dashboard, open a listing and tap **Connect an iPhone**, then scan the code with the Camera app.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    showingPairing = true
                } label: {
                    Label(model.isPairing ? "Connecting…" : "Scan pairing code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(PillButtonStyle(primary: false))
                .disabled(model.isPairing)
            }
        }
        .card()
    }
}

struct BannerView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let banner = model.banner {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: banner.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(banner.isError ? .orange : .green)
                Text(banner.message).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    model.banner = nil
                } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.bold)).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .task(id: banner.id) {
                try? await Task.sleep(for: .seconds(banner.isError ? 8 : 4))
                if model.banner?.id == banner.id { model.banner = nil }
            }
        }
    }
}

struct BuildingOverlay: View {
    let step: ScanBuilder.Step

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                Text("Building your tour").font(Theme.display(26))
                ForEach(ScanBuilder.Step.allCases, id: \.rawValue) { s in
                    HStack(spacing: 10) {
                        if s.rawValue < step.rawValue {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        } else if s == step {
                            ProgressView().frame(width: 17)
                        } else {
                            Image(systemName: "circle").foregroundStyle(.tertiary)
                        }
                        Text(s.title).font(.subheadline.weight(s == step ? .semibold : .regular))
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 320, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
    }
}

extension CaptureModel: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}
