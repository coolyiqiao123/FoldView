import Foundation
import Testing
@testable import FoldviewMenuBar

struct AIModelCatalogTests {
    private let catalogJSON = """
    {
      "schemaVersion": 1,
      "generatedAt": "2026-07-19T00:00:00.000Z",
      "future": { "ignored": true },
      "providers": [{
        "id": "codex",
        "name": "Codex",
        "executable": "/opt/bin/codex",
        "available": true,
        "error": null,
        "defaultModel": "deep",
        "defaultEffort": "high",
        "models": [{
          "id": "deep",
          "label": "Deep",
          "detail": "Careful coding",
          "efforts": ["low", "medium", "high"],
          "defaultEffort": "medium",
          "newField": 123
        }]
      }]
    }
    """

    @Test func decodesCatalogAndIgnoresUnknownKeys() throws {
        let envelope = try JSONDecoder().decode(AICatalogEnvelope.self, from: Data(catalogJSON.utf8))
        #expect(envelope.schemaVersion == 1)
        #expect(envelope.providers.first?.id == "codex")
        #expect(envelope.providers.first?.models.first?.label == "Deep")
        #expect(envelope.providers.first?.models.first?.efforts == ["low", "medium", "high"])
    }

    @Test func missingRequiredCatalogFieldsFailToDecode() {
        let malformed = """
        {"schemaVersion":1,"generatedAt":"now","providers":[{"id":"codex","name":"Codex"}]}
        """
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(AICatalogEnvelope.self, from: Data(malformed.utf8))
        }
    }

    @Test func defaultsGetAndSetShapesDecodeWithOptionalSavedField() throws {
        let get = try JSONDecoder().decode(
            AIProviderDefaults.self,
            from: Data("{\"schemaVersion\":1,\"provider\":\"codex\",\"defaultModel\":null,\"defaultEffort\":null}".utf8)
        )
        let set = try JSONDecoder().decode(
            AIProviderDefaults.self,
            from: Data("{\"schemaVersion\":1,\"provider\":\"codex\",\"defaultModel\":\"deep\",\"defaultEffort\":\"high\",\"saved\":true}".utf8)
        )
        #expect(get.saved == nil)
        #expect(set.saved == true)
    }

    @Test func initialAndModelChangeEffortSelectionUseCatalogValuesOnly() {
        let modelDefault = AIModelOption(
            id: "m", label: "M", detail: "D",
            efforts: ["low", "medium", "high"], defaultEffort: "low"
        )
        #expect(AISelection.initialEffort(for: modelDefault, providerDefault: "high") == "high")
        #expect(AISelection.initialEffort(for: modelDefault, providerDefault: "removed") == "low")
        #expect(AISelection.effortAfterModelChange(for: modelDefault, current: "high") == "high")
        #expect(AISelection.effortAfterModelChange(for: modelDefault, current: "removed") == "low")

        let first = AIModelOption(
            id: "m3", label: "M3", detail: "D",
            efforts: ["eco", "max"], defaultEffort: nil
        )
        #expect(AISelection.initialEffort(for: first, providerDefault: nil) == "eco")
        #expect(AISelection.effortAfterModelChange(for: first, current: nil) == "eco")
    }

    @Test func fixedThinkingHasNoDraftEffort() {
        let fixed = AIModelOption(id: "fixed", label: "Fixed", detail: "Always on", efforts: [], defaultEffort: nil)
        #expect(fixed.isFixedThinking)
        #expect(!fixed.hasAdjustableEffort)
        #expect(AISelection.initialEffort(for: fixed, providerDefault: "high") == nil)
        #expect(AISelection.effortAfterModelChange(for: fixed, current: "high") == nil)
    }
}
