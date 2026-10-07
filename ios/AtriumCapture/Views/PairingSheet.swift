import SwiftUI
import UIKit
import VisionKit

/// Connect to a listing: scan the dashboard's QR code in the app, or paste the link.
struct PairingSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var scanned = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Point the camera at the code on the listing page in the Atrium dashboard (Connect an iPhone).")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if QRScannerView.isAvailable {
                    QRScannerView { payload in
                        guard !scanned else { return }
                        scanned = true
                        model.pair(withText: payload)
                        dismiss()
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 340)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                } else {
                    Label("The in-app scanner isn't available here. Use the iPhone Camera app on the code, or paste the link.", systemImage: "camera")
                        .font(.subheadline)
                }
                Button {
                    if let text = UIPasteboard.general.string {
                        model.pair(withText: text)
                        dismiss()
                    }
                } label: {
                    Label("Paste pairing link", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(PillButtonStyle(primary: false))
                Text("Tip: the iPhone Camera app opens Atrium Capture straight from the code, too.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(20)
            .navigationTitle("Connect to a listing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }
}

/// VisionKit's live QR scanner.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    @MainActor static var isAvailable: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case let .barcode(code) = item, let payload = code.payloadStringValue {
                    onScan(payload)
                    return
                }
            }
        }
    }
}
