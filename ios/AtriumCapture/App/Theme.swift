import SwiftUI

/// Atrium's brand: warm paper, ink, and a touch of gold.
enum Theme {
    static let ink = Color(red: 0x16 / 255, green: 0x15 / 255, blue: 0x14 / 255)
    static let paper = Color(red: 0xF7 / 255, green: 0xF4 / 255, blue: 0xEF / 255)
    static let gold = Color(red: 0xB8 / 255, green: 0x95 / 255, blue: 0x5A / 255)
    static let sand = Color(red: 0xE7 / 255, green: 0xE0 / 255, blue: 0xD5 / 255)
    static let stone = Color(red: 0x8A / 255, green: 0x80 / 255, blue: 0x72 / 255)

    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .serif) }
}

/// A rounded white card on the paper background.
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.sand, lineWidth: 1))
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

/// Full-width capsule button in ink (primary) or outlined (secondary).
struct PillButtonStyle: ButtonStyle {
    var primary = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .foregroundStyle(primary ? Color.white : Theme.ink)
            .background(primary ? Theme.ink : Color.white, in: Capsule())
            .overlay(Capsule().stroke(primary ? Color.clear : Theme.sand, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
