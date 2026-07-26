import Foundation

struct FoldviewConfiguration: Decodable, Equatable, Sendable {
    struct Menubar: Decodable, Equatable, Sendable {
        let refreshSeconds: Int
        let showDiscoveredApps: Bool
    }

    let schemaVersion: Int
    let menubar: Menubar
    let aiClis: [AICLIPayload]
}
