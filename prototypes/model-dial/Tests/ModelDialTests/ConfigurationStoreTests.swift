import Testing
@testable import ModelDial

@Suite("ConfigurationStore")
struct ConfigurationStoreTests {
    @Test("Updates only top-level Codex settings")
    func updatesTopLevelSettings() {
        let input = """
        model = "gpt-old"
        model_reasoning_effort = "low"

        [model_providers.proxy]
        model = "must-stay"
        """
        let output = ConfigurationStore.updateTopLevelStrings([
            "model": "gpt-5.6-sol",
            "model_reasoning_effort": "max"
        ], in: input)

        #expect(output.contains("model = \"gpt-5.6-sol\""))
        #expect(output.contains("model_reasoning_effort = \"max\""))
        #expect(output.contains("model = \"must-stay\""))
    }

    @Test("Parses Kimi aliases and effort support")
    func parsesKimiModels() {
        let input = """
        default_model = "kimi-code/k3"

        [models."kimi-code/k2"]
        model = "k2"
        capabilities = [ "thinking", "tool_use" ]
        display_name = "K2 Coding"

        [models."kimi-code/k3"]
        model = "k3"
        capabilities = [ "thinking", "tool_use" ]
        display_name = "K3"
        support_efforts = [ "low", "high", "max" ]
        default_effort = "max"

        [thinking]
        enabled = true
        effort = "high"
        """
        let parsed = ConfigurationStore.parseKimi(input)

        #expect(parsed.defaultModel == "kimi-code/k3")
        #expect(parsed.thinkingEffort == "high")
        #expect(parsed.models.first?.id == "kimi-code/k3")
        #expect(parsed.models.first?.efforts == ["low", "high", "max"])
        #expect(parsed.models.last?.detail == "Thinking is always on")
    }

    @Test("Adds and updates a thinking table")
    func updatesThinkingTable() {
        let input = """
        default_model = "kimi-code/k3"

        [thinking]
        enabled = false
        effort = "low"

        [services.search]
        base_url = "https://example.test"
        """
        let output = ConfigurationStore.updateTable(
            "thinking",
            stringValues: ["effort": "max"],
            boolValues: ["enabled": true],
            in: input
        )

        #expect(output.contains("enabled = true"))
        #expect(output.contains("effort = \"max\""))
        #expect(output.contains("[services.search]"))
    }

    @Test("Loads the installed CLI catalogs")
    func loadsInstalledCatalogs() throws {
        let codex = try CatalogLoader.loadCodex()
        let kimi = try CatalogLoader.loadKimi()

        #expect(codex.models.contains { $0.id == "gpt-5.6-sol" })
        #expect(codex.models.allSatisfy { !$0.displayName.isEmpty })
        #expect(kimi.models.contains { $0.id == "kimi-code/k3" })
    }
}
