import SwiftUI

/// Full-screen multi-room capture: RoomPlan's live view with Atrium's controls on top.
struct CaptureScreen: View {
    @ObservedObject var model: CaptureModel

    var body: some View {
        ZStack {
            CaptureViewRepresentable(model: model)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                topBar
                if let instruction = model.instruction, model.phase == .scanning {
                    Text(instruction)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                        .transition(.opacity)
                }
                Spacer()
                bottomPanel
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .animation(.easeInOut(duration: 0.2), value: model.phase)
        .animation(.easeInOut(duration: 0.2), value: model.instruction)
        .sheet(isPresented: namingBinding) {
            RoomNameSheet(model: model)
                .presentationDetents([.medium, .large])
                .interactiveDismissDisabled()
        }
        .statusBarHidden()
    }

    private var namingBinding: Binding<Bool> {
        Binding(get: { model.phase == .naming }, set: { _ in })
    }

    private var topBar: some View {
        HStack {
            Button("Cancel") { model.cancel() }
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
            Spacer()
            Text(model.phase == .betweenRooms ? "\(model.rooms.count) room\(model.rooms.count == 1 ? "" : "s") scanned" : "Room \(model.roomNumber)")
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
        }
        .foregroundStyle(.primary)
        .padding(.top, 8)
    }

    /// Photos are taken whenever the phone is steady; moving slowly gives more, sharper ones.
    private var photoStatus: some View {
        HStack(spacing: 6) {
            Image(systemName: model.movingFast ? "tortoise.fill" : "camera.fill")
            if model.movingFast {
                Text("Slow down for sharp photos")
            } else {
                Text("\(model.photoCount) photo\(model.photoCount == 1 ? "" : "s") · pause on each wall")
            }
        }
        .font(.footnote.weight(model.movingFast ? .semibold : .regular))
        .foregroundStyle(model.movingFast ? Color.orange : Color.secondary)
        .animation(.easeInOut(duration: 0.2), value: model.movingFast)
    }

    @ViewBuilder
    private var bottomPanel: some View {
        switch model.phase {
        case .scanning:
            VStack(spacing: 10) {
                if let detected = model.detectedName {
                    Text("Looks like a \(detected.lowercased())")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                photoStatus
                Button("Done with this room") { model.finishRoom() }
                    .buttonStyle(PillButtonStyle())
            }
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))

        case .endingRoom:
            HStack(spacing: 10) {
                ProgressView()
                Text("Saving room \(model.roomNumber)…").font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(20)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))

        case .naming:
            EmptyView()

        case .betweenRooms:
            VStack(alignment: .leading, spacing: 12) {
                Label("Walk to the next room", systemImage: "figure.walk")
                    .font(.headline)
                Text("Keep the phone pointed ahead as you walk — your path becomes the tour route. Start scanning once you're inside.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Start scanning room \(model.roomNumber)") { model.startNextRoom() }
                    .buttonStyle(PillButtonStyle())
                Button("Finish — \(model.rooms.count) room\(model.rooms.count == 1 ? "" : "s")") { model.finish() }
                    .buttonStyle(PillButtonStyle(primary: false))
            }
            .padding(18)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))

        case let .failed(message):
            VStack(alignment: .leading, spacing: 12) {
                Label("Scanning stopped", systemImage: "exclamationmark.triangle.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text(message).font(.subheadline)
                Button("Keep what was scanned") { model.keepPartialRoom() }
                    .buttonStyle(PillButtonStyle())
                Button("Scan this room again") { model.rescanRoom() }
                    .buttonStyle(PillButtonStyle(primary: false))
            }
            .padding(18)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
    }
}

/// "What is this room?" — shown after each room.
struct RoomNameSheet: View {
    @ObservedObject var model: CaptureModel
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Room \(model.roomNumber) is scanned")
                        .font(Theme.display(28))
                    TextField("Room name", text: $model.draftName)
                        .font(.title3)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .focused($focused)
                        .padding(14)
                        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    FlowLayout(spacing: 8) {
                        ForEach(CaptureModel.quickNames, id: \.self) { name in
                            Button(name) { model.draftName = name }
                                .font(.subheadline.weight(.medium))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(model.draftName == name ? Theme.ink : Theme.paper, in: Capsule())
                                .foregroundStyle(model.draftName == name ? Color.white : Theme.ink)
                        }
                    }
                    VStack(spacing: 10) {
                        Button("Scan the next room") { model.saveRoom(thenScanAnother: true) }
                            .buttonStyle(PillButtonStyle())
                        Button("Finish and build the tour") { model.saveRoom(thenScanAnother: false) }
                            .buttonStyle(PillButtonStyle(primary: false))
                        Button("Scan this room again", role: .destructive) { model.rescanRoom() }
                            .font(.subheadline)
                            .padding(.top, 4)
                    }
                    .padding(.top, 6)
                }
                .padding(20)
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// Wraps the UIKit capture controller.
struct CaptureViewRepresentable: UIViewControllerRepresentable {
    let model: CaptureModel

    func makeUIViewController(context: Context) -> CaptureViewController { CaptureViewController(model: model) }
    func updateUIViewController(_ controller: CaptureViewController, context: Context) {}
}

/// Lays out chips left to right, wrapping onto new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + spacing
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
