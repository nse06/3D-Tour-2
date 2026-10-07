import Foundation

/// A PBR metallic-roughness material. Colors are sRGB hex like the web app's.
struct MaterialDef {
    var name: String
    var color: String
    var roughness: Float = 0.8
    var metalness: Float = 0
    /// Key of a procedural texture (see `TextureKind`).
    var texture: TextureKind? = nil
    var emissive: String? = nil
    var emissiveStrength: Float = 1
}

enum TextureKind: String, CaseIterable {
    case oak, tile
}

/// Material keys used by the geometry builders.
enum Mat {
    static let wall = "Wall_Paint"
    static let trim = "Trim_White"
    static let ceiling = "Ceiling"
    static let oak = "Floor_Oak"
    static let tile = "Floor_Tile"
    static let windowFrame = "Window_Frame"
    static let daylight = "Window_Daylight"
    static let fabric = "Fabric_Linen"
    static let fabricDark = "Fabric_Charcoal"
    static let duvet = "Bedding_White"
    static let woodDark = "Wood_Walnut"
    static let lacquer = "Cabinet_White"
    static let stone = "Counter_Stone"
    static let steel = "Steel"
    static let black = "Black_Gloss"
    static let ceramic = "Ceramic_White"
    static let water = "Water"
    static let fireplace = "Fireplace_Stone"
    static let neutral = "Object_Neutral"
    static let shadowGap = "Shadow_Gap"
    /// Photo mode: faces no photo sees (outsides and tops of walls, reveals).
    static let photoPlain = "Photo_Plain"
}

let materialLibrary: [String: MaterialDef] = {
    let defs: [MaterialDef] = [
        MaterialDef(name: Mat.wall, color: "#f1ede6", roughness: 0.92),
        MaterialDef(name: Mat.trim, color: "#f8f7f3", roughness: 0.45),
        MaterialDef(name: Mat.ceiling, color: "#f6f4ef", roughness: 0.95),
        MaterialDef(name: Mat.oak, color: "#ffffff", roughness: 0.52, texture: .oak),
        MaterialDef(name: Mat.tile, color: "#ffffff", roughness: 0.3, texture: .tile),
        MaterialDef(name: Mat.windowFrame, color: "#3b3a38", roughness: 0.5),
        MaterialDef(name: Mat.daylight, color: "#dfe8ef", roughness: 1, emissive: "#e8f0f6", emissiveStrength: 1.7),
        MaterialDef(name: Mat.fabric, color: "#cfc6b8", roughness: 0.96),
        MaterialDef(name: Mat.fabricDark, color: "#6f6a64", roughness: 0.96),
        MaterialDef(name: Mat.duvet, color: "#efece6", roughness: 0.9),
        MaterialDef(name: Mat.woodDark, color: "#7a5a40", roughness: 0.6),
        MaterialDef(name: Mat.lacquer, color: "#ebe8e2", roughness: 0.38),
        MaterialDef(name: Mat.stone, color: "#d9d4cc", roughness: 0.28),
        MaterialDef(name: Mat.steel, color: "#b8bbbe", roughness: 0.32, metalness: 0.85),
        MaterialDef(name: Mat.black, color: "#1d1d1f", roughness: 0.3),
        MaterialDef(name: Mat.ceramic, color: "#f5f5f3", roughness: 0.14),
        MaterialDef(name: Mat.water, color: "#a9c0cc", roughness: 0.05),
        MaterialDef(name: Mat.fireplace, color: "#bdb5aa", roughness: 0.85),
        MaterialDef(name: Mat.neutral, color: "#cdc8c0", roughness: 0.8),
        MaterialDef(name: Mat.shadowGap, color: "#2a2927", roughness: 0.9),
        MaterialDef(name: Mat.photoPlain, color: "#e9e5de", roughness: 1),
    ]
    return Dictionary(uniqueKeysWithValues: defs.map { ($0.name, $0) })
}()

/// sRGB hex → linear RGB (glTF color factors are linear).
func linearColor(_ hex: String) -> [Double] {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    let v = UInt32(s, radix: 16) ?? 0xffffff
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff].map { c in
        let x = Double(c) / 255
        let lin = x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
        return (lin * 10000).rounded() / 10000
    }
}
