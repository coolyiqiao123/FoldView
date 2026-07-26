import Foundation
import Testing
@testable import FoldviewMenuBar

@MainActor
final class AppStoreStateTests {
    private func waitUntil(
        timeout: Duration = .seconds(2),
        interval: Duration = .milliseconds(10),
        sourceLocation: SourceLocation = #_sourceLocation,
        _ condition: () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition() {
            if ContinuousClock.now >= deadline {
                Issue.record("condition not met within timeout", sourceLocation: sourceLocation)
                return
            }
            try await Task.sleep(for: interval)
        }
    }

    @Test func loadingThenLoadedWithLiveProjectSortedIntoLiveSection() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        #expect(store.loadState == .loading)
        store.refresh()
        try await waitUntil { store.loadState == .loaded }

        #expect(store.liveProjects.map(\.name) == ["my-app"])
        #expect(store.recentProjects == [])
    }

    @Test func configurationLoadsResolvedPathAndPersistsLiveSettingsThroughCLI() async throws {
        let fake = FakeFoldviewCLI()
        await fake.setConfigurationResult(FoldviewConfiguration(
            schemaVersion: 1,
            menubar: .init(refreshSeconds: 45, showDiscoveredApps: false),
            aiClis: [AICLIPayload(name: "Custom", executable: "/opt/bin/custom")]
        ))
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.loadConfiguration()
        try await waitUntil { store.refreshSeconds == 45 }
        #expect(store.resolvedCLIPath == "/tmp/pm")
        #expect(store.showDiscoveredApps == false)
        #expect(store.customAIClis == [AICLIPayload(name: "Custom", executable: "/opt/bin/custom")])

        store.setRefreshSeconds(90)
        try await waitUntil { store.refreshSeconds == 90 }
        #expect(await fake.refreshSecondsCalls == [90])
        store.setShowDiscoveredApps(true)
        try await waitUntil { store.showDiscoveredApps == true }
        #expect(await fake.showDiscoveredAppsCalls == [true])
    }

    @Test func rootsRefreshFailureIsVisibleToTheUser() async throws {
        let fake = FakeFoldviewCLI()
        await fake.setRootsListResult(.failure(CLIError.nonZeroExit(code: 1, message: "roots unavailable")))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        store.refreshRoots()
        try await waitUntil { store.rootsLoaded }
        #expect(store.lastActionResult == .failure("roots unavailable"))
    }

    @Test func settingsFailurePresentationShowsOnlyFailuresAndCanBeDismissed() {
        let store = AppStore(cli: FakeFoldviewCLI(), startBackgroundTimer: false)

        store.lastActionResult = .success("saved")
        #expect(store.settingsFailureMessage == nil, "successful settings actions must not create banner spam")

        store.lastActionResult = .failure("registration denied")
        #expect(store.settingsFailureMessage == "registration denied")
        store.dismissSettingsFailure()
        #expect(store.settingsFailureMessage == nil)
        #expect(store.lastActionResult == nil)
    }

    @Test func settingsViewSourceBindsFailureBannerAndDismissAction() throws {
        let macDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = macDirectory
            .appendingPathComponent("Sources/FoldviewMenuBar/Views/SettingsView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        #expect(source.contains("if let message = store.settingsFailureMessage"))
        #expect(source.contains("store.dismissSettingsFailure()"))
        #expect(source.contains("Dismiss settings error"))
    }

    @Test func backgroundTimerDoesNotRetainTheStoreAcrossItsSleep() async throws {
        let fake = FakeFoldviewCLI()
        weak var weakStore: AppStore?
        do {
            let store = AppStore(cli: fake, refreshInterval: 3_600, startBackgroundTimer: true)
            weakStore = store
        }
        try await waitUntil { weakStore == nil }
        #expect(weakStore == nil)
    }

    @Test func customCLIManagementUsesBridgeAndNeverWritesConfigurationDirectly() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Custom", executable: "/opt/bin/custom")

        store.addCustomAICLI(name: cli.name, executable: cli.executable)
        try await Task.sleep(for: .milliseconds(50))
        #expect(await fake.addCustomAICLICalls.first?.name == "Custom")
        store.removeCustomAICLI(cli)
        try await Task.sleep(for: .milliseconds(50))
        #expect(await fake.removeCustomAICLICalls == ["/opt/bin/custom"])
    }

    @Test func emptyPayloadProducesEmptyState() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.emptyPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil { store.loadState == .empty }
    }

    @Test func errorWithNoPriorPayloadProducesErrorState() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.failure(CLIError.executableNotFound))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil {
            if case .error = store.loadState { return true }
            return false
        }
    }

    @Test func staleDataIsRetainedWhenARefreshFailsAfterAnEarlierSuccess() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        await fake.enqueueStatus(.failure(CLIError.nonZeroExit(code: 1, message: "boom")))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        try await waitUntil { store.loadState == .loaded }
        #expect(!store.isStale)

        store.refresh()
        try await waitUntil { store.isStale }

        // The last good payload must still be visible, with a Retry path implied
        // by loadState staying .loaded rather than flipping to .error.
        #expect(store.loadState == .loaded)
        #expect(store.liveProjects.map(\.name) == ["my-app"])
    }

    @Test func concurrentRefreshesCoalesceAndDiscardTheStaleResult() async throws {
        let fake = FakeFoldviewCLI()
        // First call is slow and would resolve *after* the second if not for
        // generation-based coalescing.
        await fake.enqueueStatus(.success(PayloadFixtures.payloadNamed("stale-project")), delay: .milliseconds(250))
        await fake.enqueueStatus(.success(PayloadFixtures.payloadNamed("fresh-project")), delay: .milliseconds(5))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.refresh()
        store.refresh()

        try await waitUntil(timeout: .seconds(3)) { store.loadState == .loaded }
        // Let the slow, superseded first call finish resolving too, to prove its
        // late result is discarded rather than clobbering the fresh one.
        try await Task.sleep(for: .milliseconds(400))

        let visibleNames = (store.liveProjects + store.recentProjects).map(\.name)
        #expect(visibleNames == ["fresh-project"])
        #expect(!visibleNames.contains("stale-project"))

        let callCount = await fake.statusCallCount
        #expect(callCount == 2, "both calls should have been made even though only the latest is applied")
    }

    @Test func successfulActionRecordsResultAndTriggersARefresh() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))

        store.openProject(row)
        try await waitUntil { store.lastActionResult != nil }

        #expect(store.lastActionResult == .success("opened my-app"))
        let actions = await fake.performedActions
        #expect(actions == [.open(project: "/tmp/my-app")])

        try await waitUntil { store.loadState == .loaded }
        let callCount = await fake.statusCallCount
        #expect(callCount == 1, "a successful action should trigger exactly one refresh")
    }

    @Test func failedActionSurfacesFailureMessageWithoutTriggeringARefresh() async throws {
        let fake = FakeFoldviewCLI()
        await fake.setPerformResult(.failure(CLIError.nonZeroExit(code: 1, message: "could not open Terminal")))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))

        store.openProject(row)
        try await waitUntil { store.lastActionResult != nil }

        #expect(store.lastActionResult == .failure("could not open Terminal"))
        try await Task.sleep(for: .milliseconds(50))
        let callCount = await fake.statusCallCount
        #expect(callCount == 0, "a failed action must not mask itself with a refresh")
    }

    @Test func aiQuickLaunchClampsWindowCountToOneThroughNine() async throws {
        let fake = FakeFoldviewCLI()
        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())
        await fake.enqueueCatalog(.success(envelope), provider: "codex")
        await fake.enqueueCatalog(.success(envelope), provider: "kimi")
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))
        let cli = AICLIPayload(name: "claude", executable: "/usr/local/bin/claude")

        store.loadAIModels(for: cli)
        try await waitUntil { store.hasSuccessfulAICatalogDiscovery }
        store.launchAI(project: row, cli: cli, count: 42)
        try await waitUntil { store.lastActionResult != nil }

        let actions = await fake.performedActions
        #expect(actions == [.ai(
            project: "/tmp/my-app", cli: "/usr/local/bin/claude", count: 9,
            provider: nil, model: nil, effort: nil
        )])
        #expect(store.lastActionResult == .success("opened 9 × claude"))
    }

    @Test func providerCatalogsLoadIndependentlyAndFailureDoesNotBlankProjects() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let partial = Self.catalogEnvelope(codex: Self.codexCatalog(), kimiAvailable: false)
        await fake.enqueueCatalog(.success(partial), provider: "codex")
        await fake.enqueueCatalog(.success(partial), provider: "kimi")
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        store.refresh()
        try await waitUntil { store.loadState == .loaded }

        let codexCLI = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")
        store.loadAIModels(for: codexCLI)
        try await waitUntil {
            if case .ready = store.aiProviderStates["codex"] { return true }
            return false
        }

        #expect(store.providerCatalog(matching: codexCLI)?.id == "codex")
        if case .error(_, let message) = store.aiProviderStates["kimi"] {
            #expect(message == "Kimi config is unavailable.")
        } else {
            Issue.record("Kimi should retain its independent error state")
        }
        #expect(store.liveProjects.map(\.name) == ["my-app"])
    }

    @Test func failedRefreshKeepsPriorProviderCatalogVisibleButStale() async throws {
        let fake = FakeFoldviewCLI()
        let codex = Self.codexCatalog()
        let initial = Self.catalogEnvelope(codex: codex)
        await fake.enqueueCatalog(.success(initial), provider: "codex")
        await fake.enqueueCatalog(.success(initial), provider: "kimi")
        await fake.enqueueCatalog(.failure(CLIError.nonZeroExit(code: 1, message: "probe failed")), provider: "codex")
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")

        store.loadAIModels(for: cli)
        try await waitUntil { store.providerCatalog(matching: cli)?.models.first?.id == "deep" }
        store.loadAIModels(for: cli)
        try await waitUntil {
            if case .stale = store.aiProviderStates["codex"] { return true }
            return false
        }

        #expect(store.providerCatalog(matching: cli)?.models.first?.id == "deep")
        #expect(store.aiProviderStates["codex"]?.blocksActions == true)
        if case .ready = store.aiProviderStates["kimi"] {} else {
            Issue.record("a Codex-only refresh failure must not erase Kimi")
        }
    }

    @Test func lateCatalogResponseCannotClobberNewerGeneration() async throws {
        let fake = FakeFoldviewCLI()
        let old = Self.codexCatalog(modelID: "old")
        let fresh = Self.codexCatalog(modelID: "fresh")
        let oldEnvelope = Self.catalogEnvelope(codex: old)
        let freshEnvelope = Self.catalogEnvelope(codex: fresh)
        await fake.enqueueCatalog(.success(oldEnvelope), provider: "codex", delay: .milliseconds(220))
        await fake.enqueueCatalog(.success(freshEnvelope), provider: "codex", delay: .milliseconds(5))
        await fake.enqueueCatalog(.success(oldEnvelope), provider: "kimi", delay: .milliseconds(220))
        await fake.enqueueCatalog(.success(freshEnvelope), provider: "kimi", delay: .milliseconds(5))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")

        store.loadAIModels(for: cli)
        store.loadAIModels(for: cli)
        try await waitUntil { store.providerCatalog(matching: cli)?.models.first?.id == "fresh" }
        try await Task.sleep(for: .milliseconds(300))
        #expect(store.providerCatalog(matching: cli)?.models.first?.id == "fresh")
    }

    @Test func overlappingProviderLoadsDoNotCancelEachOther() async throws {
        let fake = FakeFoldviewCLI()
        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())
        await fake.enqueueCatalog(.success(envelope), provider: "codex", delay: .milliseconds(220))
        await fake.enqueueCatalog(.success(envelope), provider: "kimi", delay: .milliseconds(5))
        let store = AppStore(cli: fake, startBackgroundTimer: false)

        store.loadAIModels(for: AICLIPayload(name: "Codex", executable: "/opt/bin/codex"))
        try await waitUntil {
            if case .ready = store.aiProviderStates["kimi"] { return true }
            return false
        }
        #expect(store.aiProviderStates["codex"]?.isLoading == true)
        try await waitUntil {
            if case .ready = store.aiProviderStates["codex"] { return true }
            return false
        }
        #expect(await fake.catalogCalls.contains { $0 == "codex" })
        #expect(await fake.catalogCalls.contains { $0 == "kimi" })
    }

    @Test func saveDefaultAndLaunchAreDistinctExplicitActions() async throws {
        let fake = FakeFoldviewCLI()
        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())
        await fake.enqueueCatalog(.success(envelope), provider: "codex")
        await fake.enqueueCatalog(.success(envelope), provider: "kimi")
        await fake.enqueueCatalog(.success(AICatalogEnvelope(
            schemaVersion: 1, generatedAt: envelope.generatedAt,
            providers: [Self.codexCatalog()]
        )), provider: "codex")
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app", live: true))

        store.loadAIModels(for: cli)
        try await waitUntil { store.providerCatalog(matching: cli) != nil }
        let provider = try #require(store.providerCatalog(matching: cli))
        let model = try #require(provider.models.first)

        store.saveAIDefault(provider: provider, model: model, effort: "high")
        try await waitUntil { store.lastActionResult?.message.contains("saved") == true }
        #expect(await fake.setDefaultCalls.count == 1)
        #expect(await fake.performedActions.isEmpty)

        try await waitUntil { store.aiProviderStates["codex"]?.blocksActions == false }
        store.launchAI(project: row, cli: cli, model: model, effort: "high", count: 2)
        try await waitUntil { store.lastActionResult == .success("opened 2 × Codex") }
        let actions = await fake.performedActions
        #expect(actions == [.ai(
            project: "/tmp/my-app", cli: "/opt/bin/codex", count: 2,
            provider: "codex", model: "deep", effort: "high"
        )])
        #expect(await fake.setDefaultCalls.count == 1)
    }

    @Test func authoritativeUnsupportedSelectionMarksOnlyThatProviderStale() async throws {
        let fake = FakeFoldviewCLI()
        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())
        await fake.enqueueCatalog(.success(envelope), provider: "codex")
        await fake.enqueueCatalog(.success(envelope), provider: "kimi")
        await fake.setPerformResult(.failure(AIProviderCommandError(AIProviderErrorPayload(
            code: "unsupported_model", message: "Model disappeared.", provider: "codex",
            model: "deep", effort: nil, retryable: false
        ))))
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app"))

        store.loadAIModels(for: cli)
        try await waitUntil { store.providerCatalog(matching: cli) != nil }
        let model = try #require(store.providerCatalog(matching: cli)?.models.first)
        store.launchAI(project: row, cli: cli, model: model, effort: "high", count: 1)
        try await waitUntil {
            if case .stale = store.aiProviderStates["codex"] { return true }
            return false
        }
        if case .ready = store.aiProviderStates["kimi"] {} else {
            Issue.record("Kimi must remain ready")
        }
        #expect(store.lastActionResult == .failure("Model disappeared."))
    }

    @Test func launchBoundaryRejectsLoadingStaleAndErrorCatalogsWithoutPerformingAction() async throws {
        let cli = AICLIPayload(name: "Codex", executable: "/opt/bin/codex")
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app"))
        let model = Self.codexCatalog().models[0]
        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())

        let loadingFake = FakeFoldviewCLI()
        await loadingFake.enqueueCatalog(.success(envelope), provider: "codex", delay: .milliseconds(200))
        await loadingFake.enqueueCatalog(.success(envelope), provider: "kimi", delay: .milliseconds(200))
        let loadingStore = AppStore(cli: loadingFake, startBackgroundTimer: false)
        loadingStore.loadAIModels(for: cli)
        loadingStore.launchAI(project: row, cli: cli, model: model, effort: "high", count: 1)
        #expect(await loadingFake.performedActions.isEmpty)
        #expect(loadingStore.lastActionResult?.isFailure == true)

        let staleFake = FakeFoldviewCLI()
        await staleFake.enqueueCatalog(.success(envelope), provider: "codex")
        await staleFake.enqueueCatalog(.success(envelope), provider: "kimi")
        await staleFake.enqueueCatalog(.failure(CLIError.nonZeroExit(code: 1, message: "probe failed")), provider: "codex")
        let staleStore = AppStore(cli: staleFake, startBackgroundTimer: false)
        staleStore.loadAIModels(for: cli)
        try await waitUntil { staleStore.providerCatalog(matching: cli) != nil }
        staleStore.loadAIModels(for: cli)
        try await waitUntil {
            if case .stale = staleStore.aiProviderStates["codex"] { return true }
            return false
        }
        staleStore.launchAI(project: row, cli: cli, model: model, effort: "high", count: 1)
        #expect(await staleFake.performedActions.isEmpty)
        #expect(staleStore.lastActionResult == .failure("Refresh Codex models before launching."))

        let unavailable = Self.unavailableCodexCatalog()
        let errorEnvelope = AICatalogEnvelope(
            schemaVersion: 1,
            generatedAt: envelope.generatedAt,
            providers: [unavailable, Self.kimiCatalog()]
        )
        let errorFake = FakeFoldviewCLI()
        await errorFake.enqueueCatalog(.success(errorEnvelope), provider: "codex")
        await errorFake.enqueueCatalog(.success(errorEnvelope), provider: "kimi")
        let errorStore = AppStore(cli: errorFake, startBackgroundTimer: false)
        errorStore.loadAIModels(for: cli)
        try await waitUntil {
            if case .error = errorStore.aiProviderStates["codex"] { return true }
            return false
        }
        errorStore.launchAI(project: row, cli: cli, model: model, effort: "high", count: 1)
        #expect(await errorFake.performedActions.isEmpty)
        #expect(errorStore.lastActionResult == .failure("Refresh Codex models before launching."))
    }

    @Test func unknownProviderRejectsEffortOnlyOverrideWithoutPerformingAction() async {
        let fake = FakeFoldviewCLI()
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Custom", executable: "/opt/bin/custom")
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app"))

        store.launchAI(project: row, cli: cli, model: nil, effort: "high", count: 1)
        #expect(await fake.performedActions.isEmpty)
        #expect(store.lastActionResult == .failure("Refresh this model catalog before launching."))
    }

    @Test func initialCatalogTransportFailureBlocksCustomLaunchUntilSuccessfulRetry() async throws {
        let fake = FakeFoldviewCLI()
        await fake.enqueueCatalog(.failure(CLIError.processTimedOut), provider: "codex")
        await fake.enqueueCatalog(.failure(CLIError.processTimedOut), provider: "kimi")
        let store = AppStore(cli: fake, startBackgroundTimer: false)
        let cli = AICLIPayload(name: "Custom", executable: "/opt/bin/custom")
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "my-app"))

        store.loadAIModels(for: cli)
        try await waitUntil { !store.isAICatalogLoading }
        #expect(!store.hasSuccessfulAICatalogDiscovery)
        #expect(store.aiCatalogDiscoveryError != nil)
        store.launchAI(project: row, cli: cli, model: nil, effort: nil, count: 1)
        #expect(await fake.performedActions.isEmpty)
        #expect(store.lastActionResult == .failure("Load AI model catalogs before launching this CLI."))

        let envelope = Self.catalogEnvelope(codex: Self.codexCatalog())
        await fake.enqueueCatalog(.success(envelope), provider: "codex")
        await fake.enqueueCatalog(.success(envelope), provider: "kimi")
        await fake.enqueueStatus(.success(PayloadFixtures.validPayload))
        store.retryAIModels(for: cli)
        try await waitUntil { store.hasSuccessfulAICatalogDiscovery }
        store.launchAI(project: row, cli: cli, model: nil, effort: nil, count: 1)
        try await waitUntil { store.lastActionResult == .success("opened 1 × Custom") }
        let actions = await fake.performedActions
        #expect(actions == [.ai(
            project: "/tmp/my-app", cli: "/opt/bin/custom", count: 1,
            provider: nil, model: nil, effort: nil
        )])
    }

    private static func codexCatalog(modelID: String = "deep") -> AIProviderCatalog {
        AIProviderCatalog(
            id: "codex", name: "Codex", executable: "/opt/bin/codex", available: true, error: nil,
            defaultModel: modelID, defaultEffort: "high",
            models: [AIModelOption(
                id: modelID, label: modelID.capitalized, detail: "Careful coding",
                efforts: ["low", "medium", "high"], defaultEffort: "medium"
            )]
        )
    }

    private static func kimiCatalog(available: Bool = true) -> AIProviderCatalog {
        AIProviderCatalog(
            id: "kimi", name: "Kimi Code", executable: "/opt/bin/kimi", available: available,
            error: available ? nil : AIProviderErrorPayload(
                code: "config_read_failed", message: "Kimi config is unavailable.", provider: "kimi",
                model: nil, effort: nil, retryable: true
            ),
            defaultModel: available ? "moon" : nil, defaultEffort: nil,
            models: available ? [AIModelOption(
                id: "moon", label: "Moon", detail: "Kimi managed model", efforts: [], defaultEffort: nil
            )] : []
        )
    }

    private static func unavailableCodexCatalog() -> AIProviderCatalog {
        AIProviderCatalog(
            id: "codex", name: "Codex", executable: "/opt/bin/codex", available: false,
            error: AIProviderErrorPayload(
                code: "malformed_catalog", message: "Codex catalog is unavailable.", provider: "codex",
                model: nil, effort: nil, retryable: true
            ),
            defaultModel: nil, defaultEffort: nil, models: []
        )
    }

    private static func catalogEnvelope(
        codex: AIProviderCatalog,
        kimiAvailable: Bool = true
    ) -> AICatalogEnvelope {
        AICatalogEnvelope(
            schemaVersion: 1,
            generatedAt: "2026-07-19T00:00:00.000Z",
            providers: [codex, kimiCatalog(available: kimiAvailable)]
        )
    }
}

private extension FakeFoldviewCLI {
    func setPerformResult(_ result: Result<Void, Error>) {
        performResult = result
    }
}
