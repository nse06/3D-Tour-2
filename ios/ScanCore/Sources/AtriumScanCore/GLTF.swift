import Foundation

/// A point light (KHR_lights_punctual).
struct PointLight {
    var name: String
    var position: Vec3
    var color: String
    /// Candela.
    var intensity: Double
    var range: Double
}

/// Writes glTF 2.0 binary (.glb): one node per material, PNG textures,
/// KHR_lights_punctual lights, and the scan manifest in the scene's extras.
enum GLBWriter {
    /// `photoTextures`: material name → encoded image used as its base color (clamped, not repeated).
    /// `unlit`: every material gets KHR_materials_unlit (photo-textured models carry their own lighting).
    static func write(
        mesh: MeshBuilder, lights: [PointLight], textureSize: Int, sceneExtras: [String: Any], generator: String,
        photoTextures: [String: (data: Data, mimeType: String)] = [:], unlit: Bool = false
    ) throws -> Data {
        var bin = Data()
        var bufferViews: [[String: Any]] = []
        var accessors: [[String: Any]] = []

        func align() { while bin.count % 4 != 0 { bin.append(0) } }

        func addView(_ data: Data, target: Int?) -> Int {
            align()
            var view: [String: Any] = ["buffer": 0, "byteOffset": bin.count, "byteLength": data.count]
            if let target { view["target"] = target }
            bin.append(data)
            bufferViews.append(view)
            return bufferViews.count - 1
        }

        func floatAccessor(_ values: [Float], components: Int) -> Int {
            let view = addView(values.withUnsafeBufferPointer { Data(buffer: $0) }, target: 34962)
            var accessor: [String: Any] = [
                "bufferView": view, "componentType": 5126, "count": values.count / components, "type": components == 3 ? "VEC3" : "VEC2",
            ]
            if components == 3 {
                // Required for POSITION; exact float32 values so validators agree.
                var lo = [Float](repeating: .infinity, count: 3), hi = [Float](repeating: -.infinity, count: 3)
                for i in stride(from: 0, to: values.count, by: 3) {
                    for k in 0..<3 {
                        lo[k] = min(lo[k], values[i + k])
                        hi[k] = max(hi[k], values[i + k])
                    }
                }
                accessor["min"] = lo.map(Double.init)
                accessor["max"] = hi.map(Double.init)
            }
            accessors.append(accessor)
            return accessors.count - 1
        }

        func indexAccessor(_ values: [UInt32]) -> Int {
            let view = addView(values.withUnsafeBufferPointer { Data(buffer: $0) }, target: 34963)
            accessors.append(["bufferView": view, "componentType": 5125, "count": values.count, "type": "SCALAR"])
            return accessors.count - 1
        }

        // Textures used by any material: procedural ones repeat (sampler 0), photo atlases are clamped (sampler 1).
        var images: [[String: Any]] = []
        var imageSampler: [Int] = []
        var textureIndex: [TextureKind: Int] = [:]
        var photoTextureIndex: [String: Int] = [:]
        let usedKinds = Set(mesh.order.compactMap { materialLibrary[$0]?.texture })
        for kind in TextureKind.allCases where usedKinds.contains(kind) {
            let image: RGBImage
            switch kind {
            case .oak: image = ProceduralTexture.oak(size: textureSize)
            case .tile: image = ProceduralTexture.tile(size: textureSize)
            }
            let view = addView(PNG.encode(image), target: nil)
            images.append(["bufferView": view, "mimeType": "image/png", "name": kind.rawValue])
            imageSampler.append(0)
            textureIndex[kind] = images.count - 1
        }
        for key in mesh.order {
            guard let photo = photoTextures[key] else { continue }
            let view = addView(photo.data, target: nil)
            images.append(["bufferView": view, "mimeType": photo.mimeType, "name": key])
            imageSampler.append(1)
            photoTextureIndex[key] = images.count - 1
        }

        var materials: [[String: Any]] = []
        var nodes: [[String: Any]] = []
        var meshes: [[String: Any]] = []
        var usesEmissiveStrength = false

        for key in mesh.order {
            guard let buffer = mesh.buffers[key], !buffer.isEmpty else { continue }
            let def = materialLibrary[key] ?? MaterialDef(name: key, color: photoTextures[key] != nil ? "#ffffff" : "#cccccc", roughness: 1)
            var pbr: [String: Any] = [
                "baseColorFactor": linearColor(def.color) + [1.0],
                "metallicFactor": Double(def.metalness),
                "roughnessFactor": Double(def.roughness),
            ]
            if let kind = def.texture, let index = textureIndex[kind] { pbr["baseColorTexture"] = ["index": index] }
            if let index = photoTextureIndex[key] { pbr["baseColorTexture"] = ["index": index] }
            var material: [String: Any] = ["name": def.name, "pbrMetallicRoughness": pbr]
            var extensions: [String: Any] = [:]
            if let emissive = def.emissive, !unlit {
                material["emissiveFactor"] = linearColor(emissive)
                if def.emissiveStrength != 1 {
                    extensions["KHR_materials_emissive_strength"] = ["emissiveStrength": Double(def.emissiveStrength)]
                    usesEmissiveStrength = true
                }
            }
            if unlit { extensions["KHR_materials_unlit"] = [String: Any]() }
            if !extensions.isEmpty { material["extensions"] = extensions }
            materials.append(material)

            // Unlit models need no normals (viewers derive flat ones if they want them): a quarter less to download.
            var attributes: [String: Any] = ["POSITION": floatAccessor(buffer.positions, components: 3)]
            if !unlit { attributes["NORMAL"] = floatAccessor(buffer.normals, components: 3) }
            attributes["TEXCOORD_0"] = floatAccessor(buffer.uvs, components: 2)
            let primitive: [String: Any] = [
                "attributes": attributes,
                "indices": indexAccessor(buffer.indices),
                "material": materials.count - 1,
                "mode": 4,
            ]
            meshes.append(["name": def.name, "primitives": [primitive]])
            nodes.append(["name": def.name, "mesh": meshes.count - 1])
        }

        var lightDefs: [[String: Any]] = []
        for light in lights {
            lightDefs.append(["name": light.name, "type": "point", "color": linearColor(light.color), "intensity": light.intensity, "range": light.range])
            nodes.append([
                "name": light.name,
                "translation": [Double(light.position.x), Double(light.position.y), Double(light.position.z)],
                "extensions": ["KHR_lights_punctual": ["light": lightDefs.count - 1]],
            ])
        }

        var samplers: [[String: Any]] = []
        var textures: [[String: Any]] = []
        if !images.isEmpty {
            samplers.append(["magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497])
            samplers.append(["magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071])
            textures = images.indices.map { ["source": $0, "sampler": imageSampler[$0]] }
        }

        align()
        var json: [String: Any] = [
            "asset": ["version": "2.0", "generator": generator],
            "scene": 0,
            "scenes": [["name": "Scan", "nodes": Array(0..<nodes.count), "extras": sceneExtras]],
            "nodes": nodes,
            "meshes": meshes,
            "materials": materials,
            "accessors": accessors,
            "bufferViews": bufferViews,
            "buffers": [["byteLength": bin.count]],
        ]
        if !images.isEmpty {
            json["images"] = images
            json["textures"] = textures
            json["samplers"] = samplers
        }
        var extensionsUsed: [String] = []
        if !lightDefs.isEmpty {
            json["extensions"] = ["KHR_lights_punctual": ["lights": lightDefs]]
            extensionsUsed.append("KHR_lights_punctual")
        }
        if usesEmissiveStrength { extensionsUsed.append("KHR_materials_emissive_strength") }
        if unlit { extensionsUsed.append("KHR_materials_unlit") }
        if !extensionsUsed.isEmpty { json["extensionsUsed"] = extensionsUsed }

        var jsonData = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        while jsonData.count % 4 != 0 { jsonData.append(0x20) }

        var glb = Data()
        glb.appendUInt32LE(0x4654_6C67)  // "glTF"
        glb.appendUInt32LE(2)
        glb.appendUInt32LE(UInt32(12 + 8 + jsonData.count + 8 + bin.count))
        glb.appendUInt32LE(UInt32(jsonData.count))
        glb.appendUInt32LE(0x4E4F_534A)  // "JSON"
        glb.append(jsonData)
        glb.appendUInt32LE(UInt32(bin.count))
        glb.appendUInt32LE(0x004E_4942)  // "BIN\0"
        glb.append(bin)
        return glb
    }
}
